import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
/**
 * Cliente OIDC del relé contra Sumego (el issuer configurado), el login
 * único de las apps de Lumbre. Contrato: `SPEC.md` §4, §4.0 y §4.1 del repo
 * `sumego`.
 *
 * QUÉ ES Y QUÉ NO. El relé sigue siendo SU PROPIO servidor OAuth para
 * claude.ai y Codex (`oauth.ts`): Sumego no tiene registro dinámico ni emite
 * tokens para resource servers. Sumego sirve para saber QUIÉN es la persona
 * al conectar (`/authorize`), para enterarse de que cerró sesión
 * (back-channel logout) y, como red de seguridad si ese aviso se pierde,
 * para comprobar cada hora que su sesión sigue viva. Por eso:
 *   · del canje se guarda el ID token (para Lumbre) y el REFRESH token,
 *     cifrado en el grant: el `/token` del relé lo renueva contra Sumego como
 *     mucho cada hora, y un 4xx (cuenta suspendida, grant revocado, SPEC
 *     §4 y §7.7) corta el grant aunque el logout no haya llegado. Antes no se
 *     guardaba, y un logout perdido dejaba el grant vivo 30 días (M1 de la
 *     revisión de seguridad de c4534bc). El access token de Sumego se tira;
 *   · la persona se identifica por `sub`, NUNCA por email (el email puede
 *     cambiar y no prueba nada; aquí solo se enseña en el consentimiento);
 *   · si Sumego está caído, solo falla el login nuevo: `/mcp`, `/token` y
 *     `/revoke` no pasan por aquí.
 *
 * JWT SIN DEPENDENCIAS. La firma es ES256 y nada más (SPEC §4: «Firma de ID
 * tokens: ES256»), y eso lo verifica `node:crypto` directamente:
 * `createPublicKey({ format: 'jwk' })` y `verify` con
 * `dsaEncoding: 'ieee-p1363'` (la firma JWS es r‖s de 64 bytes, no DER). Un
 * solo algoritmo, sin negociación: cualquier `alg` que no sea exactamente
 * `ES256` se rechaza ANTES de buscar la clave, y con él `none` y HS*.
 */
export const SUMEGO_CALLBACK = 'https://mcp.lumbre.pro/oauth/sumego/callback';
export const SUMEGO_BACKCHANNEL_LOGOUT = 'https://mcp.lumbre.pro/oauth/sumego/backchannel-logout';
export const DEFAULT_OIDC_ISSUER = 'https://id.sumego.es';
/**
 * Los únicos orígenes que se aceptan como issuer de Sumego (SPEC de Sumego
 * §13.6, «Transición»): el histórico y el definitivo. Comparación exacta
 * tras normalizar, sin comodines ni otros hosts. El activo es UNO, el de
 * `LUMBRE_MCP_OIDC_ISSUER`; nunca lo decide la build.
 */
export const SUMEGO_ISSUERS = ['https://id.lumbre.pro', 'https://id.sumego.es'];
export const DEFAULT_OIDC_CLIENT_ID = 'lumbre-mcp';
export const SUMEGO_SCOPE = 'openid email';
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 3_000;
/** Discovery y JWKS cambian rara vez (una rotación de claves); una hora de
 *  caché ahorra una ida a Sumego por login sin dejar una clave vieja más de
 *  lo razonable. Una clave NUEVA no espera a esto: ver `FETCH_COOLDOWN_MS`. */
const METADATA_CACHE_MS = 60 * 60_000;
/**
 * Freno de las lecturas de discovery y JWKS: como mucho una por minuto
 * fuera de la caché. Un `kid` desconocido fuerza releer el JWKS (es como se
 * ve una rotación), y sin el freno cualquiera podía mandar logout tokens con
 * `kid` inventados y convertir este endpoint público en un amplificador de
 * peticiones contra el issuer de Sumego. Cuenta el INTENTO, salga bien o mal (B3
 * de la revisión de seguridad de c4534bc): antes solo frenaba tras una
 * lectura buena, y con Sumego fallando cada petición salía a preguntarle.
 */
