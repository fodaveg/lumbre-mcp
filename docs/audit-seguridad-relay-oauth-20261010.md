# Seguridad del relé OAuth (10 oct 2026)

Alcance: revisión defensiva, de solo lectura, del servidor de autorización que
`lumbre-mcp` expone en `https://mcp.lumbre.pro`. Árbol inspeccionado: `main`
`3540a7e3b87ea89537841016dc12ec375f1ab84e`, igual a `origin/main` tras
`git fetch`. Leídos completos `src/oauth.ts` (2374 líneas) y
`src/lumbre-oauth-backchannel.ts` (264). De `src/http.ts`, las rutas OAuth, el
bearer, Host/Origin, el cuerpo y los logs (líneas 95-655). De los tests, el
inventario de casos y los pertinentes. También `deploy/compose.yml`,
`deploy/mcp-lumbre-pro.caddy` y `Dockerfile`.

El contenedor ejecuta `dist/`, no `src/`. El último commit de `src/oauth.ts`,
`src/http.ts` y sus equivalentes en `dist/` es el mismo (`1cf36a9`), y el del
backchannel también (`3969953`). No se comprobó byte a byte que `dist/` sea la
compilación exacta de `src/`.

Se ejecutó una sola sonda en proceso contra `dist/oauth.js`, con `fetch` y
backchannel simulados, sin red ni servidor:
`audit-seguridad-relay-oauth-20261010.sonda.mjs` (junto a este informe). No se
ejecutó ningún fichero de test ni la suite. Ya auditado el 2 oct y no repetido:
la fuga en `describeMethod`, corregida en `6a598a8`.

Lo hizo un agente de solo lectura; la sesión coordinadora comprobó contra el
repo las citas de M1 (`src/oauth.ts:34-35`, `:1566-1574`) y de I2
(`src/http.ts:650-652`).

## Hallazgos priorizados

No hay ningún hallazgo Alto. Tres Medios: uno de disponibilidad comprobado en
el código y su test (M1), uno de diseño del cifrado (M2) y una hipótesis de
denegación de servicio sin medir (M3).

