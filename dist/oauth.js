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
/**
 * Tope de la outbox de revocación y caducidad de cada elemento.
 *
 * Un elemento = una credencial upstream que este relé todavía no ha
 * conseguido revocar en Lumbre. Sin tope ni caducidad crecía para siempre:
 * basta con que `backchannel.revoke` falle (Lumbre caída, secreto rotado a
 * medias) para que el elemento se quede ahí, y cada arranque los descifra
 * todos (`ensureReady`).
 *
 * 256 elementos: el uso real son 1-3 cuentas y una credencial por
 * autorización, así que cualquier backlog legítimo se cuenta con los dedos;
 * 256 es dos órdenes de magnitud por encima y acota el fichero (~100 KB).
 * 30 días: la misma vigencia absoluta que una familia de refresh
 * (`REFRESH_TTL_MS`). Pasado ese plazo ya no queda ningún grant local que
 * pueda usar esa credencial, y seguir intentando revocarla eternamente no
 * arregla nada que no arregle ya Lumbre.
 *
 * QUÉ SE DESCARTA Y POR QUÉ ES SEGURO — descartar un elemento significa que
 * esa credencial upstream NO se revoca desde aquí. Es aceptable porque:
 *   1. el grant local ya no existe (se retiró al encolar la revocación), así
 *      que ESTE relé no puede usar la credencial ni la sirve a nadie;
 *   2. la credencial es del backchannel de Lumbre, que la puede caducar o
 *      revocar desde la sesión web de la persona — no queda fuera de control,
 *      queda fuera de NUESTRO control;
 *   3. lo contrario (crecer sin límite) convierte un fallo transitorio de
 *      Lumbre en un fichero de estado que ya no arranca.
 * No es gratis, así que no se hace en silencio: se escribe una línea en
 * stderr con el número descartado y el motivo, SIN credenciales ni
 * credentialIds. Deliberadamente NO se marca degradación en `/readyz`: esa
 * sonda es el healthcheck del contenedor (`deploy/compose.yml`), y un 503 ahí
 * lo reinicia — tumbar el servicio entero por una revocación vieja que ya no
 * afecta a ningún grant vivo sería un remedio peor que la enfermedad.
 */
const MAX_REVOCATION_OUTBOX_ITEMS = 256;
const REVOCATION_OUTBOX_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_PUBLIC_LIMITS = {
    authorize: { requestsPerMinute: 30, concurrent: 8 },
    token: { requestsPerMinute: 60, concurrent: 16 },
    revoke: { requestsPerMinute: 60, concurrent: 16 }
};
/**
 * Presupuesto de `/authorize` MÁS ALLÁ del límite por IP de
 * `enterPublicEndpoint`. Cada `/authorize` válido crea un registro real en
 * app.lumbre.pro, así que limitar solo por IP dejaba barato llenar
 * `MAX_PENDING_ITEMS` desde una botnet: el coste del atacante era una IP
 * distinta cada 30 peticiones.
 *
 * 10 por minuto y `client_id`, 60 por minuto en total. El uso legítimo son
 * unas pocas autorizaciones a la HORA (una persona enchufando claude.ai o
 * Codex), así que ambos números están ~100x por encima de lo real y ninguno
 * puede molestar a nadie que esté conectando de verdad.
 */
const DEFAULT_AUTHORIZE_BUDGET = { perClientPerMinute: 10, globalPerMinute: 60 };
/** Techo de ventanas por `client_id` vivas a la vez. El path de un `client_id`
 *  de claude.ai es libre, así que el mapa necesita un límite; 512 está muy por
 *  encima de los clientes reales (dos) y de lo que cabe en un minuto con el
 *  presupuesto global puesto. */
