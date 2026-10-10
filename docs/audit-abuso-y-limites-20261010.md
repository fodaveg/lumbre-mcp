# Abuso y límites de recursos del transporte HTTP (10 oct 2026)

Alcance: abuso y límites de recursos del transporte HTTP remoto (`src/http.ts`,
`src/oauth.ts`, `src/existence-cache.ts`, `src/notes.ts`,
`deploy/mcp-lumbre-pro.caddy`, `deploy/compose.yml`, `Dockerfile`). Cierra la
deuda de `audit-followup-20261002.md` («no se midió crecimiento de heap ni
comportamiento con réplicas»). Árbol inspeccionado: `main`
`3540a7e3b87ea89537841016dc12ec375f1ab84e`, limpio; `dist/` versionado idéntico
al compilado de `src/` (diff vacío). No se tocó el repo ni producción.

Método: lectura de código y sondas locales contra un upstream falso. Servidor
real (`createHttpApp`/`createOAuthService` del compilado) con `backchannel` y
CIMD simulados, inyectados por las costuras de `OAuthServiceOptions` como hacen
los tests. La memoria se mide en el proceso servidor con `global.gc()` ×2 y
`process.memoryUsage()` desde un listener de depuración aparte; el generador de
carga corre en otro proceso. Para el cierre se usa el entrypoint real
`node dist/http.js` con un cortafuegos (`--import noprod.mjs`) que bloquea
cualquier `fetch` fuera de `127.0.0.1` (0 bloqueos registrados). Entorno: Node
v24.19.0 en macOS (el contenedor usa `node:22-alpine`): las cifras de RSS
dependen del asignador y no son extrapolables a musl; el heap sí. Entre
repeticiones el RSS varía ±30 %, por lo que se dan rangos.

Resumen: no hay fuga de heap. Los fallos reales son de amplificación hacia la
app y de falta de límites de concurrencia y de memoria. Las sondas y sus
salidas íntegras están en `audit-abuso-y-limites-20261010.sondas/`.

Lo hizo el agente `debugger`; la sesión coordinadora comprobó contra el repo las
citas del hallazgo 2 (`src/http.ts:318-325`), del 12 (`src/http.ts:418`) y la
ausencia de `mem_limit`, `init` y `stop_grace_period` en `deploy/compose.yml`.

## Hallazgos priorizados

