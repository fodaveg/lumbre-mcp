import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
function html(value) {
    return value.replace(/[&<>"']/g, (char) => {
        const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return entities[char] ?? char;
    });
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
        url.hostname !== 'claude.ai' ||
        (url.port !== '' && url.port !== '443') ||
        url.pathname === '/' ||
        url.search !== '' ||
        hasDotSegment ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== '') {
        throw new OAuthError('invalid_client', 'Este conector solo admite documentos de cliente de claude.ai.');
    }
    return url;
}
function grantContext(clientId, resource, scope) {
    return Buffer.from(JSON.stringify([clientId, resource, scope]), 'utf8');
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
    if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.grants)) {
        throw new Error('store OAuth inválido');
    }
    const grants = raw.grants.map((value, index) => {
        if (!value || typeof value !== 'object')
            throw new Error('grant OAuth inválido');
        const grant = value;
        if (typeof grant.clientId !== 'string' ||
            typeof grant.resource !== 'string' ||
            typeof grant.scope !== 'string' ||
            typeof grant.accessHash !== 'string' ||
            !Number.isFinite(grant.accessExpiresAt) ||
            typeof grant.refreshHash !== 'string' ||
            !Number.isFinite(grant.refreshExpiresAt) ||
            !validEncryptedValue(grant.upstream)) {
            throw new Error('grant OAuth inválido');
        }
        const familyId = raw.version === 2 && typeof grant.familyId === 'string'
            ? grant.familyId
            : digest(`familia:${index}:${grant.accessHash}:${grant.refreshHash}`);
        const familyExpiresAt = typeof grant.familyExpiresAt === 'number' && Number.isFinite(grant.familyExpiresAt)
            ? grant.familyExpiresAt
            : grant.refreshExpiresAt;
        return { ...grant, familyId, familyExpiresAt };
    });
    const usedRefreshTokens = raw.version === 2 && Array.isArray(raw.usedRefreshTokens)
        ? raw.usedRefreshTokens.map((value) => {
            if (!value || typeof value !== 'object')
                throw new Error('tombstone OAuth inválido');
            const item = value;
            if (typeof item.hash !== 'string' ||
                typeof item.familyId !== 'string' ||
                !Number.isFinite(item.expiresAt)) {
                throw new Error('tombstone OAuth inválido');
            }
            return item;
        })
        : [];
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
    return {
        version: 2,
        grants: grants.filter((grant) => !overflowFamilies.has(grant.familyId)),
        usedRefreshTokens: usedRefreshTokens.filter((item) => !overflowFamilies.has(item.familyId))
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
    encryptionKey;
    keyPromise;
    transactions = new Map();
    codes = new Map();
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
            !candidate.redirect_uris.every((redirect) => typeof redirect === 'string') ||
            !candidate.redirect_uris.includes(OAUTH_CALLBACK) ||
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
        if (redirectUri !== OAUTH_CALLBACK)
            throw new OAuthError('invalid_request', 'redirect_uri no registrado.');
        if (scope !== OAUTH_SCOPE)
            throw new OAuthError('invalid_scope', `El scope debe ser ${OAUTH_SCOPE}.`);
        if (resource !== OAUTH_RESOURCE)
            throw new OAuthError('invalid_target', `El resource debe ser ${OAUTH_RESOURCE}.`);
        if (method !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
            throw new OAuthError('invalid_request', 'Se requiere PKCE S256 válido.');
        }
        if (state !== undefined && state.length > 1024)
            throw new OAuthError('invalid_request', 'state demasiado largo.');
        return { clientId: clientId, redirectUri, scope, resource, challenge, state };
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
    async handleAuthorize(req, res, url, upstreamBaseUrl) {
        let release;
        try {
            release = this.enterPublicEndpoint(req, 'authorize');
            if (req.method === 'GET') {
                this.prunePending();
                const request = this.authorizationRequest(url.searchParams);
                const metadata = await this.clientMetadata(request.clientId);
                const transaction = opaque('tx_');
                this.transactions.set(transaction, {
                    ...request,
                    expiresAt: this.now() + TRANSACTION_TTL_MS,
                    clientName: metadata.client_name?.slice(0, 120) || 'Claude'
                });
                res.writeHead(200, securityHeaders('text/html; charset=utf-8'));
                res.end(`<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Autorizar Lumbre</title>
<style>body{font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#242424}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.75rem;margin-top:.5rem}button{margin-top:1rem}small{color:#666}</style>
<h1>Autorizar Lumbre</h1>
<p><strong>${html(metadata.client_name?.slice(0, 120) || 'Claude')}</strong> solicita acceso a tus tareas con el permiso <code>${OAUTH_SCOPE}</code>.</p>
<p><small>Cliente verificado: <strong>claude.ai</strong> · ${html(request.clientId)}</small></p>
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="transaction" value="${html(transaction)}">
<label>Token de Lumbre<input type="password" name="lumbre_token" required autocomplete="off" maxlength="512"></label>
<small>Se valida una vez por HTTPS. No se incluye en la URL y se guarda cifrado para renovar el acceso.</small>
<button type="submit">Autorizar</button>
</form>
</html>`);
                return;
            }
            if (req.method !== 'POST')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            const form = await readForm(req);
            const transactionId = one(form, 'transaction');
            const upstreamToken = one(form, 'lumbre_token');
            const transaction = this.transactions.get(transactionId);
            this.transactions.delete(transactionId);
            if (!transaction || transaction.expiresAt <= this.now())
                throw new OAuthError('invalid_request', 'La autorización ha caducado; vuelve a iniciarla.');
            if (!upstreamToken || upstreamToken.length > 512)
                throw new OAuthError('access_denied', 'Token de Lumbre inválido.');
            await this.validateUpstreamToken(upstreamBaseUrl, upstreamToken);
            this.prunePending();
            const code = opaque('lm_code_');
            this.codes.set(code, { ...transaction, upstreamToken, expiresAt: this.now() + CODE_TTL_MS });
            const redirect = new URL(transaction.redirectUri);
            redirect.searchParams.set('code', code);
            if (transaction.state !== undefined)
                redirect.searchParams.set('state', transaction.state);
            redirect.searchParams.set('iss', OAUTH_ISSUER);
            res.writeHead(302, { ...securityHeaders('text/plain; charset=utf-8'), location: redirect.toString() });
            res.end('Redirigiendo a Claude.');
        }
        catch (error) {
            oauthError(res, error);
        }
        finally {
            release?.();
        }
    }
    async validateUpstreamToken(baseUrl, token) {
        let response;
        try {
            response = await this.fetchFn(`${baseUrl.replace(/\/$/, '')}/api/tasks?scope=today&notes=none`, {
                headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
                redirect: 'error',
                signal: AbortSignal.timeout(10_000)
            });
        }
        catch {
            throw new OAuthError('temporarily_unavailable', 'No se pudo validar el token con Lumbre.', 503);
        }
        const status = response.status;
        await response.body?.cancel().catch(() => undefined);
        if (status === 401 || status === 403)
            throw new OAuthError('access_denied', 'El token de Lumbre no es válido.', 401);
        if (status < 200 || status >= 300)
            throw new OAuthError('temporarily_unavailable', 'Lumbre no pudo validar el token.', 503);
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
        const code = this.codes.get(codeValue);
        this.codes.delete(codeValue);
        if (!code || code.expiresAt <= this.now())
            throw new OAuthError('invalid_grant', 'Código inválido, usado o caducado.');
        if (clientId !== code.clientId || redirectUri !== code.redirectUri || resource !== code.resource) {
            throw new OAuthError('invalid_grant', 'El código no pertenece a esta solicitud.');
        }
        if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
            throw new OAuthError('invalid_grant', 'code_verifier inválido.');
        const actual = createHash('sha256').update(verifier, 'ascii').digest('base64url');
        if (!equalText(actual, code.challenge))
            throw new OAuthError('invalid_grant', 'PKCE no coincide.');
        await this.issueGrant(code, res);
    }
    async issueGrant(code, res) {
        const accessToken = opaque(ACCESS_PREFIX);
        const refreshToken = opaque(REFRESH_PREFIX);
        const familyId = randomBytes(16).toString('base64url');
        const now = this.now();
        const familyExpiresAt = now + REFRESH_TTL_MS;
        const key = await this.key();
        await this.mutateStore((store) => {
            store.grants.push({
                familyId,
                familyExpiresAt,
                clientId: code.clientId,
                resource: code.resource,
                scope: code.scope,
                accessHash: digest(accessToken),
                accessExpiresAt: now + ACCESS_TTL_MS,
                refreshHash: digest(refreshToken),
                refreshExpiresAt: familyExpiresAt,
                upstream: encrypt(code.upstreamToken, key, grantContext(code.clientId, code.resource, code.scope))
            });
            return true;
        });
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
                this.removeFamily(store, used.familyId);
                return true;
            }
            const grant = store.grants.find((item) => item.refreshHash === oldHash);
            if (!grant ||
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
                this.removeFamily(store, grant.familyId);
                return true;
            }
            result.outcome = 'rotated';
            grant.accessHash = digest(accessToken);
            grant.accessExpiresAt = now + ACCESS_TTL_MS;
            grant.refreshHash = digest(nextRefresh);
            grant.refreshExpiresAt = nextRefreshExpiresAt;
            return true;
        });
        if (result.outcome !== 'rotated')
            throw new OAuthError('invalid_grant', 'Refresh token inválido, usado o caducado.');
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
            await this.mutateStore((store) => {
                let familyId = store.grants.find((grant) => grant.clientId === clientId && (grant.accessHash === hash || grant.refreshHash === hash))?.familyId;
                familyId ??= store.usedRefreshTokens.find((item) => item.hash === hash)?.familyId;
                if (!familyId)
                    return false;
                const familyGrant = store.grants.find((grant) => grant.familyId === familyId && grant.clientId === clientId);
                if (!familyGrant)
                    return false;
                this.removeFamily(store, familyId);
                return true;
            });
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
            if (!grant || grant.accessExpiresAt <= now || grant.resource !== OAUTH_RESOURCE || grant.scope !== OAUTH_SCOPE)
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
        if (!this.suppliedEncryptionKey && !(await pathExists(join(this.stateDir, 'oauth.key')))) {
            if (await pathExists(this.storePath()))
                throw new Error('store OAuth presente sin su clave');
        }
        const key = await this.key();
        const store = await this.loadStore();
        for (const grant of store.grants) {
            validateClientIdUrl(grant.clientId);
            if (grant.resource !== OAUTH_RESOURCE || grant.scope !== OAUTH_SCOPE) {
                throw new Error('grant OAuth fuera de contrato');
            }
            const upstream = decrypt(grant.upstream, key, grantContext(grant.clientId, grant.resource, grant.scope));
            if (upstream.length === 0 || upstream.length > 512)
                throw new Error('credencial upstream inválida');
        }
        if (await pathExists(this.storePath()))
            await chmod(this.storePath(), 0o600);
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
    prunePending() {
        const now = this.now();
        for (const [id, transaction] of this.transactions) {
            if (transaction.expiresAt <= now)
                this.transactions.delete(id);
        }
        for (const [id, code] of this.codes) {
            if (code.expiresAt <= now)
                this.codes.delete(id);
        }
        while (this.transactions.size >= MAX_PENDING_ITEMS)
            this.transactions.delete(this.transactions.keys().next().value);
        while (this.codes.size >= MAX_PENDING_ITEMS)
            this.codes.delete(this.codes.keys().next().value);
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
                return { version: 2, grants: [], usedRefreshTokens: [] };
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
                store.usedRefreshTokens = store.usedRefreshTokens.filter((item) => item.expiresAt > now);
                changed = mutator(store);
                if (!changed)
                    return;
                store.grants = store.grants.filter((grant) => grant.refreshExpiresAt > now);
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