const MAX_AUTHORIZE_CLIENT_WINDOWS = 512;
/**
 * Intentos FALLIDOS de `/mcp` por IP y minuto (ver `mcpAttemptsExhausted`).
 *
 * Solo cuentan los que acaban en 401 — ni los autenticados ni los 403/405. Un
 * cliente MCP real hace ráfagas de decenas de llamadas por minuto, pero 401
 * recibe UNO: el de descubrimiento, al conectar. Con 30/min cabe de sobra un
 * cliente reconectando o varios dispositivos tras el mismo NAT, y a la vez
 * queda acotado el ritmo al que se puede probar bearers a ciegas contra
 * `resolveAccessToken`, que es el trabajo caro (toca el store).
 *
 * Se limita el FALLO y no la petición a propósito: limitar `/mcp` entero
 * castigaría al usuario real —el que hace las ráfagas— sin frenar al abuso,
 * que puede repartirse entre IPs igual de bien.
 *
 * Y se mira DESPUÉS de resolver la credencial, no antes: mirarlo antes cortaba
 * también a quien traía un bearer bueno desde una IP que hubiera acumulado
 * fallos (claude.ai reintentando con un access token caducado desde una salida
 * compartida). El precio de ese orden es que el presupuesto ya no ahorra el
 * trabajo de resolver —barato desde que el store se cachea en memoria—, solo
 * acota el ritmo de 401 provocables.
 */
const DEFAULT_FAILED_MCP_ATTEMPTS_PER_MINUTE = 30;
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
/**
 * Compara dos hashes de credencial (`codeHash`, `accessHash`, `refreshHash`,
 * tombstones) en tiempo constante.
 *
 * Es el MISMO `equalText` que ya se usaba para el PKCE, con otro nombre para
 * que se lea qué se está comparando. Buscar un grant con `===` sobre estos
 * campos deja un canal temporal: `===` de cadenas corta en el primer byte
 * distinto, así que el tiempo de respuesta filtra cuántos caracteres del hash
 * presentado coinciden con uno guardado. No es la vía más práctica de atacar
 * esto —el hash no es el token, y hay que acertarlo entero—, pero es gratis
 * cerrarla y el helper ya existía en el fichero.
 */