| # | Prio | Hallazgo | Evidencia | Impacto | Corrección propuesta |
| --- | --- | --- | --- | --- | --- |
| 1 | **Alta** | Un único POST puede lanzar ~21 600 `tools/call` (batch JSON-RPC) con un bearer inventado. Sin tope de concurrencia ni de memoria. | `src/http.ts:360-362,423` pasa el cuerpo parseado tal cual a `transport.handleRequest`. El SDK 1.30.0 itera arrays (`webStandardStreamableHttp.js:497-499`). Medido: cuerpo de 2 086 031 B (< 2 MiB) con 21 620 llamadas → 200 tras 38,6 s, 2508–2979 llamadas simultáneas al upstream, 16 131 llegaron (el resto falló al conectar), RSS 90 → 785–868 MB (heap solo 20 MB). Con 500 llamadas: 1 POST de 47 KB → 500 llamadas al upstream y 1,6 MB de respuesta. `deploy/compose.yml` sin `mem_limit`. | Cualquier cliente anónimo, sin token válido, hace que el relé dispare miles de peticiones a `app.lumbre.pro` desde la IP compartida y presione la memoria del VPS hasta el OOM. Caddy no lo evita: `max_size 2MB` sigue dejando ~20 700 llamadas. | Rechazar arrays JSON-RPC con 400 (el batching se retiró de la spec MCP 2025-06-18) o acotarlos a un N pequeño. Semáforo global y por bearer de `tools/call` en vuelo con 429 al desbordarse. `mem_limit` y `memory-reservation` en compose. |
| 2 | Media | Cualquier cadena `Bearer x` pasa la puerta de `/mcp` y llega al upstream sin límite de ritmo. | `src/http.ts:318-325`: un bearer que no empieza por `lm_at_` se acepta como token directo. `src/oauth.ts:1040-1051`: el limitador solo cuenta 401 sin credencial. Medido: 3000 POST con bearer basura desde una IP → 3000 × 200, 3000 llamadas al upstream, 1200–1800 req/s, 0 × 429. Sin bearer: 30 × 401 y luego 30 × 429. | Amplificación hacia `app.lumbre.pro` sin coste para el atacante. Si Lumbre limita por IP, el relé entero comparte esa IP. La reacción de la app no se midió. | Contar también los 401 del upstream por IP y bearer. Limitar `/mcp` por IP con un cupo amplio. Cachear negativamente unos segundos el hash de un bearer que el upstream rechazó. |
| 3 | Media | Sin tope de concurrencia de peticiones ni de conexiones. | 500 `tools/call` concurrentes con upstream a 3 s → 500 simultáneos en el upstream, RSS 90 → 363–379 MB. `maxConnections` sin definir. Timeouts de Node por defecto: `requestTimeout` 300 s, `headersTimeout` 60 s, `keepAliveTimeout` 5 s. Caddy no configura timeouts de cuerpo ni de lectura. El cliente de Lumbre espera 30 s (`src/lumbre-client.ts:336`). | Memoria proporcional a la concurrencia, sin techo. Slowloris sobre el cuerpo hasta 300 s por conexión (no medido). | Semáforo global (ver 1), `server.maxConnections`, `requestTimeout` menor (30–60 s) y `timeouts` en el `reverse_proxy` de Caddy. |
| 4 | Media | DoS del alta de conexiones: el cupo de `/authorize` se agota con el `client_id` público de claude.ai. | `src/oauth.ts:100,1072-1098`: 10/min por `client_id` y 60/min global, sin atribuir a nadie. Medido: 12 `/authorize` desde 12 IPs distintas con el `client_id` público → 10 × 302 y 2 × 429; una IP legítima después recibe 429 «Demasiadas autorizaciones en curso». | Con 10 peticiones/min cualquiera impide que alguien conecte claude.ai al relé. No afecta a las sesiones ya conectadas, cuyo refresh va por `/token`. | Presupuesto por IP primero y por `client_id` solo como red de seguridad bastante más alta. O consumir el cupo del `client_id` únicamente cuando el callback vuelve aprobado. |
| 5 | Media | Con más de una réplica sobre el mismo volumen se pierden escrituras del almacén OAuth. | `src/oauth.ts:2279-2369`: cada proceso escribe el fichero entero desde su caché en memoria; solo `/readyz` la refresca. Medido: dos procesos con el mismo `XDG_STATE_HOME`, 10 `/authorize` alternados (todos 302) → 5 pendientes en disco, esperado 10. `src/existence-cache.ts:155-160` ya lo avisa para la caché de existencia. Los rate limits y las ventanas de `/authorize` también son por proceso. | Hoy no hay réplicas (`container_name` fijo impide `--scale`): latente. Con réplicas: callbacks «caducada o no existe» y refresh tokens perdidos. | Documentar «una sola instancia» en `README-deploy.md`. Si hace falta escalar: lock de fichero y relectura antes de escribir, o mover el almacén a una base de datos. |
| 6 | Baja | El cierre corta todo y no hay handler de señales. | Ni `src/http.ts` ni `src/index.ts` tienen `SIGTERM`/`server.close`. Medido con el entrypoint real: 50 en vuelo + SIGTERM → 50 × ECONNRESET, proceso terminado por señal a los 6 ms. Compose sin `init: true` ni `stop_grace_period`. | Cada deploy o reinicio corta las llamadas en vuelo, incluidas mutaciones que ya llegaron al upstream. Sobre Docker como PID 1 lo midió `audit-recuperacion-despliegue-20261010.md` (H3): 10 s de espera y SIGKILL. | Handler de `SIGTERM`/`SIGINT` con `server.close()`, `closeIdleConnections()` y plazo de ~10 s, más `init: true` en compose. |
| 7 | Baja | El coste de cada `/authorize` pendiente crece con el tamaño del almacén. | Cada mutación reescribe el fichero entero con `fsync` (`src/oauth.ts:2325-2346`). Medido a 500 pendientes: 65,6 ms por `/authorize` (0,12 ms con 10). Tope de 1000 pendientes (`MAX_PENDING_ITEMS`, `src/oauth.ts:30`) con carrera: 8 hilos concurrentes → 1007 registros creados en el upstream por 1000 guardados (7 huérfanos). | Latencia baja, y la cola de escritura es única. Los huérfanos del upstream caducan solos. | Comprobar el tope también dentro del mutador antes del backchannel, o reservar un hueco. |
| 8 | Baja | Un fichero `notes-seen-<id>.json` por cada bearer que consiga listar tareas, sin tope de número. | `src/notes.ts:402-408`. Medido: 900 bearers distintos → 900 ficheros de ~715 B. Se podan a los 30 días sin escribir (`src/notes.ts:421`) y por el barrido horario. Con upstream respondiendo 401: 0 ficheros. | Solo lo alcanzan credenciales que el upstream acepta. Cota práctica: cuentas reales de Lumbre. | Tope de ficheros o poda por LRU si algún día hay cuentas ajenas. |
| 9 | Baja | `resolveAccessToken` recorre todos los grants en cada `/mcp` con prefijo `lm_at_`. | `src/oauth.ts:1714-1736`: `find` con `timingSafeEqual` y `Buffer.from` por grant, antes del limitador. Medido con 10 000 grants: 1,71 ms por petición con token inexistente (4,9 ms en otra pasada con GC). | Bloquea el event loop. Con 10 000 grants satura a ~600 req/s. Hoy los grants reales son 1–3. | Índice `Map` por `accessHash`. |
| 10 | Baja | Barrido de credenciales: una introspección en serie por grant, y cada purga reescribe todo el almacén. | `src/oauth.ts:1920-1943`. Ver pregunta 6. | A escala realista es irrelevante. Con miles de grants, un 429 de Lumbre aborta el barrido y nunca llega al final. | Solo si crece el número de cuentas: paginar o paralelizar con tope 4–8. |
| 11 | Informativo | Sin fuga de heap. | Pregunta 5. | | |
| 12 | Informativo | Transporte stateless: no hay sesiones MCP. | `src/http.ts:418` (`sessionIdGenerator: undefined`). Medido: `initialize` sin cabecera `mcp-session-id`; GET/DELETE `/mcp` → 405. | Sin crecimiento por sesión. | |
| 13 | Informativo | Los límites de cuerpo funcionan, con una salvedad en chunked. | Pregunta 2. | | |