| Sev. | Hallazgo | Evidencia | Riesgo | Corrección propuesta |
| --- | --- | --- | --- | --- |
| Media | **M1. Una familia de refresh se revoca sola al llegar a la 65ª rotación.** Las tombstones caducan con `familyExpiresAt`, así que no se liberan antes de que acabe la familia. Al llegar a 64, la rotación siguiente se trata como replay y revoca la familia. | `src/oauth.ts:35`, `:1566-1574`, `:1589-1597`; el test `src/oauth.test.ts:612-640` confirma el comportamiento | Disponibilidad, no confidencialidad. Con access de 1 h, un uso continuado supera 64 refresh antes de los 30 días. La persona recibe `invalid_grant`, la credencial upstream se revoca en Lumbre y tiene que volver a conectar. No queda ningún log que lo explique. Que el uso real llegue a 64 es hipótesis; que se revoque al llegar es hecho. | Descartar la tombstone más antigua de la familia (FIFO) en lugar de revocar, o subir el tope por familia por encima de 30 d / 1 h (unas 720 más margen) y dejar el tope global como freno. Si se mantiene la revocación, dejar una línea de log con solo el recuento. |
| Media | **M2. La clave AES-256-GCM está en el mismo volumen y directorio que el almacén cifrado.** | `src/oauth.ts:2113` (`oauth.key`), `:2147` (`oauth-store.json`); `deploy/compose.yml` (`state:/state`) | El cifrado en reposo protege contra la filtración del JSON suelto, pero no contra la copia del volumen o de un backup del VPS. Quien se lleva `/state` obtiene las credenciales upstream de todas las cuentas. | Cargar la clave desde un secreto separado del volumen (Docker secret o fichero montado de solo lectura desde otra ruta del host) y excluirla de los backups del volumen. Documentar que un backup de `/state` equivale a tener las credenciales. |
| Media (hipótesis) | **M3. La ranura de concurrencia global de `/token` y `/revoke` (16) se toma antes de leer el cuerpo, y esa lectura no tiene timeout propio.** | `src/oauth.ts:84-85`, `:1109-1113`, `:1342-1344`, `:412-438`; `src/http.ts:445` sin `requestTimeout`. El valor por defecto de Node es 300 s (medido en local con Node 24; Node 22 tiene el mismo) | Unas pocas conexiones que envían el formulario muy despacio ocupan las 16 ranuras durante hasta 5 min. Mientras tanto todos los refresh reciben 429 y los clientes pueden acabar desconectando. No se verificó si Caddy almacena o corta antes los cuerpos lentos. | Poner un timeout corto a `readLimitedBody` (5-10 s) o tomar la ranura después de leer el formulario. Bajar `server.requestTimeout` y `headersTimeout`. Añadir un límite de concurrencia por IP además del global. |
| Baja | **B1. El callback de Lumbre no está ligado al navegador que inició `/authorize`.** No hay cookie ni nonce: el único secreto es el UUID `request`. | `src/oauth.ts:1198-1306`; el atacante solo conoce el `request` si inició el flujo él (`:1150-1157`, `:1235`) | En un phishing de consentimiento (el atacante inicia el flujo y la víctima aprueba en Lumbre), el atacante obtiene el código si llama al callback antes que el navegador de la víctima. PKCE no lo impide porque el iniciador es el propio atacante. No puede sondear sin perder la pendiente (`:1244-1250` la consume antes de `exchange`), así que depende de una carrera. Un `denied` falsificado también devuelve al falsificador el `state` original (`:1239-1241`). | Al hacer `/authorize`, poner una cookie `__Host-` (HttpOnly, Secure, SameSite=Lax) con un nonce aleatorio y guardar su hash en la pendiente. El callback la exige en `approved` y en `denied`. |
| Baja | **B2. El `redirect_uri` fijo de claude.ai se valida tarde.** Si el documento CIMD de un `client_id` de claude.ai registra otra URI, la comprobación exacta (`:1129`) pasa, se crea el registro en Lumbre y solo después `normalizeStore` lo rechaza. | `src/oauth.ts:511-512`, `:1129`, `:1150`, `:2325`, `:541`, `:695`. Medido con la sonda: HTTP 500 `server_error`, 1 llamada al backchannel y ninguna redirección | El sistema falla cerrado (no se redirige a la URI ajena), pero deja un registro huérfano en Lumbre y responde 500 en lugar de 400. Para aprovecharlo haría falta servir JSON en una ruta de claude.ai. | Llamar a `validStoredRedirect(clientId, redirectUri)` en `handleAuthorize` antes de `enterAuthorizeBudget` y del backchannel, y responder 400 `invalid_request`. |
| Baja | **B3. Reutilizar un código de autorización no revoca los tokens ya emitidos con él** (RFC 6749 §4.1.2, SHOULD). | `src/oauth.ts:1363-1364`, `:1473-1477`, `:1495` | Si un código se filtra y se canjea dos veces, el segundo intento falla, pero la familia emitida con el primero sigue viva. PKCE ya reduce mucho este riesgo. | Guardar `codeHash → familyId` hasta `CODE_TTL_MS` y revocar la familia cuando se presente un código ya usado. |
| Baja | **B4. El AAD del token upstream no incluye `credentialId`.** Todas las cuentas de claude.ai comparten `clientId`, y `resource` y `scope` son constantes. | `src/oauth.ts:549-551` (y sus usos en `:1287-1290`, `:1379`, `:1526`, `:1732`) | Los textos cifrados son intercambiables entre grants del mismo cliente. Solo afecta a quien puede escribir el almacén, que en la práctica también tiene la clave (ver M2). | Añadir `credentialId` al AAD (es el mismo en el código, el grant y la outbox), con una migración a `version: 4` o un descifrado de transición. |
| Baja | **B5. El contenedor corre como root y sin endurecimiento.** | `Dockerfile` (sin `USER`, imagen base sin fijar por digest); `deploy/compose.yml` (sin `read_only`, `cap_drop`, `security_opt: no-new-privileges`) | Si se ejecuta código en el proceso (por ejemplo, por una dependencia), el atacante dispone de root dentro del contenedor y más superficie para escapar de él. | Añadir `USER node` con `/state` de su propiedad, `read_only: true` con el volumen escribible, `cap_drop: [ALL]`, `no-new-privileges` y fijar `node:22-alpine` por digest. |
| Baja (hipótesis) | **B6. Un bearer que no empieza por `lm_at_` se reenvía tal cual a Lumbre y no cuenta en el limitador de fallos.** | `src/http.ts:318-326`, `:340-345` | Todo el tráfico llega a Lumbre desde la IP del relé. Un abuso por esta vía heredada podría agotar los límites por IP de Lumbre y afectar al resto de usuarios del relé. No se midieron los límites de Lumbre. | Contar también en el limitador del relé los 401 que devuelve Lumbre, o retirar el Bearer directo y `/mcp/<token>` cuando OAuth sea la única vía. |
| Informativo | **I1. Un access token puede durar hasta 1 h más que su familia.** | `src/oauth.ts:1577`; `resolveAccessToken` no mira `refreshExpiresAt` (`:1723-1730`); la poda está en `:2293-2297` y el barrido corre cada hora (`src/http.ts:566`) | Ventana máxima de 1 h tras los 30 días. | Emitir `accessExpiresAt = min(now + 1 h, familyExpiresAt)` o comprobar `refreshExpiresAt > now` al resolver. |
| Informativo | **I2. No hay rotación de clave.** Perderla o cambiarla tumba el servicio, aunque falla cerrado. | `src/oauth.ts:1745`, `:2124`, `:1768-1773`; `src/http.ts:650-653`; una `keyPromise` rechazada queda en caché (`:2106`) | Disponibilidad. | Documentar el procedimiento: archivar el almacén y que los usuarios vuelvan a autorizar. Opcionalmente, admitir una lista de claves con identificador. |
| Informativo | **I3. Los `.tmp` huérfanos de un corte no se limpian al arrancar.** | `src/oauth.ts:2327`; el `unlink` de `:2349` solo corre si el proceso sigue vivo | Pueden quedar copias completas del almacén (0600, credenciales cifradas) en `/state`. | Borrar `oauth-store.json.*.tmp` en `ensureReady`. |
| Informativo | **I4. El barrido purga en cuanto Lumbre responde `{active:false}`.** No hay ningún freno ante una purga masiva. | `src/lumbre-oauth-backchannel.ts:213`; `src/oauth.ts:1433`, `:1941-1942` | Un incidente en Lumbre (restaurar una base de datos sin la tabla de credenciales) desconectaría a todos. Solo afecta a la disponibilidad. | Cortar el barrido si más de cierto porcentaje de los grants sale inactivo en una misma pasada. |
| Informativo | **I5. El secreto del backchannel viaja como variable de entorno del contenedor.** | `deploy/compose.yml` (`LUMBRE_MCP_BACKCHANNEL_SECRET`) | Lo ve cualquiera con acceso a `docker inspect` en el host. | Usar Docker secrets o un fichero montado. |
| Informativo | **I6. El límite por IP usa la última entrada de `X-Forwarded-For`.** | `src/oauth.ts:1006-1010` | Es correcto solo si Caddy sustituye la cabecera de clientes no confiables y no hay otro proxy delante. Otro contenedor de la red `edge` puede falsearla. No se midió la versión ni la configuración global de Caddy. | Confirmar `trusted_proxies` en el Caddy del borde. |

