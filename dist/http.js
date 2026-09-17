#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAccountNotesSeenStore } from './notes.js';
import { createOAuthService, OAUTH_CHALLENGE, stopReceiving } from './oauth.js';
import { stripToolsListSchema } from './schema-strip.js';
// CONTRATO M1: acoplamiento con la factory real de `index.ts` (M1, ya
// integrado). `createServer(config, opts)` NO cae en los defaults de `opts`
// enteros: `localFilesystem: false` (ver más abajo) va explícito, y la huella
// de notas vistas (`notesSeenStore`) va explícita TAMBIÉN — un store POR
// CUENTA (`createAccountNotesSeenStore`, `notes.ts`), no el default
// `fileNotesSeenStore` — ver el porqué en el punto donde se llama a
// `createServer`, más abajo.
import { createServer } from './index.js';
/**
 * Transporte HTTP remoto de lumbre-mcp (mcp.lumbre.pro, tarea M2). A
 * diferencia de `index.ts` (stdio, un proceso por cliente, token fijo por
 * `env`), este servidor es un RELÉ compartido: NO tiene token propio — cada
 * petición trae una credencial. Este lote incorpora el núcleo OAuth 2.1
 * Authorization Code + PKCE: el bearer opaco se resuelve localmente al token
 * upstream cifrado y solo ESTE último se convierte en `config.token`; el
 * bearer OAuth nunca se reenvía a app.lumbre.pro. El consentimiento actual es
 * un arnés provisional y no se despliega hasta integrar el broker de Lumbre.
 * Mientras tanto se conservan el Bearer directo y `/mcp/<token>`.
 *
 * SEGUNDA FORMA (tarea M2b, 2026-08-25): `POST /mcp/<token>` — el token va en
 * el PATH en vez de la cabecera. Motivo: claude.ai (web/móvil) no deja
 * configurar cabeceras en un conector personalizado. OAuth sustituirá esta vía
 * cuando exista el broker; se mantiene durante la migración. `/mcp` sigue funcionando exactamente
 * igual para quien sí puede mandar cabecera (Claude Code, ver
 * `deploy/README-deploy.md`). Si llegan las dos formas a la vez, GANA la
 * cabecera (resuelta en `handleMcpRequest`) — es la menos expuesta de las dos (no
 * queda guardada en ningún sitio salvo la config del cliente), así que ante
 * ambigüedad se prefiere la buena en vez de fallar o mezclar.
 *
 * Modo STATELESS (`sessionIdGenerator: undefined`, ver el JSDoc de
 * `StreamableHTTPServerTransport` en el SDK): un `McpServer` + un transporte
 * NUEVOS por petición HTTP, cerrados al terminar. No hay sesión que fugue
 * entre el token de un cliente y el de otro — la alternativa (un server
 * reutilizado con sesiones) obligaría a atar cada sesión a un token y a
 * expirarlas; más superficie para un conector que hoy sirve peticiones
 * sueltas de Claude, no streams largos.
 *
 * `PORT` (env, default 8787 — arbitrario, elegido por no chocar con los
 * puertos que ya usan otros servicios locales del entorno: 3000/5000/8080).
 * `LUMBRE_BASE_URL` (env, default `https://app.lumbre.pro`, igual que
 * `index.ts`) — a diferencia del token, SÍ es del servidor: todas las
 * peticiones relevan hacia la MISMA instancia de Lumbre.
 */
const DEFAULT_PORT = 8787;
const DEFAULT_BASE_URL = 'https://app.lumbre.pro';
/**
 * Tope del cuerpo de una petición a `/mcp` (2 MiB). La cuenta, porque el
 * número no es redondo por casualidad: el cuerpo legítimo más grande que
 * existe es un `tools/call` de `add_attachment` con `content_base64`, cuyo
 * tope decodificado es `MAX_BASE64_ATTACHMENT_BYTES` (1 MiB,
 * `attachments.ts`). Base64 infla 4 bytes por cada 3, así que 1 MiB
 * decodificado son 1.398.104 bytes de texto base64 (≈1,33 MiB), más el sobre
 * JSON-RPC (método, `filename`, escapado de la cadena). 2 MiB deja ~700 KiB
 * de margen sobre ese peor caso —un 50% largo— sin dejar que una petición
 * anónima haga crecer la memoria del proceso sin límite: hasta hoy `readBody`
 * acumulaba en un array de `Buffer` SIN tope y se alcanzaba con cualquier
 * `Authorization: Bearer x` (el token solo se valida contra Lumbre más tarde,
 * al llamar a la tool).
 *
 * El borde lleva su propio `request_body { max_size … }` (ver
 * `deploy/mcp-lumbre-pro.caddy`), un pelín MÁS estricto a propósito: quien
 * pase por Caddy choca antes ahí; este tope es la red de seguridad para quien
 * alcance el contenedor por la red `edge` sin pasar por el borde.
 */
