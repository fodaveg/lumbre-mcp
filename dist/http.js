#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { nullNotesSeenStore } from './notes.js';
import { stripToolsListSchema } from './schema-strip.js';
// CONTRATO M1: acoplamiento con la factory real de `index.ts` (M1, ya
// integrado). `createServer(config, opts)` NO cae en los defaults de `opts`
// enteros: `localFilesystem: false` (ver más abajo) y `notesSeenStore:
// nullNotesSeenStore` — a diferencia de `main()` (stdio), este proceso es
// COMPARTIDO entre todos los dispositivos de David con el mismo token, así
// que ni el disco ni la huella de notas por fichero (`fileNotesSeenStore`,
// el default) tienen sentido aquí — ver el JSDoc de `nullNotesSeenStore` en
// `notes.ts` para el porqué completo.
import { createServer } from './index.js';
/**
 * Transporte HTTP remoto de lumbre-mcp (mcp.lumbre.pro, tarea M2). A
 * diferencia de `index.ts` (stdio, un proceso por cliente, token fijo por
 * `env`), este servidor es un RELÉ compartido: NO tiene token propio — cada
 * petición trae el suyo en `Authorization: Bearer <token>` y ese token se
 * convierte en el `config.token` con el que ESA petición habla con
 * app.lumbre.pro (ver `lumbre-client.ts`). Sin header, 401 fail-closed: nunca
 * se intenta una petición sin auth "a ver qué pasa".
 *
 * SEGUNDA FORMA (tarea M2b, 2026-08-25): `POST /mcp/<token>` — el token va en
 * el PATH en vez de la cabecera. Motivo: claude.ai (web/móvil) no deja
 * configurar cabeceras en un conector personalizado y, si el servidor
 * responde 401, exige un flujo OAuth 2.1 completo que este relé no tiene
 * (M3, sin hacer). Es la vía barata, igual que ya hace Lumbre con el feed ICS
 * y los buzones: el token vive en la URL. `/mcp` sigue funcionando exactamente
 * igual para quien sí puede mandar cabecera (Claude Code, ver
 * `deploy/README-deploy.md`). Si llegan las dos formas a la vez, GANA la
 * cabecera (`extractToken`, más abajo) — es la menos expuesta de las dos (no
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
 * Hosts permitidos, tanto para el header `Host` (protección DNS-rebinding
 * mínima: si alguien resuelve `mcp.lumbre.pro` a este proceso desde un
 * hostname distinto, se corta aquí) como para `Origin` (peticiones desde un
 * navegador). `localhost`/`127.0.0.1`/`::1` cubren desarrollo local; el
 * puerto NO se valida (cambia según quién lo levante en local).
 *
 * El SDK trae `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection`
 * en `StreamableHTTPServerTransportOptions`, pero están `@deprecated` a favor
 * de "usa middleware externo" (ver `webStandardStreamableHttp.d.ts`) — de ahí
 * que la validación viva aquí, ANTES de construir el transporte, en vez de
 * pasada como opción.
 */
const ALLOWED_HOSTNAMES = new Set(['mcp.lumbre.pro', 'localhost', '127.0.0.1', '::1']);
function hostnameOf(headerValue) {
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!raw)
        return undefined;
    try {
        // El header `Host` no lleva esquema (`mcp.lumbre.pro:443`); `Origin` sí
        // (`https://mcp.lumbre.pro`). `URL` exige uno, así que si no trae `://`
        // se le pone uno neutro solo para poder parsear el hostname.
        const withScheme = raw.includes('://') ? raw : `http://${raw}`;
        return new URL(withScheme).hostname;
    }
    catch {
        return undefined;
    }
}
function isAllowedHost(req) {
    const hostname = hostnameOf(req.headers.host);
    return hostname !== undefined && ALLOWED_HOSTNAMES.has(hostname);
}
/** Sin `Origin` (curl, el SDK de un cliente MCP no-navegador) no hay ataque de
 *  DNS-rebinding que proteger — ese vector es específicamente "una página en
 *  el navegador de la víctima habla con localhost", y exige `Origin`. Con
 *  `Origin` presente, SÍ se exige que esté en la lista. */
function isAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin)
        return true;
    const hostname = hostnameOf(origin);
    return hostname !== undefined && ALLOWED_HOSTNAMES.has(hostname);
}
function tokenFromHeader(req) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
        return undefined;
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : undefined;
}
/** Forma del token de email-to-task de Lumbre: 32 chars hexadecimales. Un
 *  segmento de path que no case NO es "un token raro" — es "sin token": no se
 *  recorta ni se normaliza, se trata exactamente igual que si no hubiera
 *  nada, y el 401 de siempre lo cubre. */
const TOKEN_PATH_PATTERN = /^[0-9a-f]{32}$/i;
function isWellFormedPathToken(segment) {
    return TOKEN_PATH_PATTERN.test(segment);
}
/** Combina las dos formas de traer el token, cabecera primero. `pathToken` ya
 *  ha pasado (o no) `isWellFormedPathToken` en el llamador — aquí solo se
 *  decide la prioridad. */
function extractToken(req, pathToken) {
    return tokenFromHeader(req) ?? pathToken;
}
function sendJsonRpcError(res, status, code, message) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
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
async function handleMcpRequest(req, res, baseUrl, pathToken, routeLabel) {
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
    // (`extractToken`); un `pathToken` mal formado ya llega aquí como
    // `undefined` (ver `createHttpApp`), así que un path con la forma
    // incorrecta cae exactamente por esta misma rama, como "sin credencial".
    const token = extractToken(req, pathToken);
    if (!token) {
        sendJsonRpcError(res, 401, -32001, 'Falta Authorization: Bearer <token> o un token válido en el path.');
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
    catch {
        sendJsonRpcError(res, 400, -32700, 'Parse error: el cuerpo no es JSON válido.');
        logRequest(`POST ${routeLabel}`, 400);
        return;
    }
    const config = { baseUrl, token };
    // CONTRATO M1: la única LLAMADA a la factory real de `index.ts`.
    // `localFilesystem: false` — este proceso corre en el VPS compartido, no
    // en la máquina de quien pregunta: `add_attachment({ file_path })` NUNCA
    // vería el disco correcto desde aquí (medido el 2026-08-27: "no existe el
    // fichero" contra un fichero que sí existía en el Mac del usuario, porque
    // el `fs.stat` corría aquí). Ver el JSDoc de `CreateServerOptions` en
    // `index.ts`. `notesSeenStore: nullNotesSeenStore` — mismo motivo de
    // fondo (proceso compartido, no una máquina por dispositivo): el fichero
    // de huellas por defecto no distingue de qué dispositivo viene cada
    // petición, ver el JSDoc de `nullNotesSeenStore` en `notes.ts`.
    const mcpServer = createServer(config, { localFilesystem: false, notesSeenStore: nullNotesSeenStore });
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
export function createHttpApp(baseUrl = process.env.LUMBRE_BASE_URL?.trim() || DEFAULT_BASE_URL) {
    return createHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/healthz' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('ok');
            return;
        }
        if (url.pathname === '/mcp') {
            void handleMcpRequest(req, res, baseUrl, undefined, '/mcp');
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
            void handleMcpRequest(req, res, baseUrl, pathToken, '/mcp/<redactado>');
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
    const app = createHttpApp(baseUrl);
    app.listen(port, () => {
        console.error(`[lumbre-mcp-http] escuchando en :${port} (relé hacia ${baseUrl})`);
    });
}
//# sourceMappingURL=http.js.map