## Respuestas a las 10 preguntas

### 1. PKCE

- **S256 siempre (hecho).** `code_challenge_method` es obligatorio (`one(...)` con `required` por defecto, `src/oauth.ts:991`, `:448-454`), y cualquier valor distinto de `S256` se rechaza (`:996-998`). El reto debe tener exactamente 43 caracteres base64url (`:996`). Los metadatos solo anuncian S256 (`:894`, test `oauth.test.ts:297`).
- **`plain` (hecho).** Se rechaza con `invalid_request` (`:996`). No hay ningún test que pruebe explícitamente `plain` o la ausencia del método.
- **Verificador (hecho).** Se exige el formato RFC 7636, 43-128 caracteres sin reservar (`:1372`). Se calcula SHA-256 en base64url y se compara con `equalText`, que usa `timingSafeEqual` tras igualar longitudes (`:1375-1377`, `:318-322`). Un verificador incorrecto no consume el código (`:1376-1378`, test `oauth.test.ts:1250`).

### 2. `redirect_uri` y documento de metadatos del cliente

- **Sin registro dinámico ni persistencia de clientes (hecho).** El `client_id` tiene que ser una URL `https:` de `claude.ai` o `chatgpt.com`, puerto vacío o 443, sin query, fragmento, credenciales ni segmentos `.`/`..`, y con una ruta distinta de `/` (`:478-503`). Las de chatgpt.com deben casar con `/oauth/codex/[id/]client.json` (`:505-507`). La ruta en claude.ai es libre.
- **Se descarga el documento (hecho)** en `fetchClientMetadata` (`:930-982`): timeout de 5 s (`:932`); `redirect: 'manual'` y estado 200 obligatorio (`:935`, `:939`); `content-type` `application/json` (`:942-945`); 64 KiB como máximo, por cabecera y por recuento real (`:29`, `:456-476`); `client_id` del documento idéntico a la URL, `client_name` no vacío, `redirect_uris` no vacío y solo de cadenas, `token_endpoint_auth_method` igual a `none` (`:955-969`); caché respetando `Cache-Control`, con máximo 1 h y 128 entradas, y deduplicación de descargas en vuelo (`:903-928`, `:970-980`). TLS con la validación por defecto de Node; no hay `NODE_TLS_REJECT_UNAUTHORIZED` en el repo.
- **Qué impide una URI arbitraria (hecho).** Dos barreras: igualdad exacta con una URI registrada en el documento, salvo loopback `http://127.0.0.1:<puerto>` con la misma ruta para Codex (RFC 8252) (`:511-537`, `:1129`); y `normalizeStore`, que fija la URI guardada: en claude.ai solo `https://claude.ai/api/mcp/auth_callback`, en chatgpt.com solo `http://127.0.0.1[:puerto]/callback[/id]` (`:539-547`, `:695`, `:722`), aplicado antes de escribir (`:2325`) y al cargar. La segunda barrera actúa después de llamar a Lumbre (B2).
- **Lo que sí controla el documento:** `client_name`, recortado a 120 caracteres (`:1132`), que se envía a Lumbre y aparece en su pantalla de consentimiento. No se verificó cómo lo escapa Lumbre.