export const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024;
/**
 * Código JSON-RPC del 413. Va en el rango reservado a errores de servidor
 * (-32000..-32099, ver la spec JSON-RPC 2.0), como el -32000 genérico de
 * 405/403 y el -32001 de "sin credencial": un código propio para que un
 * cliente distinga "el cuerpo no cabe" de "no tienes permiso".
 */
const JSON_RPC_PAYLOAD_TOO_LARGE = -32002;
/** El cuerpo superó `MAX_MCP_BODY_BYTES`. Se distingue del error de parseo
 *  (400) porque el 413 lleva su propio status y su propio código. */
class PayloadTooLargeError extends Error {
}
/**
 * Hosts permitidos, tanto para el header `Host` (protección DNS-rebinding
 * mínima: si alguien resuelve `mcp.lumbre.pro` a este proceso desde un
 * hostname distinto, se corta aquí) como para `Origin` (peticiones desde un
 * navegador). El puerto NO se valida (cambia según quién lo levante en local).
 *
 * El SDK trae `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection`
 * en `StreamableHTTPServerTransportOptions`, pero están `@deprecated` a favor
 * de "usa middleware externo" (ver `webStandardStreamableHttp.d.ts`) — de ahí
 * que la validación viva aquí, ANTES de construir el transporte, en vez de
 * pasada como opción.
 */
const ALLOWED_HOSTNAMES = new Set(['mcp.lumbre.pro']);
/**
 * `localhost`/`127.0.0.1`/`::1` cubren desarrollo local, pero hasta hoy se
 * aceptaban TAMBIÉN en producción, donde el único cliente legítimo es Caddy
 * (que llega con `Host: mcp.lumbre.pro` desde la red `edge`, una IP `172.x`).
 * Un `Host: localhost` desde ahí no lo manda nadie legítimo: es exactamente la
 * forma de saltarse la comprobación de rebinding.
 *
 * Ahora un hostname de loopback solo vale si la CONEXIÓN viene de loopback.
 * Eso deja pasar lo que tiene que pasar y nada más:
 *   · el healthcheck del contenedor (`wget http://127.0.0.1:8787/readyz`, ver
 *     `deploy/compose.yml`), que sale y entra por la interfaz de loopback;
 *   · los tests y el desarrollo local, que hablan con `127.0.0.1:<puerto>`;
 *   · NO Caddy con un `Host` falsificado, ni nadie que alcance el contenedor
 *     por el DNS de la red `edge`.
 * `LUMBRE_MCP_ALLOW_LOOPBACK_HOST=1` fuerza el comportamiento antiguo para un
 * entorno de desarrollo raro (un proxy local que reescribe el `Host`), y es
 * explícita: no se enciende sola en producción.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
function isLoopbackAddress(address) {
    if (!address)
        return false;
    // Un socket IPv6 que recibe una conexión IPv4 la reporta mapeada
    // (`::ffff:127.0.0.1`), que es como llegan los tests: `listen(0)` escucha
    // en `::` y el cliente entra por 127.0.0.1.
    const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
    return normalized === '::1' || /^127\./.test(normalized);
}
/**
 * Decide si un hostname es aceptable para ESTA conexión. Exportada porque es
 * la costura que testea `http.test.ts`: la diferencia entre producción y
 * desarrollo es la IP del peer, y montar un listener en una interfaz no-
 * loopback dentro de un test es frágil (depende de la red de la máquina).
 */
