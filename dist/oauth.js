import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BackchannelError, LUMBRE_OAUTH_CALLBACK, LumbreBackchannel, isValidRequestId } from './lumbre-oauth-backchannel.js';
import { forgetAccountNotesSeen, pruneStaleAccountNotesSeen } from './notes.js';
import { SUMEGO_PERSON_MESSAGES, exchangeFailure } from './sumego-messages.js';
import { OidcError, SumegoOidcClient, loginConfigFromEnv } from './sumego-oidc.js';
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
/**
 * Caducidad de un access token recién emitido: una hora, pero nunca más allá
 * de su familia (I1 del audit de seguridad del 10 oct 2026). Antes, el access
 * emitido en la última hora de la familia la sobrevivía hasta 1 h, porque
 * `resolveAccessToken` solo mira `accessExpiresAt` y la poda de la familia
 * espera a la siguiente escritura o al barrido horario. Se recorta al
 * emitir, que es un solo sitio, en vez de añadir otra condición al camino
 * caliente de cada `/mcp`.
 */
function accessExpiryFor(now, familyExpiresAt) {
    return Math.min(now + ACCESS_TTL_MS, familyExpiresAt);
}
/** `expires_in` de la respuesta, en segundos enteros y nunca 0. */
function expiresInSeconds(expiresAt, now) {
    return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_FORM_BYTES = 16 * 1024;
/**
 * Tiempo máximo para recibir el formulario de `/token` o `/revoke` (M3 del
 * audit de seguridad del 10 oct 2026). Sin él, la lectura heredaba el
 * `requestTimeout` de Node (300 s): unas pocas conexiones mandando el cuerpo
 * byte a byte retenían el trabajo durante cinco minutos. El formulario son
 * unos cientos de bytes y como mucho `MAX_FORM_BYTES`; 10 s le sobran a
 * cualquier red móvil y acotan lo que cuesta una conexión lenta a propósito.
 */
const FORM_READ_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PENDING_ITEMS = 1_000;
const MAX_CIMD_CACHE_ITEMS = 128;
const DEFAULT_CIMD_CACHE_MS = 5 * 60_000;
const MAX_CIMD_CACHE_MS = 60 * 60_000;
const MAX_REFRESH_TOMBSTONES = 10_000;
/**
 * Tombstones que se guardan por familia de refresh. Al llegar al tope se
 * descarta la MÁS ANTIGUA de esa familia (FIFO) y la rotación sigue; ver
 * `addRefreshTombstone`. Antes, llegar aquí revocaba la familia, y como las
 * tombstones viven lo que la familia (30 días) y el access dura una hora, un
 * uso continuado llegaba a la 65.ª rotación mucho antes de los 30 días y se
 * desconectaba solo (M1 del audit de seguridad del 10 oct 2026).
 */
const MAX_REFRESH_TOMBSTONES_PER_FAMILY = 64;
const MAX_OUTBOX_RETRIES_PER_READINESS = 1;
const READINESS_CACHE_MS = 5_000;
/**
 * Temporales que dejan `mutateStore` (`oauth-store.json.<pid>.<hex>.tmp`) y
 * la creación de la clave (`oauth.key.<pid>.<hex>.tmp`) si el proceso muere
 * entre el `open` y el `rename`/`link`: el `unlink` de su `finally` ya no
 * llega a correr. El del store es una copia COMPLETA del almacén (0600, con
 * las credenciales cifradas), así que no se deja ahí (I3 del audit de
 * seguridad y H10 del de recuperación, 10 oct 2026). Exacto a propósito: no
 * casa con los `.tmp` de la huella de notas (`notes.ts`), que no son de aquí.
 */
const ORPHAN_TEMP_PATTERN = /^(?:oauth-store\.json|oauth\.key)\.\d+\.[0-9a-f]{12}\.tmp$/;
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
/**
 * Freno de purga masiva del barrido (I4 del audit de seguridad del 10 oct
 * 2026): si en UNA pasada sale inactiva MÁS DE LA MITAD de las autorizaciones,
 * y hay al menos 5, no se purga ninguna, se deja una línea con el recuento y
 * se vuelve a mirar en el siguiente ciclo.
 *
 * Por qué: el barrido purga en cuanto Lumbre contesta `{active:false}`, y un
 * incidente allí (restaurar una base de datos sin la tabla de credenciales,
 * una migración mala) contestaría eso para TODAS: el relé desconectaría a
 * todo el mundo en una hora sin que nadie lo decidiera. Las bajas reales
 * llegan de una en una (alguien revoca la conexión o borra su cuenta), así
 * que más de la mitad en la misma hora no es uso, es un fallo de Lumbre.
 *
 * Por qué 5 de mínimo: con menos, cada autorización es una persona, y dos de
 * tres bajas en la misma hora son perfectamente posibles (el uso real son
 * 1-3 cuentas). Por debajo, el freno bloquearía bajas legítimas sin
 * distinguir nada. Lo que cuesta un falso positivo es poco: la autorización
 * retenida no autoriza nada nuevo, porque el refresh pregunta a Lumbre antes
 * de rotar y revoca si sale inactiva; solo tarda más en borrarse del disco
 * (como mucho, hasta que caduca la familia).
 */
const MASS_PURGE_MIN_GRANTS = 5;
const MASS_PURGE_MAX_RATIO = 0.5;
/**
 * `logout` es el back-channel logout de Sumego. Lo llama SU servidor, desde
 * una sola IP (el mismo VPS), y manda uno por app y sesión: «cerrar en todas»
 * son unos pocos de golpe. 60 por minuto cubre eso de sobra y acota lo que
 * cuesta un POST anónimo con un JWT inventado (una verificación de firma y,
 * como mucho una vez por minuto, una relectura del JWKS).
 */
const DEFAULT_PUBLIC_LIMITS = {
    authorize: { requestsPerMinute: 30, concurrent: 8 },
    token: { requestsPerMinute: 60, concurrent: 16 },
    revoke: { requestsPerMinute: 60, concurrent: 16 },
    logout: { requestsPerMinute: 60, concurrent: 8 }
};
/**
 * Cookie que ata una transacción de Sumego al NAVEGADOR que la abrió (SPEC
 * de Sumego §4 y §7.3). Se pone en `/authorize` y se exige en la vuelta de
 * Sumego y en el POST del consentimiento: quien tenga la URL de Sumego de
 * otra persona (o le cuele la suya) no puede terminar el flujo en otro
 * navegador. `__Host-` obliga a `Secure`, `Path=/` y sin `Domain`; `Lax`
 * porque la vuelta es una navegación GET desde id.lumbre.pro.
 *
 * UNA por navegador, como las de Sumego: si se abren dos conexiones a la vez
 * en el mismo navegador, la segunda pisa la cookie de la primera y esa
 * primera falla al volver. Precio aceptado: es un caso raro y se arregla
 * volviendo a conectar.
 */
const SUMEGO_BINDING_COOKIE = '__Host-lumbre-mcp-sumego';
const SUMEGO_CONSENT_PATH = '/oauth/sumego/consent';
/**
 * `jti` de logout tokens ya usados que se recuerdan a la vez. Cada uno vive
 * lo que su ventana de aceptación (`LOGOUT_TOKEN_MAX_AGE_MS` + margen, unos
 * minutos), y solo los firma Sumego, así que el uso real son unos pocos. Si
 * aun así se llena, se descarta el más antiguo: es el más cerca de caducar, y
 * rechazar un logout legítimo por falta de sitio sería peor (dejaría viva una
 * sesión que la persona quiso cerrar).
 */
const MAX_LOGOUT_TOKENS = 1_000;
/**
 * Cuánto se recuerda una sesión de Sumego cerrada (`ClosedSumegoSession`):
 * lo que puede durar una conexión a medias, que es la transacción
 * (`TRANSACTION_TTL_MS`, 10 min). Con tope, como los `jti`: si se llena, se
 * descarta la que antes caduca.
 */
const CLOSED_SUMEGO_SESSION_TTL_MS = 10 * 60_000;
const MAX_CLOSED_SUMEGO_SESSIONS = 1_000;
/**
 * Cada cuánto, como mucho, el `/token` de un grant de Sumego le pregunta a
 * Sumego si la sesión sigue viva (SPEC de Sumego §4: «la app renueva el
 * refresh cada hora y una cuenta suspendida no renueva»). Es lo que cierra el
 * grant si el back-channel logout se pierde.
 */
const SUMEGO_RECHECK_MS = 60 * 60_000;
/**
 * Margen con el que caduca en local el consentimiento antes de que Lumbre
 * rechace el ID token por viejo (M2 de la revisión de seguridad de c4534bc).
 * Lumbre acepta ID tokens de 5 minutos como mucho (más 60 s de margen); la
 * transacción duraba 10. El consentimiento caduca a los 5 minutos del `iat`
 * menos este margen, y lo que llegue tarde se queda en `consentInvalid` sin
 * gastar el canje.
 */
const ID_TOKEN_MAX_AGE_FOR_LUMBRE_MS = 5 * 60_000;
const CONSENT_EXPIRY_MARGIN_MS = 30_000;
/**
 * Presupuesto de `/authorize` que se gasta justo antes de crear el registro
 * en app.lumbre.pro (ver `enterAuthorizeBudget`). Cada `/authorize` válido
 * crea un registro real allí, así que limitar solo con el límite por IP de
 * `enterPublicEndpoint` (que cuenta también el callback y las peticiones
 * inválidas) dejaba barato llenar `MAX_PENDING_ITEMS` desde una botnet.
 *
 * El ORDEN es lo que importa (hallazgo 4 del audit de abuso del 10 oct 2026):
 * primero POR IP y solo después por `client_id`. Con 10 por `client_id` y sin
 * presupuesto por IP propio, doce peticiones desde doce IPs con el `client_id`
 * público de claude.ai bastaban para que nadie pudiera conectar claude.ai al
 * relé durante ese minuto. Ahora:
 *   · 3 por minuto e IP: una persona conectando claude.ai o Codex hace UNA,
 *     y dos o tres si cancela y reintenta. Una IP no puede gastar más.
 *   · 40 por minuto y `client_id`: red de seguridad, no el freno principal.
 *     Agotarla exige ya repartir el ataque en 14 IPs, y aun así deja 20 del
 *     global para los demás clientes (Codex).
 *   · 60 por minuto en total: el techo de registros que este relé crea en
 *     Lumbre, y con el TTL de 10 min, ~600 pendientes, por debajo de
 *     `MAX_PENDING_ITEMS`.
 * El uso legítimo son unas pocas autorizaciones a la HORA, así que ninguno de
 * los tres molesta a quien conecta de verdad.
 */
const DEFAULT_AUTHORIZE_BUDGET = { perIpPerMinute: 3, perClientPerMinute: 40, globalPerMinute: 60 };
/** Techo de ventanas por IP del presupuesto de `/authorize`. Expulsar una
 *  reinicia el cupo de ESA IP, pero el de `client_id` y el global siguen
 *  contando por debajo, así que llenar el mapa no abre la puerta. */
const MAX_AUTHORIZE_IP_WINDOWS = 2_048;
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
 *
 * También cuentan los 401 que devuelve LUMBRE a la credencial reenviada
 * (`recordUpstreamRejection`, hallazgo 2 del audit de abuso del 10 oct 2026).
 * Y con el cupo agotado, una credencial que este relé NO puede comprobar por
 * su cuenta (Bearer directo o token en el path) ya no se reenvía: recibe el
 * 429. Antes cualquier `Bearer x` llegaba a Lumbre sin límite (3000 de 3000
 * medidos). Un access `lm_at_` que resuelve sigue pasando siempre: ese sí se
 * comprueba aquí, y es el caso de claude.ai descrito arriba. Y tampoco se
 * corta una credencial directa que Lumbre aceptó hace poco
 * (`ACCEPTED_CREDENTIAL_TTL_MS`): una IP compartida no castiga al que ya
 * estaba trabajando.
 */
const DEFAULT_FAILED_MCP_ATTEMPTS_PER_MINUTE = 30;
/**
 * Cuánto recuerda el relé que Lumbre rechazó con 401 una credencial de `/mcp`
 * (hallazgo 2 del audit de abuso del 10 oct 2026; B6 del de seguridad). Un
 * bearer que no es `lm_at_` no se puede comprobar aquí y se reenvía tal cual:
 * sin esto, repetir el mismo bearer basura era una llamada a app.lumbre.pro
 * por petición, desde la IP compartida del relé. Durante este plazo esa
 * credencial recibe el 401 local (y gasta cupo de fallos) sin salir hacia
 * Lumbre. Unos segundos bastan para cortar la repetición en ráfaga y no
 * castigan a quien acaba de arreglar su token: un token NUEVO es otra clave.
 * Se guarda el SHA-256, nunca la credencial.
 */
const REJECTED_CREDENTIAL_TTL_MS = 15_000;
/** Techo de credenciales rechazadas recordadas a la vez; se expulsan las más
 *  antiguas. Con cientos de distintas por segundo el cupo de fallos por IP
 *  ya ha cortado mucho antes. */
const MAX_REJECTED_CREDENTIALS = 1_024;
/**
 * Cuánto recuerda el relé que Lumbre ACEPTÓ una credencial de `/mcp` que él
 * no puede comprobar por su cuenta (Bearer directo o token en el path). Con
 * el cupo de fallos de una IP agotado, esas credenciales dejan de reenviarse
 * (ver `DEFAULT_FAILED_MCP_ATTEMPTS_PER_MINUTE`), y sin esto una IP de salida
 * compartida castigaba a todos: bastaban los 401 de otro (claude.ai
 * reintentando un `lm_at_` caducado) para que el token válido de un tercero
 * recibiera 429. Con esta memoria, el corte solo alcanza a credenciales que
 * Lumbre no ha aceptado en los últimos 10 minutos: un cliente en uso las
 * renueva con cada llamada que llega a Lumbre, y un atacante que rota
 * bearers basura nunca entra. Un 401 posterior la saca en el acto.
 */
const ACCEPTED_CREDENTIAL_TTL_MS = 10 * 60_000;
/** Techo de credenciales aceptadas recordadas a la vez; se expulsan las más
 *  antiguas. El uso real son pocas cuentas. */
const MAX_ACCEPTED_CREDENTIALS = 1_024;
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
/**
 * Lee el cuerpo hasta `limit` bytes y en menos de `timeoutMs`. Pasado el
 * plazo responde 408 y deja de recibir (`stopReceiving`), igual que al
 * pasarse de tamaño: lo que siga llegando ya no se guarda ni se espera.
 */
async function readLimitedBody(req, limit = MAX_FORM_BYTES, timeoutMs = FORM_READ_TIMEOUT_MS) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
        stopReceiving(req);
        throw new OAuthError('invalid_request', 'Formulario demasiado grande.', 413);
    }
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            chunks.length = 0;
            reject(error);
        };
        const timer = setTimeout(() => {
            stopReceiving(req);
            fail(new OAuthError('invalid_request', 'El formulario tardó demasiado en llegar.', 408));
        }, timeoutMs);
        timer.unref();
        req.on('data', (chunk) => {
            if (settled)
                return;
            size += chunk.length;
            if (size > limit) {
                stopReceiving(req);
                fail(new OAuthError('invalid_request', 'Formulario demasiado grande.', 413));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', fail);
    });
}
async function readForm(req, timeoutMs) {
    const type = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
        throw new OAuthError('invalid_request', 'Se requiere application/x-www-form-urlencoded.');
    }
    return new URLSearchParams(await readLimitedBody(req, MAX_FORM_BYTES, timeoutMs));
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
/** AAD de lo cifrado de una transacción de Sumego: atado a su solicitud y a
 *  su `state`, para que no se pueda trasplantar a otra entrada del almacén. */