## Las 7 preguntas

### 1. ¿Hay rate limiting?

En Caddy, no: `deploy/mcp-lumbre-pro.caddy` solo tiene `request_body { max_size 2MB }` (líneas 30-32), sin `rate_limit` ni timeouts; Caddy estándar no trae el módulo. En Node, sí, y es parcial (`src/oauth.ts`); el cliente se identifica por el último valor de `x-forwarded-for` (`src/oauth.ts:1006-1010`).

| Ruta | Límite |
| --- | --- |
| `/authorize` y `/oauth/lumbre/callback` | 30/min y 8 concurrentes por IP (`:83`) |
| `/token` | 60/min y 16 concurrentes por IP |
| `/revoke` | 60/min y 16 concurrentes por IP |
| `/authorize` adicional | 10/min por `client_id` y 60/min global (`:100`) |
| `/mcp` | 30 fallos de 401 sin credencial por minuto e IP (`:129`) |

`/mcp` con credencial no tiene ningún límite: ni de ritmo, ni de concurrencia, ni de tamaño de batch. Medido: 3000 peticiones con bearer basura desde una IP, todas 200 y 3000 llamadas al upstream. Los 401 sin bearer sí se cortan: 30 × 401 y luego 30 × 429.

### 2. Límite de cuerpo por ruta

| Ruta | Límite | 10 MB con Content-Length | 10 MB chunked |
| --- | --- | --- | --- |
| `/mcp` | 2 MiB (`src/http.ts:82`); Caddy 2 MB (2 000 000 B) | 413 tras leer ~0,8 MB | El servidor corta el socket tras ~3,3 MB. La sonda vio EPIPE y no llegó a leer el 413 (carrera de `stopReceiving`) |
| `/mcp` sin bearer | no lee el cuerpo | 401 inmediato (1 ms, ~0,9 MB aceptados por el buffer del socket) | 401 inmediato |
| `/token`, `/revoke` | 16 KiB (`MAX_FORM_BYTES`, `src/oauth.ts:28`) | 413 | 413 |
| `/authorize`, `/oauth/lumbre/callback` | no leen cuerpo | 405 inmediato | 405 inmediato |
| `/register` | no existe | 404 y socket cerrado | igual |