export function isAllowedHostname(hostname, remoteAddress) {
    if (hostname === undefined)
        return false;
    if (ALLOWED_HOSTNAMES.has(hostname))
        return true;
    if (!LOOPBACK_HOSTNAMES.has(hostname))
        return false;
    return process.env.LUMBRE_MCP_ALLOW_LOOPBACK_HOST === '1' || isLoopbackAddress(remoteAddress);
}
function hostnameOf(headerValue) {
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!raw)
        return undefined;
    try {
        // El header `Host` no lleva esquema (`mcp.lumbre.pro:443`); `Origin` sí
        // (`https://mcp.lumbre.pro`). `URL` exige uno, así que si no trae `://`
        // se le pone uno neutro solo para poder parsear el hostname.
        const withScheme = raw.includes('://') ? raw : `http://${raw}`;
        const hostname = new URL(withScheme).hostname;
        // `URL` devuelve los literales IPv6 ENTRE CORCHETES (`[::1]`), que es
        // como se escriben en un `Host`/`Origin` pero no como está la lista:
        // sin quitarlos, un `Host: [::1]:8787` —el de un healthcheck o un
        // desarrollo local por IPv6— no casaba y se iba con un 403.
        return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    }
    catch {
        return undefined;
    }
}
function isAllowedHost(req) {
    return isAllowedHostname(hostnameOf(req.headers.host), req.socket.remoteAddress);
}
/** Sin `Origin` (curl, el SDK de un cliente MCP no-navegador) no hay ataque de
 *  DNS-rebinding que proteger — ese vector es específicamente "una página en
 *  el navegador de la víctima habla con localhost", y exige `Origin`. Con
 *  `Origin` presente, SÍ se exige que esté en la lista. */
function isAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin)
        return true;
    return isAllowedHostname(hostnameOf(origin), req.socket.remoteAddress);
}
function tokenFromHeader(req) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
        return undefined;
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : undefined;
}
/** Forma del token de email-to-task de Lumbre: 32 chars hexadecimales EN
 *  MINÚSCULAS. Un segmento de path que no case NO es "un token raro" — es
 *  "sin token": no se recorta ni se normaliza, se trata exactamente igual que
 *  si no hubiera nada, y el 401 de siempre lo cubre.
 *
 *  Sin la `i`, a propósito: el borde solo casa minúsculas
 *  (`path_regexp ^/mcp/([0-9a-f]{32})$` en `deploy/mcp-lumbre-pro.caddy`), así
 *  que un token en mayúsculas llegaba aquí SIN que Caddy lo hubiera sacado del
 *  path — es decir, entrando entero en el pipeline de logs del borde, que es
 *  justo lo que ese bloque existe para evitar. Aceptarlo aquí premiaba la
 *  única forma de la URL que sí filtra el token. */