function sumegoContext(kind, request, stateHash) {
    return Buffer.from(JSON.stringify(['sumego-transaction', kind, request.requestId, stateHash, request.clientId, request.resource, request.scope]), 'utf8');
}
/** AAD del refresh de Sumego de un código o grant: atado a su credencial de
 *  Lumbre (que es la misma del código al grant y a través de las rotaciones)
 *  y distinto del de la credencial upstream, para que no se puedan cambiar
 *  el uno por el otro. */
function sumegoRefreshContext(holder) {
    return Buffer.from(JSON.stringify(['sumego-refresh', holder.credentialId, holder.clientId, holder.resource, holder.scope]), 'utf8');
}
/**
 * ¿Cerró un logout reciente esta sesión de Sumego DESPUÉS de emitirse su ID
 * token? (B1.) `>=` y no `>`: los `iat` van en segundos, y un logout en el
 * mismo segundo que el login es justo la carrera que esto cubre. El precio,
 * que un login hecho en el mismo segundo que un logout de su persona se corte,
 * se arregla volviendo a conectar.
 */
function closedAfter(store, subject, issuedAt, now) {
    const sid = digest(subject.sid);
    const sub = digest(subject.sub);
    return store.closedSumegoSessions.some((item) => item.expiresAt > now &&
        item.closedAt >= issuedAt &&
        ((item.kind === 'sid' && item.valueHash === sid) || (item.kind === 'sub' && item.valueHash === sub)));
}
function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
const PAGE_STYLE = 'body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:2rem 1rem;background:#faf8f5;color:#1f1b16}' +
    'main{max-width:28rem;margin:0 auto}h1{font-size:1.4rem;line-height:1.3;overflow-wrap:anywhere}' +
    'p,dd{overflow-wrap:anywhere}dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1rem}dt{font-weight:600}dd{margin:0}' +
    'form{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.5rem}' +
    'button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #6b5d4f;background:#fff;color:#1f1b16;cursor:pointer}' +
    'button[value=allow]{background:#b4451f;border-color:#b4451f;color:#fff}' +
    'button:focus-visible{outline:3px solid #1f6feb;outline-offset:2px}';
/**
 * Página HTML mínima del relé: el consentimiento y los errores del login
 * con Sumego. Sin scripts; todo lo variable llega ya escapado. `formAction`
 * son los orígenes a los que puede ir el POST del formulario: Chrome aplica
 * `form-action` también a la REDIRECCIÓN que sigue al envío (medido por
 * Sumego, SPEC §3), así que el del cliente (claude.ai, el loopback de Codex)
 * tiene que estar o el «Permitir» se queda en blanco.
 */
function htmlPage(res, status, page) {
    const headers = securityHeaders('text/html; charset=utf-8');
    headers['content-security-policy'] =
        "default-src 'none'; style-src 'unsafe-inline'; " +
            `form-action ${['\'self\'', ...(page.formAction ?? [])].join(' ')}; ` +
            "frame-ancestors 'none'; base-uri 'none'";
    res.writeHead(status, { ...headers, ...page.headers });
    res.end('<!doctype html><html lang="es"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        `<title>${escapeHtml(page.title)}</title><style>${PAGE_STYLE}</style></head>` +
        `<body><main>${page.body}</main></body></html>`);
}
/**
 * Página de error del login con Sumego. Solo enseña mensajes propios: los de
 * `OAuthError`, que son frases nuestras, o uno genérico.
 *
 * La cookie de atadura se borra SOLO si `burned` (la transacción se acaba de
 * quemar, y la cookie ya no ata nada). B2 de la revisión de seguridad de
 * c4534bc: antes la borraba siempre, y una respuesta falsificada (otro `iss`)
 * o una recarga de la vuelta dejaban sin cookie a la conexión buena, que
 * seguía viva en otra ventana.
 */
function sumegoErrorPage(res, error, burned) {
    const known = error instanceof OAuthError ? error : new OAuthError('server_error', SUMEGO_PERSON_MESSAGES.generic, 500);
    htmlPage(res, known.status, {
        title: 'No se pudo conectar con Lumbre',
        body: '<h1>No se pudo conectar con Lumbre</h1>' +
            `<p>${escapeHtml(known.message)}</p>` +
            '<p>Puedes cerrar esta ventana y volver a intentarlo desde la aplicación.</p>',
        ...(burned ? { headers: { 'set-cookie': clearBindingCookie() } } : {})
    });
}
function bindingCookie(value) {
    return `${SUMEGO_BINDING_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TRANSACTION_TTL_MS / 1000}`;
}
function clearBindingCookie() {
    return `${SUMEGO_BINDING_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
/** Valor de la cookie de atadura, si viene UNA y con la forma que emitimos. */
function bindingFrom(req) {
    const values = (req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${SUMEGO_BINDING_COOKIE}=`))
        .map((part) => part.slice(SUMEGO_BINDING_COOKIE.length + 1));
    return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]) ? values[0] : undefined;
}
function validSumegoSubject(value) {
    if (!value || typeof value !== 'object')
        return false;
    const subject = value;
    return (Object.keys(subject).length === 2 &&
        typeof subject.sub === 'string' &&
        subject.sub.length > 0 &&
        subject.sub.length <= 255 &&
        typeof subject.sid === 'string' &&
        subject.sid.length > 0 &&
        subject.sid.length <= 255);
}
function validSumegoTransaction(value) {
    if (!value || typeof value !== 'object')
        return false;
    const item = value;
    if (typeof item.stateHash !== 'string' ||
        typeof item.bindingHash !== 'string' ||
        !validEncryptedValue(item.secrets) ||
        (item.phase !== 'login' && item.phase !== 'callback' && item.phase !== 'consent')) {
        return false;
    }
    if (item.phase === 'consent') {
        return (typeof item.csrfHash === 'string' &&
            validEncryptedValue(item.idToken) &&
            validSumegoSubject(item.subject) &&
            Number.isFinite(item.issuedAt) &&
            validEncryptedValue(item.refresh));
    }
    return (item.csrfHash === undefined &&
        item.idToken === undefined &&
        item.subject === undefined &&
        item.issuedAt === undefined &&
        item.refresh === undefined);
}
/** Campos de `SumegoSession`: los dos opcionales, y si están, bien formados. */
function validSumegoSession(holder) {
    return ((holder.sumegoRefresh === undefined || (holder.sumego !== undefined && validEncryptedValue(holder.sumegoRefresh))) &&
        (holder.sumegoCheckedAt === undefined || Number.isFinite(holder.sumegoCheckedAt)));
}
/** ¿Pertenece esta identidad de Sumego a lo que pide el logout? Con `sid`
 *  manda la sesión (y si viene también `sub`, tiene que casar); con solo
 *  `sub`, todas las de esa persona. */
