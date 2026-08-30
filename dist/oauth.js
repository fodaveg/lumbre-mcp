import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BackchannelError, LUMBRE_OAUTH_CALLBACK, LumbreBackchannel, isValidRequestId } from './lumbre-oauth-backchannel.js';
export const OAUTH_ISSUER = 'https://mcp.lumbre.pro';
export const OAUTH_RESOURCE = `${OAUTH_ISSUER}/mcp`;
export const OAUTH_SCOPE = 'lumbre:mcp';
export const OAUTH_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const OAUTH_RESOURCE_METADATA = `${OAUTH_ISSUER}/.well-known/oauth-protected-resource/mcp`;
export const OAUTH_CHALLENGE = `Bearer resource_metadata="${OAUTH_RESOURCE_METADATA}", scope="${OAUTH_SCOPE}"`;
const ACCESS_PREFIX = 'lm_at_';
const REFRESH_PREFIX = 'lm_rt_';
const CODE_TTL_MS = 5 * 60_000;
const TRANSACTION_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_FORM_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PENDING_ITEMS = 1_000;
const MAX_CIMD_CACHE_ITEMS = 128;
const DEFAULT_CIMD_CACHE_MS = 5 * 60_000;
const MAX_CIMD_CACHE_MS = 60 * 60_000;
const MAX_REFRESH_TOMBSTONES = 10_000;
const MAX_REFRESH_TOMBSTONES_PER_FAMILY = 64;
const MAX_OUTBOX_RETRIES_PER_READINESS = 1;
const READINESS_CACHE_MS = 5_000;
const DEFAULT_PUBLIC_LIMITS = {
    authorize: { requestsPerMinute: 30, concurrent: 8 },
    token: { requestsPerMinute: 60, concurrent: 16 },
    revoke: { requestsPerMinute: 60, concurrent: 16 }
};
class OAuthError extends Error {
    code;
    status;
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
function defaultStateDir() {
    const root = process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
    return join(root, 'lumbre-mcp');
}
function opaque(prefix) {
    return `${prefix}${randomBytes(32).toString('base64url')}`;
}
function digest(value) {
    return createHash('sha256').update(value, 'utf8').digest('base64url');
}
function equalText(a, b) {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    return aa.length === bb.length && timingSafeEqual(aa, bb);
}
async function syncDirectory(path) {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
function securityHeaders(contentType) {
    return {
        'content-type': contentType,
        'cache-control': 'no-store',
        pragma: 'no-cache',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    };
}
function json(res, status, body) {
    res.writeHead(status, securityHeaders('application/json; charset=utf-8'));
    res.end(JSON.stringify(body));
}
function oauthError(res, error) {
    const known = error instanceof OAuthError ? error : new OAuthError('server_error', 'No se pudo completar la autorización.', 500);
    json(res, known.status, { error: known.code, error_description: known.message });
}
async function readLimitedBody(req, limit = MAX_FORM_BYTES) {
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let exceeded = false;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit && !exceeded) {
                exceeded = true;
                reject(new OAuthError('invalid_request', 'Formulario demasiado grande.', 413));
                return;
            }
            if (!exceeded)
                chunks.push(chunk);
        });
        req.on('end', () => {
            if (!exceeded)
                resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', reject);
    });
}
async function readForm(req) {
    const type = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
        throw new OAuthError('invalid_request', 'Se requiere application/x-www-form-urlencoded.');
    }
    return new URLSearchParams(await readLimitedBody(req));
}
function one(params, name, required = true) {
    const values = params.getAll(name);
    if (values.length > 1 || (required && values.length !== 1) || (values[0]?.length ?? 0) > 2048) {
        throw new OAuthError('invalid_request', `Parámetro ${name} inválido.`);
    }
    return values[0];
}
async function readResponseText(res) {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
        throw new OAuthError('invalid_client', 'Documento de cliente demasiado grande.');
    }
    if (!res.body)
        return '';
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > MAX_METADATA_BYTES) {
            await reader.cancel();
            throw new OAuthError('invalid_client', 'Documento de cliente demasiado grande.');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}