const FETCH_COOLDOWN_MS = 60_000;
/** Margen de reloj entre este VPS y Sumego para `exp` e `iat`. Pequeño a
 *  propósito: los dos viven en la misma máquina y con NTP. */
export const CLOCK_SKEW_MS = 60_000;
/** Antigüedad máxima de un ID token al llegar: se emite en el canje, que
 *  ocurre en el mismo segundo, así que cinco minutos sobran. */
const ID_TOKEN_MAX_AGE_MS = 5 * 60_000;
/**
 * Antigüedad máxima de un `logout_token`. Sumego lo manda en el acto; uno
 * más viejo es una reproducción. Este número es también lo que se guarda el
 * `jti` (ver `LogoutClaims.keepUntil`): pasado este plazo el token ya se
 * rechaza por viejo, así que recordarlo más no protege nada.
 */
export const LOGOUT_TOKEN_MAX_AGE_MS = 5 * 60_000;
/** Un JWT de Sumego mide unos cientos de bytes; esto acota lo que se
 *  decodifica y parsea de algo que llega sin autenticar. */
const MAX_JWT_LENGTH = 8 * 1024;
const MAX_CLAIM_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;
/** Fallo del lado de Sumego, tipado igual que `BackchannelError`: `invalid`
 *  es una respuesta o un token que no valen, `transient` es no haber podido
 *  preguntar (red, timeout, 5xx, 429). El mensaje no lleva nunca un token. */