const TOKEN_PATH_PATTERN = /^[0-9a-f]{32}$/;
function isWellFormedPathToken(segment) {
    return TOKEN_PATH_PATTERN.test(segment);
}
function sendJsonRpcError(res, status, code, message, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
/**
 * Lee el cuerpo con un tope duro de bytes (`MAX_MCP_BODY_BYTES`).
 *
 * Dos comprobaciones, no una: el `content-length` declarado se mira ANTES de
 * leer nada (así un cuerpo enorme y honesto se rechaza sin acumular ni un
 * byte), y luego se cuenta lo que llega de verdad — porque `content-length`
 * puede faltar (`transfer-encoding: chunked`) o mentir.
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
            reject(new PayloadTooLargeError());
            return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_MCP_BODY_BYTES) {
                chunks.length = 0;
                reject(new PayloadTooLargeError());
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
/** Solo para el log — nunca vuelca el body ni el token, solo el nombre del
 *  método JSON-RPC (o `batch(N)` si es una petición en lote). */
function describeMethod(body) {
    if (Array.isArray(body))
        return `batch(${body.length})`;
    if (body && typeof body === 'object' && typeof body.method === 'string') {
        return body.method;
    }
    return 'unknown';
}
/** Log mínimo a stderr (stdout queda libre para no ensuciar nada que lo lea):
 *  método JSON-RPC + status HTTP, NUNCA el token ni el body. */
function logRequest(method, status) {
    console.error(`[lumbre-mcp-http] ${method} ${status}`);
}
/**
 * `routeLabel` es SOLO para el log: `/mcp` o `/mcp/<redactado>` — nunca el
 * segmento real del path, esté o no bien formado (un token mal transcrito por
 * un solo carácter sigue siendo un token que no debe acabar en un log). El
 * body ya lo lee `handleMcpRequest` sin volcarlo tampoco (`describeMethod`).
 */
async function handleMcpRequest(req, res, baseUrl, pathToken, routeLabel, oauth) {
    if (req.method !== 'POST') {
        sendJsonRpcError(res, 405, -32000, `Method not allowed. Modo stateless: solo POST ${routeLabel}.`);
        logRequest(`${req.method ?? '?'} ${routeLabel}`, 405);
        return;
    }
    if (!isAllowedHost(req) || !isAllowedOrigin(req)) {
        sendJsonRpcError(res, 403, -32000, 'Host/Origin no permitido.');
        logRequest(`POST ${routeLabel}`, 403);
        return;
    }
    // Fail-closed: sin token no se llega ni a leer el body. El servidor NO
    // tiene token propio — es el de ESTA petición el que se usa para hablar
    // con app.lumbre.pro (ver el JSDoc de cabecera). Cabecera gana sobre path
    // (resuelta debajo); un `pathToken` mal formado ya llega aquí como
    // `undefined` (ver `createHttpApp`), así que un path con la forma
    // incorrecta cae exactamente por esta misma rama, como "sin credencial".
    const presentedBearer = tokenFromHeader(req);
    let token = pathToken;
    // `authMode` (ver `LumbreConfig.authMode`, tarea 0a717ae9): `'oauth'` SOLO
    // cuando el bearer presentado es un access token OAuth 2.1 resuelto por el
    // broker (`resolveAccessToken`) a la credencial upstream — un 401 de
    // app.lumbre.pro con esa credencial no lo arregla nadie tocando
    // `LUMBRE_TOKEN`. El Bearer directo y el token en el path (formas de
    // compatibilidad, ver el JSDoc de cabecera) siguen siendo el mismo tipo de
    // credencial estática que `LUMBRE_TOKEN`, así que conservan `'token'`.
    let authMode = 'token';
    if (presentedBearer) {
        if (oauth.isOAuthAccessToken(presentedBearer)) {
            token = await oauth.resolveAccessToken(presentedBearer);
            authMode = 'oauth';
        }
        else {
            token = presentedBearer;
        }
    }
    if (!token) {
        // El presupuesto se mira AQUÍ, en la única rama en la que la petición no
        // trae credencial utilizable, y DESPUÉS de intentar resolverla. Estaba
        // antes, arriba del todo, y eso cortaba TODO `POST /mcp` de esa IP
        // aunque trajera un bearer bueno: claude.ai reintentando con un access
        // token caducado (duran una hora) desde una IP de salida compartida
        // agotaba el cupo, y el bearer ya refrescado se comía un 429. Una
        // petición que resuelve no toca el limitador ni para leerlo.
        //
        // Lo que se paga por ese orden: el presupuesto ya no evita el trabajo
        // de resolver, solo acota el ritmo de 401 que se pueden provocar. Sale
        // a cuenta porque resolver es barato desde que el store está cacheado
        // en memoria (`loadStore` en `oauth.ts`), y porque lo caro de verdad
        // —leer el cuerpo, montar el `McpServer`— sigue detrás de esta puerta.
        if (oauth.mcpAttemptsExhausted(req)) {
            sendJsonRpcError(res, 429, -32000, 'Demasiados intentos de autenticación; inténtalo de nuevo más tarde.');
            logRequest(`POST ${routeLabel}`, 429);
            return;
        }
        oauth.recordFailedMcpAttempt(req);
        sendJsonRpcError(res, 401, -32001, 'Authorization requerida. Conecta este servidor mediante OAuth 2.1.', { 'www-authenticate': OAUTH_CHALLENGE });
        logRequest(`POST ${routeLabel}`, 401);
        return;
    }
    let parsedBody;
    let methodLabel = 'unknown';
    try {
        const raw = await readBody(req);
        parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
        methodLabel = describeMethod(parsedBody);
    }
    catch (err) {
        if (err instanceof PayloadTooLargeError) {
            sendJsonRpcError(res, 413, JSON_RPC_PAYLOAD_TOO_LARGE, `El cuerpo de la petición supera el tope de ${MAX_MCP_BODY_BYTES} bytes.`);
            // SIN `connection: close` en la cabecera, y está medido: Node marca
            // entonces `res._last` y hace `destroySoon()` del socket en cuanto
            // la respuesta termina, con el cliente todavía subiendo — RST, y el
            // 413 no llega (`fetch failed … ECONNRESET`). El cierre lo hace
            // `stopReceiving`, que espera a que el cliente acabe o a que se
            // agote el margen.
            stopReceiving(req);
            logRequest(`POST ${routeLabel}`, 413);
            return;
        }
        sendJsonRpcError(res, 400, -32700, 'Parse error: el cuerpo no es JSON válido.');
        logRequest(`POST ${routeLabel}`, 400);
        return;
    }
    const config = { baseUrl, token, authMode };
    // CONTRATO M1: la única LLAMADA a la factory real de `index.ts`.
    // `localFilesystem: false` — este proceso corre en el VPS compartido, no
    // en la máquina de quien pregunta: `add_attachment({ file_path })` NUNCA
    // vería el disco correcto desde aquí (medido el 2026-08-27: "no existe el
    // fichero" contra un fichero que sí existía en el Mac del usuario, porque
    // el `fs.stat` corría aquí). Ver el JSDoc de `CreateServerOptions` en
    // `index.ts`.
    //
    // `notesSeenStore: createAccountNotesSeenStore(token)` — este proceso es un
    // RELÉ compartido (ver el JSDoc de cabecera), así que `token` puede ser
    // cualquiera de VARIAS cuentas distintas en el mismo contenedor. El
    // fichero único de siempre (`fileNotesSeenStore`, el default de
    // `createServer`) mezclaba la huella de todas ellas: una nota "vista" por
    // una cuenta salía como marcador para OTRA que nunca la vio, y el tráfico
    // de una podía expulsar del cap de 2.000 entradas las de la otra. El
    // store por cuenta (`notes.ts`) separa el fichero en disco
    // (`notes-seen-<id>.json`, `<id>` derivado de `token`, nunca la credencial
    // en sí) sin perder la ventaja original de compartir huella ENTRE
    // dispositivos de la MISMA cuenta (Claude Code, claude.ai web/móvil…): el
    // aislamiento es por cuenta, no por dispositivo. Ver el detalle de coste
    // (huella nula descartada, ~29,9 KB de más por `list_tasks`) en el JSDoc
    // de `createAccountNotesSeenStore`.
    const mcpServer = createServer(config, {
        localFilesystem: false,
        notesSeenStore: createAccountNotesSeenStore(token)
    });
    // `enableJsonResponse: true`: respuesta JSON directa en vez de un stream
    // SSE — este endpoint sirve llamadas sueltas de tool (petición → una
    // respuesta), no notificaciones de servidor a mitad de una tarea larga.
    // Simplifica también al cliente: `fetch` + `res.json()`, sin parsear
    // `text/event-stream` a mano (ver `scripts/smoke-remote.mjs`).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    stripToolsListSchema(transport);
    try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
    }
    catch (err) {
        console.error('[lumbre-mcp-http] error interno:', err instanceof Error ? err.message : String(err));
        if (!res.headersSent)
            sendJsonRpcError(res, 500, -32603, 'Internal server error');
    }
    finally {
        logRequest(`POST ${routeLabel} ${methodLabel}`, res.statusCode);
        res.on('close', () => {
            void transport.close();
            void mcpServer.close();
        });
    }
}
/**
 * Construye la app sin arrancar el listener — separado de `main()` para que
 * los tests puedan levantarla en un puerto efímero (`app.listen(0)`) sin
 * pisar el `PORT` real.
 */