Memoria tras las 12 subidas de 10 MB: heap 16,7 MB, sin cambio. Borde exacto de `/mcp`: 2 097 152 B pasa la comprobación de tamaño (llega a 400 por JSON inválido) y 2 097 153 B da 413. `readBody` cuenta bytes reales, así que `chunked` sin `Content-Length` queda cubierto. JSON `[[[…` de 2 MiB: 400 en 213 ms, sin crash. El tope de 2 MiB es el límite de memoria por petición, no el de trabajo (hallazgo 1).

### 3. Sesiones MCP

Modo stateless: un `McpServer` y un transporte nuevos por petición, cerrados en `res.on('close')` (`src/http.ts:409-432`). Sesiones por bearer: 0. Caducidad: no aplica. Retención entre peticiones: solo el bundle de cachés de existencia por token (pregunta 5), con TTL de entradas de 5 s, poda por inactividad de 30 min y LRU de 200 tokens (`src/existence-cache.ts:189,203`). Medido: `initialize` no devuelve `mcp-session-id`; un `tools/call` con un `mcp-session-id` inventado responde 200 y se ignora; GET y DELETE de `/mcp` dan 405. Lo que sí retiene memoria: cada petición en vuelo (hallazgos 1 y 3).

### 4. Almacén OAuth: crecimiento anónimo

`authorizationRequests`: un anónimo sí puede crear entradas sin completarlas, acotado en tres niveles (30/min por IP, 10/min por `client_id`, 60/min global). Con TTL de 10 min (`:25`), el techo estacionario es 600, por debajo de `MAX_PENDING_ITEMS` = 1000 (`:30`). Con el `client_id` real de claude.ai, ~100. `client_id` debe ser un documento de `claude.ai` o `chatgpt.com` (`validateClientIdUrl`, `:478-509`). Medido con límites por defecto, 500 intentos desde una IP: 10 aceptados y 490 × 429. Con límites relajados: 1200 intentos → exactamente 1000 guardadas más 200 × 503. Hay tope por número y no por tamaño del fichero.

| | Medido |
| --- | --- |
| Coste en disco por entrada | 563 B (1000 entradas = 563 010 B) |
| Heap | 16,2 → 17,0 MB (10 entradas) · 18,2 MB (500) · 17,6 MB (1000) |
| RSS | 144 → 246 MB en el peor caso relajado |

`authorizationCodes`: un anónimo no puede crearlos; solo nacen en el callback aprobado (`src/oauth.ts:1274-1292`). Tope 1000 y TTL 5 min (`:24`). Coste estimado ~0,7 KB por código. `usedRefreshTokens`: topes de 10 000 y 64 por familia (`:34-35`); ~100 B por entrada, ~1 MB en el peor caso; no lo alimenta un anónimo. `grants`: sin tope en `normalizeStore`; solo crecen con autorizaciones aprobadas.

### 5. Heap (servidor real, upstream falso, `heapUsed` tras `gc()`)

Escenario (a): 300 bearers distintos con una `list_tasks` cada uno.

| Paso | Heap MB |
| --- | --- |
| Base | 16,30 |
| Tras 300 bearers (oleada 1) | 25,95 (+9,7, incluye el arranque en caliente) |
| Tras otros 300 bearers distintos | 26,54 (+0,6) |
| Tras otros 300 bearers distintos | 26,73 (+0,2) |
| 6 s en reposo | 26,26 |

El crecimiento se detiene: el LRU de 200 tokens cumple. En disco quedan 900 ficheros de huella (643 KB), no acotados en número (hallazgo 8).

Escenario (b): el mismo bearer.

| Paso | Heap MB |
| --- | --- |
| Tras la 1.ª petición | 17,37 |
| 500 peticiones | 21,74 |
| 2000 peticiones | 21,03 |
| 5000 peticiones | 21,40 |
| 10 000 peticiones | 21,49 |

Estable: no hay fuga por petición, a 700–950 req/s.

Escenario (c): 500 `/authorize` sin completar, con límites por defecto: heap 16,2 → 17,0 MB; 10 aceptados (490 × 429). Con límites relajados: 18,2 MB a 500 entradas y 17,6 MB al tope de 1000.

RSS (el dato que importa para el contenedor): con 20 peticiones concurrentes sube de ~92 a ~270–330 MB y se queda en esa marca alta, con heap plano (tras 10 000 peticiones: 328 MB). Con 500 concurrentes: 365–379 MB. Con batch de 21 600 llamadas: 785–868 MB. El RSS se explica por la concurrencia, no por fuga. Sin `mem_limit` en el contenedor, no hay techo.