### 3. Códigos de autorización

- **Entropía (hecho).** `lm_code_` más 32 bytes aleatorios en base64url (`:1270`, `:310-312`). Solo se guarda su SHA-256 (`:1285`).
- **TTL (hecho).** 5 min (`:24`, `:1292`). Los caducados se retiran y su credencial upstream pasa a la outbox (`:1365-1367`, `:2298-2311`).
- **Un solo uso (hecho).** `issueGrant` busca el código y lo elimina dentro de la cola serializada de escritura. Un segundo canje recibe `invalid_grant` (`:1472-1495`); test `oauth.test.ts:1250`. Un código reutilizado no revoca la familia ya emitida (B3).
- **Ligado (hecho)** a `client_id`, `redirect_uri` y `resource` (`:1369-1371`), al reto PKCE (`:1376`) y a `credentialId` (`:1474`). Antes de emitir se comprueba con Lumbre que la credencial upstream sigue activa (`:1380-1384`).

### 4. Refresh

- **Rotación (hecho).** Cada refresh emite access y refresh nuevos y guarda el anterior como tombstone (`:1504-1507`, `:1566-1580`). La credencial se comprueba con Lumbre antes de rotar (`:1532-1536`). Si el backchannel falla, 503 sin rotar ni revocar (`:1452-1463`, test `oauth.test.ts:720`).
- **Detección de reutilización (hecho).** Se busca en `usedRefreshTokens` con comparación en tiempo constante (`:1509`, `:1539`). Si aparece, se revoca la familia entera (`:1528-1531`, `:1550-1552`, `:1604-1617`) y se vacía la outbox contra Lumbre (`:1583`, `:1651`). Dos refresh concurrentes se detectan como replay (test `oauth.test.ts:524`). Si Lumbre responde `mismatch` o `inactive`, también se revoca (`:1533-1535`). Presentar un refresh ya usado en `/revoke` revoca igualmente (`:1695`).
- **TTL de la familia (hecho).** 30 días absolutos desde el alta (`:27`, `:1470`), sin renovación deslizante (`:1566`, `:1579`). La poda los retira al vencer (`:2293-2297`).
- **Tope de tombstones (hecho):** 64 por familia y 10 000 en total; al alcanzarlo se revoca la familia (`:34-35`, `:1567-1574`). Ver M1.