function validateClientIdUrl(clientId) {
    let url;
    let hasDotSegment = false;
    try {
        url = new URL(clientId);
        const pathStart = clientId.indexOf('/', clientId.indexOf('://') + 3);
        const rawPath = pathStart < 0 ? '' : clientId.slice(pathStart).split(/[?#]/, 1)[0];
        hasDotSegment = rawPath.split('/').some((segment) => {
            const decoded = decodeURIComponent(segment);
            return decoded === '.' || decoded === '..';
        });
    }
    catch {
        throw new OAuthError('invalid_client', 'client_id debe ser un documento HTTPS válido.');
    }
    if (url.protocol !== 'https:' ||
        (url.hostname !== 'claude.ai' && url.hostname !== 'chatgpt.com') ||
        (url.port !== '' && url.port !== '443') ||
        url.pathname === '/' ||
        url.search !== '' ||
        hasDotSegment ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== '') {
        throw new OAuthError('invalid_client', 'Este conector solo admite documentos de cliente de Claude o Codex.');
    }
    if (url.hostname === 'chatgpt.com' && !/^\/oauth\/codex\/(?:[A-Za-z0-9_-]+\/)?client\.json$/.test(url.pathname)) {
        throw new OAuthError('invalid_client', 'Documento de cliente de Codex no reconocido.');
    }
    return url;
}
function registeredRedirectMatches(clientId, requested, registered) {
    if (requested === registered)
        return true;
    const client = validateClientIdUrl(clientId);
    if (client.hostname !== 'chatgpt.com')
        return false;
    try {
        const actual = new URL(requested);
        const expected = new URL(registered);
        return (actual.protocol === 'http:' &&
            actual.hostname === '127.0.0.1' &&
            actual.port !== '' &&
            expected.protocol === 'http:' &&
            expected.hostname === actual.hostname &&
            expected.port === '' &&
            expected.pathname === actual.pathname &&
            expected.search === actual.search &&
            expected.hash === '' &&
            actual.hash === '' &&
            expected.username === '' &&
            expected.password === '' &&
            actual.username === '' &&
            actual.password === '');
    }
    catch {
        return false;
    }
}
function validStoredRedirect(clientId, redirectUri) {
    const client = validateClientIdUrl(clientId);
    if (client.hostname === 'claude.ai')
        return redirectUri === OAUTH_CALLBACK;
    const callbackId = client.pathname.match(/^\/oauth\/codex\/([A-Za-z0-9_-]+)\/client\.json$/)?.[1];
    const registered = callbackId
        ? `http://127.0.0.1/callback/${callbackId}`
        : 'http://127.0.0.1/callback';
    return registeredRedirectMatches(clientId, redirectUri, registered);
}
function grantContext(clientId, resource, scope) {
    return Buffer.from(JSON.stringify([clientId, resource, scope]), 'utf8');
}
function transactionContext(requestId, clientId, resource, scope) {
    return Buffer.from(JSON.stringify(['lumbre-transaction', requestId, clientId, resource, scope]), 'utf8');
}
function encrypt(value, key, context) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}
function decrypt(value, key, context) {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64url'));
    decipher.setAAD(context);
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
function validEncryptedValue(value) {
    if (!value || typeof value !== 'object')
        return false;
    const candidate = value;
    return (typeof candidate.iv === 'string' &&
        typeof candidate.tag === 'string' &&
        typeof candidate.ciphertext === 'string');
}
function normalizeStore(value) {
    if (!value || typeof value !== 'object')
        throw new Error('store OAuth inválido');
    const raw = value;
    if (raw.version === 1 || raw.version === 2) {
        throw new Error('store OAuth provisional v1/v2 no compatible; archívalo y vuelve a autorizar desde la sesión web');
    }
    if (raw.version !== 3 ||
        !Array.isArray(raw.grants) ||
        !Array.isArray(raw.usedRefreshTokens) ||
        !Array.isArray(raw.authorizationRequests) ||
        !Array.isArray(raw.authorizationCodes) ||
        !Array.isArray(raw.revocationOutbox)) {
        throw new Error('store OAuth inválido');
    }
    const grants = raw.grants.map((value) => {
        if (!value || typeof value !== 'object')
            throw new Error('grant OAuth inválido');
        const grant = value;
        if (grant.provider !== 'lumbre-web' ||
            typeof grant.credentialId !== 'string' ||
            !isValidRequestId(grant.credentialId) ||
            typeof grant.familyId !== 'string' ||
            !Number.isFinite(grant.familyExpiresAt) ||
            typeof grant.clientId !== 'string' ||
            typeof grant.resource !== 'string' ||
            typeof grant.scope !== 'string' ||
            typeof grant.accessHash !== 'string' ||
            !Number.isFinite(grant.accessExpiresAt) ||
            typeof grant.refreshHash !== 'string' ||
            !Number.isFinite(grant.refreshExpiresAt) ||
            !validEncryptedValue(grant.upstream)) {
            throw new Error('grant OAuth inválido');
        }
        return grant;
    });
    const usedRefreshTokens = raw.usedRefreshTokens.map((value) => {
        if (!value || typeof value !== 'object')
            throw new Error('tombstone OAuth inválido');
        const item = value;
        if (typeof item.hash !== 'string' ||
            typeof item.familyId !== 'string' ||
            !Number.isFinite(item.expiresAt)) {
            throw new Error('tombstone OAuth inválido');
        }
        return item;
    });
    const usedHashes = new Set(usedRefreshTokens.map((item) => item.hash));
    if (new Set(grants.map((grant) => grant.familyId)).size !== grants.length ||
        new Set(grants.map((grant) => grant.accessHash)).size !== grants.length ||
        new Set(grants.map((grant) => grant.refreshHash)).size !== grants.length ||
        grants.some((grant) => grant.familyExpiresAt < grant.refreshExpiresAt) ||
        usedHashes.size !== usedRefreshTokens.length ||
        grants.some((grant) => usedHashes.has(grant.refreshHash)) ||
        usedRefreshTokens.length > MAX_REFRESH_TOMBSTONES) {
        throw new Error('store OAuth incoherente');
    }
    const familyCounts = new Map();
    for (const item of usedRefreshTokens) {
        familyCounts.set(item.familyId, (familyCounts.get(item.familyId) ?? 0) + 1);
    }
    const overflowFamilies = new Set([...familyCounts].filter(([, count]) => count > MAX_REFRESH_TOMBSTONES_PER_FAMILY).map(([familyId]) => familyId));
    if (overflowFamilies.size > 0)
        throw new Error('store OAuth incoherente: familia sobre el límite de tombstones');
    const authorizationRequests = raw.authorizationRequests.map((value) => {
        if (!value || typeof value !== 'object')
            throw new Error('autorización OAuth inválida');
        const item = value;
        if (typeof item.requestId !== 'string' ||
            !isValidRequestId(item.requestId) ||
            !validEncryptedValue(item.transaction) ||
            typeof item.clientName !== 'string' ||
            item.clientName !== item.clientName.trim() ||
            item.clientName.length === 0 ||
            item.clientName.length > 120 ||
            typeof item.clientId !== 'string' ||
            typeof item.redirectUri !== 'string' ||
            !validStoredRedirect(item.clientId, item.redirectUri) ||
            item.scope !== OAUTH_SCOPE ||
            item.resource !== OAUTH_RESOURCE ||
            typeof item.challenge !== 'string' ||
            !/^[A-Za-z0-9_-]{43}$/.test(item.challenge) ||
            (item.state !== undefined && (typeof item.state !== 'string' || item.state.length > 1024)) ||
            !Number.isFinite(item.expiresAt)) {
            throw new Error('autorización OAuth inválida');
        }
        return item;
    });
    if (authorizationRequests.length > MAX_PENDING_ITEMS ||
        new Set(authorizationRequests.map((item) => item.requestId)).size !== authorizationRequests.length) {
        throw new Error('store OAuth incoherente');
    }
    const authorizationCodes = raw.authorizationCodes.map((value) => {
        if (!value || typeof value !== 'object')
            throw new Error('código OAuth inválido');
        const item = value;
        if (typeof item.codeHash !== 'string' ||
            typeof item.credentialId !== 'string' ||
            !isValidRequestId(item.credentialId) ||
            typeof item.clientId !== 'string' ||
            typeof item.redirectUri !== 'string' ||
            !validStoredRedirect(item.clientId, item.redirectUri) ||
            item.scope !== OAUTH_SCOPE ||
            item.resource !== OAUTH_RESOURCE ||
            typeof item.challenge !== 'string' ||
            !/^[A-Za-z0-9_-]{43}$/.test(item.challenge) ||
            (item.state !== undefined && (typeof item.state !== 'string' || item.state.length > 1024)) ||
            !Number.isFinite(item.expiresAt) ||
            !validEncryptedValue(item.upstream)) {
            throw new Error('código OAuth inválido');
        }
        return item;
    });
    const revocationOutbox = raw.revocationOutbox.map((value) => {
        if (!value || typeof value !== 'object')
            throw new Error('outbox OAuth inválida');
        const item = value;
        if (item.provider !== 'lumbre-web' ||
            typeof item.credentialId !== 'string' ||
            !isValidRequestId(item.credentialId) ||
            typeof item.clientId !== 'string' ||
            item.resource !== OAUTH_RESOURCE ||
            item.scope !== OAUTH_SCOPE ||
            !validEncryptedValue(item.upstream)) {
            throw new Error('outbox OAuth inválida');
        }
        return item;
    });
    const credentialIds = [
        ...grants.map((item) => item.credentialId),
        ...authorizationCodes.map((item) => item.credentialId),
        ...revocationOutbox.map((item) => item.credentialId)
    ];
    const opaqueHashes = [
        ...grants.flatMap((item) => [item.accessHash, item.refreshHash]),
        ...usedRefreshTokens.map((item) => item.hash),
        ...authorizationCodes.map((item) => item.codeHash)
    ];
    if (authorizationCodes.length > MAX_PENDING_ITEMS ||
        new Set(authorizationCodes.map((item) => item.codeHash)).size !== authorizationCodes.length ||
        new Set(credentialIds).size !== credentialIds.length ||
        new Set(opaqueHashes).size !== opaqueHashes.length) {
        throw new Error('store OAuth incoherente');
    }
    return {
        version: 3,
        grants,
        usedRefreshTokens,
        authorizationRequests,
        authorizationCodes,
        revocationOutbox
    };
}
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
export class OAuthService {
    stateDir;
    fetchFn;
    now;
    suppliedEncryptionKey;
    publicLimits;
    persistenceStep;
    backchannel;
    encryptionKey;
    keyPromise;
    rateWindows = new Map();
    inFlight = { authorize: 0, token: 0, revoke: 0 };
    clientMetadataCache = new Map();
    clientMetadataInFlight = new Map();
    readinessCache;
    readinessInFlight;
    writeQueue = Promise.resolve();
    constructor(options = {}) {
        this.stateDir = options.stateDir ?? defaultStateDir();
        this.fetchFn = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.persistenceStep = options.persistenceStep;
        this.backchannel = options.backchannel ?? new LumbreBackchannel({
            baseUrl: options.lumbreAppBaseUrl ?? process.env.LUMBRE_APP_BASE_URL,
            secret: options.backchannelSecret ?? process.env.LUMBRE_MCP_BACKCHANNEL_SECRET,
            fetch: this.fetchFn
        });
        if (options.encryptionKey && options.encryptionKey.length !== 32)
            throw new Error('OAuth encryptionKey debe tener 32 bytes');
        this.suppliedEncryptionKey = options.encryptionKey !== undefined;
        this.encryptionKey = options.encryptionKey;
        this.publicLimits = {
            authorize: { ...DEFAULT_PUBLIC_LIMITS.authorize, ...options.publicLimits?.authorize },
            token: { ...DEFAULT_PUBLIC_LIMITS.token, ...options.publicLimits?.token },
            revoke: { ...DEFAULT_PUBLIC_LIMITS.revoke, ...options.publicLimits?.revoke }
        };
    }
    protectedResourceMetadata() {
        return {
            resource: OAUTH_RESOURCE,
            authorization_servers: [OAUTH_ISSUER],
            bearer_methods_supported: ['header'],
            scopes_supported: [OAUTH_SCOPE]
        };
    }
    authorizationServerMetadata() {
        return {
            issuer: OAUTH_ISSUER,
            authorization_endpoint: `${OAUTH_ISSUER}/authorize`,
            token_endpoint: `${OAUTH_ISSUER}/token`,
            revocation_endpoint: `${OAUTH_ISSUER}/revoke`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            revocation_endpoint_auth_methods_supported: ['none'],
            scopes_supported: [OAUTH_SCOPE],
            client_id_metadata_document_supported: true,
            authorization_response_iss_parameter_supported: true
        };
    }
    async clientMetadata(clientId) {
        const cached = this.clientMetadataCache.get(clientId);
        if (cached && cached.expiresAt > this.now()) {
            this.clientMetadataCache.delete(clientId);
            this.clientMetadataCache.set(clientId, cached);
            return cached.metadata;
        }
        if (cached)
            this.clientMetadataCache.delete(clientId);
        const existing = this.clientMetadataInFlight.get(clientId);
        if (existing)
            return await existing;
        const pending = this.fetchClientMetadata(clientId).then(({ metadata, cacheMs }) => {
            if (cacheMs > 0) {
                while (this.clientMetadataCache.size >= MAX_CIMD_CACHE_ITEMS) {
                    this.clientMetadataCache.delete(this.clientMetadataCache.keys().next().value);
                }
                this.clientMetadataCache.set(clientId, { metadata, expiresAt: this.now() + cacheMs });
            }
            return metadata;
        });
        this.clientMetadataInFlight.set(clientId, pending);
        try {
            return await pending;
        }
        finally {
            this.clientMetadataInFlight.delete(clientId);
        }
    }
    async fetchClientMetadata(clientId) {
        const url = validateClientIdUrl(clientId);
        const signal = AbortSignal.timeout(5_000);
        let response;
        try {
            response = await this.fetchFn(url, { redirect: 'manual', signal, headers: { accept: 'application/json' } });
        }
        catch {
            throw new OAuthError('invalid_client', 'No se pudo leer el documento del cliente.');
        }
        if (response.status !== 200 || response.type === 'opaqueredirect') {
            throw new OAuthError('invalid_client', 'El documento del cliente no respondió 200 sin redirecciones.');
        }
        const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
            throw new OAuthError('invalid_client', 'El documento del cliente no es JSON.');
        }
        let metadata;
        try {
            metadata = JSON.parse(await readResponseText(response));
        }
        catch (error) {
            if (error instanceof OAuthError)
                throw error;
            throw new OAuthError('invalid_client', 'El documento del cliente contiene JSON inválido.');
        }
        if (!metadata || typeof metadata !== 'object')
            throw new OAuthError('invalid_client', 'Documento de cliente inválido.');
        const candidate = metadata;
        if (candidate.client_id !== clientId ||
            typeof candidate.client_name !== 'string' ||
            candidate.client_name.trim() === '' ||
            !Array.isArray(candidate.redirect_uris) ||
            candidate.redirect_uris.length === 0 ||
            !candidate.redirect_uris.every((redirect) => typeof redirect === 'string') ||
            (candidate.token_endpoint_auth_method !== undefined && candidate.token_endpoint_auth_method !== 'none') ||
            (candidate.grant_types !== undefined &&
                (!Array.isArray(candidate.grant_types) || !candidate.grant_types.includes('authorization_code'))) ||
            (candidate.response_types !== undefined &&
                (!Array.isArray(candidate.response_types) || !candidate.response_types.includes('code')))) {
            throw new OAuthError('invalid_client', 'El documento del cliente no registra el callback o el flujo requerido.');
        }
        const cacheControl = response.headers.get('cache-control') ?? '';
        const cacheDirectives = cacheControl.toLowerCase().split(',').map((directive) => directive.trim());
        const forbidsCache = cacheDirectives.some((directive) => directive === 'no-store' || directive === 'no-cache' || directive.startsWith('no-cache='));
        const maxAge = Number(cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1]);
        const cacheMs = forbidsCache
            ? 0
            : Number.isFinite(maxAge)
                ? Math.min(Math.max(0, maxAge * 1_000), MAX_CIMD_CACHE_MS)
                : DEFAULT_CIMD_CACHE_MS;
        return { metadata: candidate, cacheMs };
    }
    authorizationRequest(params) {
        const responseType = one(params, 'response_type');
        const clientId = one(params, 'client_id');
        const redirectUri = one(params, 'redirect_uri');
        const scope = one(params, 'scope');
        const resource = one(params, 'resource');
        const challenge = one(params, 'code_challenge');
        const method = one(params, 'code_challenge_method');
        const state = one(params, 'state', false);
        if (responseType !== 'code')
            throw new OAuthError('unsupported_response_type', 'Solo se admite response_type=code.');
        if (scope !== OAUTH_SCOPE)
            throw new OAuthError('invalid_scope', `El scope debe ser ${OAUTH_SCOPE}.`);
        if (resource !== OAUTH_RESOURCE)
            throw new OAuthError('invalid_target', `El resource debe ser ${OAUTH_RESOURCE}.`);
        if (method !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
            throw new OAuthError('invalid_request', 'Se requiere PKCE S256 válido.');
        }
        if (state !== undefined && state.length > 1024)
            throw new OAuthError('invalid_request', 'state demasiado largo.');
        return { clientId: clientId, redirectUri: redirectUri, scope, resource, challenge, state };
    }
    enterPublicEndpoint(req, endpoint) {
        const forwarded = req.headers['x-forwarded-for'];
        const rawForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        const remote = rawForwarded?.split(',').at(-1)?.trim().slice(0, 128) || req.socket.remoteAddress || 'unknown';
        const now = this.now();
        for (const [key, window] of this.rateWindows) {
            if (window.startedAt + 60_000 <= now)
                this.rateWindows.delete(key);
        }
        while (this.rateWindows.size >= 2_048)
            this.rateWindows.delete(this.rateWindows.keys().next().value);
        const key = `${endpoint}:${remote}`;
        const limit = this.publicLimits[endpoint];
        const window = this.rateWindows.get(key);
        if (window && window.count >= limit.requestsPerMinute) {
            throw new OAuthError('temporarily_unavailable', 'Demasiadas solicitudes; inténtalo de nuevo más tarde.', 429);
        }
        if (this.inFlight[endpoint] >= limit.concurrent) {
            throw new OAuthError('temporarily_unavailable', 'El servidor está ocupado; inténtalo de nuevo.', 429);
        }
        if (window)
            window.count += 1;
        else
            this.rateWindows.set(key, { startedAt: now, count: 1 });
        this.inFlight[endpoint] += 1;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.inFlight[endpoint] -= 1;
        };
    }
    async handleAuthorize(req, res, url) {
        let release;
        try {
            release = this.enterPublicEndpoint(req, 'authorize');
            if (req.method !== 'GET')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            const request = this.authorizationRequest(url.searchParams);
            const metadata = await this.clientMetadata(request.clientId);
            if (!metadata.redirect_uris.some((registered) => registeredRedirectMatches(request.clientId, request.redirectUri, registered))) {
                throw new OAuthError('invalid_request', 'redirect_uri no registrado.');
            }
            const clientName = metadata.client_name.trim().slice(0, 120);
            const transactionId = randomBytes(32).toString('base64url');
            let created;
            try {
                created = await this.backchannel.createAuthorizationRequest({
                    transactionId,
                    clientId: request.clientId,
                    clientName,
                    resource: request.resource,
                    scope: request.scope,
                    callbackUri: LUMBRE_OAUTH_CALLBACK
                });
            }
            catch (error) {
                throw this.backchannelOAuthError(error);
            }
            const expiresAt = Math.min(created.expiresAt, this.now() + TRANSACTION_TTL_MS);
            const authorizationUrl = new URL(created.authorizationUrl);
            if (created.expiresAt <= this.now() ||
                created.expiresAt > this.now() + TRANSACTION_TTL_MS + 5 * 60_000 ||
                authorizationUrl.searchParams.get('request') !== created.requestId) {
                throw new OAuthError('server_error', 'Lumbre devolvió una autorización fuera de contrato.', 502);
            }
            const key = await this.key();
            await this.mutateStore((store) => {
                store.authorizationRequests = store.authorizationRequests.filter((item) => item.expiresAt > this.now());
                if (store.authorizationRequests.length >= MAX_PENDING_ITEMS) {
                    throw new OAuthError('temporarily_unavailable', 'Hay demasiadas autorizaciones pendientes.', 503);
                }
                store.authorizationRequests.push({
                    ...request,
                    requestId: created.requestId,
                    transaction: encrypt(transactionId, key, transactionContext(created.requestId, request.clientId, request.resource, request.scope)),
                    clientName,
                    expiresAt
                });
                return true;
            });
            res.writeHead(302, { ...securityHeaders('text/plain; charset=utf-8'), location: created.authorizationUrl });
            res.end('Redirigiendo a Lumbre.');
        }
        catch (error) {
            oauthError(res, error);
        }
        finally {
            release?.();
        }
    }
    async handleLumbreCallback(req, res, url) {
        let release;
        try {
            release = this.enterPublicEndpoint(req, 'authorize');
            if (req.method !== 'GET')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            const requestId = one(url.searchParams, 'request');
            const decision = one(url.searchParams, 'decision');
            if (!requestId || !isValidRequestId(requestId) || (decision !== 'approved' && decision !== 'denied')) {
                throw new OAuthError('invalid_request', 'Callback de Lumbre inválido.');
            }
            let pending;
            await this.mutateStore((store) => {
                const found = store.authorizationRequests.find((item) => item.requestId === requestId);
                if (!found)
                    return false;
                pending = found;
                store.authorizationRequests = store.authorizationRequests.filter((item) => item.requestId !== requestId);
                return true;
            });
            if (!pending || pending.expiresAt <= this.now()) {
                throw new OAuthError('invalid_request', 'La autorización ha caducado, ya fue usada o no existe.');
            }
            const authorized = pending;
            if (decision === 'denied') {
                this.redirectToClient(res, authorized, { error: 'access_denied' });
                return;
            }
            let credential;
            try {
                const transactionId = decrypt(authorized.transaction, await this.key(), transactionContext(authorized.requestId, authorized.clientId, authorized.resource, authorized.scope));
                credential = await this.backchannel.exchange(requestId, transactionId);
            }
            catch (error) {
                throw this.backchannelOAuthError(error, 'invalid_grant');
            }
            if (credential.resource !== authorized.resource || credential.scope !== authorized.scope) {
                await this.persistCredentialRevocation(credential, authorized);
                throw new OAuthError('server_error', 'Lumbre devolvió una credencial fuera de contrato.', 502);
            }
            const code = opaque('lm_code_');
            const key = await this.key();
            try {
                await this.mutateStore((store) => {
                    store.authorizationCodes = store.authorizationCodes.filter((item) => item.expiresAt > this.now());
                    if (store.authorizationCodes.length >= MAX_PENDING_ITEMS) {
                        throw new OAuthError('temporarily_unavailable', 'Hay demasiados códigos pendientes.', 503);
                    }
                    store.authorizationCodes.push({
                        clientId: authorized.clientId,
                        redirectUri: authorized.redirectUri,
                        scope: authorized.scope,
                        resource: authorized.resource,
                        challenge: authorized.challenge,
                        state: authorized.state,
                        codeHash: digest(code),
                        upstream: encrypt(credential.accessToken, key, grantContext(authorized.clientId, authorized.resource, authorized.scope)),
                        credentialId: credential.credentialId,
                        expiresAt: this.now() + CODE_TTL_MS
                    });
                    return true;
                });
            }
            catch (error) {
                try {
                    await this.persistCredentialRevocation(credential, authorized);
                }
                catch {
                    // Si el propio store no puede persistir la compensación, solo queda
                    // el revoke directo idempotente. Nunca se incluye el token en el error.
                    await this.backchannel.revoke(credential.accessToken).catch(() => undefined);
                }
                throw error;
            }
            this.redirectToClient(res, authorized, { code });
        }
        catch (error) {
            oauthError(res, error);
        }
        finally {
            release?.();
        }
    }
    redirectToClient(res, request, result) {
        const redirect = new URL(request.redirectUri);
        if ('code' in result)
            redirect.searchParams.set('code', result.code);
        else
            redirect.searchParams.set('error', result.error);
        if (request.state !== undefined)
            redirect.searchParams.set('state', request.state);
        redirect.searchParams.set('iss', OAUTH_ISSUER);
        res.writeHead(302, { ...securityHeaders('text/plain; charset=utf-8'), location: redirect.toString() });
        res.end('Redirigiendo a Claude.');
    }
    backchannelOAuthError(error, invalidCode = 'server_error') {
        if (error instanceof BackchannelError && error.kind === 'transient') {
            return new OAuthError('temporarily_unavailable', 'Lumbre no está disponible temporalmente.', 503);
        }
        return new OAuthError(invalidCode, 'Lumbre rechazó o devolvió una respuesta fuera de contrato.', invalidCode === 'temporarily_unavailable' ? 503 : 502);
    }
    async handleToken(req, res) {
        let release;
        try {
            release = this.enterPublicEndpoint(req, 'token');
            if (req.method !== 'POST')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            const form = await readForm(req);
            const grantType = one(form, 'grant_type');
            if (grantType === 'authorization_code')
                await this.exchangeCode(form, res);
            else if (grantType === 'refresh_token')
                await this.exchangeRefresh(form, res);
            else
                throw new OAuthError('unsupported_grant_type', 'grant_type no admitido.');
        }
        catch (error) {
            oauthError(res, error);
        }
        finally {
            release?.();
        }
    }
    async exchangeCode(form, res) {
        const codeValue = one(form, 'code');
        const clientId = one(form, 'client_id');
        const redirectUri = one(form, 'redirect_uri');
        const verifier = one(form, 'code_verifier');
        const resource = one(form, 'resource');
        const codeHash = digest(codeValue);
        const code = (await this.loadStore()).authorizationCodes.find((item) => item.codeHash === codeHash);
        if (!code)
            throw new OAuthError('invalid_grant', 'Código inválido, usado o caducado.');
        if (code.expiresAt <= this.now()) {
            await this.retireAuthorizationCode(codeHash);
            throw new OAuthError('invalid_grant', 'Código inválido, usado o caducado.');
        }
        if (clientId !== code.clientId || redirectUri !== code.redirectUri || resource !== code.resource) {
            throw new OAuthError('invalid_grant', 'El código no pertenece a esta solicitud.');
        }
        if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
            throw new OAuthError('invalid_grant', 'code_verifier inválido.');
        }
        const actual = createHash('sha256').update(verifier, 'ascii').digest('base64url');
        if (!equalText(actual, code.challenge)) {
            throw new OAuthError('invalid_grant', 'PKCE no coincide.');
        }
        const upstreamToken = decrypt(code.upstream, await this.key(), grantContext(code.clientId, code.resource, code.scope));
        const active = await this.introspectCredential(code, upstreamToken);
        if (!active) {
            await this.retireAuthorizationCode(codeHash);
            throw new OAuthError('invalid_grant', 'La autorización de Lumbre ya no está activa.');
        }
        await this.issueGrant(code, codeHash, res);
    }
    async retireAuthorizationCode(codeHash) {
        let credentialId;
        await this.mutateStore((store) => {
            const code = store.authorizationCodes.find((item) => item.codeHash === codeHash);
            if (!code)
                return false;
            credentialId = code.credentialId;
            if (!store.revocationOutbox.some((item) => item.credentialId === code.credentialId)) {
                store.revocationOutbox.push({
                    provider: 'lumbre-web',
                    credentialId: code.credentialId,
                    clientId: code.clientId,
                    resource: code.resource,
                    scope: code.scope,
                    upstream: code.upstream
                });
            }
            store.authorizationCodes = store.authorizationCodes.filter((item) => item.codeHash !== codeHash);
            return true;
        });
        if (credentialId)
            await this.flushRevocationOutbox(credentialId);
    }
    async introspectCredential(credential, upstreamToken) {
        let result;
        try {
            result = await this.backchannel.introspect(upstreamToken);
        }
        catch (error) {
            throw this.backchannelOAuthError(error, 'temporarily_unavailable');
        }
        if (!result.active)
            return false;
        if (result.credentialId !== credential.credentialId ||
            result.clientId !== credential.clientId ||
            result.resource !== credential.resource ||
            result.scope !== credential.scope) {
            return false;
        }
        return true;
    }
    async issueGrant(code, codeHash, res) {
        const accessToken = opaque(ACCESS_PREFIX);
        const refreshToken = opaque(REFRESH_PREFIX);
        const familyId = randomBytes(16).toString('base64url');
        const now = this.now();
        const familyExpiresAt = now + REFRESH_TTL_MS;
        let issued = false;
        await this.mutateStore((store) => {
            const storedCode = store.authorizationCodes.find((item) => item.codeHash === codeHash && item.credentialId === code.credentialId && item.expiresAt > now);
            if (!storedCode)
                return false;
            store.authorizationCodes = store.authorizationCodes.filter((item) => item.codeHash !== codeHash);
            store.grants.push({
                provider: 'lumbre-web',
                credentialId: code.credentialId,
                familyId,
                familyExpiresAt,
                clientId: code.clientId,
                resource: code.resource,
                scope: code.scope,
                accessHash: digest(accessToken),
                accessExpiresAt: now + ACCESS_TTL_MS,
                refreshHash: digest(refreshToken),
                refreshExpiresAt: familyExpiresAt,
                upstream: code.upstream
            });
            issued = true;
            return true;
        });
        if (!issued)
            throw new OAuthError('invalid_grant', 'Código inválido, usado o caducado.');
        json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refreshToken, scope: code.scope });
    }
    async exchangeRefresh(form, res) {
        const refreshToken = one(form, 'refresh_token');
        const clientId = one(form, 'client_id');
        const resource = one(form, 'resource');
        const requestedScope = one(form, 'scope', false);
        const oldHash = digest(refreshToken);
        const accessToken = opaque(ACCESS_PREFIX);
        const nextRefresh = opaque(REFRESH_PREFIX);
        const now = this.now();
        const snapshot = await this.loadStore();
        const usedSnapshot = snapshot.usedRefreshTokens.find((item) => item.hash === oldHash && item.expiresAt > now);
        const grantSnapshot = usedSnapshot
            ? snapshot.grants.find((item) => item.familyId === usedSnapshot.familyId)
            : snapshot.grants.find((item) => item.refreshHash === oldHash);
        if (!grantSnapshot ||
            grantSnapshot.provider !== 'lumbre-web' ||
            !isValidRequestId(grantSnapshot.credentialId) ||
            grantSnapshot.clientId !== clientId ||
            grantSnapshot.resource !== resource ||
            (requestedScope !== undefined && requestedScope !== grantSnapshot.scope)) {
            throw new OAuthError('invalid_grant', 'Refresh token inválido, usado o caducado.');
        }
        const upstreamToken = decrypt(grantSnapshot.upstream, await this.key(), grantContext(grantSnapshot.clientId, grantSnapshot.resource, grantSnapshot.scope));
        if (usedSnapshot) {
            await this.revokeFamily(grantSnapshot.familyId, grantSnapshot.credentialId);
            throw new OAuthError('invalid_grant', 'Refresh token inválido, usado o caducado.');
        }
        const active = await this.introspectCredential(grantSnapshot, upstreamToken);
        if (!active) {
            await this.revokeFamily(grantSnapshot.familyId, grantSnapshot.credentialId);
            throw new OAuthError('invalid_grant', 'La credencial de Lumbre ya no está activa.');
        }
        const result = { outcome: 'invalid' };
        await this.mutateStore((store) => {
            const used = store.usedRefreshTokens.find((item) => item.hash === oldHash && item.expiresAt > now);
            if (used) {
                const familyGrant = store.grants.find((item) => item.familyId === used.familyId);
                if (!familyGrant ||
                    familyGrant.clientId !== clientId ||
                    familyGrant.resource !== resource ||
                    (requestedScope !== undefined && requestedScope !== familyGrant.scope)) {
                    return false;
                }
                result.outcome = 'replayed';
                this.enqueueFamilyRevocation(store, familyGrant);
                return true;
            }
            const grant = store.grants.find((item) => item.refreshHash === oldHash);
            if (!grant ||
                grant.familyId !== grantSnapshot.familyId ||
                grant.credentialId !== grantSnapshot.credentialId ||
                grant.refreshExpiresAt <= now ||
                grant.clientId !== clientId ||
                grant.resource !== resource ||
                (requestedScope !== undefined && requestedScope !== grant.scope)) {
                return false;
            }
            const nextRefreshExpiresAt = grant.familyExpiresAt;
            if (!this.addRefreshTombstone(store, oldHash, grant.familyId, nextRefreshExpiresAt)) {
                // Al alcanzar cualquier límite, la opción segura y siempre disponible
                // es revocar la familia. Nunca se bloquea una eliminación por intentar
                // conservar otra tombstone.
                result.outcome = 'replayed';
                this.enqueueFamilyRevocation(store, grant);
                return true;
            }
            result.outcome = 'rotated';
            grant.accessHash = digest(accessToken);
            grant.accessExpiresAt = now + ACCESS_TTL_MS;
            grant.refreshHash = digest(nextRefresh);
            grant.refreshExpiresAt = nextRefreshExpiresAt;
            return true;
        });
        if (result.outcome !== 'rotated') {
            if (result.outcome === 'replayed')
                await this.flushRevocationOutbox(grantSnapshot.credentialId);
            throw new OAuthError('invalid_grant', 'Refresh token inválido, usado o caducado.');
        }
        json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: nextRefresh, scope: OAUTH_SCOPE });
    }
    addRefreshTombstone(store, hash, familyId, expiresAt) {
        if (store.usedRefreshTokens.some((item) => item.hash === hash))
            return true;
        const familyCount = store.usedRefreshTokens.filter((item) => item.familyId === familyId).length;
        if (familyCount >= MAX_REFRESH_TOMBSTONES_PER_FAMILY || store.usedRefreshTokens.length >= MAX_REFRESH_TOMBSTONES) {
            return false;
        }
        store.usedRefreshTokens.push({ hash, familyId, expiresAt });
        return true;
    }
    removeFamily(store, familyId) {
        store.grants = store.grants.filter((grant) => grant.familyId !== familyId);
        store.usedRefreshTokens = store.usedRefreshTokens.filter((item) => item.familyId !== familyId);
    }
    enqueueFamilyRevocation(store, grant) {
        if (!store.revocationOutbox.some((item) => item.credentialId === grant.credentialId)) {
            store.revocationOutbox.push({
                provider: 'lumbre-web',
                credentialId: grant.credentialId,
                clientId: grant.clientId,
                resource: grant.resource,
                scope: grant.scope,
                upstream: grant.upstream
            });
        }
        this.removeFamily(store, grant.familyId);
    }
    async persistCredentialRevocation(credential, context) {
        const key = await this.key();
        await this.mutateStore((store) => {
            if (store.revocationOutbox.some((item) => item.credentialId === credential.credentialId))
                return false;
            store.revocationOutbox.push({
                provider: 'lumbre-web',
                credentialId: credential.credentialId,
                clientId: context.clientId,
                resource: context.resource,
                scope: context.scope,
                upstream: encrypt(credential.accessToken, key, grantContext(context.clientId, context.resource, context.scope))
            });
            return true;
        });
        await this.flushRevocationOutbox(credential.credentialId);
    }
    async revokeFamily(familyId, credentialId) {
        await this.mutateStore((store) => {
            const grant = store.grants.find((item) => item.familyId === familyId && item.credentialId === credentialId);
            if (!grant)
                return false;
            this.enqueueFamilyRevocation(store, grant);
            return true;
        });
        await this.flushRevocationOutbox(credentialId);
    }
    async flushRevocationOutbox(onlyCredentialId) {
        const store = await this.loadStore();
        const items = onlyCredentialId
            ? store.revocationOutbox.filter((item) => item.credentialId === onlyCredentialId)
            : store.revocationOutbox.slice(0, MAX_OUTBOX_RETRIES_PER_READINESS);
        for (const item of items) {
            let upstreamToken;
            try {
                upstreamToken = decrypt(item.upstream, await this.key(), grantContext(item.clientId, item.resource, item.scope));
                await this.backchannel.revoke(upstreamToken);
            }
            catch {
                continue;
            }
            await this.mutateStore((current) => {
                const before = current.revocationOutbox.length;
                current.revocationOutbox = current.revocationOutbox.filter((candidate) => candidate.credentialId !== item.credentialId);
                return current.revocationOutbox.length !== before;
            });
        }
    }
    async handleRevoke(req, res) {
        let release;
        try {
            release = this.enterPublicEndpoint(req, 'revoke');
            if (req.method !== 'POST')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            const form = await readForm(req);
            const token = one(form, 'token');
            const clientId = one(form, 'client_id');
            const hash = digest(token);
            let credentialId;
            await this.mutateStore((store) => {
                let familyId = store.grants.find((grant) => grant.provider === 'lumbre-web' && grant.clientId === clientId && (grant.accessHash === hash || grant.refreshHash === hash))?.familyId;
                familyId ??= store.usedRefreshTokens.find((item) => item.hash === hash)?.familyId;
                if (!familyId)
                    return false;
                const familyGrant = store.grants.find((grant) => grant.provider === 'lumbre-web' && grant.familyId === familyId && grant.clientId === clientId);
                if (!familyGrant)
                    return false;
                credentialId = familyGrant.credentialId;
                this.enqueueFamilyRevocation(store, familyGrant);
                return true;
            });
            if (credentialId)
                await this.flushRevocationOutbox(credentialId);
            json(res, 200, {});
        }
        catch (error) {
            oauthError(res, error);
        }
        finally {
            release?.();
        }
    }
    async resolveAccessToken(token) {
        if (!token.startsWith(ACCESS_PREFIX))
            return undefined;
        try {
            const hash = digest(token);
            const now = this.now();
            const store = await this.loadStore();
            const grant = store.grants.find((item) => item.accessHash === hash);
            if (!grant ||
                grant.provider !== 'lumbre-web' ||
                !isValidRequestId(grant.credentialId) ||
                grant.accessExpiresAt <= now ||
                grant.resource !== OAUTH_RESOURCE ||
                grant.scope !== OAUTH_SCOPE)
                return undefined;
            validateClientIdUrl(grant.clientId);
            return decrypt(grant.upstream, await this.key(), grantContext(grant.clientId, grant.resource, grant.scope));
        }
        catch {
            return undefined;
        }
    }
    isOAuthAccessToken(token) {
        return token.startsWith(ACCESS_PREFIX);
    }
    async ensureReady() {
        this.backchannel.ensureConfigured();
        if (!this.suppliedEncryptionKey && !(await pathExists(join(this.stateDir, 'oauth.key')))) {
            if (await pathExists(this.storePath()))
                throw new Error('store OAuth presente sin su clave');
        }
        const key = await this.key();
        const store = await this.loadStore();
        for (const grant of store.grants) {
            validateClientIdUrl(grant.clientId);
            if (grant.provider !== 'lumbre-web' ||
                !isValidRequestId(grant.credentialId) ||
                grant.resource !== OAUTH_RESOURCE ||
                grant.scope !== OAUTH_SCOPE) {
                throw new Error('grant OAuth fuera de contrato');
            }
            const upstream = decrypt(grant.upstream, key, grantContext(grant.clientId, grant.resource, grant.scope));
            if (!/^[a-f0-9]{64}$/.test(upstream))
                throw new Error('credencial upstream inválida');
        }
        for (const pending of store.authorizationRequests) {
            validateClientIdUrl(pending.clientId);
            const transactionId = decrypt(pending.transaction, key, transactionContext(pending.requestId, pending.clientId, pending.resource, pending.scope));
            if (!/^[A-Za-z0-9_-]{32,256}$/.test(transactionId))
                throw new Error('transacción OAuth inválida');
        }
        for (const code of store.authorizationCodes) {
            validateClientIdUrl(code.clientId);
            const upstream = decrypt(code.upstream, key, grantContext(code.clientId, code.resource, code.scope));
            if (!/^[a-f0-9]{64}$/.test(upstream))
                throw new Error('credencial upstream inválida');
        }
        for (const item of store.revocationOutbox) {
            const upstream = decrypt(item.upstream, key, grantContext(item.clientId, item.resource, item.scope));
            if (!/^[a-f0-9]{64}$/.test(upstream))
                throw new Error('outbox OAuth inválida');
        }
        if (await pathExists(this.storePath()))
            await chmod(this.storePath(), 0o600);
        // Ejecuta también al arrancar la poda segura: grants/códigos caducados
        // pasan al outbox antes de intentar la revocación upstream.
        await this.mutateStore(() => false);
        await this.flushRevocationOutbox();
    }
    async checkReady() {
        const cached = this.readinessCache;
        if (cached && cached.expiresAt > this.now()) {
            if (cached.error)
                throw cached.error;
            return;
        }
        if (this.readinessInFlight)
            return await this.readinessInFlight;
        const pending = this.ensureReady().then(() => {
            this.readinessCache = { expiresAt: this.now() + READINESS_CACHE_MS };
        }, (error) => {
            this.readinessCache = { expiresAt: this.now() + READINESS_CACHE_MS, error };
            throw error;
        });
        this.readinessInFlight = pending;
        try {
            await pending;
        }
        finally {
            if (this.readinessInFlight === pending)
                this.readinessInFlight = undefined;
        }
    }
    async key() {
        if (this.encryptionKey)
            return this.encryptionKey;
        this.keyPromise ??= this.loadOrCreateKey();
        return await this.keyPromise;
    }
    async loadOrCreateKey() {
        await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
        await chmod(this.stateDir, 0o700);
        const keyPath = join(this.stateDir, 'oauth.key');
        try {
            const encoded = (await readFile(keyPath, 'utf8')).trim();
            const key = Buffer.from(encoded, 'base64url');
            if (key.length !== 32)
                throw new Error('clave inválida');
            await chmod(keyPath, 0o600);
            this.encryptionKey = key;
            return key;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        if (await pathExists(this.storePath()))
            throw new Error('store OAuth presente sin su clave');
        const key = randomBytes(32);
        const handle = await open(keyPath, 'wx', 0o600).catch(async (error) => {
            if (error.code !== 'EEXIST')
                throw error;
            return undefined;
        });
        if (handle) {
            try {
                await handle.writeFile(key.toString('base64url'), 'utf8');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await syncDirectory(this.stateDir);
            this.encryptionKey = key;
        }
        else {
            this.encryptionKey = Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64url');
        }
        if (!this.encryptionKey || this.encryptionKey.length !== 32)
            throw new Error('clave OAuth inválida');
        return this.encryptionKey;
    }
    storePath() {
        return join(this.stateDir, 'oauth-store.json');
    }
    async loadStore() {
        try {
            return normalizeStore(JSON.parse(await readFile(this.storePath(), 'utf8')));
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return {
                    version: 3,
                    grants: [],
                    usedRefreshTokens: [],
                    authorizationRequests: [],
                    authorizationCodes: [],
                    revocationOutbox: []
                };
            }
            throw error;
        }
    }
    async mutateStore(mutator) {
        let failure;
        let changed = false;
        this.writeQueue = this.writeQueue.then(async () => {
            try {
                const store = await this.loadStore();
                const now = this.now();
                let housekeeping = false;
                const expiredGrants = store.grants.filter((grant) => grant.refreshExpiresAt <= now);
                for (const grant of expiredGrants) {
                    this.enqueueFamilyRevocation(store, grant);
                    housekeeping = true;
                }
                const expiredCodes = store.authorizationCodes.filter((code) => code.expiresAt <= now);
                for (const code of expiredCodes) {
                    if (!store.revocationOutbox.some((item) => item.credentialId === code.credentialId)) {
                        store.revocationOutbox.push({
                            provider: 'lumbre-web', credentialId: code.credentialId, clientId: code.clientId,
                            resource: code.resource, scope: code.scope, upstream: code.upstream
                        });
                    }
                    housekeeping = true;
                }
                if (expiredCodes.length > 0) {
                    const expiredHashes = new Set(expiredCodes.map((code) => code.codeHash));
                    store.authorizationCodes = store.authorizationCodes.filter((code) => !expiredHashes.has(code.codeHash));
                }
                const usedBefore = store.usedRefreshTokens.length;
                store.usedRefreshTokens = store.usedRefreshTokens.filter((item) => item.expiresAt > now);
                const requestsBefore = store.authorizationRequests.length;
                store.authorizationRequests = store.authorizationRequests.filter((item) => item.expiresAt > now);
                housekeeping ||= usedBefore !== store.usedRefreshTokens.length || requestsBefore !== store.authorizationRequests.length;
                changed = mutator(store) || housekeeping;
                if (!changed)
                    return;
                // No serializamos nunca un estado intermedio incoherente aunque el
                // proveedor reutilice por error un credentialId o haya una colisión.
                normalizeStore(store);
                await mkdir(dirname(this.storePath()), { recursive: true, mode: 0o700 });
                const temp = `${this.storePath()}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
                let handle;
                try {
                    handle = await open(temp, 'wx', 0o600);
                    await handle.writeFile(JSON.stringify(store), 'utf8');
                    await handle.sync();
                    await this.persistenceStep?.('temporary-file-synced');
                    await handle.close();
                    handle = undefined;
                    await rename(temp, this.storePath());
                    await this.persistenceStep?.('store-renamed');
                    await syncDirectory(dirname(this.storePath()));
                    await this.persistenceStep?.('state-directory-synced');
                }
                finally {
                    await handle?.close().catch(() => undefined);
                    await unlink(temp).catch(() => undefined);
                }
            }
            catch (error) {
                failure = error;
            }
        });
        await this.writeQueue;
        if (failure)
            throw failure;
        return changed;
    }
}
export function createOAuthService(options = {}) {
    return new OAuthService(options);
}
//# sourceMappingURL=oauth.js.map