function logoutMatches(subject, claims) {
    if (!subject)
        return false;
    if (claims.sid !== undefined)
        return subject.sid === claims.sid && (claims.sub === undefined || subject.sub === claims.sub);
    return claims.sub !== undefined && subject.sub === claims.sub;
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
/**
 * ¿Es el MISMO valor cifrado? Compara el sobre (iv, tag y texto cifrado), no
 * el contenido: sirve para comprobar dentro de un mutador que la entrada del
 * almacén sigue siendo la que se leyó antes de un `await`. No necesita tiempo
 * constante: los dos lados salen de nuestro propio almacén, ninguno lo
 * presenta quien llama.
 */
function sameEncryptedValue(a, b) {
    return a.iv === b.iv && a.tag === b.tag && a.ciphertext === b.ciphertext;
}
/**
 * Credenciales upstream que el almacén tiene EN USO: las de los grants y las
 * de los códigos pendientes de canje. La outbox no cuenta a propósito: ahí la
 * credencial ya no autoriza nada, solo espera a que Lumbre confirme su
 * revocación.
 */
function heldCredentials(store) {
    return [...store.grants, ...store.authorizationCodes].map(({ credentialId, clientId, resource, scope, upstream }) => ({ credentialId, clientId, resource, scope, upstream }));
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
        !Array.isArray(raw.revocationOutbox) ||
        (raw.redeemedCodes !== undefined && !Array.isArray(raw.redeemedCodes)) ||
        (raw.usedLogoutTokens !== undefined && !Array.isArray(raw.usedLogoutTokens)) ||
        (raw.closedSumegoSessions !== undefined && !Array.isArray(raw.closedSumegoSessions))) {
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
            !validEncryptedValue(grant.upstream) ||
            (grant.sumego !== undefined && !validSumegoSubject(grant.sumego)) ||
            !validSumegoSession(grant)) {
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
            !Number.isFinite(item.expiresAt) ||
            (item.sumego !== undefined && !validSumegoTransaction(item.sumego))) {
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
            !validEncryptedValue(item.upstream) ||
            (item.sumego !== undefined && !validSumegoSubject(item.sumego)) ||
            !validSumegoSession(item)) {
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
    const redeemedCodes = (raw.redeemedCodes ?? []).map((value) => {
        if (!value || typeof value !== 'object')
            throw new Error('código canjeado OAuth inválido');
        const item = value;
        if (typeof item.codeHash !== 'string' || typeof item.familyId !== 'string' || !Number.isFinite(item.expiresAt)) {
            throw new Error('código canjeado OAuth inválido');
        }
        return item;
    });
    const usedLogoutTokens = (raw.usedLogoutTokens ?? []).map((value) => {
        if (!value || typeof value !== 'object')
            throw new Error('logout OAuth inválido');
        const item = value;
        if (typeof item.jtiHash !== 'string' || !Number.isFinite(item.expiresAt)) {
            throw new Error('logout OAuth inválido');
        }
        return item;
    });
    const closedSumegoSessions = (raw.closedSumegoSessions ?? []).map((value) => {
        if (!value || typeof value !== 'object')
            throw new Error('sesión cerrada OAuth inválida');
        const item = value;
        if ((item.kind !== 'sid' && item.kind !== 'sub') ||
            typeof item.valueHash !== 'string' ||
            !Number.isFinite(item.closedAt) ||
            !Number.isFinite(item.expiresAt)) {
            throw new Error('sesión cerrada OAuth inválida');
        }
        return item;
    });
    const stateHashes = authorizationRequests.flatMap((item) => (item.sumego ? [item.sumego.stateHash] : []));
    if (closedSumegoSessions.length > MAX_CLOSED_SUMEGO_SESSIONS ||
        usedLogoutTokens.length > MAX_LOGOUT_TOKENS ||
        new Set(usedLogoutTokens.map((item) => item.jtiHash)).size !== usedLogoutTokens.length ||
        new Set(stateHashes).size !== stateHashes.length) {
        throw new Error('store OAuth incoherente');
    }
    const credentialIds = [
        ...grants.map((item) => item.credentialId),
        ...authorizationCodes.map((item) => item.credentialId),
        ...revocationOutbox.map((item) => item.credentialId)
    ];
    const opaqueHashes = [
        ...grants.flatMap((item) => [item.accessHash, item.refreshHash]),
        ...usedRefreshTokens.map((item) => item.hash),
        ...authorizationCodes.map((item) => item.codeHash),
        ...redeemedCodes.map((item) => item.codeHash)
    ];
    if (authorizationCodes.length > MAX_PENDING_ITEMS ||
        redeemedCodes.length > MAX_PENDING_ITEMS ||
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
        revocationOutbox,
        redeemedCodes,
        usedLogoutTokens,
        closedSumegoSessions
    };
}
/** Suma uno a la ventana de `key`, creándola si no existe; al crearla expulsa
 *  las más antiguas si el mapa llegó a `max`. */
function consumeBoundedWindow(windows, key, now, max) {
    const window = windows.get(key);
    if (window) {
        window.count += 1;
        return;
    }
    while (windows.size >= max)
        windows.delete(windows.keys().next().value);
    windows.set(key, { startedAt: now, count: 1 });
}
/** Crea `path` con `wx` y 0600, escribe `content` y hace `fsync`. Devuelve
 *  `false` si ya existía (`EEXIST`), sin tocarlo. */
async function writeExclusive(path, content) {
    let handle;
    try {
        handle = await open(path, 'wx', 0o600);
    }
    catch (error) {
        if (error.code === 'EEXIST')
            return false;
        throw error;
    }
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    return true;
}
/** Anota `hash` hasta `now + ttl` en un mapa hash → caducidad: retira las
 *  caducadas, y al llegar a `max` expulsa las más antiguas. */
function rememberCredential(memory, hash, now, ttl, max) {
    for (const [key, expiresAt] of memory) {
        if (expiresAt <= now)
            memory.delete(key);
    }
    memory.delete(hash);
    while (memory.size >= max)
        memory.delete(memory.keys().next().value);
    memory.set(hash, now + ttl);
}
/** ¿Sigue vigente `hash` en un mapa de `rememberCredential`? */
function isRemembered(memory, hash, now) {
    const expiresAt = memory.get(hash);
    if (expiresAt === undefined)
        return false;
    if (expiresAt > now)
        return true;
    memory.delete(hash);
    return false;
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
    linkFile;
    backchannel;
    encryptionKey;
    keyPromise;
    rateWindows = new Map();
    /** SHA-256 de credencial rechazada por Lumbre → hasta cuándo se recuerda;
     *  ver `recordUpstreamRejection`. */
    rejectedCredentials = new Map();
    /** SHA-256 de credencial aceptada por Lumbre → hasta cuándo se recuerda;
     *  ver `recordUpstreamAcceptance`. */
    acceptedCredentials = new Map();
    /** Ventanas del presupuesto de `/authorize`, fuera de `rateWindows` para
     *  que la expulsión por tamaño de ese mapa no pueda reiniciarlas; ver
     *  `enterAuthorizeBudget`. */
    authorizeGlobalWindow;
    authorizeClientWindows = new Map();
    authorizeIpWindows = new Map();
    /** Huecos de `MAX_PENDING_ITEMS` apartados por un `/authorize` que está
     *  hablando con Lumbre y aún no ha guardado su pendiente; ver
     *  `reservePendingSlot`. */
    pendingReservations = 0;
    inFlight = { authorize: 0, token: 0, revoke: 0, logout: 0 };
    login;
    sumego;
    sumegoRenewalJoined;
    clientMetadataCache = new Map();
    clientMetadataInFlight = new Map();
    readinessCache;
    readinessInFlight;
    writeQueue = Promise.resolve();
    authorizeBudget;
    failedMcpAttemptsPerMinute;
    formReadTimeoutMs;
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
    /** Hay un `sweepInactiveCredentials` en curso; ver ahí por qué solo uno. */
    sweepInFlight = false;
    /** Índice `accessHash` → grant del store del que salió; ver
     *  `grantByAccessHash`. */
    accessIndex;
    /** La limpieza de temporales huérfanos ya corrió en este proceso; ver
     *  `removeOrphanTemps`. */
    orphanTempsRemoved = false;
    /** Renovación de Sumego en vuelo por `familyId`; ver `renewSumegoSession`. */
    sumegoRenewals = new Map();
    /** Revocaciones best-effort en Sumego aún en vuelo; ver
     *  `revokeSumegoRefreshLater`. */
    backgroundTasks = new Set();
    constructor(options = {}) {
        this.stateDir = options.stateDir ?? defaultStateDir();
        this.fetchFn = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.persistenceStep = options.persistenceStep;
        this.storeRead = options.storeRead;
        this.linkFile = options.linkFile ?? link;
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
            revoke: { ...DEFAULT_PUBLIC_LIMITS.revoke, ...options.publicLimits?.revoke },
            logout: { ...DEFAULT_PUBLIC_LIMITS.logout, ...options.publicLimits?.logout }
        };
        // El proveedor se fija al construir: un valor desconocido o `sumego` sin
        // secreto lanzan aquí, y `http.ts` no abre el listener.
        this.login = options.login ?? loginConfigFromEnv();
        this.sumego = options.sumego ?? new SumegoOidcClient({ config: this.login.sumego, fetch: this.fetchFn, now: this.now });
        if (this.login.provider === 'sumego')
            this.sumego.ensureConfigured();
        this.sumegoRenewalJoined = options.sumegoRenewalJoined;
        this.authorizeBudget = { ...DEFAULT_AUTHORIZE_BUDGET, ...options.authorizeBudget };
        this.failedMcpAttemptsPerMinute = options.failedMcpAttemptsPerMinute ?? DEFAULT_FAILED_MCP_ATTEMPTS_PER_MINUTE;
        this.formReadTimeoutMs = options.formReadTimeoutMs ?? FORM_READ_TIMEOUT_MS;
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
     * consulta `handleMcpRequest` (`http.ts`) después de intentar resolver la
     * credencial, en dos sitios: en la rama sin credencial utilizable (429 en
     * vez de 401), y antes de reenviar una credencial que el relé no puede
     * comprobar (Bearer directo o token en el path) y que Lumbre no aceptó en
     * los últimos `ACCEPTED_CREDENTIAL_TTL_MS`. Un access `lm_at_` que
     * resuelve, o una credencial directa aceptada hace poco, no lo consulta.
     * Ver `DEFAULT_FAILED_MCP_ATTEMPTS_PER_MINUTE`.
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
     * Lumbre respondió 401 a la credencial que presentó esta petición: cuenta
     * como un fallo de `/mcp` de esa IP y se recuerda su hash durante
     * `REJECTED_CREDENTIAL_TTL_MS` (ver `isRejectedCredential`). `credential`
     * es lo que presentó el CLIENTE (el bearer, `lm_at_` incluido, o el token
     * del path), no la credencial upstream en la que se resolvió.
     */
    recordUpstreamRejection(req, credential) {
        this.recordFailedMcpAttempt(req);
        const hash = digest(credential);
        this.acceptedCredentials.delete(hash);
        rememberCredential(this.rejectedCredentials, hash, this.now(), REJECTED_CREDENTIAL_TTL_MS, MAX_REJECTED_CREDENTIALS);
    }
    /** ¿Rechazó Lumbre esta credencial hace menos de
     *  `REJECTED_CREDENTIAL_TTL_MS`? Se busca por su SHA-256, que quien llama
     *  no puede elegir bit a bit, así que el `Map` no abre canal temporal. */
    isRejectedCredential(credential) {
        return isRemembered(this.rejectedCredentials, digest(credential), this.now());
    }
    /**
     * Lumbre respondió 2xx a la credencial que presentó esta petición: se
     * recuerda su hash durante `ACCEPTED_CREDENTIAL_TTL_MS` para que el cupo
     * de fallos de la IP no la corte (ver `isAcceptedCredential`). Mismo
     * `credential` que en `recordUpstreamRejection`.
     */
    recordUpstreamAcceptance(credential) {
        const hash = digest(credential);
        this.rejectedCredentials.delete(hash);
        rememberCredential(this.acceptedCredentials, hash, this.now(), ACCEPTED_CREDENTIAL_TTL_MS, MAX_ACCEPTED_CREDENTIALS);
    }
    /** ¿Aceptó Lumbre esta credencial hace menos de
     *  `ACCEPTED_CREDENTIAL_TTL_MS`? Por su SHA-256, como la de rechazadas. */
    isAcceptedCredential(credential) {
        return isRemembered(this.acceptedCredentials, digest(credential), this.now());
    }
    /**
     * Presupuesto de `/authorize` por IP, por `client_id` y global, que se
     * gasta JUSTO ANTES de llamar al backchannel — el orden es el punto:
     * pasada esta puerta, la petición crea un registro real en app.lumbre.pro.
     *
     * Se mira primero la IP y no se gasta NADA si alguno de los tres está
     * agotado: así una IP que insiste se queda en su propio cupo y no se come
     * el del `client_id` público (ver `DEFAULT_AUTHORIZE_BUDGET`).
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
    enterAuthorizeBudget(clientId, remote) {
        const now = this.now();
        if (this.authorizeGlobalWindow && this.authorizeGlobalWindow.startedAt + 60_000 <= now) {
            this.authorizeGlobalWindow = undefined;
        }
        for (const windows of [this.authorizeIpWindows, this.authorizeClientWindows]) {
            for (const [key, window] of windows) {
                if (window.startedAt + 60_000 <= now)
                    windows.delete(key);
            }
        }
        const ipWindow = this.authorizeIpWindows.get(remote);
        if (ipWindow !== undefined && ipWindow.count >= this.authorizeBudget.perIpPerMinute) {
            throw new OAuthError('temporarily_unavailable', 'Demasiadas autorizaciones desde esta conexión; inténtalo de nuevo más tarde.', 429);
        }
        const clientWindow = this.authorizeClientWindows.get(clientId);
        if ((clientWindow !== undefined && clientWindow.count >= this.authorizeBudget.perClientPerMinute) ||
            (this.authorizeGlobalWindow !== undefined &&
                this.authorizeGlobalWindow.count >= this.authorizeBudget.globalPerMinute)) {
            throw new OAuthError('temporarily_unavailable', 'Demasiadas autorizaciones en curso; inténtalo de nuevo más tarde.', 429);
        }
        consumeBoundedWindow(this.authorizeIpWindows, remote, now, MAX_AUTHORIZE_IP_WINDOWS);
        consumeBoundedWindow(this.authorizeClientWindows, clientId, now, MAX_AUTHORIZE_CLIENT_WINDOWS);
        if (this.authorizeGlobalWindow)
            this.authorizeGlobalWindow.count += 1;
        else
            this.authorizeGlobalWindow = { startedAt: now, count: 1 };
    }
    /**
     * Aparta un hueco de `MAX_PENDING_ITEMS` ANTES de llamar al backchannel y
     * devuelve cómo soltarlo (hallazgo 7 del audit de abuso del 10 oct 2026).
     * Mirar el tope solo contra lo guardado dejaba una carrera: ocho
     * `/authorize` concurrentes con 999 pendientes veían todos sitio, los ocho
     * creaban su registro en Lumbre y siete se rechazaban después, huérfanos.
     *
     * La comprobación va DENTRO de un mutador: la cola de `mutateStore` la
     * ordena con las escrituras, así que ve lo ya guardado (con la poda de
     * caducadas hecha) más lo apartado por quien sigue hablando con Lumbre. El
     * mutador no escribe nada por sí mismo.
     */
    async reservePendingSlot() {
        let reserved = false;
        try {
            await this.mutateStore((store) => {
                if (store.authorizationRequests.length + this.pendingReservations >= MAX_PENDING_ITEMS)
                    return false;
                this.pendingReservations += 1;
                reserved = true;
                return false;
            });
        }
        catch (error) {
            if (reserved)
                this.pendingReservations -= 1;
            throw error;
        }
        if (!reserved)
            throw new OAuthError('temporarily_unavailable', 'Hay demasiadas autorizaciones pendientes.', 503);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.pendingReservations -= 1;
        };
    }
    /** Límite por ritmo e IP Y ranura de concurrencia, de una vez: para las
     *  rutas que no leen cuerpo (`/authorize`, el callback). */
    enterPublicEndpoint(req, endpoint) {
        const key = this.checkRateLimit(req, endpoint);
        this.checkConcurrency(endpoint);
        this.consumeRateWindow(key, this.now());
        return this.takeConcurrencySlot(endpoint);
    }
    /**
     * Solo el límite por ritmo e IP, gastándolo. Lo usan `/token` y
     * `/revoke`, que toman la ranura de concurrencia DESPUÉS de leer el
     * formulario (`enterConcurrency`): tomarla antes dejaba que unas pocas
     * conexiones lentas ocuparan las 16 ranuras globales mientras mandaban el
     * cuerpo, y todos los refresh legítimos recibían 429 (M3 del audit de
     * seguridad del 10 oct 2026). La lectura ya está acotada en tamaño y en
     * tiempo (`readLimitedBody`) y no toca el store ni Lumbre, así que no
     * necesita ranura.
     */
    enterRateLimit(req, endpoint) {
        const key = this.checkRateLimit(req, endpoint);
        this.consumeRateWindow(key, this.now());
    }
    /** Ranura de concurrencia global del endpoint; devuelve cómo soltarla. */
    enterConcurrency(endpoint) {
        this.checkConcurrency(endpoint);
        return this.takeConcurrencySlot(endpoint);
    }
    /** ¿Le queda cupo del minuto a esta IP? Lanza 429 si no; no gasta nada. */
    checkRateLimit(req, endpoint) {
        this.pruneRateWindows(this.now());
        const key = `${endpoint}:${this.remoteAddressOf(req)}`;
        if (this.overRateLimit(key, this.publicLimits[endpoint].requestsPerMinute)) {
            throw new OAuthError('temporarily_unavailable', 'Demasiadas solicitudes; inténtalo de nuevo más tarde.', 429);
        }
        return key;
    }
    checkConcurrency(endpoint) {
        if (this.inFlight[endpoint] >= this.publicLimits[endpoint].concurrent) {
            throw new OAuthError('temporarily_unavailable', 'El servidor está ocupado; inténtalo de nuevo.', 429);
        }
    }
    takeConcurrencySlot(endpoint) {
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
        let releaseReservation;
        try {
            release = this.enterPublicEndpoint(req, 'authorize');
            if (req.method !== 'GET')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            const request = this.authorizationRequest(url.searchParams);
            const metadata = await this.clientMetadata(request.clientId);
            if (!metadata.redirect_uris.some((registered) => registeredRedirectMatches(request.clientId, request.redirectUri, registered))) {
                throw new OAuthError('invalid_request', 'redirect_uri no registrado.');
            }
            // La URI que el almacén aceptará guardar para este cliente, mirada
            // AQUÍ y no solo en `normalizeStore` (B2 del audit de seguridad del
            // 10 oct 2026). Si el CIMD de un `client_id` de claude.ai registraba
            // otra URI, la comprobación de arriba pasaba, se creaba el registro
            // en Lumbre y el rechazo llegaba al guardar: un 500 y un registro
            // huérfano allí. Ahora es un 400 antes de gastar presupuesto.
            if (!validStoredRedirect(request.clientId, request.redirectUri)) {
                throw new OAuthError('invalid_request', 'redirect_uri no admitido para este cliente.');
            }
            const clientName = metadata.client_name.trim().slice(0, 120);
            // Las DOS puertas antes de tocar app.lumbre.pro: el presupuesto
            // (por IP, por `client_id` y global; el límite por IP de
            // `enterPublicEndpoint` no basta, se reparte entre IPs), y un hueco
            // apartado en la cola de pendientes. Lo de `MAX_PENDING_ITEMS` se
            // comprobaba DESPUÉS del backchannel: llenar la cola dejaba mil
            // registros creados en Lumbre que aquí ni se guardaban.
            this.enterAuthorizeBudget(request.clientId, this.remoteAddressOf(req));
            releaseReservation = await this.reservePendingSlot();
            if (this.login.provider === 'sumego') {
                await this.redirectToSumego(res, request, clientName);
                return;
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
            releaseReservation?.();
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
            //
            // Las solicitudes de un login con Sumego no son de este callback:
            // su `requestId` también es de Lumbre, pero se cierran por
            // `/oauth/sumego/consent`. Sin el filtro, quien conociera ese UUID
            // podría quemarlas desde aquí.
            const stored = (await this.loadStore()).authorizationRequests.find((item) => item.requestId === requestId && item.sumego === undefined);
            if (!stored || stored.expiresAt <= this.now()) {
                throw new OAuthError('invalid_request', 'La autorización ha caducado, ya fue usada o no existe.');
            }
            if (decision === 'denied') {
                this.redirectToClient(res, stored, { error: 'access_denied' });
                return;
            }
            let pending;
            await this.mutateStore((store) => {
                const found = store.authorizationRequests.find((item) => item.requestId === requestId && item.sumego === undefined);
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
            const code = await this.storeAuthorizationCode(authorized, credential);
            this.redirectToClient(res, authorized, { code });
        }
        catch (error) {
            oauthError(res, error);
        }
        finally {
            release?.();
        }
    }
    /**
     * Guarda el código de autorización de una credencial recién canjeada en
     * Lumbre y lo devuelve. Común a los dos logins (Lumbre y Sumego): con
     * Sumego, `sumego` lleva la identidad y el refresh que hereda el grant.
     *
     * Con Sumego, dentro del mismo mutador que lo guarda, se mira si un logout
     * cerró ya esa sesión después del ID token (B1): el logout pudo llegar
     * mientras se canjeaba con Lumbre, cuando todavía no había nada que
     * revocar. Entonces no se guarda, y la credencial va a la outbox.
     *
     * Si la credencial no es la pedida, o el código no se puede guardar, se
     * revoca en Lumbre por la outbox antes de fallar: nunca se queda una
     * credencial viva allí que este relé no conozca.
     */
    async storeAuthorizationCode(authorized, credential, sumego) {
        if (credential.resource !== authorized.resource || credential.scope !== authorized.scope) {
            await this.persistCredentialRevocation(credential, authorized);
            throw new OAuthError('server_error', 'Lumbre devolvió una credencial fuera de contrato.', 502);
        }
        const code = opaque('lm_code_');
        const key = await this.key();
        try {
            await this.mutateStore((store) => {
                const now = this.now();
                if (sumego && closedAfter(store, sumego.subject, sumego.issuedAt, now)) {
                    throw new OAuthError('access_denied', SUMEGO_PERSON_MESSAGES.sessionClosed, 403);
                }
                store.authorizationCodes = store.authorizationCodes.filter((item) => item.expiresAt > now);
                if (store.authorizationCodes.length >= MAX_PENDING_ITEMS) {
                    throw new OAuthError('temporarily_unavailable', 'Hay demasiados códigos pendientes.', 503);
                }
                const holder = {
                    credentialId: credential.credentialId,
                    clientId: authorized.clientId,
                    resource: authorized.resource,
                    scope: authorized.scope
                };
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
                    expiresAt: now + CODE_TTL_MS,
                    ...(sumego
                        ? {
                            sumego: { sub: sumego.subject.sub, sid: sumego.subject.sid },
                            sumegoRefresh: encrypt(sumego.refreshToken, key, sumegoRefreshContext(holder)),
                            // Sumego confirmó la sesión al emitir el ID token.
                            sumegoCheckedAt: sumego.issuedAt
                        }
                        : {})
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
        return code;
    }
    /**
     * `/authorize` con `LUMBRE_MCP_LOGIN_PROVIDER=sumego`: todo lo de
     * `handleAuthorize` ya se ha comprobado (cliente, redirect, PKCE del
     * cliente, presupuesto, hueco en la cola). Aquí:
     *   1. Se generan `state`, `nonce`, el `code_verifier` de PKCE hacia
     *      Sumego y el valor de la cookie de atadura. Todos aleatorios de 256
     *      bits y de un solo uso.
     *   2. El discovery de Sumego, ANTES de crear nada en Lumbre: con Sumego
     *      caído el `/authorize` falla aquí, sin dejar un registro huérfano.
     *   3. La solicitud en Lumbre (`createSumegoAuthorizationRequest`), con el
     *      hash del `nonce`: Lumbre ata a ella el ID token que verá en el canje.
     *   4. Se guarda la transacción, cifrada como la de siempre, y se manda a
     *      la persona a Sumego con la cookie puesta.
     */
    async redirectToSumego(res, request, clientName) {
        const state = randomBytes(32).toString('base64url');
        const nonce = randomBytes(32).toString('base64url');
        const codeVerifier = randomBytes(32).toString('base64url');
        const binding = randomBytes(32).toString('base64url');
        const transactionId = randomBytes(32).toString('base64url');
        let authorizationUrl;
        try {
            authorizationUrl = await this.sumego.authorizationUrl({
                state,
                nonce,
                codeChallenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
            });
        }
        catch (error) {
            throw this.sumegoOAuthError(error);
        }
        let created;
        try {
            created = await this.backchannel.createSumegoAuthorizationRequest({
                transactionId,
                clientId: request.clientId,
                clientName,
                resource: request.resource,
                scope: request.scope,
                callbackUri: LUMBRE_OAUTH_CALLBACK,
                identityProvider: 'sumego',
                sumegoNonceSha256: createHash('sha256').update(nonce, 'utf8').digest('base64url')
            });
        }
        catch (error) {
            throw this.backchannelOAuthError(error);
        }
        if (created.expiresAt <= this.now() || created.expiresAt > this.now() + TRANSACTION_TTL_MS + 5 * 60_000) {
            throw new OAuthError('server_error', 'Lumbre devolvió una autorización fuera de contrato.', 502);
        }
        const expiresAt = Math.min(created.expiresAt, this.now() + TRANSACTION_TTL_MS);
        const stateHash = digest(state);
        const key = await this.key();
        await this.mutateStore((store) => {
            store.authorizationRequests = store.authorizationRequests.filter((item) => item.expiresAt > this.now());
            if (store.authorizationRequests.length >= MAX_PENDING_ITEMS) {
                throw new OAuthError('temporarily_unavailable', 'Hay demasiadas autorizaciones pendientes.', 503);
            }
            const pending = {
                ...request,
                requestId: created.requestId,
                transaction: encrypt(transactionId, key, transactionContext(created.requestId, request.clientId, request.resource, request.scope)),
                clientName,
                expiresAt
            };
            pending.sumego = {
                stateHash,
                bindingHash: digest(binding),
                phase: 'login',
                secrets: encrypt(JSON.stringify({ nonce, codeVerifier }), key, sumegoContext('secrets', pending, stateHash))
            };
            store.authorizationRequests.push(pending);
            return true;
        });
        res.writeHead(302, {
            ...securityHeaders('text/plain; charset=utf-8'),
            location: authorizationUrl,
            'set-cookie': bindingCookie(binding)
        });
        res.end('Redirigiendo a Sumego.');
    }
    /**
     * Vuelta de Sumego (`/oauth/sumego/callback`). En este orden, y el orden
     * es la seguridad:
     *   1. `iss` presente e igual al issuer (RFC 9207), TAMBIÉN en una
     *      respuesta de error. Si no, 400 sin tocar nada: no se sabe de quién
     *      es la respuesta.
     *   2. El `state` consume la transacción (`login` → `callback`) de forma
     *      atómica: una segunda vuelta con el mismo `state` ya no la encuentra.
     *   3. La cookie de atadura. Sin ella o distinta, la transacción se quema
     *      (SPEC de Sumego §7.3): quien abrió el flujo no es este navegador.
     *   4. Un `error` de Sumego vuelve al cliente con `access_denied` (o el
     *      código estándar que traiga) y su `iss`.
     *   5. El canje del `code` y la validación del ID token
     *      (`SumegoOidcClient.redeemCode`).
     *   6. `callback` → `consent`, con el ID token y el refresh de Sumego
     *      cifrados y el hash de un token CSRF nuevo, y la página de
     *      consentimiento. En el mismo mutador: si un logout cerró ya esta
     *      sesión (B1), se quema en vez de avanzar; y el consentimiento caduca
     *      antes de que el ID token deje de valer para Lumbre (M2).
     * Cualquier fallo a partir del paso 2 quema la transacción, y solo
     * entonces se borra la cookie (B2). Una vuelta con el `state` de una
     * transacción que ya pasó de `login` (una recarga, un doble clic) no quema
     * nada: dice que la página ya se usó y deja la cookie, porque la
     * confirmación sigue abierta en la otra ventana.
     */
    async handleSumegoCallback(req, res, url) {
        let release;
        let consumed;
        let burned = false;
        /** Refresh de Sumego recién obtenido y aún no guardado: si el flujo
         *  muere aquí, se revoca en Sumego (sin guardar, nadie lo usaría). */
        let orphanRefresh;
        try {
            release = this.enterPublicEndpoint(req, 'authorize');
            if (req.method !== 'GET')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            const iss = one(url.searchParams, 'iss', false);
            if (iss === undefined || iss !== this.sumego.issuer) {
                throw new OAuthError('invalid_request', SUMEGO_PERSON_MESSAGES.wrongIssuer);
            }
            const state = one(url.searchParams, 'state');
            const stateHash = digest(state);
            let alreadyUsed = false;
            await this.mutateStore((store) => {
                const found = store.authorizationRequests.find((item) => item.sumego !== undefined && matchesHash(item.sumego.stateHash, stateHash));
                if (!found || found.expiresAt <= this.now())
                    return false;
                if (found.sumego.phase !== 'login') {
                    alreadyUsed = true;
                    return false;
                }
                found.sumego.phase = 'callback';
                consumed = structuredClone(found);
                return true;
            });
            if (alreadyUsed)
                throw new OAuthError('invalid_request', SUMEGO_PERSON_MESSAGES.alreadyUsed);
            if (!consumed)
                throw new OAuthError('invalid_request', SUMEGO_PERSON_MESSAGES.expired);
            const pending = consumed;
            const binding = bindingFrom(req);
            if (!binding || !matchesHash(pending.sumego.bindingHash, digest(binding))) {
                throw new OAuthError('invalid_request', SUMEGO_PERSON_MESSAGES.otherBrowser);
            }
            const idpError = one(url.searchParams, 'error', false);
            if (idpError !== undefined) {
                await this.discardSumegoTransaction(pending.requestId);
                consumed = undefined;
                const error = idpError === 'server_error' || idpError === 'temporarily_unavailable' ? idpError : 'access_denied';
                this.redirectToClient(res, pending, { error }, { 'set-cookie': clearBindingCookie() });
                return;
            }
            const code = one(url.searchParams, 'code');
            const key = await this.key();
            const secrets = JSON.parse(decrypt(pending.sumego.secrets, key, sumegoContext('secrets', pending, stateHash)));
            let redeemed;
            try {
                redeemed = await this.sumego.redeemCode(code, secrets.codeVerifier, secrets.nonce);
            }
            catch (error) {
                throw this.sumegoOAuthError(error);
            }
            orphanRefresh = redeemed.refreshToken;
            const subject = { sub: redeemed.identity.sub, sid: redeemed.identity.sid };
            const csrf = randomBytes(32).toString('base64url');
            // `as`: se asigna dentro del mutador, y sin él TS lo estrecha a 'gone'.
            let outcome = 'gone';
            await this.mutateStore((store) => {
                const now = this.now();
                const found = store.authorizationRequests.find((item) => item.requestId === pending.requestId && item.sumego?.phase === 'callback');
                if (!found || found.expiresAt <= now || !matchesHash(found.sumego.stateHash, stateHash))
                    return false;
                if (closedAfter(store, subject, redeemed.issuedAt, now)) {
                    store.authorizationRequests = store.authorizationRequests.filter((item) => item !== found);
                    outcome = 'closed';
                    return true;
                }
                found.expiresAt = Math.min(found.expiresAt, redeemed.issuedAt + ID_TOKEN_MAX_AGE_FOR_LUMBRE_MS - CONSENT_EXPIRY_MARGIN_MS);
                found.sumego = {
                    ...found.sumego,
                    phase: 'consent',
                    csrfHash: digest(csrf),
                    idToken: encrypt(redeemed.idToken, key, sumegoContext('id-token', found, stateHash)),
                    subject,
                    issuedAt: redeemed.issuedAt,
                    refresh: encrypt(redeemed.refreshToken, key, sumegoContext('refresh', found, stateHash))
                };
                outcome = 'consent';
                return true;
            });
            if (outcome === 'closed') {
                consumed = undefined;
                burned = true;
                throw new OAuthError('access_denied', SUMEGO_PERSON_MESSAGES.sessionClosed, 403);
            }
            if (outcome === 'gone')
                throw new OAuthError('invalid_request', SUMEGO_PERSON_MESSAGES.expired);
            consumed = undefined;
            orphanRefresh = undefined;
            this.consentPage(res, pending, csrf, redeemed.identity.email);
        }
        catch (error) {
            if (consumed) {
                burned = true;
                await this.discardSumegoTransaction(consumed.requestId).catch(() => undefined);
            }
            if (orphanRefresh)
                this.revokeSumegoRefreshLater(orphanRefresh);
            sumegoErrorPage(res, error, burned);
        }
        finally {
            release?.();
        }
    }
    /** Página de consentimiento: quién pide acceso, a dónde vuelve y con qué
     *  cuenta. El nombre del cliente viene de su CIMD (de fuera), así que todo
     *  pasa por `escapeHtml`. */
    consentPage(res, pending, csrf, email) {
        const redirect = new URL(pending.redirectUri);
        const clientName = escapeHtml(pending.clientName);
        htmlPage(res, 200, {
            title: 'Conectar con Lumbre',
            formAction: [redirect.origin],
            body: `<h1>¿Dar acceso a ${clientName} a tu Lumbre?</h1>` +
                `<p>${clientName} podrá leer y cambiar tus tareas, proyectos y áreas de Lumbre en tu nombre, hasta que lo desconectes.</p>` +
                '<dl>' +
                `<dt>Aplicación</dt><dd>${clientName}</dd>` +
                `<dt>Vuelve a</dt><dd>${escapeHtml(redirect.host)}</dd>` +
                `<dt>Cuenta</dt><dd>${escapeHtml(email ?? 'Tu cuenta de Lumbre')}</dd>` +
                '</dl>' +
                `<p>${escapeHtml(SUMEGO_PERSON_MESSAGES.consentDeadline)}</p>` +
                `<form method="post" action="${SUMEGO_CONSENT_PATH}">` +
                `<input type="hidden" name="request" value="${escapeHtml(pending.requestId)}">` +
                `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
                '<button type="submit" name="decision" value="allow">Permitir</button>' +
                '<button type="submit" name="decision" value="deny">Cancelar</button>' +
                '</form>'
        });
    }
    /**
     * POST del consentimiento (`/oauth/sumego/consent`). Exige la cookie de
     * atadura y el token CSRF de ESA transacción, y la consume entera en el
     * mismo paso: un segundo POST ya no la encuentra. Un CSRF o una cookie
     * que no casan NO la queman (si no, cualquiera que adivinara el
     * `requestId` podría abortar el consentimiento de otra persona), pero
     * tampoco canjean nada.
     *
     * «Cancelar» vuelve al cliente con `access_denied` e `iss`. «Permitir»
     * canjea el ID token en Lumbre (`exchangeSumegoIdentity`) y sigue igual
     * que el callback de Lumbre: código de autorización y vuelta al cliente.
     */
    async handleSumegoConsent(req, res) {
        let release;
        let burned = false;
        /** Refresh de Sumego de la transacción consumida mientras no esté
         *  guardado en un código: si el flujo acaba sin código, se revoca. */
        let orphanRefresh;
        try {
            this.enterRateLimit(req, 'authorize');
            if (req.method !== 'POST')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            const form = await readForm(req, this.formReadTimeoutMs);
            release = this.enterConcurrency('authorize');
            const requestId = one(form, 'request');
            const csrf = one(form, 'csrf');
            const decision = one(form, 'decision');
            if (!isValidRequestId(requestId) || (decision !== 'allow' && decision !== 'deny')) {
                throw new OAuthError('invalid_request', SUMEGO_PERSON_MESSAGES.consentMalformed);
            }
            const binding = bindingFrom(req);
            if (!binding) {
                throw new OAuthError('invalid_request', SUMEGO_PERSON_MESSAGES.otherBrowser, 403);
            }
            let consumed;
            await this.mutateStore((store) => {
                const found = store.authorizationRequests.find((item) => item.requestId === requestId && item.sumego?.phase === 'consent');
                if (!found ||
                    found.expiresAt <= this.now() ||
                    !matchesHash(found.sumego.bindingHash, digest(binding)) ||
                    !matchesHash(found.sumego.csrfHash, digest(csrf))) {
                    return false;
                }
                consumed = structuredClone(found);
                store.authorizationRequests = store.authorizationRequests.filter((item) => item.requestId !== requestId);
                return true;
            });
            if (!consumed) {
                throw new OAuthError('invalid_request', SUMEGO_PERSON_MESSAGES.consentInvalid, 403);
            }
            const authorized = consumed;
            burned = true;
            const key = await this.key();
            const stateHash = authorized.sumego.stateHash;
            orphanRefresh = decrypt(authorized.sumego.refresh, key, sumegoContext('refresh', authorized, stateHash));
            const clearCookie = { 'set-cookie': clearBindingCookie() };
            if (decision === 'deny') {
                this.redirectToClient(res, authorized, { error: 'access_denied' }, clearCookie);
                return;
            }
            const transactionId = decrypt(authorized.transaction, key, transactionContext(authorized.requestId, authorized.clientId, authorized.resource, authorized.scope));
            const idToken = decrypt(authorized.sumego.idToken, key, sumegoContext('id-token', authorized, stateHash));
            let credential;
            try {
                credential = await this.backchannel.exchangeSumegoIdentity({
                    requestId: authorized.requestId,
                    transactionId,
                    idToken,
                    clientId: authorized.clientId,
                    resource: authorized.resource,
                    scope: authorized.scope
                });
            }
            catch (error) {
                throw this.sumegoExchangeError(error);
            }
            const code = await this.storeAuthorizationCode(authorized, credential, {
                subject: authorized.sumego.subject,
                issuedAt: authorized.sumego.issuedAt,
                refreshToken: orphanRefresh
            });
            orphanRefresh = undefined;
            this.redirectToClient(res, authorized, { code }, clearCookie);
        }
        catch (error) {
            sumegoErrorPage(res, error, burned);
        }
        finally {
            // «Cancelar» y cualquier final sin código: el refresh de Sumego de
            // esta conexión no lo va a usar nadie.
            if (orphanRefresh)
                this.revokeSumegoRefreshLater(orphanRefresh);
            release?.();
        }
    }
    /**
     * Back-channel logout de Sumego (`/oauth/sumego/backchannel-logout`). Lo
     * llama el SERVIDOR de Sumego: sin cookies ni CSRF, pero con el mismo
     * límite de cuerpo y de tiempo que `/token` (`readForm`).
     *
     * Valida el `logout_token` (`SumegoOidcClient.validateLogoutToken`) y,
     * dentro de UNA escritura del almacén: rechaza un `jti` ya visto, lo
     * anota hasta que caducaría, y revoca lo que case. Con `sid`, lo de esa
     * sesión; con solo `sub`, todo lo de esa persona: grants (y sus familias
     * de refresh), códigos aún sin canjear y transacciones en consentimiento.
     * Las credenciales de Lumbre de lo revocado van a la outbox y se revocan
     * allí con el `revoke` de siempre; si Lumbre no contesta, se reintenta por
     * la outbox.
     *
     * COSTE DE BUSCAR POR `sub`/`sid`: se recorren los grants y los códigos
     * dentro del mutador, O(n). No compensa un índice: CADA logout escribe el
     * almacén (el `jti` tiene que persistir aunque no case nada, o un
     * reinicio reabriría su reproducción), y escribir ya cuesta O(n) (copia,
     * `normalizeStore` y serializar el fichero entero). Un índice no bajaría
     * el orden y añadiría un segundo estado que mantener coherente. Y no es
     * un camino caliente: solo lo dispara un token firmado por Sumego, con su
     * propio límite por IP.
     *
     * 200 si se atendió (case algo o no), 400 si el token no vale o ya se usó,
     * 503 si no se pudo leer el JWKS de Sumego. Siempre `no-store`.
     */
    async handleSumegoBackchannelLogout(req, res) {
        let release;
        try {
            this.enterRateLimit(req, 'logout');
            if (req.method !== 'POST')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            const form = await readForm(req, this.formReadTimeoutMs);
            release = this.enterConcurrency('logout');
            const token = one(form, 'logout_token');
            let claims;
            try {
                claims = await this.sumego.validateLogoutToken(token);
            }
            catch (error) {
                if (error instanceof OidcError && error.kind === 'transient') {
                    throw new OAuthError('temporarily_unavailable', 'No se pudo comprobar el logout_token.', 503);
                }
                throw new OAuthError('invalid_request', 'logout_token inválido.');
            }
            const jtiHash = digest(claims.jti);
            const revoked = [];
            let replayed = false;
            await this.mutateStore((store) => {
                const now = this.now();
                if (store.usedLogoutTokens.some((item) => matchesHash(item.jtiHash, jtiHash) && item.expiresAt > now)) {
                    replayed = true;
                    return false;
                }
                store.usedLogoutTokens.push({ jtiHash, expiresAt: claims.keepUntil });
                if (store.usedLogoutTokens.length > MAX_LOGOUT_TOKENS) {
                    store.usedLogoutTokens = store.usedLogoutTokens
                        .slice()
                        .sort((a, b) => a.expiresAt - b.expiresAt)
                        .slice(-MAX_LOGOUT_TOKENS);
                }
                // La sesión (o la persona) cerrada se recuerda unos minutos, para
                // alcanzar también la conexión que ahora mismo va por la mitad
                // (B1; ver `ClosedSumegoSession` y `closedAfter`).
                const closedAt = claims.issuedAt;
                const closing = claims.sid !== undefined ? { kind: 'sid', value: claims.sid } : { kind: 'sub', value: claims.sub };
                store.closedSumegoSessions.push({
                    kind: closing.kind,
                    valueHash: digest(closing.value),
                    closedAt,
                    expiresAt: now + CLOSED_SUMEGO_SESSION_TTL_MS
                });
                if (store.closedSumegoSessions.length > MAX_CLOSED_SUMEGO_SESSIONS) {
                    store.closedSumegoSessions = store.closedSumegoSessions
                        .slice()
                        .sort((a, b) => a.expiresAt - b.expiresAt)
                        .slice(-MAX_CLOSED_SUMEGO_SESSIONS);
                }
                for (const grant of store.grants.filter((item) => logoutMatches(item.sumego, claims))) {
                    this.enqueueFamilyRevocation(store, grant);
                    revoked.push(grant.credentialId);
                }
                for (const code of store.authorizationCodes.filter((item) => logoutMatches(item.sumego, claims))) {
                    if (!store.revocationOutbox.some((item) => item.credentialId === code.credentialId)) {
                        store.revocationOutbox.push({
                            provider: 'lumbre-web',
                            credentialId: code.credentialId,
                            clientId: code.clientId,
                            resource: code.resource,
                            scope: code.scope,
                            upstream: code.upstream,
                            queuedAt: now
                        });
                    }
                    revoked.push(code.credentialId);
                }
                store.authorizationCodes = store.authorizationCodes.filter((item) => !logoutMatches(item.sumego, claims));
                store.authorizationRequests = store.authorizationRequests.filter((item) => !logoutMatches(item.sumego?.subject, claims));
                return true;
            });
            if (replayed)
                throw new OAuthError('invalid_request', 'logout_token ya usado.');
            for (const credentialId of revoked)
                await this.flushRevocationOutbox(credentialId);
            res.writeHead(200, securityHeaders('text/plain; charset=utf-8'));
            res.end();
        }
        catch (error) {
            oauthError(res, error);
        }
        finally {
            release?.();
        }
    }
    /** Quema una transacción de Sumego (cualquier fase). */
    async discardSumegoTransaction(requestId) {
        await this.mutateStore((store) => {
            const before = store.authorizationRequests.length;
            store.authorizationRequests = store.authorizationRequests.filter((item) => !(item.requestId === requestId && item.sumego !== undefined));
            return store.authorizationRequests.length !== before;
        });
    }
    /** Fallo de Sumego (discovery, token endpoint, ID token) en palabras para
     *  la persona (`SUMEGO_PERSON_MESSAGES`). */
    sumegoOAuthError(error) {
        if (error instanceof OidcError && error.kind === 'transient') {
            return new OAuthError('temporarily_unavailable', SUMEGO_PERSON_MESSAGES.accountsUnavailable, 503);
        }
        return new OAuthError('server_error', SUMEGO_PERSON_MESSAGES.identityRejected, 502);
    }
    /**
     * Fallo del canje con Lumbre en palabras para la persona
     * (`exchangeFailure`, `sumego-messages.ts`). Si el fallo es NUESTRO
     * (cuerpo mal formado, secreto del canal, contrato roto), además deja
     * una línea en el log del servidor: a la persona solo le llega la
     * genérica, y sin esa línea nadie se enteraría de que hay que arreglar
     * algo aquí. Sin tokens ni identificadores.
     */
    sumegoExchangeError(error) {
        const failure = exchangeFailure(error);
        if (failure.log) {
            console.error(`[lumbre-mcp-oauth] canje con Sumego: fallo del relé o de su configuración, no de la persona (${failure.log})`);
        }
        const code = failure.status === 503 ? 'temporarily_unavailable' : failure.status === 403 ? 'access_denied' : 'invalid_grant';
        return new OAuthError(code, failure.message, failure.status);
    }
    redirectToClient(res, request, result, headers = {}) {
        const redirect = new URL(request.redirectUri);
        if ('code' in result)
            redirect.searchParams.set('code', result.code);
        else
            redirect.searchParams.set('error', result.error);
        if (request.state !== undefined)
            redirect.searchParams.set('state', request.state);
        redirect.searchParams.set('iss', OAUTH_ISSUER);
        res.writeHead(302, { ...securityHeaders('text/plain; charset=utf-8'), ...headers, location: redirect.toString() });
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
            this.enterRateLimit(req, 'token');
            if (req.method !== 'POST')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            // Primero el formulario, después la ranura: ver `enterRateLimit`.
            const form = await readForm(req, this.formReadTimeoutMs);
            release = this.enterConcurrency('token');
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
        const snapshot = await this.loadStore();
        const code = snapshot.authorizationCodes.find((item) => matchesHash(item.codeHash, codeHash));
        if (!code) {
            // ¿Es un código ya canjeado? Entonces se revoca lo emitido con él
            // (ver `RedeemedCode`). Se mira antes en la copia leída para que un
            // código cualquiera no haga cola en `mutateStore`.
            if (snapshot.redeemedCodes.some((item) => matchesHash(item.codeHash, codeHash) && item.expiresAt > this.now())) {
                await this.revokeRedeemedCodeFamily(codeHash);
            }
            throw new OAuthError('invalid_grant', 'Código inválido, usado o caducado.');
        }
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
    /**
     * Pregunta a Lumbre por una credencial y devuelve su estado SIN aplanarlo
     * (ver `CredentialState`). Un fallo del backchannel sale tal cual, como
     * `BackchannelError`: aquí no se decide qué significa no haber podido
     * saberlo, eso es cosa de cada llamante.
     *
     * Existe separada de `introspectCredential` porque sus dos llamantes
     * necesitan cosas distintas del mismo dato. El canje y el refresh solo
     * preguntan "¿puedo seguir emitiendo tokens con esto?", y ahí `mismatch`
     * vale lo mismo que `inactive`: no. El barrido pregunta "¿puedo DESTRUIR
     * esta autorización?", y ahí solo vale un `inactive` explícito: una
     * respuesta por otra credencial es una anomalía de Lumbre, no una orden de
     * borrar.
     */
    async credentialState(credential, upstreamToken) {
        const result = await this.backchannel.introspect(upstreamToken);
        // `=== false` y no `!result.active`: el backchannel ya valida la forma
        // exacta, pero quien decide una purga no se apoya en que un valor raro
        // resulte ser falsy.
        if (result.active === false)
            return 'inactive';
        if (result.active !== true ||
            result.credentialId !== credential.credentialId ||
            result.clientId !== credential.clientId ||
            result.resource !== credential.resource ||
            result.scope !== credential.scope) {
            return 'mismatch';
        }
        return 'active';
    }
    /**
     * Versión del canje de código y del refresh: ¿sigue valiendo esta
     * credencial para emitir tokens? Mismo comportamiento de siempre: un fallo
     * del backchannel es un 503 `temporarily_unavailable` (no se rota ni se
     * revoca nada), y tanto `inactive` como `mismatch` son un "no".
     */
    async introspectCredential(credential, upstreamToken) {
        let state;
        try {
            state = await this.credentialState(credential, upstreamToken);
        }
        catch (error) {
            throw this.backchannelOAuthError(error, 'temporarily_unavailable');
        }
        return state === 'active';
    }
    /**
     * Revoca la familia emitida con un código ya canjeado (B3). Dentro de un
     * mutador; devuelve el `credentialId` a vaciar de la outbox, o `undefined`
     * si no hay nada que revocar (el registro caducó, o la familia ya no
     * existe: entonces no se toca nada y el registro caduca solo).
     *
     * POR DISEÑO, también con un cliente legítimo: si su primera respuesta de
     * `/token` se pierde (timeout, red) y REINTENTA el canje con el mismo
     * código, ese reintento revoca la familia que el primero emitió y la
     * persona tiene que volver a conectar. Desde aquí un reintento y un código
     * robado son indistinguibles, y RFC 6749 §4.1.2 pide (SHOULD) revocar.
     * Lo cuenta también el README.
     */
    revokeRedeemedCodeInStore(store, codeHash, now) {
        const redeemed = store.redeemedCodes.find((item) => matchesHash(item.codeHash, codeHash) && item.expiresAt > now);
        if (!redeemed)
            return undefined;
        const grant = store.grants.find((item) => item.familyId === redeemed.familyId);
        if (!grant)
            return undefined;
        this.enqueueFamilyRevocation(store, grant);
        return grant.credentialId;
    }
    async revokeRedeemedCodeFamily(codeHash) {
        let credentialId;
        await this.mutateStore((store) => {
            credentialId = this.revokeRedeemedCodeInStore(store, codeHash, this.now());
            return credentialId !== undefined;
        });
        if (credentialId)
            await this.flushRevocationOutbox(credentialId);
    }
    async issueGrant(code, codeHash, res) {
        const accessToken = opaque(ACCESS_PREFIX);
        const refreshToken = opaque(REFRESH_PREFIX);
        const familyId = randomBytes(16).toString('base64url');
        const now = this.now();
        const familyExpiresAt = now + REFRESH_TTL_MS;
        let issued = false;
        let replayedCredentialId;
        await this.mutateStore((store) => {
            const storedCode = store.authorizationCodes.find((item) => matchesHash(item.codeHash, codeHash) && item.credentialId === code.credentialId && item.expiresAt > now);
            if (!storedCode) {
                // Lo canjeó otro entre la lectura y aquí (dos canjes en
                // carrera): el segundo también es reutilización.
                replayedCredentialId = this.revokeRedeemedCodeInStore(store, codeHash, now);
                return replayedCredentialId !== undefined;
            }
            store.authorizationCodes = store.authorizationCodes.filter((item) => !matchesHash(item.codeHash, codeHash));
            store.redeemedCodes.push({ codeHash, familyId, expiresAt: storedCode.expiresAt });
            // Los códigos ya nacen acotados (`MAX_PENDING_ITEMS` y el
            // presupuesto de `/authorize`), así que esto no debería recortar
            // nunca; está para que la lista no pueda crecer sin techo.
            if (store.redeemedCodes.length > MAX_PENDING_ITEMS) {
                store.redeemedCodes = store.redeemedCodes.slice(-MAX_PENDING_ITEMS);
            }
            store.grants.push({
                provider: 'lumbre-web',
                credentialId: code.credentialId,
                familyId,
                familyExpiresAt,
                clientId: code.clientId,
                resource: code.resource,
                scope: code.scope,
                accessHash: digest(accessToken),
                accessExpiresAt: accessExpiryFor(now, familyExpiresAt),
                refreshHash: digest(refreshToken),
                refreshExpiresAt: familyExpiresAt,
                upstream: code.upstream,
                // La identidad de Sumego pasa al grant: es lo que busca el
                // back-channel logout. Un código de Lumbre no la lleva.
                ...(storedCode.sumego ? { sumego: storedCode.sumego } : {}),
                // Y su refresh de Sumego, con el mismo cifrado: el AAD va atado a
                // la credencial, que es la misma en el código y en el grant.
                ...(storedCode.sumegoRefresh
                    ? { sumegoRefresh: storedCode.sumegoRefresh, sumegoCheckedAt: storedCode.sumegoCheckedAt }
                    : {})
            });
            issued = true;
            return true;
        });
        if (!issued) {
            if (replayedCredentialId)
                await this.flushRevocationOutbox(replayedCredentialId);
            throw new OAuthError('invalid_grant', 'Código inválido, usado o caducado.');
        }
        json(res, 200, {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: expiresInSeconds(accessExpiryFor(now, familyExpiresAt), now),
            refresh_token: refreshToken,
            scope: code.scope
        });
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
        // Grant de Sumego: como mucho cada hora, ¿sigue viva su sesión allí?
        // (M1.) Si Sumego dice que no, la familia ya está revocada.
        if ((await this.renewSumegoSession(grantSnapshot)) === 'revoked') {
            throw new OAuthError('invalid_grant', 'La sesión de la cuenta ya no está activa.');
        }
        const active = await this.introspectCredential(grantSnapshot, upstreamToken);
        if (!active) {
            await this.revokeFamily(grantSnapshot.familyId, grantSnapshot.credentialId);
            throw new OAuthError('invalid_grant', 'La credencial de Lumbre ya no está activa.');
        }
        const result = {
            outcome: 'invalid',
            accessExpiresAt: now
        };
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
                // Al alcanzar el tope GLOBAL, la opción segura y siempre disponible
                // es revocar la familia. Nunca se bloquea una eliminación por intentar
                // conservar otra tombstone. (El tope por familia ya no llega aquí:
                // descarta la más antigua, ver `addRefreshTombstone`.)
                result.outcome = 'replayed';
                this.enqueueFamilyRevocation(store, grant);
                return true;
            }
            result.outcome = 'rotated';
            grant.accessHash = digest(accessToken);
            grant.accessExpiresAt = accessExpiryFor(now, grant.familyExpiresAt);
            result.accessExpiresAt = grant.accessExpiresAt;
            grant.refreshHash = digest(nextRefresh);
            grant.refreshExpiresAt = nextRefreshExpiresAt;
            return true;
        });
        if (result.outcome !== 'rotated') {
            if (result.outcome === 'replayed')
                await this.flushRevocationOutbox(grantSnapshot.credentialId);
            throw new OAuthError('invalid_grant', 'Refresh token inválido, usado o caducado.');
        }
        json(res, 200, {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: expiresInSeconds(result.accessExpiresAt, now),
            refresh_token: nextRefresh,
            scope: OAUTH_SCOPE
        });
    }
    /**
     * Comprobación horaria de la sesión de Sumego de un grant (M1 de la
     * revisión de seguridad de c4534bc; SPEC de Sumego §4 y §7.7). Es la red
     * de seguridad del back-channel logout: si el aviso se pierde, la cuenta
     * suspendida o el grant revocado en Sumego se notan aquí, en el siguiente
     * `/token` pasada la hora, en vez de a los 30 días.
     *
     *   · `skipped`: no es de Sumego, no guarda refresh, o se comprobó hace
     *     menos de `SUMEGO_RECHECK_MS`.
     *   · `ok`: Sumego renovó (y rotó) el refresh; se guarda el nuevo y la hora.
     *   · `revoked`: Sumego respondió 4xx salvo 429. La familia se revoca y su
     *     credencial de Lumbre va a la outbox.
     *   · `transient`: 429, 5xx, timeout o Sumego caído. No se corta nada y
     *     se vuelve a intentar en el siguiente `/token` (SPEC §8: con Sumego
     *     caído las sesiones abiertas siguen).
     *
     * CONCURRENCIA, que es lo delicado: Sumego rota el refresh en cada uso, así
     * que dos renovaciones con el mismo refresh harían que la segunda recibiera
     * un `invalid_grant` legítimo, y revocaríamos por error. Por eso hay UNA
     * renovación en vuelo por familia (`sumegoRenewals`): la segunda petición
     * espera a la primera y comparte su resultado. Y el refresh rotado se guarda
     * solo si el guardado sigue siendo el de partida; si no, es una carrera, y
     * un `invalid_grant` en una carrera NO revoca.
     */
    async renewSumegoSession(grant) {
        if (!grant.sumego || !grant.sumegoRefresh)
            return 'skipped';
        if ((grant.sumegoCheckedAt ?? 0) + SUMEGO_RECHECK_MS > this.now())
            return 'skipped';
        const inFlight = this.sumegoRenewals.get(grant.familyId);
        if (inFlight) {
            this.sumegoRenewalJoined?.();
            return await inFlight;
        }
        const pending = this.runSumegoRenewal(grant.familyId).finally(() => {
            this.sumegoRenewals.delete(grant.familyId);
        });
        this.sumegoRenewals.set(grant.familyId, pending);
        return await pending;
    }
    async runSumegoRenewal(familyId) {
        // El estado vigente, no la copia que leyó quien llama: si otra petición
        // acaba de renovar, aquí ya se ve el refresh nuevo y su hora.
        const grant = (await this.loadStore()).grants.find((item) => item.familyId === familyId);
        if (!grant?.sumego || !grant.sumegoRefresh)
            return 'skipped';
        if ((grant.sumegoCheckedAt ?? 0) + SUMEGO_RECHECK_MS > this.now())
            return 'skipped';
        const startValue = grant.sumegoRefresh;
        const key = await this.key();
        let refreshToken;
        try {
            refreshToken = decrypt(startValue, key, sumegoRefreshContext(grant));
        }
        catch {
            // Sin poder preguntar no se corta (como en el barrido de Lumbre).
            return 'transient';
        }
        const stillHolds = (store) => {
            const current = store.grants.find((item) => item.familyId === familyId);
            return current?.sumegoRefresh && sameEncryptedValue(current.sumegoRefresh, startValue) ? current : undefined;
        };
        let renewed;
        try {
            renewed = await this.sumego.refresh(refreshToken);
        }
        catch (error) {
            if (!(error instanceof OidcError) || error.kind !== 'invalid')
                return 'transient';
            let credentialId;
            await this.mutateStore((store) => {
                const current = stillHolds(store);
                // Ya no es el refresh que se usó: otro lo renovó (o se revocó) en
                // medio. Su `invalid_grant` es de la carrera, no de la sesión.
                if (!current)
                    return false;
                credentialId = current.credentialId;
                this.enqueueFamilyRevocation(store, current);
                return true;
            });
            if (!credentialId)
                return 'ok';
            await this.flushRevocationOutbox(credentialId);
            return 'revoked';
        }
        const checkedAt = this.now();
        let stored = false;
        await this.mutateStore((store) => {
            const current = stillHolds(store);
            if (!current)
                return false;
            current.sumegoRefresh = encrypt(renewed.refreshToken, key, sumegoRefreshContext(current));
            current.sumegoCheckedAt = checkedAt;
            stored = true;
            return true;
        });
        // Nadie lo guardó (el grant se fue en medio): que no quede vivo en Sumego.
        if (!stored)
            this.revokeSumegoRefreshLater(renewed.refreshToken);
        return 'ok';
    }
    /**
     * Revoca un refresh de Sumego en segundo plano, best-effort: si Sumego no
     * tiene `revocation_endpoint` o falla, no pasa nada (la sesión muere sola
     * allí, y el grant local ya no existe). No bloquea a quien lo pide; el
     * apagado ordenado lo espera (`whenWritesSettled`).
     */
    revokeSumegoRefreshLater(refreshToken) {
        const task = this.sumego
            .revokeRefresh(refreshToken)
            .catch(() => undefined)
            .finally(() => {
            this.backgroundTasks.delete(task);
        });
        this.backgroundTasks.add(task);
    }
    /**
     * Revoca en Sumego el refresh de cada código o grant de Sumego que acaba
     * de salir del almacén: logout, `/revoke`, `invalid_grant` de Sumego,
     * replay, caducidad, purga del barrido. Mismo patrón que la huella de notas
     * (`forgetNotesSeenOfRetired`): lo llama `mutateStore` tras confirmar la
     * escritura, así cubre todos los caminos. Una rotación NO cuenta: la
     * credencial sigue en el almacén y el refresh viejo ya lo invalidó Sumego.
     */
    async revokeSumegoRefreshOfRetired(before, store) {
        const held = new Set([...store.grants, ...store.authorizationCodes].map((item) => item.credentialId));
        const retired = before.filter((item) => !held.has(item.credentialId));
        if (retired.length === 0)
            return;
        try {
            const key = await this.key();
            for (const item of retired) {
                try {
                    this.revokeSumegoRefreshLater(decrypt(item.sumegoRefresh, key, sumegoRefreshContext(item)));
                }
                catch {
                    // No se descifra: no hay nada que mandar a Sumego.
                }
            }
        }
        catch {
            // Sin clave no hay nada que descifrar; la sesión muere sola en Sumego.
        }
    }
    /**
     * Guarda la tombstone del refresh que se acaba de rotar. Devuelve `false`
     * solo si el tope GLOBAL está lleno, y entonces quien llama revoca.
     *
     * Con la familia en su tope (`MAX_REFRESH_TOMBSTONES_PER_FAMILY`) descarta
     * primero la más antigua de ESA familia (FIFO: `push` añade al final, así
     * que la primera del array es la más vieja). Lo que se pierde es detectar
     * el replay de un refresh de hace más de 64 rotaciones: presentarlo ya no
     * revoca la familia, solo recibe el `invalid_grant` de un refresh
     * desconocido. Es un precio pequeño: un refresh robado y guardado 64 horas
     * sin usar, mientras el legítimo sigue rotando, ya no vale para nada; lo
     * que la tombstone añade es la revocación, y esa sigue intacta para las 64
     * más recientes, que es donde cae una carrera o un robo reciente.
     */
    addRefreshTombstone(store, hash, familyId, expiresAt) {
        if (store.usedRefreshTokens.some((item) => matchesHash(item.hash, hash)))
            return true;
        const family = store.usedRefreshTokens.filter((item) => item.familyId === familyId);
        if (family.length >= MAX_REFRESH_TOMBSTONES_PER_FAMILY) {
            const discarded = new Set(family.slice(0, family.length - MAX_REFRESH_TOMBSTONES_PER_FAMILY + 1));
            store.usedRefreshTokens = store.usedRefreshTokens.filter((item) => !discarded.has(item));
        }
        if (store.usedRefreshTokens.length >= MAX_REFRESH_TOMBSTONES)
            return false;
        store.usedRefreshTokens.push({ hash, familyId, expiresAt });
        return true;
    }
    removeFamily(store, familyId) {
        store.grants = store.grants.filter((grant) => grant.familyId !== familyId);
        store.usedRefreshTokens = store.usedRefreshTokens.filter((item) => item.familyId !== familyId);
        store.redeemedCodes = store.redeemedCodes.filter((item) => item.familyId !== familyId);
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
            this.enterRateLimit(req, 'revoke');
            if (req.method !== 'POST')
                throw new OAuthError('invalid_request', 'Método no permitido.', 405);
            // Primero el formulario, después la ranura: ver `enterRateLimit`.
            const form = await readForm(req, this.formReadTimeoutMs);
            release = this.enterConcurrency('revoke');
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
            // Solo lectura: sin clonar el store entero en cada petición (ver
            // `loadStoreReadOnly`).
            const store = await this.loadStoreReadOnly();
            const grant = this.grantByAccessHash(store, hash);
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
    /**
     * Grant cuyo access tiene este hash, por índice y no recorriendo la lista
     * (hallazgo 9 del audit de abuso del 10 oct 2026: con 10 000 grants, el
     * `find` con `timingSafeEqual` por grant costaba ~1,7 ms de event loop en
     * CADA `/mcp`, también con tokens inventados).
     *
     * COHERENCIA: el índice se ata a la IDENTIDAD del objeto store del que
     * salió y se rehace en cuanto llega otro. Eso basta porque la caché nunca
     * se muta en sitio, solo se sustituye (`adoptStore`, `invalidateStore`):
     * altas, rotaciones, revocaciones, purgas y la relectura de `ensureReady`
     * producen todas un objeto nuevo. No hay un segundo sitio que mantener.
     *
     * La búsqueda en el `Map` no es en tiempo constante, pero la clave es el
     * SHA-256 del token presentado: quien llama no puede elegir sus bits, así
     * que no hay prefijo que ir afinando. Lo encontrado se confirma igualmente
     * con `matchesHash`, como el resto de comparaciones de credencial.
     */
    grantByAccessHash(store, hash) {
        if (this.accessIndex?.store !== store) {
            this.accessIndex = { store, byHash: new Map(store.grants.map((grant) => [grant.accessHash, grant])) };
        }
        const grant = this.accessIndex.byHash.get(hash);
        return grant && matchesHash(grant.accessHash, hash) ? grant : undefined;
    }
    isOAuthAccessToken(token) {
        return token.startsWith(ACCESS_PREFIX);
    }
    async ensureReady() {
        this.backchannel.ensureConfigured();
        // Solo la configuración: Sumego caído no impide arrancar (SPEC de
        // Sumego §8), así que aquí no se le pregunta nada.
        if (this.login.provider === 'sumego')
            this.sumego.ensureConfigured();
        if (!this.suppliedEncryptionKey && !(await pathExists(join(this.stateDir, 'oauth.key')))) {
            if (await pathExists(this.storePath()))
                throw new Error('store OAuth presente sin su clave');
        }
        const key = await this.key();
        await this.removeOrphanTemps();
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
            if (pending.sumego) {
                const stateHash = pending.sumego.stateHash;
                decrypt(pending.sumego.secrets, key, sumegoContext('secrets', pending, stateHash));
                if (pending.sumego.idToken)
                    decrypt(pending.sumego.idToken, key, sumegoContext('id-token', pending, stateHash));
                if (pending.sumego.refresh)
                    decrypt(pending.sumego.refresh, key, sumegoContext('refresh', pending, stateHash));
            }
        }
        for (const code of store.authorizationCodes) {
            validateClientIdUrl(code.clientId);
            const upstream = decrypt(code.upstream, key, grantContext(code.clientId, code.resource, code.scope));
            if (!/^[a-f0-9]{64}$/.test(upstream))
                throw new Error('credencial upstream inválida');
        }
        // El refresh de Sumego de grants y códigos también tiene que descifrar:
        // si no, la comprobación horaria fallaría en silencio (`transient`).
        for (const holder of [...store.grants, ...store.authorizationCodes]) {
            if (holder.sumegoRefresh)
                decrypt(holder.sumegoRefresh, key, sumegoRefreshContext(holder));
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
    /**
     * Borra los temporales huérfanos de `ORPHAN_TEMP_PATTERN`. UNA vez por
     * proceso, en el primer `ensureReady`, que en producción es el del
     * arranque (`http.ts` no abre el listener hasta que pasa).
     *
     * Corre DENTRO de la cola de escritura: así ninguna escritura de este
     * proceso tiene su temporal a medias mientras se borra, y un temporal que
     * casa el patrón solo puede ser de un proceso anterior. Eso descansa en la
     * misma premisa que la caché del store: un solo proceso escribe aquí (ver
     * `cachedStore`).
     *
     * No lanza: un temporal que no se pudo borrar no impide arrancar. Deja una
     * línea con el recuento, sin nombres (el nombre lleva un pid y nada más,
     * pero no hace falta).
     */
    async removeOrphanTemps() {
        if (this.orphanTempsRemoved)
            return;
        this.orphanTempsRemoved = true;
        const job = this.writeQueue.then(async () => {
            let names;
            try {
                names = await readdir(this.stateDir);
            }
            catch {
                return;
            }
            let removed = 0;
            for (const name of names) {
                if (!ORPHAN_TEMP_PATTERN.test(name))
                    continue;
                try {
                    await unlink(join(this.stateDir, name));
                    removed += 1;
                }
                catch {
                    // Lo intentará el siguiente arranque.
                }
            }
            if (removed > 0) {
                console.error(`[lumbre-mcp-oauth] ${removed} temporal(es) huérfano(s) de una escritura interrumpida borrado(s)`);
            }
        });
        this.writeQueue = job;
        await job;
    }
    /**
     * Barrido periódico: lo que este relé guarda de una credencial que Lumbre
     * ya no reconoce se borra aquí, sin esperar a que el cliente vuelva.
     *
     * POR QUÉ HACE FALTA. Lumbre no avisa al relé cuando alguien revoca la
     * conexión desde la app o borra su cuenta. Hasta ahora el relé solo se
     * enteraba cuando el cliente refrescaba; si el cliente no volvía (que es lo
     * normal tras borrar una cuenta), la credencial cifrada y la huella de
     * notas se quedaban hasta que caducaba la familia (30 días) y, encima, la
     * poda solo corría si OTRA petición escribía en el almacén.
     *
     * QUÉ HACE, en orden y de una en una (nunca en paralelo contra Lumbre):
     *   1. La poda de siempre (`mutateStore`): familias y códigos caducados
     *      pasan a la outbox. Así la caducidad deja de depender del tráfico.
     *   2. Por cada grant: introspección. Primero se pregunta por TODOS y
     *      después se purga (`purgeInactiveGrant`, y su huella de notas se va
     *      con él) cada uno al que Lumbre respondió un `active: false`
     *      EXPLÍCITO, salvo que salten demasiados a la vez: ver
     *      `MASS_PURGE_MIN_GRANTS`. Si la pasada se corta a medias, no se
     *      purga ninguno de esa pasada.
     *   3. Por cada pendiente de la outbox: el `flush` de siempre; y si sigue
     *      ahí y Lumbre declara inactiva su credencial, se retira (ya no hay
     *      nada que revocar).
     *   4. La caducidad de 30 días de las huellas de notas, que cubre lo que
     *      este relé no puede saber (ver `pruneStaleAccountNotesSeen`).
     *
     * QUÉ NO PURGA NUNCA. Destruir una autorización no tiene vuelta atrás (la
     * persona tendría que volver a conectar), así que la única señal que vale
     * es que Lumbre conteste, con 2xx y dentro de contrato, exactamente
     * `{ "active": false }`. Cualquier otra cosa es "no pude saberlo":
     *   · red caída, timeout, 5xx o 429 (`BackchannelError('transient')`);
     *   · 401/403 del canal (secreto mal configurado) o cualquier otro 4xx, y
     *     un cuerpo fuera de contrato (`BackchannelError('invalid')`);
     *   · una respuesta activa que corresponde a OTRA credencial (`mismatch`).
     * Los dos primeros grupos CORTAN el barrido entero: si Lumbre no contesta
     * algo utilizable a una, no lo va a hacer a la siguiente, y seguir sería
     * martillear una app caída (o gastar su límite de intentos) sin poder
     * decidir nada. Se reintenta en el siguiente ciclo. `mismatch` no corta
     * (Lumbre sí contesta), solo deja esa credencial como estaba.
     *
     * Ojo, esto es MÁS estricto que el refresh a propósito: allí un `mismatch`
     * revoca la familia (el cliente está delante y puede reautorizar); aquí
     * nadie ha pedido nada, así que ante la duda no se toca.
     *
     * UNO A LA VEZ. Si el anterior sigue en curso (Lumbre lenta), este no hace
     * nada: dos barridos solapados solo duplicarían las llamadas a Lumbre. No
     * hace falta para la integridad del almacén (de eso se encarga la cola de
     * `mutateStore`), es por no multiplicar el tráfico.
     *
     * No lanza: un barrido fallido no puede tumbar el proceso ni marcar
     * `/readyz` (que no lo consulta). Devuelve recuentos y deja UNA línea en
     * stderr solo si purgó o descartó algo, sin nada que identifique a nadie.
     */
    async sweepInactiveCredentials() {
        const result = {
            skipped: false,
            aborted: false,
            purgedGrants: 0,
            retiredOutboxItems: 0,
            undetermined: 0,
            prunedNotesFiles: 0,
            heldBack: 0
        };
        if (this.sweepInFlight)
            return { ...result, skipped: true };
        this.sweepInFlight = true;
        try {
            try {
                await this.sweepStoredCredentials(result);
            }
            catch {
                // Un fallo que no es de Lumbre (el almacén no se pudo leer o
                // escribir, la clave no carga): tampoco se sigue. Lo ya purgado
                // antes del fallo queda contado y purgado.
                result.aborted = true;
            }
            // La caducidad de las huellas no depende de Lumbre: se aplica aunque
            // el barrido se haya cortado.
            result.prunedNotesFiles = await pruneStaleAccountNotesSeen(this.now(), { force: true });
        }
        finally {
            this.sweepInFlight = false;
        }
        if (result.purgedGrants > 0 || result.retiredOutboxItems > 0 || result.prunedNotesFiles > 0) {
            // Solo recuentos. Ni token, ni `credentialId`, ni `familyId`, ni el
            // nombre de un fichero de huella (que es un hash de la credencial).
            console.error(`[lumbre-mcp-oauth] barrido de credenciales: ${result.purgedGrants} autorización(es) purgada(s) ` +
                `por credencial inactiva en Lumbre, ${result.retiredOutboxItems} revocación(es) pendiente(s) retirada(s), ` +
                `${result.prunedNotesFiles} huella(s) de notas caducada(s)` +
                (result.aborted ? '; cortado antes de terminar, sigue en el siguiente ciclo' : ''));
        }
        return result;
    }
    /** Pasos 1 a 3 de `sweepInactiveCredentials`. Marca `aborted` y vuelve en
     *  cuanto Lumbre no contesta algo utilizable. */
    async sweepStoredCredentials(result) {
        await this.mutateStore(() => false);
        const key = await this.key();
        const grants = (await this.loadStore()).grants;
        const inactive = [];
        for (const grant of grants) {
            let upstreamToken;
            try {
                upstreamToken = decrypt(grant.upstream, key, grantContext(grant.clientId, grant.resource, grant.scope));
            }
            catch {
                // No se puede preguntar por una credencial que no se descifra, y
                // sin preguntar no se purga. (`/readyz` ya canta este estado.)
                result.undetermined += 1;
                continue;
            }
            let state;
            try {
                state = await this.credentialState(grant, upstreamToken);
            }
            catch {
                result.aborted = true;
                return;
            }
            if (state === 'mismatch')
                result.undetermined += 1;
            if (state === 'inactive')
                inactive.push(grant);
        }
        // Con el freno puesto se omite SOLO lo que se apoya en un `inactive` de
        // Lumbre: purgar grants y retirar pendientes de la outbox. El `flush` de
        // la outbox sigue: revocar en Lumbre lo que este relé ya soltó no
        // destruye nada que alguien esté usando.
        const braked = grants.length >= MASS_PURGE_MIN_GRANTS && inactive.length > grants.length * MASS_PURGE_MAX_RATIO;
        if (braked) {
            result.aborted = true;
            result.heldBack = inactive.length;
            // Solo recuentos, como el resto de líneas del barrido.
            console.error(`[lumbre-mcp-oauth] barrido de credenciales: freno de purga masiva, ${inactive.length} de ` +
                `${grants.length} autorizaciones salen inactivas en Lumbre en la misma pasada; no se purga ` +
                'ninguna y se vuelve a mirar en el siguiente ciclo');
        }
        else {
            for (const grant of inactive) {
                if (await this.purgeInactiveGrant(grant))
                    result.purgedGrants += 1;
            }
        }
        for (const item of (await this.loadStore()).revocationOutbox) {
            await this.flushRevocationOutbox(item.credentialId);
            const stillQueued = (await this.loadStoreReadOnly()).revocationOutbox.some((candidate) => candidate.credentialId === item.credentialId);
            if (!stillQueued || braked)
                continue;
            let upstreamToken;
            try {
                upstreamToken = decrypt(item.upstream, key, grantContext(item.clientId, item.resource, item.scope));
            }
            catch {
                result.undetermined += 1;
                continue;
            }
            let state;
            try {
                state = await this.credentialState(item, upstreamToken);
            }
            catch {
                result.aborted = true;
                return;
            }
            if (state === 'mismatch')
                result.undetermined += 1;
            // Activa (o no se sabe de quién es): sigue habiendo algo que revocar
            // en Lumbre, así que la pendiente se queda y se reintenta.
            if (state !== 'inactive')
                continue;
            if (await this.retireSettledRevocation(item))
                result.retiredOutboxItems += 1;
        }
    }
    /**
     * Retira del almacén TODO lo de una autorización cuya credencial Lumbre
     * acaba de declarar inactiva: el grant, las tombstones de su familia y,
     * por si acaso, cualquier código pendiente o pendiente de revocación con
     * esa misma credencial (`normalizeStore` ya impide que coexistan con el
     * grant; el filtro está para que la purga no dependa de ese invariante).
     *
     * NO pasa por la outbox, a diferencia de `revokeFamily`. La outbox existe
     * para credenciales que siguen VIVAS en Lumbre y hay que revocar allí; esta
     * ya no lo está, lo ha dicho Lumbre. Encolarla dejaría la credencial
     * cifrada en disco hasta que un `revoke` innecesario confirmase (o hasta 30
     * días si Lumbre se cae justo después), que es exactamente lo que este
     * barrido viene a quitar. Aquí todo sale en UNA escritura.
     *
     * Vuelve a comprobar DENTRO del mutador que el grant sigue ahí y con la
     * misma credencial: entre la introspección y este punto ha habido un
     * `await`, y el cliente pudo revocar, o la familia caducar. Si ya no está,
     * no se hace nada y se devuelve `false` (quien lo retiró ya se encargó de
     * su huella). Una rotación por refresh NO cuenta como cambio: es la misma
     * credencial, y sigue inactiva.
     *
     * La huella de notas la borra `mutateStore` al confirmar la escritura, como
     * en cualquier otra retirada (ver `forgetNotesSeenOfRetired`).
     */
    async purgeInactiveGrant(seen) {
        let purged = false;
        await this.mutateStore((store) => {
            const grant = store.grants.find((item) => item.familyId === seen.familyId &&
                item.credentialId === seen.credentialId &&
                sameEncryptedValue(item.upstream, seen.upstream));
            if (!grant)
                return false;
            this.removeFamily(store, grant.familyId);
            store.authorizationCodes = store.authorizationCodes.filter((item) => item.credentialId !== grant.credentialId);
            store.revocationOutbox = store.revocationOutbox.filter((item) => item.credentialId !== grant.credentialId);
            purged = true;
            return true;
        });
        return purged;
    }
    /** Retira de la outbox una pendiente cuya credencial Lumbre ya declara
     *  inactiva. Misma comprobación dentro del mutador que
     *  `purgeInactiveGrant`: si un `flush` concurrente ya la quitó, `false`. */
    async retireSettledRevocation(seen) {
        let retired = false;
        await this.mutateStore((store) => {
            const before = store.revocationOutbox.length;
            store.revocationOutbox = store.revocationOutbox.filter((item) => !(item.credentialId === seen.credentialId && sameEncryptedValue(item.upstream, seen.upstream)));
            retired = store.revocationOutbox.length !== before;
            return retired;
        });
        return retired;
    }
    /**
     * Borra la huella de notas (`notes-seen-<id>.json`, `notes.ts`) de cada
     * credencial que `before` tenía en uso y `store` ya no. Lo llama
     * `mutateStore` y SOLO él: es el único sitio por el que algo sale del
     * almacén, así que colgarlo de ahí cubre todos los caminos de una vez
     * (`/revoke`, replay de un refresh, credencial inactiva al refrescar o al
     * canjear, caducidad de la familia o del código, la purga del barrido) y
     * también el que se añada mañana sin acordarse de esto.
     *
     * EL ORDEN, que es la decisión de seguridad: primero se confirma la
     * escritura del almacén (`rename`), DESPUÉS se borra el fichero. Los dos
     * fallos a medias posibles no pesan igual:
     *   · Al revés (fichero primero) y falla la escritura: el grant sigue vivo
     *     (y con él una credencial que puede seguir activa en Lumbre) pero ya
     *     sin su huella. Se habría destruido un dato de una autorización que
     *     sigue en pie, por una retirada que no ocurrió.
     *   · Así (almacén primero) y falla el borrado, o el proceso muere entre
     *     los dos pasos: queda un fichero huérfano de una autorización que ya
     *     no existe. No contiene la credencial ni texto de ninguna nota (son
     *     identificadores de tarea con una fecha y una longitud), nadie puede
     *     volver a leerlo ni a escribirlo desde fuera, y NO se queda para
     *     siempre: deja de escribirse y el barrido lo borra a los 30 días.
     * Entre perder de más y tardar de más, se elige tardar. Por eso el borrado
     * va tras el `rename` y no espera al `fsync` del directorio: si ese último
     * paso falla, el grant ya salió del fichero igualmente.
     *
     * SOLO SI NADIE MÁS LA USA. El nombre del fichero sale del TOKEN, no del
     * `credentialId`. La relación es una credencial por autorización
     * (`normalizeStore` rechaza un `credentialId` repetido), pero si Lumbre
     * entregase el mismo token a dos autorizaciones, borrar al irse la primera
     * le quitaría la huella a la segunda. Así que se comparan los tokens
     * descifrados de lo que QUEDA, y si no se puede descifrar lo que queda no
     * se borra nada: sin saber, no se destruye.
     *
     * No lanza: la escritura del almacén ya está confirmada y un fallo aquí no
     * puede convertirse en el fallo de la operación que la pidió. Lo que no se
     * pudo borrar se dice en stderr con un recuento, sin nombres.
     *
     * LÍMITE CONOCIDO: una tool en vuelo con esa credencial en el instante de
     * la retirada puede volver a escribir el fichero después de este borrado.
     * Es el mismo huérfano de arriba y cae por la misma red de 30 días.
     */
    async forgetNotesSeenOfRetired(before, store) {
        const held = heldCredentials(store);
        const heldIds = new Set(held.map((item) => item.credentialId));
        const retired = before.filter((item) => !heldIds.has(item.credentialId));
        if (retired.length === 0)
            return;
        let failed = 0;
        try {
            const key = await this.key();
            const heldTokens = new Set(held.map((item) => decrypt(item.upstream, key, grantContext(item.clientId, item.resource, item.scope))));
            for (const item of retired) {
                try {
                    const upstreamToken = decrypt(item.upstream, key, grantContext(item.clientId, item.resource, item.scope));
                    if (heldTokens.has(upstreamToken))
                        continue;
                    await forgetAccountNotesSeen(upstreamToken);
                }
                catch {
                    failed += 1;
                }
            }
        }
        catch {
            failed = retired.length;
        }
        if (failed > 0) {
            console.error(`[lumbre-mcp-oauth] huella de notas: ${failed} fichero(s) de autorizaciones retiradas sin borrar; ` +
                'caducan a los 30 días sin escrituras');
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
        // La clave se escribe ENTERA en un temporal con `fsync` y solo después
        // aparece con su nombre (H9 del audit de recuperación del 10 oct 2026).
        // Antes se abría `oauth.key` con `wx` y se escribía dentro: un corte
        // entre el `open` y el `sync` dejaba una clave vacía y el siguiente
        // arranque fallaba con «clave inválida» hasta borrarla a mano.
        //
        // `link` y no `rename`: los dos publican el fichero de forma atómica,
        // pero `rename` PISA un destino que ya exista, y eso perdería lo que
        // daba el `wx`: si dos arranques generan clave a la vez, gana uno y el
        // otro lee la suya (`EEXIST`), en vez de quedarse cada uno con una
        // distinta. El temporal casa con `ORPHAN_TEMP_PATTERN`, así que si el
        // corte llega antes de publicarlo lo borra el siguiente arranque.
        const key = randomBytes(32);
        const temp = `${keyPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        let created = false;
        try {
            const handle = await open(temp, 'wx', 0o600);
            try {
                await handle.writeFile(key.toString('base64url'), 'utf8');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            try {
                await this.linkFile(temp, keyPath);
                created = true;
            }
            catch (error) {
                const code = error.code;
                if (code === 'ENOTSUP' || code === 'EPERM') {
                    // Sistema de ficheros sin enlaces duros (algunos montajes FUSE o
                    // SMB): se vuelve a lo de antes, `wx` directo sobre `oauth.key`,
                    // con el contenido ya escrito y su `fsync`. Conserva la
                    // exclusividad; lo que pierde ahí es solo la atomicidad frente a
                    // un corte, que es como estaba antes de H9.
                    created = await writeExclusive(keyPath, key.toString('base64url'));
                }
                else if (code !== 'EEXIST') {
                    throw error;
                }
            }
        }
        finally {
            await unlink(temp).catch(() => undefined);
        }
        if (created) {
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
        return structuredClone(await this.loadStoreShared());
    }
    /**
     * Lo mismo que `loadStore` pero SIN copia (R10 del audit de rendimiento:
     * `resolveAccessToken` clonaba el store entero en CADA petición `/mcp`).
     * Devuelve la referencia de la caché, tipada como solo lectura: el único
     * llamante es un camino que solo lee (`find` + campos). Es seguro porque
     * todo escritor pasa por `loadStore` (copia privada) y la caché solo se
     * SUSTITUYE (`adoptStore`), nunca se muta en sitio: una referencia ya
     * entregada sigue siendo un estado coherente, a lo sumo anterior a una
     * escritura posterior. NO usar desde un mutador.
     */
    async loadStoreReadOnly() {
        return this.loadStoreShared();
    }
    async loadStoreShared() {
        const cached = this.cachedStore;
        if (cached)
            return cached;
        const generation = this.storeGeneration;
        const store = await this.readStore();
        if (generation !== this.storeGeneration) {
            const current = this.cachedStore;
            // Sin caché vigente (alguien la invalidó) se relee, pero tampoco se
            // adopta: quien invalidó manda.
            return current ?? (await this.readStore());
        }
        this.cachedStore = store;
        return store;
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
                    revocationOutbox: [],
                    redeemedCodes: [],
                    usedLogoutTokens: [],
                    closedSumegoSessions: []
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
    /**
     * Espera a que la cola de escritura del store quede vacía, incluidas las
     * escrituras que se encolen mientras se espera. La usa el apagado
     * ordenado de `http.ts` (SIGTERM) para no salir con un `rename` a medias
     * de confirmar. Espera también las revocaciones best-effort en Sumego
     * que haya en vuelo (`revokeSumegoRefreshLater`), cada una acotada por el
     * timeout del cliente OIDC. No lanza: el fallo de una escritura ya lo
     * recibe quien la pidió.
     */
    async whenWritesSettled() {
        let queue;
        do {
            queue = this.writeQueue;
            await queue.catch(() => undefined);
            await Promise.all([...this.backgroundTasks]);
        } while (queue !== this.writeQueue || this.backgroundTasks.size > 0);
    }
    async mutateStore(mutator) {
        let failure;
        let changed = false;
        this.writeQueue = this.writeQueue.then(async () => {
            // Para `forgetNotesSeenOfRetired`: qué credenciales había en uso
            // antes de esta pasada, y el estado que llegó a quedar en disco.
            let heldBefore = [];
            // Lo mismo para `revokeSumegoRefreshOfRetired`.
            let sumegoBefore = [];
            let written;
            try {
                const store = await this.loadStore();
                // Antes de la poda y del mutador: las dos cosas retiran grants.
                heldBefore = heldCredentials(store);
                sumegoBefore = [...store.grants, ...store.authorizationCodes].flatMap(({ credentialId, clientId, resource, scope, sumegoRefresh }) => sumegoRefresh ? [{ credentialId, clientId, resource, scope, sumegoRefresh }] : []);
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
                const redeemedBefore = store.redeemedCodes.length;
                store.redeemedCodes = store.redeemedCodes.filter((item) => item.expiresAt > now);
                const logoutsBefore = store.usedLogoutTokens.length;
                store.usedLogoutTokens = store.usedLogoutTokens.filter((item) => item.expiresAt > now);
                const closedBefore = store.closedSumegoSessions.length;
                store.closedSumegoSessions = store.closedSumegoSessions.filter((item) => item.expiresAt > now);
                housekeeping ||=
                    usedBefore !== store.usedRefreshTokens.length ||
                        requestsBefore !== store.authorizationRequests.length ||
                        redeemedBefore !== store.redeemedCodes.length ||
                        logoutsBefore !== store.usedLogoutTokens.length ||
                        closedBefore !== store.closedSumegoSessions.length;
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
                    written = store;
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
            // Toda credencial que acaba de salir del almacén se lleva su huella
            // de notas. Va DESPUÉS de confirmar el `rename` (nunca antes: ver el
            // orden en `forgetNotesSeenOfRetired`), aunque un paso posterior haya
            // fallado, y dentro de la cola: ninguna otra escritura puede colarse
            // entre el estado que se acaba de escribir y la comprobación de que
            // nadie más usa esa credencial.
            if (written)
                await this.forgetNotesSeenOfRetired(heldBefore, written);
            if (written)
                await this.revokeSumegoRefreshOfRetired(sumegoBefore, written);
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