### 5. Access tokens

- **Entropía (hecho).** `lm_at_` más 32 bytes aleatorios (`:1466`, `:1505`). Solo se guarda el SHA-256 (`:1486`, `:1576`).
- **Comparación (hecho).** SHA-256 del token presentado y `matchesHash` con `timingSafeEqual` (`:1717`, `:1722`, `:336-338`; test `oauth.test.ts:1852`). `find` se detiene en la primera coincidencia, lo que solo revela la posición del grant en la lista.
- **Si el upstream caduca antes (hecho).** `resolveAccessToken` no consulta a Lumbre en cada petición (`:1714-1736`). Reenvía la credencial upstream y es Lumbre quien la rechaza; la tool responde con el mensaje de «reconecta» (test `http.test.ts:418`). En el siguiente refresh se revoca la familia (`:1532-1535`), y el barrido horario la purga aunque el cliente no vuelva (`:1920-1943`; `src/http.ts:566`). Ver I1.

### 6. Cifrado

- **Clave (hecho).** `randomBytes(32)` sin derivación (`:2125`). Se escribe en base64url con `open(..., 'wx', 0o600)`, `fsync` y `fsync` del directorio (`:2126-2138`). Al cargarla se fuerza `chmod 0600` (`:2118`). El directorio se fuerza a `0700` (`:2111-2112`). Si existe el almacén pero no la clave, el arranque se niega (`:1745`, `:2124`). Está junto al almacén (M2).
- **IV (hecho).** 12 bytes aleatorios en cada cifrado (`:558`).
- **AAD (hecho).** Tokens upstream de grant, código y outbox: `JSON.stringify([clientId, resource, scope])` (`:549-551`); no cubre `credentialId`, `familyId` ni hashes (B4). Transacción pendiente: `['lumbre-transaction', requestId, clientId, resource, scope]` (`:553-555`). El resto de campos del almacén va en claro y sin autenticar; `normalizeStore` valida forma y coherencia (`:605-781`).
- **Rotar la clave (hecho).** No hay mecanismo. Con otra clave, el descifrado falla en `ensureReady` (`:1768-1773`) y el proceso no abre el listener (`src/http.ts:650-653`). Fallo cerrado con caída del servicio (I2).

### 7. Escrituras del almacén