### 6. Barrido de credenciales con 10 000 grants

Por código (`src/oauth.ts:1920-1970`): una introspección por grant, en serie, más una por elemento de la outbox (máx. 256). Medido sin latencia (store de 5,83 MB, 10 000 grants activos): 10 000 `introspect`, 0,19 s de barrido y 0,18 s de `ensureReady`. Con 25 ms de latencia por llamada: 1000 grants → 26,1 s, lineal; extrapolado, 10 000 → ~261 s. Purga de 100 inactivos entre 10 000: 15,8 s; cada purga reescribe el almacén entero con `fsync`, ~0,16 s por purga a 5,8 MB, sensible a la latencia de disco. Un 429, 5xx o timeout (3 s) aborta el barrido y se reintenta en el ciclo siguiente.

### 7. Cierre con 50 en vuelo y SIGTERM

Se cortan. Con el entrypoint real (`node dist/http.js`) y 50 `tools/call` en vuelo (upstream a 4 s): 50 de 50 acabaron en `ECONNRESET`; el proceso terminó por la señal a los 6 ms. No hay handler de señales ni `server.close()`.

## Método y scripts

En `audit-abuso-y-limites-20261010.sondas/`:

| Fichero | Función |
| --- | --- |
| `upstream.mjs` | upstream falso de Lumbre. Responde `GET /api/tasks` con 40 tareas y cuenta peticiones. `UP_DELAY_MS`, `UP_STATUS` |
| `server.mjs` | servidor real con backchannel y CIMD simulados. `RELAX=1` quita los límites OAuth. Listener de depuración con `/mem`, `/bc` y `/cfg` |
| `lib.mjs` | arranque/parada, cliente HTTP y utilidades |
| `heap.mjs` | pregunta 5 (`a`, `b`, `c`, `d`) |
| `bodies.mjs` | preguntas 2 y 3, y el batch de 500 llamadas |
| `amplif.mjs` | hallazgos 1, 2 y 4 |
| `sweep.mjs` | pregunta 6 |
| `shutdown.mjs` | pregunta 7, con `noprod.mjs` como cortafuegos |
| `replicas.mjs` | hallazgo 5 |
| `out-*.json` | salidas íntegras de cada sonda |

Las sondas esperan un compilado de HEAD en `build/dist` junto a ellas
(`npx tsc -p tsconfig.json --outDir <sondas>/build/dist`, con `node_modules`
enlazado). Comandos, desde ese directorio: `node heap.mjs a` (y `b`, `c`, `d`),
`node bodies.mjs`, `node amplif.mjs`, `node sweep.mjs 10000 0 0`,
`node sweep.mjs 1000 25 0`, `node sweep.mjs 10000 0 100`, `node shutdown.mjs`,
`node replicas.mjs`. Cada sonda crea directorios `state-*`, `ports-*` y
`sweep-*` que se borran al terminar. No se copió ningún token: los bearers son
aleatorios y efímeros. No se ejecutó ninguna suite. Producción no se tocó.

## Fuera de alcance / no medido

- Docker y PID 1: no se probó con contenedor; lo midió en producción `audit-recuperacion-despliegue-20261010.md` (H3). El asignador de `node:22-alpine` (musl) fragmenta distinto: RSS no extrapolable.
- Caddy real: solo se leyó el fragmento. Se asume que sobreescribe `x-forwarded-for` de clientes no confiables, de lo que depende `remoteAddressOf` (`src/oauth.ts:1006`).
- `app.lumbre.pro`: su límite por IP y su reacción a 3000 o 16 000 llamadas en cadena no se midieron. Es lo que decide si los hallazgos 1 y 2 se convierten en caída para todos los usuarios.
- Slowloris sobre cuerpo o cabeceras: solo se leyeron los timeouts de Node por defecto.
- CPU del relé: el coste de crear un `McpServer` con todos los schemas zod por petición no se aisló.
- Coste en disco de `authorizationCodes` y `usedRefreshTokens`: estimado por código.
- Latencia de disco real del VPS para las reescrituras con `fsync`.
- Escala real: se usaron 10 000 grants y 1000 pendientes por ser la cota del código. El uso real es de 1–3 cuentas.