export class OidcError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
    }
}
function validateIssuer(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('LUMBRE_MCP_OIDC_ISSUER inválido');
    }
    if (url.protocol !== 'https:' ||
        url.search !== '' ||
        url.hash !== '' ||
        url.username !== '' ||
        url.password !== '') {
        throw new Error('LUMBRE_MCP_OIDC_ISSUER debe ser una URL https sin query, fragmento ni credenciales');
    }
    // El issuer de Sumego es la raíz SIN barra final (SPEC §3), y es lo que
    // se compara byte a byte con `iss`. `URL` ya iguala mayúsculas del
    // esquema y del host y quita el puerto por defecto (`:443`); la barra
    // final se quita aquí. Lo que quede se compara con la lista, de modo que
    // un subdominio, otro puerto o una ruta no pasan. El mensaje nombra la
    // variable, no el valor.
    const normalized = url.pathname === '/' ? url.origin : `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    if (!SUMEGO_ISSUERS.includes(normalized)) {
        throw new Error(`LUMBRE_MCP_OIDC_ISSUER debe ser uno de ${SUMEGO_ISSUERS.join(' o ')}`);
    }
    return normalized;
}
/**
 * Lee la configuración de login del entorno. Lanza (y `http.ts` aborta el
 * arranque) con un proveedor desconocido o con `sumego` sin secreto. Los
 * mensajes nombran la variable, NUNCA su valor: el del secreto no puede
 * acabar en un log, y el del proveedor tampoco hace falta.
 */
export function loginConfigFromEnv(env = process.env) {
    const rawProvider = env.LUMBRE_MCP_LOGIN_PROVIDER?.trim() || 'lumbre';
    if (rawProvider !== 'lumbre' && rawProvider !== 'sumego') {
        throw new Error('LUMBRE_MCP_LOGIN_PROVIDER debe ser lumbre o sumego');
    }
    const issuer = validateIssuer(env.LUMBRE_MCP_OIDC_ISSUER?.trim() || DEFAULT_OIDC_ISSUER);
    const clientId = env.LUMBRE_MCP_OIDC_CLIENT_ID?.trim() || DEFAULT_OIDC_CLIENT_ID;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) {
        throw new Error('LUMBRE_MCP_OIDC_CLIENT_ID inválido');
    }
    const clientSecret = env.LUMBRE_MCP_OIDC_CLIENT_SECRET?.trim() || undefined;
    const config = { provider: rawProvider, sumego: { issuer, clientId, clientSecret } };
    if (rawProvider === 'sumego')
        assertClientSecret(clientSecret);
    return config;
}
function assertClientSecret(secret) {
    if (!secret) {
        throw new Error('LUMBRE_MCP_OIDC_CLIENT_SECRET es obligatorio con LUMBRE_MCP_LOGIN_PROVIDER=sumego');
    }
    if (secret.length > 512 || /[\r\n]/.test(secret)) {
        throw new Error('LUMBRE_MCP_OIDC_CLIENT_SECRET no puede pasar de 512 caracteres ni contener saltos de línea');
    }
}
function base64UrlJson(segment) {
    try {
        return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    }
    catch {
        throw new OidcError('invalid', 'JWT con JSON inválido.');
    }
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function claimString(value, max = MAX_CLAIM_LENGTH) {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}
/** Igualdad en tiempo constante de dos cadenas de cualquier longitud: se
 *  comparan sus SHA-256, que siempre miden lo mismo. */
function sameText(a, b) {
    const aa = createHash('sha256').update(a, 'utf8').digest();
    const bb = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(aa, bb);
}
/**
 * Comprobaciones comunes de `aud`/`azp`: el token tiene que ser PARA este
 * cliente. Con varias audiencias se exige además `azp` (OIDC Core §3.1.3.7):
 * si no, un token emitido para otra app que nos incluya de paso valdría aquí.
 */
function audienceMatches(payload, clientId) {
    const aud = payload.aud;
    const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : undefined;
    if (!audiences || audiences.length === 0 || !audiences.every((item) => typeof item === 'string'))
        return false;
    if (!audiences.includes(clientId))
        return false;
    if (payload.azp !== undefined && payload.azp !== clientId)
        return false;
    if (audiences.length > 1 && payload.azp !== clientId)
        return false;
    return true;
}
function originOf(value) {
    try {
        return new URL(value).origin;
    }
    catch {
        return undefined;
    }
}
async function readBoundedJson(response, what) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new OidcError('invalid', `${what}: respuesta demasiado grande.`);
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json' && contentType !== 'application/jwk-set+json') {
        await response.body?.cancel().catch(() => undefined);
        throw new OidcError('invalid', `${what}: la respuesta no es JSON.`);
    }
    if (!response.body)
        throw new OidcError('invalid', `${what}: respuesta vacía.`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new OidcError('invalid', `${what}: respuesta demasiado grande.`);
        }
        chunks.push(value);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new OidcError('invalid', `${what}: JSON inválido.`);
    }
}
export class SumegoOidcClient {
    issuer;
    clientId;
    clientSecret;
    fetchFn;
    now;
    timeoutMs;
    discovery;
    discoveryInFlight;
    /** Último INTENTO de leer el discovery, saliera bien o mal (`FETCH_COOLDOWN_MS`). */
    discoveryAttemptAt;
    jwks;
    jwksInFlight;
    /** Último INTENTO de leer el JWKS, saliera bien o mal (`FETCH_COOLDOWN_MS`). */
    jwksAttemptAt;
    constructor(options) {
        this.issuer = validateIssuer(options.config.issuer);
        this.clientId = options.config.clientId;
        this.clientSecret = options.config.clientSecret;
        this.fetchFn = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    ensureConfigured() {
        assertClientSecret(this.clientSecret);
    }
    async authorizationUrl(params) {
        const { authorizationEndpoint } = await this.metadata();
        const url = new URL(authorizationEndpoint);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', this.clientId);
        url.searchParams.set('redirect_uri', SUMEGO_CALLBACK);
        url.searchParams.set('scope', SUMEGO_SCOPE);
        url.searchParams.set('state', params.state);
        url.searchParams.set('nonce', params.nonce);
        url.searchParams.set('code_challenge', params.codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
        return url.toString();
    }
    /**
     * Canjea el `code` en el token endpoint de Sumego (`client_secret_basic`,
     * PKCE) y valida el ID token. Devuelve también el refresh token, que es
     * obligatorio: sin él no hay comprobación horaria de la sesión, y aceptar
     * su falta la apagaría en silencio (igual que `sid` y el logout). El access
     * token de Sumego se descarta.
     *
     * Errores: cualquier 4xx salvo 429 es `invalid` (SPEC §4.0.3: el login
     * falla); 429, 5xx, red y timeout son `transient`.
     */
    async redeemCode(code, codeVerifier, nonce) {
        this.ensureConfigured();
        const { tokenEndpoint } = await this.metadata();
        const response = await this.postForm(tokenEndpoint, {
            grant_type: 'authorization_code',
            code,
            redirect_uri: SUMEGO_CALLBACK,
            code_verifier: codeVerifier
        });
        if (response.status !== 200)
            throw await this.tokenEndpointError(response, 'Sumego rechazó el canje del código.');
        const body = await readBoundedJson(response, 'Token de Sumego');
        if (!isRecord(body) || typeof body.id_token !== 'string') {
            throw new OidcError('invalid', 'Sumego no devolvió un ID token.');
        }
        if (!claimString(body.refresh_token, 4096)) {
            throw new OidcError('invalid', 'Sumego no devolvió un refresh token.');
        }
        const payload = await this.verifiedPayload(body.id_token);
        const now = this.now();
        if (payload.iss !== this.issuer ||
            !audienceMatches(payload, this.clientId) ||
            typeof payload.exp !== 'number' ||
            payload.exp * 1000 <= now - CLOCK_SKEW_MS ||
            typeof payload.iat !== 'number' ||
            payload.iat * 1000 > now + CLOCK_SKEW_MS ||
            payload.iat * 1000 < now - ID_TOKEN_MAX_AGE_MS - CLOCK_SKEW_MS ||
            typeof payload.nonce !== 'string' ||
            !sameText(payload.nonce, nonce) ||
            !claimString(payload.sub) ||
            !claimString(payload.sid)) {
            throw new OidcError('invalid', 'ID token de Sumego fuera de contrato.');
        }
        const email = claimString(payload.email, MAX_EMAIL_LENGTH) ? payload.email : undefined;
        return {
            identity: { sub: payload.sub, sid: payload.sid, ...(email ? { email } : {}) },
            idToken: body.id_token,
            issuedAt: payload.iat * 1000,
            refreshToken: body.refresh_token
        };
    }
    /**
     * Renueva un refresh de Sumego (`grant_type=refresh_token`). Sumego rota
     * siempre (SPEC §4.0.1), así que el 200 trae uno nuevo y el de entrada deja
     * de valer: quien llama tiene que guardar el nuevo, y no puede usar el
     * mismo dos veces (lo segundo sería un `invalid_grant` legítimo).
     *
     * Errores: SOLO un `400` con `error=invalid_grant` es `invalid`: la sesión
     * se cierra (cuenta suspendida, grant revocado o refresh ya usado, SPEC
     * §4.0.3). Todo lo demás es `transient` y no corta nada: 429, 5xx, red,
     * timeout, un 200 sin `refresh_token`, y también cualquier otro 4xx.
     *
     * DESVIACIÓN DE LA SPEC, decidida por David el 21 oct 2026. §4.0.3 dice
     * «cualquier 4xx del token endpoint salvo 429» cierra la sesión. Aquí no:
     * `invalid_client`, `unauthorized_client`, `invalid_request`, un 401 o un
     * 400 sin cuerpo legible hablan de NUESTRA configuración (el secreto de
     * cliente, sobre todo), no de la sesión de la persona. Tomarlos al pie de
     * la letra haría que un secreto mal rotado revocara, en una hora, TODOS los
     * grants de Sumego del relé. Se tratan como transitorios y dejan una línea
     * en el log para que alguien revise el secreto. En el LOGIN no se aplica:
     * ahí cualquier 4xx hace fallar el login (`redeemCode`), porque no hay
     * nada que conservar.
     */
    async refresh(refreshToken) {
        this.ensureConfigured();
        const { tokenEndpoint } = await this.metadata();
        const response = await this.postForm(tokenEndpoint, { grant_type: 'refresh_token', refresh_token: refreshToken });
        if (response.status === 400 && (await this.oauthErrorCode(response)) === 'invalid_grant') {
            throw new OidcError('invalid', 'Sumego rechazó la renovación: la sesión ya no vale.');
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            await response.body?.cancel().catch(() => undefined);
            // Sin datos: ni token ni cuerpo; el client_id no es secreto.
            console.error(`[lumbre-mcp-oauth] Sumego rechaza al cliente ${this.clientId}: revisar LUMBRE_MCP_OIDC_CLIENT_SECRET`);
            throw new OidcError('transient', 'Sumego rechaza al cliente (configuración), no a la sesión.');
        }
        if (response.status !== 200)
            throw await this.tokenEndpointError(response, 'Sumego rechazó la renovación.');
        let body;
        try {
            body = await readBoundedJson(response, 'Refresh de Sumego');
        }
        catch {
            throw new OidcError('transient', 'Sumego devolvió una renovación ilegible.');
        }
        if (!isRecord(body) || !claimString(body.refresh_token, 4096)) {
            throw new OidcError('transient', 'Sumego no devolvió el refresh rotado.');
        }
        return { refreshToken: body.refresh_token };
    }
    /**
     * Revoca un refresh (RFC 7009) si el discovery publica
     * `revocation_endpoint`. Sin endpoint no hay nada que hacer: la sesión ya
     * muere sola en Sumego. Cualquier respuesta que no sea 200 lanza.
     */
    async revokeRefresh(refreshToken) {
        this.ensureConfigured();
        const { revocationEndpoint } = await this.metadata();
        if (!revocationEndpoint)
            return;
        const response = await this.postForm(revocationEndpoint, { token: refreshToken, token_type_hint: 'refresh_token' });
        await response.body?.cancel().catch(() => undefined);
        if (response.status !== 200)
            throw new OidcError('transient', 'Sumego no confirmó la revocación.');
    }
    /** POST de formulario al token endpoint (o al de revocación) con
     *  `client_secret_basic`. Solo lanza si no hay respuesta. */
    async postForm(endpoint, form) {
        // RFC 6749 §2.3.1: id y secreto van form-urlencoded ANTES del base64.
        const basic = Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`, 'utf8').toString('base64');
        try {
            return await this.fetchFn(endpoint, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(this.timeoutMs),
                headers: {
                    authorization: `Basic ${basic}`,
                    accept: 'application/json',
                    'content-type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(form).toString()
            });
        }
        catch {
            throw new OidcError('transient', 'No se pudo contactar con Sumego.');
        }
    }
    /** El `error` de una respuesta de error OAuth (RFC 6749 §5.2), o
     *  `undefined` si el cuerpo no es un JSON legible con ese campo. Nunca
     *  lanza: un cuerpo raro es solo «sin código». */
    async oauthErrorCode(response) {
        try {
            const body = await readBoundedJson(response, 'Error de Sumego');
            return isRecord(body) && typeof body.error === 'string' ? body.error : undefined;
        }
        catch {
            return undefined;
        }
    }
    async tokenEndpointError(response, rejected) {
        await response.body?.cancel().catch(() => undefined);
        const transient = response.status >= 500 || response.status === 429;
        return new OidcError(transient ? 'transient' : 'invalid', transient ? 'Sumego no está disponible temporalmente.' : rejected);
    }
    /**
     * Valida un `logout_token` (OIDC Back-Channel Logout 1.0 §2.4 y §2.6):
     * firma, `iss`, `aud`, `iat` dentro de la ventana, `jti`, el evento de
     * logout en `events`, SIN `nonce` (es lo que lo distingue de un ID token:
     * un ID token robado no vale como orden de logout), y `sub` o `sid`.
     *
     * Que el `jti` no se haya usado ya lo comprueba quien llama, contra el
     * almacén: aquí no hay estado.
     */
    async validateLogoutToken(token) {
        const payload = await this.verifiedPayload(token);
        const now = this.now();
        const events = payload.events;
        if (payload.iss !== this.issuer ||
            !audienceMatches(payload, this.clientId) ||
            typeof payload.iat !== 'number' ||
            payload.iat * 1000 > now + CLOCK_SKEW_MS ||
            payload.iat * 1000 < now - LOGOUT_TOKEN_MAX_AGE_MS - CLOCK_SKEW_MS ||
            (payload.exp !== undefined && (typeof payload.exp !== 'number' || payload.exp * 1000 <= now - CLOCK_SKEW_MS)) ||
            !claimString(payload.jti) ||
            !isRecord(events) ||
            !isRecord(events[BACKCHANNEL_LOGOUT_EVENT]) ||
            'nonce' in payload ||
            (payload.sub !== undefined && !claimString(payload.sub)) ||
            (payload.sid !== undefined && !claimString(payload.sid)) ||
            (payload.sub === undefined && payload.sid === undefined)) {
            throw new OidcError('invalid', 'logout_token fuera de contrato.');
        }
        return {
            jti: payload.jti,
            ...(typeof payload.sub === 'string' ? { sub: payload.sub } : {}),
            ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}),
            keepUntil: payload.iat * 1000 + LOGOUT_TOKEN_MAX_AGE_MS + CLOCK_SKEW_MS,
            issuedAt: payload.iat * 1000
        };
    }
    /**
     * Comprueba forma y firma de un JWS compacto y devuelve su payload. El
     * `alg` se mira ANTES de tocar ninguna clave: solo `ES256`. La clave se
     * elige por `kid`; si no está en el JWKS en caché, se relee una vez (con
     * el freno de `FETCH_COOLDOWN_MS`) por si Sumego rotó.
     */
    async verifiedPayload(token) {
        if (token.length > MAX_JWT_LENGTH)
            throw new OidcError('invalid', 'JWT demasiado largo.');
        const parts = token.split('.');
        if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
            throw new OidcError('invalid', 'JWT mal formado.');
        }
        const [encodedHeader, encodedPayload, encodedSignature] = parts;
        const header = base64UrlJson(encodedHeader);
        if (!isRecord(header) || header.alg !== 'ES256' || 'crit' in header) {
            throw new OidcError('invalid', 'JWT con algoritmo no admitido.');
        }
        if (header.kid !== undefined && !claimString(header.kid))
            throw new OidcError('invalid', 'JWT con kid inválido.');
        const signature = Buffer.from(encodedSignature, 'base64url');
        if (signature.length !== 64)
            throw new OidcError('invalid', 'Firma ES256 mal formada.');
        const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii');
        const kid = header.kid;
        let candidates = this.keysFor(await this.keys(false), kid);
        if (candidates.length === 0)
            candidates = this.keysFor(await this.keys(true), kid);
        const valid = candidates.some(({ key }) => verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature));
        if (!valid)
            throw new OidcError('invalid', 'Firma del JWT inválida.');
        const payload = base64UrlJson(encodedPayload);
        if (!isRecord(payload))
            throw new OidcError('invalid', 'JWT sin payload de objeto.');
        return payload;
    }
    keysFor(keys, kid) {
        return kid === undefined ? keys : keys.filter((item) => item.kid === kid);
    }
    /**
     * Discovery, de la caché si está fresca. Si no, se lee, pero como mucho
     * un intento por minuto (`FETCH_COOLDOWN_MS`): dentro de ese minuto se
     * sirve la copia caducada si la hay, y si no, `transient` sin salir a
     * Sumego. Así, con Sumego caído, un aluvión de `/authorize` o de logouts
     * no se convierte en un aluvión contra él.
     */
    async metadata() {
        const now = this.now();
        const cached = this.discovery;
        if (cached && cached.expiresAt > now)
            return cached.value;
        if (this.discoveryInFlight)
            return await this.discoveryInFlight;
        if (this.discoveryAttemptAt !== undefined && this.discoveryAttemptAt + FETCH_COOLDOWN_MS > now) {
            if (cached)
                return cached.value;
            throw new OidcError('transient', 'Discovery de Sumego: se reintenta en un minuto.');
        }
        this.discoveryAttemptAt = now;
        this.discoveryInFlight = this.fetchDiscovery().finally(() => {
            this.discoveryInFlight = undefined;
        });
        return await this.discoveryInFlight;
    }
    async fetchDiscovery() {
        const body = await this.getJson(`${this.issuer}/.well-known/openid-configuration`, 'Discovery de Sumego');
        if (!isRecord(body) || body.issuer !== this.issuer) {
            throw new OidcError('invalid', 'Discovery de Sumego con otro issuer.');
        }
        const issuerOrigin = new URL(this.issuer).origin;
        const endpoint = (value) => {
            // Los endpoints de Sumego viven en su mismo origen (`/oidc/*`, SPEC
            // §3). Exigirlo cierra que un discovery manipulado mande el código
            // o el secreto de cliente a otro sitio.
            if (typeof value !== 'string' || originOf(value) !== issuerOrigin) {
                throw new OidcError('invalid', 'Discovery de Sumego con un endpoint fuera de su origen.');
            }
            const url = new URL(value);
            if (url.hash !== '' || url.username !== '' || url.password !== '') {
                throw new OidcError('invalid', 'Discovery de Sumego con un endpoint inválido.');
            }
            return url.toString();
        };
        const value = {
            authorizationEndpoint: endpoint(body.authorization_endpoint),
            tokenEndpoint: endpoint(body.token_endpoint),
            jwksUri: endpoint(body.jwks_uri),
            // Opcional (RFC 7009): sin él, revocar el refresh no es posible y se
            // omite; la sesión muere igual en Sumego.
            ...(body.revocation_endpoint !== undefined ? { revocationEndpoint: endpoint(body.revocation_endpoint) } : {})
        };
        this.discovery = { value, expiresAt: this.now() + METADATA_CACHE_MS };
        return value;
    }
    /** JWKS con el mismo freno que el discovery: fuera de la caché fresca (o
     *  forzado por un `kid` desconocido), un intento por minuto; dentro de ese
     *  minuto, la copia que haya o `transient`. */
    async keys(forceRefresh) {
        const now = this.now();
        const cached = this.jwks;
        if (cached && !forceRefresh && cached.expiresAt > now)
            return cached.keys;
        if (this.jwksInFlight)
            return await this.jwksInFlight;
        if (this.jwksAttemptAt !== undefined && this.jwksAttemptAt + FETCH_COOLDOWN_MS > now) {
            if (cached)
                return cached.keys;
            throw new OidcError('transient', 'JWKS de Sumego: se reintenta en un minuto.');
        }
        this.jwksAttemptAt = now;
        this.jwksInFlight = this.fetchJwks().finally(() => {
            this.jwksInFlight = undefined;
        });
        return await this.jwksInFlight;
    }
    async fetchJwks() {
        const { jwksUri } = await this.metadata();
        const body = await this.getJson(jwksUri, 'JWKS de Sumego');
        if (!isRecord(body) || !Array.isArray(body.keys))
            throw new OidcError('invalid', 'JWKS de Sumego inválido.');
        const keys = [];
        for (const jwk of body.keys) {
            // Solo claves EC P-256 de firma. Las demás (RS256 si algún día se
            // publica para otro cliente, §4) se ignoran: este cliente no las usa.
            if (!isRecord(jwk) ||
                jwk.kty !== 'EC' ||
                jwk.crv !== 'P-256' ||
                typeof jwk.x !== 'string' ||
                typeof jwk.y !== 'string' ||
                'd' in jwk ||
                (jwk.use !== undefined && jwk.use !== 'sig') ||
                (jwk.alg !== undefined && jwk.alg !== 'ES256') ||
                (jwk.kid !== undefined && !claimString(jwk.kid))) {
                continue;
            }
            try {
                const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
                keys.push({ ...(typeof jwk.kid === 'string' ? { kid: jwk.kid } : {}), key });
            }
            catch {
                // Una clave que no se importa no firma nada nuestro.
            }
        }
        this.jwks = { keys, expiresAt: this.now() + METADATA_CACHE_MS };
        return keys;
    }
    async getJson(url, what) {
        let response;
        try {
            response = await this.fetchFn(url, {
                redirect: 'error',
                signal: AbortSignal.timeout(this.timeoutMs),
                headers: { accept: 'application/json' }
            });
        }
        catch {
            throw new OidcError('transient', `${what}: no se pudo contactar con Sumego.`);
        }
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            throw new OidcError(response.status >= 500 || response.status === 429 ? 'transient' : 'invalid', `${what}: Sumego respondió ${response.status}.`);
        }
        return await readBoundedJson(response, what);
    }
}
//# sourceMappingURL=sumego-oidc.js.map