- **Atómicas (hecho).** Todas pasan por `mutateStore`, serializada en `writeQueue` (`:2279-2369`): normalizar (`:2325`); tmp único con `wx` y `0600` (`:2327-2330`); `writeFile` y `fsync` (`:2331-2332`); `close` y `rename` (`:2334-2336`); adoptar en caché y `fsync` del directorio (`:2342-2345`); `unlink` del tmp en `finally` (`:2349`). Ante error se invalida la caché (`:2351-2357`). Probado en `oauth.test.ts:1202`.
- **Escrituras concurrentes (hecho).** Serializadas dentro del proceso. Las lecturas en vuelo no pisan una escritura posterior gracias a `storeGeneration` (`:2184-2215`, test `oauth.test.ts:1456`). La premisa documentada es un solo proceso (`:832-843`); con dos réplicas se perderían escrituras sin aviso.
- **Corte a mitad (hecho).** El `rename` garantiza el fichero viejo o el nuevo. Pueden quedar `.tmp` huérfanos (I3). Un almacén incoherente se rechaza entero (`:605-781`).

### 8. Backchannel hacia la app

- **Autenticación (hecho).** Secreto compartido `LUMBRE_MCP_BACKCHANNEL_SECRET` (`:860-864`), 32-512 caracteres sin saltos de línea (`lumbre-oauth-backchannel.ts:165-169`), como `Authorization: Bearer` en un POST JSON (`:239-249`; test `lumbre-oauth-backchannel.test.ts:28`). Sin mTLS ni firma de petición. Cómo compara Lumbre el secreto queda fuera de alcance.
- **Destino (hecho).** Origen fijo `https://app.lumbre.pro`; cualquier otro `LUMBRE_APP_BASE_URL` se rechaza (`:1`, `:73-91`). `redirect: 'error'` (`:241`).
- **Timeouts y reintentos (hecho).** 3 s por llamada (`:5`, `:242`). Sin reintentos automáticos. Las revocaciones fallidas van a la outbox: una por pasada de readiness (`oauth.ts:36`, `:1654-1679`), por credencial en cada evento y en el barrido. Máximo 256 elementos y 30 días (`:72-73`, `:2245-2277`).
- **Respuestas (hecho).** 5xx y 429 cuentan como `transient`; cualquier otro estado fuera de 2xx, como `invalid` (`:253-261`). Cuerpo `application/json`, 64 KiB como máximo y conjunto exacto de claves (`:121-150`, `:67-71`, `:176-233`).
- **5xx durante el barrido (hecho).** No se purga nada. Cualquier excepción del backchannel corta el barrido (`oauth.ts:1934-1939`, `:1958-1963`). Solo un 2xx con exactamente `{"active":false}` purga (`lumbre-oauth-backchannel.ts:213`, `oauth.ts:1433`). Un `mismatch` no purga (`:1940-1941`). Cubierto en `oauth.test.ts:2281-2328` y `:2330-2361`.

### 9. Superficie HTTP

- **Métodos (hecho).** `/authorize` y `/oauth/lumbre/callback`: solo GET (`oauth.ts:1126`, `:1202`). `/token` y `/revoke`: solo POST `application/x-www-form-urlencoded` (`:1343`, `:1685`, `:440-446`). `/mcp`: solo POST (`http.ts:290-294`). `.well-known`: solo GET (`http.ts:490-504`). Otra ruta: 404 (`:548`). Los 405 no llevan `Allow`.
- **CORS (hecho).** No se emite ningún `Access-Control-*`.
- **Host y Origin (hecho).** Solo `mcp.lumbre.pro`, y loopback únicamente desde una conexión de loopback (`http.ts:108-183`, `:464-468`). Sin `Origin` se deja pasar.
- **Límites de cuerpo (hecho).** Formularios OAuth hasta 16 KiB (`oauth.ts:28`, `:395-438`; test `oauth.test.ts:1609`). `/mcp` hasta 2 MiB (`http.ts:82`, `:228-249`). Caddy limita a 2 MB. Cada parámetro hasta 2048 caracteres y `state` 1024 (`oauth.ts:450`, `:999`). Sin timeout de lectura (M3).
- **Limitación de ritmo (hecho).** Por IP y endpoint, con concurrencia global (`:82-86`, `:1100-1120`). Presupuesto de `/authorize`: 10 por `client_id` y 60 en total por minuto (`:100`, `:1072-1098`). Fallos de `/mcp`: 30 por IP y minuto (`:129`; `http.ts:340-345`).
- **Enumeración (hecho).** `/mcp` responde el mismo 401 a token inexistente, caducado o malformado (`oauth.ts:1723-1735`; `http.ts:346-352`). `/token` responde lo mismo a código inexistente y caducado (`:1364`, `:1367`). Refresh desconocido o usado: mensaje uniforme (`:1521`, `:1584`). `/revoke` siempre 200 `{}` (`:1706`). El callback devuelve un mensaje uniforme (`:1237`, `:1252`). Los errores que no son `OAuthError` salen como 500 genérico (`:366-369`).
- **Cabeceras (hecho).** Rutas OAuth: `no-store`, `pragma`, `no-referrer`, `nosniff`, `X-Frame-Options: DENY` y CSP restrictiva (`oauth.ts:349-359`). Resto: `no-store` y `nosniff` (`http.ts:461-462`). Caddy añade HSTS con `includeSubDomains` sin `preload`, quita `Server`, no publica `/readyz` (404) y no registra logs de acceso para este host.