export function createHttpApp(baseUrl = process.env.LUMBRE_BASE_URL?.trim() || DEFAULT_BASE_URL, oauth = createOAuthService()) {
    return createHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        // Cabeceras de seguridad para TODA respuesta de este servidor, puestas
        // en un solo sitio y antes de enrutar. Las rutas OAuth ya traían las
        // suyas (`securityHeaders` en `oauth.ts`), pero el resto —errores
        // JSON-RPC, `/healthz`, `/readyz`, 404, 405, y las respuestas que
        // escribe el propio `StreamableHTTPServerTransport`— salían sin
        // ninguna: una respuesta con token o con el resultado de una tool no
        // debe quedarse en ninguna caché intermedia, ni interpretarse como un
        // tipo distinto del declarado.
        //
        // `setHeader` y no `writeHead`: Node fusiona lo puesto aquí con lo que
        // cada `writeHead` pase después, y en un choque GANA `writeHead` — así
        // la metadata OAuth conserva su `cache-control: public, max-age=300`
        // deliberado sin excepciones repartidas por el fichero.
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        if (!isAllowedHost(req) || !isAllowedOrigin(req)) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Host/Origin no permitido.');
            return;
        }
        if (url.pathname === '/healthz' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('ok');
            return;
        }
        if (url.pathname === '/readyz' && req.method === 'GET') {
            void oauth.checkReady().then(() => {
                res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('ready');
            }, () => {
                res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
                res.end('not ready');
            });
            return;
        }
        if (req.method === 'GET' &&
            (url.pathname === '/.well-known/oauth-protected-resource/mcp' ||
                url.pathname === '/.well-known/oauth-protected-resource')) {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
            res.end(JSON.stringify(oauth.protectedResourceMetadata()));
            return;
        }
        if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
            res.end(JSON.stringify(oauth.authorizationServerMetadata()));
            return;
        }
        if (url.pathname === '/authorize') {
            void oauth.handleAuthorize(req, res, url);
            return;
        }
        if (url.pathname === '/oauth/lumbre/callback') {
            void oauth.handleLumbreCallback(req, res, url);
            return;
        }
        if (url.pathname === '/token') {
            void oauth.handleToken(req, res);
            return;
        }
        if (url.pathname === '/revoke') {
            void oauth.handleRevoke(req, res);
            return;
        }
        if (url.pathname === '/mcp') {
            void handleMcpRequest(req, res, baseUrl, undefined, '/mcp', oauth);
            return;
        }
        // `/mcp/<token>` (segunda forma, ver el JSDoc de cabecera). Cualquier
        // cosa bajo el prefijo `/mcp/` entra aquí, no solo un único segmento
        // hexadecimal bien formado — `/mcp/` (vacío), `/mcp/algo/mas` (varios
        // segmentos) o un segmento con caracteres raros llegan igual a
        // `handleMcpRequest` con `pathToken: undefined`, y caen por el mismo
        // 401 de "sin credencial" que hoy. No hay recorte ni normalización: o
        // el resto del path es EXACTAMENTE un segmento que casa
        // `TOKEN_PATH_PATTERN`, o no hay token.
        const MCP_PATH_PREFIX = '/mcp/';
        if (url.pathname.startsWith(MCP_PATH_PREFIX)) {
            const remainder = url.pathname.slice(MCP_PATH_PREFIX.length);
            const isSingleSegment = remainder.length > 0 && !remainder.includes('/');
            const pathToken = isSingleSegment && isWellFormedPathToken(remainder) ? remainder : undefined;
            void handleMcpRequest(req, res, baseUrl, pathToken, '/mcp/<redactado>', oauth);
            return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    });
}
// Arranca el listener solo si este módulo es el entrypoint del proceso
// (`node dist/http.js`) — importarlo desde un test (`createHttpApp`) no debe
// abrir un puerto real.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    const port = Number(process.env.PORT) || DEFAULT_PORT;
    const baseUrl = process.env.LUMBRE_BASE_URL?.trim() || DEFAULT_BASE_URL;
    const oauth = createOAuthService();
    void oauth.ensureReady().then(() => {
        const app = createHttpApp(baseUrl, oauth);
        app.listen(port, () => {
            console.error(`[lumbre-mcp-http] escuchando en :${port} (relé hacia ${baseUrl})`);
        });
    }, () => {
        console.error('[lumbre-mcp-http] estado OAuth no disponible; listener no iniciado');
        process.exitCode = 1;
    });
}
//# sourceMappingURL=http.js.map