function matchesHash(stored, presented) {
    return equalText(stored, presented);
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
/** Margen para que un cliente que se pasó por poco termine de escribir y
 *  llegue a LEER el 413 antes de que le cerremos. Ver `stopReceiving`. */
const LINGERING_CLOSE_MS = 2_000;
/**
 * Deja de procesar el cuerpo y cierra la conexión, sin tragarse el resto.
 *
 * Lo importante, y lo que faltaba: a partir de aquí no se acumula NI UN BYTE
 * más — se quitan los manejadores de `data` y lo que siga llegando se
 * descarta. Eso es lo que cierra el agujero: quien mandaba un cuerpo
 * interminable tenía al proceso guardándolo, o al menos leyéndolo, gratis.
 *
 * Por qué NO un `destroy()` seco, que fue el primer intento y se midió: con
 * el cliente a medio subir, destruir el socket manda un RST, el 413 se pierde
 * por el camino y `fetch` devuelve `EPIPE` en vez de la respuesta — o sea, un
 * cliente que se pasa de tamaño no se entera de POR QUÉ falló. Así que se
 * hace lo mismo que nginx con su `lingering_close`: se drena a la basura
 * mientras el cliente termina, y se cierra en cuanto acaba (`end`) o al
 * agotarse `LINGERING_CLOSE_MS`, lo que ocurra antes. La ventana está acotada
 * en tiempo y no cuesta memoria.
 *
 * Vive aquí, y no en `http.ts`, solo por dependencias: `http.ts` ya importa
 * de este módulo, y al revés se cerraría un ciclo.
 */
export function stopReceiving(req) {
    req.removeAllListeners('data');
    req.resume();
    let closed = false;
    const close = () => {
        if (closed)
            return;
        closed = true;
        clearTimeout(timer);
        req.destroy();
    };
    const timer = setTimeout(close, LINGERING_CLOSE_MS);
    timer.unref();
    req.once('end', close);
    req.once('error', close);
    req.once('close', close);
}
async function readLimitedBody(req, limit = MAX_FORM_BYTES) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
        stopReceiving(req);
        throw new OAuthError('invalid_request', 'Formulario demasiado grande.', 413);
    }
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let exceeded = false;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit && !exceeded) {
                exceeded = true;
                chunks.length = 0;
                stopReceiving(req);
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
            !validEncryptedValue(item.upstream) ||
            // Ausente = store anterior a este campo, y eso NO es corrupción:
            // se acepta y lo sella la primera poda. Presente pero no numérico
            // sí lo es.
            (item.queuedAt !== undefined && !Number.isFinite(item.queuedAt))) {
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
    storeRead;
    backchannel;
    encryptionKey;
    keyPromise;
    rateWindows = new Map();
    /** Ventanas del presupuesto de `/authorize`, fuera de `rateWindows` para
     *  que la expulsión por tamaño de ese mapa no pueda reiniciarlas; ver
     *  `enterAuthorizeBudget`. */
    authorizeGlobalWindow;
    authorizeClientWindows = new Map();
    inFlight = { authorize: 0, token: 0, revoke: 0 };
    clientMetadataCache = new Map();
    clientMetadataInFlight = new Map();
    readinessCache;
    readinessInFlight;
    writeQueue = Promise.resolve();
    authorizeBudget;
    failedMcpAttemptsPerMinute;
    /**
     * Último estado PERSISTIDO conocido del store, en memoria.
     *
     * Sin esto, `resolveAccessToken` —o sea, CADA petición a `/mcp` con un
     * bearer `lm_at_…`— leía, parseaba y normalizaba el fichero entero. La
     * caché se llena al leer de disco y se sustituye dentro de la cola de
     * escritura (`mutateStore`) en cuanto el `rename` ha terminado, así que
     * nunca se sirve un store anterior a una escritura ya confirmada; ante
     * cualquier error se vacía y la siguiente lectura vuelve al disco.
     *
     * Se entrega SIEMPRE una copia (`structuredClone`): los mutadores trabajan
     * sobre su propio objeto, de modo que una escritura abortada no puede
     * dejar la caché con un estado intermedio que nunca llegó al fichero.
     *
     * PREMISA, y hoy se cumple: UN SOLO PROCESO escribe este store. El
     * despliegue es un contenedor con un `node dist/http.js`
     * (`deploy/compose.yml`), sin réplicas. Dos procesos NO comparten esta
     * memoria y se servirían grants viejos entre sí; si algún día se replica,
     * esto tiene que pasar a un almacén compartido o invalidarse por `mtime`.
     * Mitigación parcial que ya existe: `ensureReady` (y con él `/readyz`)
     * relee del disco y adopta lo leído, así que un cambio externo del fichero
     * se acaba viendo. El ritmo real lo marca quien llama: `READINESS_CACHE_MS`
     * solo impide repetirla antes de 5 s, y el único que la pide es el
     * healthcheck del contenedor, cada 30 s (`deploy/compose.yml`; Caddy no
     * publica `/readyz`). O sea: hasta 30 s de retraso, no 5.
     */
    cachedStore;
    /**
     * Cambia con cada adopción o vaciado de `cachedStore`. Existe para que una
     * lectura de disco lanzada ANTES de una escritura no pueda adoptarse
     * DESPUÉS y pisarla; ver la carrera explicada en `loadStore`.
     */
    storeGeneration = 0;
    constructor(options = {}) {
        this.stateDir = options.stateDir ?? defaultStateDir();
        this.fetchFn = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.persistenceStep = options.persistenceStep;
        this.storeRead = options.storeRead;
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
        this.authorizeBudget = { ...DEFAULT_AUTHORIZE_BUDGET, ...options.authorizeBudget };
        this.failedMcpAttemptsPerMinute = options.failedMcpAttemptsPerMinute ?? DEFAULT_FAILED_MCP_ATTEMPTS_PER_MINUTE;
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
    /** IP del cliente tal y como la ve este proceso: la ÚLTIMA entrada de
     *  `x-forwarded-for` es la que añade Caddy (el peer real), no la que
     *  pudiera haber falsificado quien llama. */
    remoteAddressOf(req) {
        const forwarded = req.headers['x-forwarded-for'];
        const rawForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        return rawForwarded?.split(',').at(-1)?.trim().slice(0, 128) || req.socket.remoteAddress || 'unknown';
    }
    /** Retira ventanas vencidas y acota el mapa; se llama antes de mirar o
     *  tocar cualquier ventana. */
    pruneRateWindows(now) {
        for (const [key, window] of this.rateWindows) {
            if (window.startedAt + 60_000 <= now)
                this.rateWindows.delete(key);
        }
        while (this.rateWindows.size >= 2_048)
            this.rateWindows.delete(this.rateWindows.keys().next().value);
    }
    /** ¿Esta clave ya agotó su cupo del minuto? No consume nada. */
    overRateLimit(key, limit) {
        const window = this.rateWindows.get(key);
        return window !== undefined && window.count >= limit;
    }
    consumeRateWindow(key, now) {
        const window = this.rateWindows.get(key);
        if (window)
            window.count += 1;
        else
            this.rateWindows.set(key, { startedAt: now, count: 1 });
    }
    /**
     * ¿Esta IP agotó su presupuesto de intentos FALLIDOS contra `/mcp`? Lo
     * consulta `handleMcpRequest` (`http.ts`) SOLO en la rama en la que la
     * petición se quedó sin credencial utilizable, y después de intentar
     * resolverla: una petición que autentica no pasa por aquí ni para leer el
     * contador. Ver `DEFAULT_FAILED_MCP_ATTEMPTS_PER_MINUTE`.
     */
    mcpAttemptsExhausted(req) {
        const now = this.now();
        this.pruneRateWindows(now);
        return this.overRateLimit(`mcp-failed:${this.remoteAddressOf(req)}`, this.failedMcpAttemptsPerMinute);
    }
    /** Anota un 401 de `/mcp` contra el presupuesto de esta IP. */
    recordFailedMcpAttempt(req) {
        const now = this.now();
        this.pruneRateWindows(now);
        this.consumeRateWindow(`mcp-failed:${this.remoteAddressOf(req)}`, now);
    }
    /**
     * Presupuesto de `/authorize` por `client_id` y global, que se gasta JUSTO
     * ANTES de llamar al backchannel — el orden es el punto: pasada esta
     * puerta, la petición crea un registro real en app.lumbre.pro.
     *
     * NO usa `rateWindows`, y ese es justo el arreglo: ahí la expulsión por
     * TAMAÑO borra por orden de inserción, y la ventana global es de las claves
     * más viejas de cada minuto. Bastaba con generar 2.048 claves nuevas
     * —rotando IPs contra cualquier endpoint público, o contra el espacio
     * `mcp-failed:<ip>`— para expulsar y reiniciar precisamente el presupuesto
     * que tiene que resistir eso. Global y por cliente viven ahora en estado
     * propio, que solo limpia la caducidad.
     *
     * Las ventanas por `client_id` sí se acotan en número
     * (`MAX_AUTHORIZE_CLIENT_WINDOWS`), porque el path de un `client_id` de
     * claude.ai es libre y no se puede dejar crecer un mapa sin techo.
     * Expulsar una de ellas reinicia el cupo de ESE cliente, pero el global
     * —que es el que acota el total— sigue contando por debajo.
     */
    enterAuthorizeBudget(clientId) {
        const now = this.now();
        if (this.authorizeGlobalWindow && this.authorizeGlobalWindow.startedAt + 60_000 <= now) {
            this.authorizeGlobalWindow = undefined;
        }
        for (const [key, window] of this.authorizeClientWindows) {
            if (window.startedAt + 60_000 <= now)
                this.authorizeClientWindows.delete(key);
        }
        const clientWindow = this.authorizeClientWindows.get(clientId);
        if ((clientWindow !== undefined && clientWindow.count >= this.authorizeBudget.perClientPerMinute) ||
            (this.authorizeGlobalWindow !== undefined &&
                this.authorizeGlobalWindow.count >= this.authorizeBudget.globalPerMinute)) {
            throw new OAuthError('temporarily_unavailable', 'Demasiadas autorizaciones en curso; inténtalo de nuevo más tarde.', 429);
        }
        if (clientWindow) {
            clientWindow.count += 1;
        }
        else {
            while (this.authorizeClientWindows.size >= MAX_AUTHORIZE_CLIENT_WINDOWS) {
                this.authorizeClientWindows.delete(this.authorizeClientWindows.keys().next().value);
            }
            this.authorizeClientWindows.set(clientId, { startedAt: now, count: 1 });
        }
        if (this.authorizeGlobalWindow)
            this.authorizeGlobalWindow.count += 1;
        else
            this.authorizeGlobalWindow = { startedAt: now, count: 1 };
    }
    enterPublicEndpoint(req, endpoint) {
        const remote = this.remoteAddressOf(req);
        const now = this.now();
        this.pruneRateWindows(now);
        const key = `${endpoint}:${remote}`;
        const limit = this.publicLimits[endpoint];
        if (this.overRateLimit(key, limit.requestsPerMinute)) {
            throw new OAuthError('temporarily_unavailable', 'Demasiadas solicitudes; inténtalo de nuevo más tarde.', 429);
        }
        if (this.inFlight[endpoint] >= limit.concurrent) {
            throw new OAuthError('temporarily_unavailable', 'El servidor está ocupado; inténtalo de nuevo.', 429);
        }
        this.consumeRateWindow(key, now);
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
            // Las DOS puertas que faltaban antes de tocar app.lumbre.pro:
            // presupuesto por `client_id` y global (el límite por IP de
            // `enterPublicEndpoint` no basta: se reparte entre IPs), y el cupo
            // de pendientes. Lo de `MAX_PENDING_ITEMS` ya se comprobaba, pero
            // DESPUÉS del backchannel: llenar la cola dejaba mil registros
            // creados en Lumbre que aquí ni se guardaban. Ahora se mira antes,
            // y es barato porque el store está cacheado en memoria.
            this.enterAuthorizeBudget(request.clientId);
            const pendingNow = (await this.loadStore()).authorizationRequests.filter((item) => item.expiresAt > this.now()).length;
            if (pendingNow >= MAX_PENDING_ITEMS) {
                throw new OAuthError('temporarily_unavailable', 'Hay demasiadas autorizaciones pendientes.', 503);
            }
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
            // `denied` NO consume la autorización pendiente, y esta asimetría es
            // el arreglo, no un descuido: este callback es un GET público cuyo
            // único "secreto" es el UUID `request`. Consumir la pendiente ANTES
            // de contrastar la decisión con Lumbre significaba que cualquiera
            // que conociera ese UUID podía mandar `decision=denied` y abortar
            // la autorización de otra persona — una decisión que Lumbre nunca
            // llegaba a confirmar. Dejándola en pie, un `denied` falsificado no
            // destruye nada: el callback bueno sigue encontrando su pendiente,
            // y la falsa solo redirige al navegador de quien la mandó. Un
            // `denied` legítimo tampoco necesita borrar nada: la entrada caduca
            // sola (`TRANSACTION_TTL_MS`, 10 min) y `mutateStore` la poda.
            //
            // `approved` sí conserva el consumo atómico ANTES de `exchange`,
            // igual que hasta ahora: es lo que garantiza UNA sola llamada de
            // canje: dos callbacks concurrentes compiten por el mismo
            // `mutateStore`, gana uno y el otro se encuentra sin pendiente. El
            // contrato de `/exchange` de Lumbre no es reintentable a ciegas
            // (ver `README.md`), así que esa ventana no se abre.
            //
            // DE QUÉ DEPENDE ESTO AL OTRO LADO, comprobado en el repo `lumbre`:
            // `exchangeMcpAuthorizationRequest`
            // (`src/lib/server/repos/lumbre-mcp-integration.ts:126-146`) exige
            // `approvedAt IS NOT NULL` dentro del mismo `DELETE … RETURNING`,
            // así que una transacción DENEGADA no se puede canjear ni aunque un
            // tercero mande `decision=approved` con el UUID acertado. Si esa
            // condición desapareciera de allí, no basta con dejar la pendiente
            // en pie: habría que volver a validar la decisión aquí.
            const stored = (await this.loadStore()).authorizationRequests.find((item) => item.requestId === requestId);
            if (!stored || stored.expiresAt <= this.now()) {
                throw new OAuthError('invalid_request', 'La autorización ha caducado, ya fue usada o no existe.');
            }
            if (decision === 'denied') {
                this.redirectToClient(res, stored, { error: 'access_denied' });
                return;
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
        const code = (await this.loadStore()).authorizationCodes.find((item) => matchesHash(item.codeHash, codeHash));
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
            const code = store.authorizationCodes.find((item) => matchesHash(item.codeHash, codeHash));
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
                    upstream: code.upstream,
                    queuedAt: this.now()
                });
            }
            store.authorizationCodes = store.authorizationCodes.filter((item) => !matchesHash(item.codeHash, codeHash));
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
            const storedCode = store.authorizationCodes.find((item) => matchesHash(item.codeHash, codeHash) && item.credentialId === code.credentialId && item.expiresAt > now);
            if (!storedCode)
                return false;
            store.authorizationCodes = store.authorizationCodes.filter((item) => !matchesHash(item.codeHash, codeHash));
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
        const usedSnapshot = snapshot.usedRefreshTokens.find((item) => matchesHash(item.hash, oldHash) && item.expiresAt > now);
        const grantSnapshot = usedSnapshot
            ? snapshot.grants.find((item) => item.familyId === usedSnapshot.familyId)
            : snapshot.grants.find((item) => matchesHash(item.refreshHash, oldHash));
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
            const used = store.usedRefreshTokens.find((item) => matchesHash(item.hash, oldHash) && item.expiresAt > now);
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
            const grant = store.grants.find((item) => matchesHash(item.refreshHash, oldHash));
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
        if (store.usedRefreshTokens.some((item) => matchesHash(item.hash, hash)))
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
                upstream: grant.upstream,
                queuedAt: this.now()
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
                upstream: encrypt(credential.accessToken, key, grantContext(context.clientId, context.resource, context.scope)),
                queuedAt: this.now()
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
                let familyId = store.grants.find((grant) => grant.provider === 'lumbre-web' && grant.clientId === clientId && (matchesHash(grant.accessHash, hash) || matchesHash(grant.refreshHash, hash)))?.familyId;
                familyId ??= store.usedRefreshTokens.find((item) => matchesHash(item.hash, hash))?.familyId;
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
            const grant = store.grants.find((item) => matchesHash(item.accessHash, hash));
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
        // Readiness NO se contesta desde la caché: la gracia de `/readyz` es
        // afirmar que el fichero de estado se puede leer y descifrar AHORA.
        //
        // Se lee del disco DIRECTAMENTE, sin vaciar antes la caché compartida:
        // vaciarla abría un hueco en el que el resto de peticiones leían disco
        // mientras esta validación estaba en vuelo, y era la mitad de la
        // carrera que describe `loadStore`. Lo leído se adopta al final, y
        // solo si nadie escribió mientras tanto.
        const generation = this.storeGeneration;
        const store = await this.readStore();
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
        // Lo validado se adopta SOLO si nadie escribió durante la validación.
        // Así `/readyz` sigue refrescando la caché con lo que hay en disco —que
        // es como se recoge un cambio externo del fichero— sin poder pisar una
        // escritura más nueva que la lectura.
        if (generation === this.storeGeneration)
            this.adoptStore(store);
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
    /**
     * Sustituye la caché por un estado que YA está en disco y anota que el
     * estado vigente cambió. Solo lo llaman el `mutateStore` que acaba de
     * confirmar su `rename` y la validación de `ensureReady`.
     */
    adoptStore(store) {
        this.cachedStore = store;
        this.storeGeneration += 1;
    }
    /** Vacía la caché: la siguiente lectura vuelve al disco. */
    invalidateStore() {
        this.cachedStore = undefined;
        this.storeGeneration += 1;
    }
    /**
     * Estado del store, de memoria si lo hay y del disco si no. Siempre una
     * COPIA: quien la recibe puede mutarla sin contaminar la caché (ver
     * `cachedStore`).
     *
     * LA CARRERA QUE CIERRA `storeGeneration`, que estaba abierta y era grave:
     * entre que se lanza el `readFile` y resuelve pasa tiempo, y en ese hueco
     * un `mutateStore` puede completar su `rename` y adoptar el estado NUEVO.
     * Adoptar después la lectura vieja —que es lo que hacía -— dejaba la caché
     * un paso por detrás del disco: un token recién emitido dejaba de
     * resolver, uno recién revocado volvía a resolver, y el siguiente
     * `mutateStore` partía de esa caché vieja y la serializaba, perdiendo la
     * escritura anterior EN DISCO y sin ningún error.
     *
     * La regla: solo se adopta la lectura si la generación no cambió durante
     * el `await`. Si cambió, la lectura ya nació caduca y se descarta —se
     * devuelve el estado vigente, nunca el viejo.
     */
    async loadStore() {
        const cached = this.cachedStore;
        if (cached)
            return structuredClone(cached);
        const generation = this.storeGeneration;
        const store = await this.readStore();
        if (generation !== this.storeGeneration) {
            const current = this.cachedStore;
            // Sin caché vigente (alguien la invalidó) se relee, pero tampoco se
            // adopta: quien invalidó manda.
            return current ? structuredClone(current) : await this.readStore();
        }
        this.cachedStore = store;
        return structuredClone(store);
    }
    async readStore() {
        try {
            const store = normalizeStore(JSON.parse(await readFile(this.storePath(), 'utf8')));
            await this.storeRead?.();
            return store;
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
    /**
     * Poda la outbox de revocación: primero por caducidad, y si aun así sigue
     * sobre el tope, por antigüedad (FIFO, se conservan los más NUEVOS: los
     * viejos son los que más cerca están de caducar de todas formas, y su
     * credencial es la que más papeletas tiene de haber expirado ya arriba).
     * Devuelve si cambió algo (sellado de migración o descarte). Ver
     * `MAX_REVOCATION_OUTBOX_ITEMS` para la política y por qué es seguro.
     */
    pruneRevocationOutbox(store, now) {
        const before = store.revocationOutbox.length;
        // Los elementos heredados (sin `queuedAt`) se sellan ahora: empiezan a
        // contar desde esta poda, nunca se descartan por sorpresa.
        let stamped = 0;
        for (const item of store.revocationOutbox) {
            if (item.queuedAt === undefined) {
                item.queuedAt = now;
                stamped += 1;
            }
        }
        store.revocationOutbox = store.revocationOutbox.filter((item) => (item.queuedAt ?? now) + REVOCATION_OUTBOX_TTL_MS > now);
        if (store.revocationOutbox.length > MAX_REVOCATION_OUTBOX_ITEMS) {
            store.revocationOutbox = store.revocationOutbox
                .slice()
                .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
                .slice(-MAX_REVOCATION_OUTBOX_ITEMS);
        }
        const discarded = before - store.revocationOutbox.length;
        if (discarded > 0) {
            // Sin credenciales, sin `credentialId`: solo el número y el motivo.
            // Que se descarte no puede quedar sin rastro (ver la política), pero
            // el rastro tampoco puede ser un secreto en un log.
            console.error(`[lumbre-mcp-oauth] outbox de revocación: ${discarded} pendiente(s) descartada(s) ` +
                `por caducidad (${REVOCATION_OUTBOX_TTL_MS} ms) o tope (${MAX_REVOCATION_OUTBOX_ITEMS}); ` +
                'esas credenciales upstream no se revocarán desde aquí');
        }
        return discarded > 0 || stamped > 0;
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
                            resource: code.resource, scope: code.scope, upstream: code.upstream, queuedAt: now
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
                // La poda de la outbox va DESPUÉS del mutador: así lo que el
                // mutador acabe de encolar entra ya en la cuenta del tope y no
                // se cuela un elemento 257 hasta la siguiente escritura.
                changed = this.pruneRevocationOutbox(store, now) || changed;
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
                    // A partir del `rename` el fichero YA es este `store`, así
                    // que la caché puede adoptarlo: dentro de la cola de
                    // escritura y después de confirmar, nunca antes. `store` es
                    // la copia privada de esta pasada (ver `loadStore`), así que
                    // nadie más tiene una referencia a ella.
                    this.adoptStore(store);
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
                // Ante CUALQUIER fallo se vacía: no sabemos si el fichero quedó
                // como estaba o a medias, y una caché dudosa es peor que una
                // lectura de más.
                this.invalidateStore();
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