### 10. Logs

Ningún `console.*` del alcance escribe tokens, hashes, códigos, `code_verifier`, `credentialId`, `familyId` ni nombres de ficheros de huella (hecho). Líneas que escriben en log:

- `src/oauth.ts:1908-1913`: barrido; solo recuentos.
- `src/oauth.ts:2097-2100`: huellas sin borrar; solo un recuento.
- `src/oauth.ts:2270-2274`: outbox descartada; recuento y constantes.
- `src/http.ts:273`: método MCP de una lista blanca y estado HTTP; ruta redactada (`/mcp/<redactado>`).
- `src/http.ts:425`, `:617`, `:651`: texto fijo.
- `src/http.ts:647`: puerto y `baseUrl`.

Fuera del alcance OAuth, `src/index.ts:140` también es un texto fijo. Los mensajes de los `BackchannelError` son literales y no se escriben en log. Lo cubren `oauth.test.ts:2481`, `:2150`, `:449` y `http.test.ts:169`, `:194`, `:537`. No se revisó si el SDK de MCP escribe algo por su cuenta.

## Fuera de alcance / no medido

- **Lado Lumbre:** cómo valida el secreto del backchannel, la pantalla de consentimiento (escapado de `client_name`, si redirige al callback de inmediato, lo que fija la ventana de carrera de B1), la caducidad propia de las credenciales upstream, la condición `approvedAt IS NOT NULL` que cita `oauth.ts:1227-1234`, y si Lumbre limita por IP (B6).
- **Producción:** no hubo conexión. Sin verificar la versión de Caddy ni su `trusted_proxies`, si hay CDN delante, el bloque global `mcp_errores`, el `.env` del VPS, los permisos reales del volumen ni la política de backups de `/state` (ver `audit-recuperacion-despliegue-20261010.md`).
- **Comportamiento de Caddy con cuerpos lentos:** M3 queda como hipótesis.
- **CVE de dependencias:** no se ejecutó `npm audit`.
- **`dist/` frente a `src/`:** solo se compararon los commits.
- **Tests no ejecutados.** Huecos de cobertura vistos: rechazo explícito de `plain` y de la ausencia de `code_challenge_method`; documento CIMD de claude.ai con un `redirect_uri` distinto del fijo (B2); timeout real de la descarga CIMD; reutilización de un código ya canjeado con revocación de la familia; 65ª rotación en uso legítimo (solo está probado el tope inyectado); un 404 del backchannel en el barrido.
- **Explotabilidad real de B1:** depende de la carrera con el navegador de la víctima; no se intentó.

## Sonda reproducible (B2)

`node docs/audit-seguridad-relay-oauth-20261010.sonda.mjs "$PWD/dist/oauth.js"`.
Corre en proceso, sin red ni servidor, con `fetch` y backchannel simulados y una
clave efímera. Resultado el 2026-10-10 sobre `3540a7e`:
`{"status":500,"redirectedTo":null,"body":"{\"error\":\"server_error\",...}","backchannelCalls":1}`.
