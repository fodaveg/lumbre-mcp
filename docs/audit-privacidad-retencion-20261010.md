# Privacidad y retención de datos del relé (10 oct 2026)

Alcance: revisión estática, de solo lectura, de qué datos personales o de uso
guarda el relé `mcp.lumbre.pro`, dónde, cuánto tiempo y qué escribe en logs. El
resultado alimenta la frase de la política de privacidad de la web de Lumbre que
describe el relé. Árbol inspeccionado: `main`
`3540a7e3b87ea89537841016dc12ec375f1ab84e`, igual a `origin/main`. El `dist/`
versionado tiene las mismas llamadas de log que `src/`. No hubo conexión al
servidor ni se ejecutaron tests.

Leídos completos: `src/oauth.ts`, `src/notes.ts`, `src/existence-cache.ts`,
`src/http.ts`, `src/index.ts`, `deploy/mcp-lumbre-pro.caddy`,
`deploy/compose.yml` y `Dockerfile`. Por partes: `src/lumbre-client.ts` (puntos
de red y `assertTaskUsable`), `src/lumbre-oauth-backchannel.ts` (puntos de
red), `src/tools/*.ts` (logs y pobladores de caché), `deploy/README-deploy.md`
(1-264), `README.md` (985-1174 más grep), `docs/instalar.md` (grep) y
`deploy/publicar.sh` (grep). En dependencias, grep de `console.*` en
`@modelcontextprotocol/sdk@1.30.0` y `@hono/node-server`.

HECHO = lo que demuestra el código del SHA. HIPÓTESIS = lo que no se puede
comprobar desde el repo. El inventario reproducible está en
`audit-privacidad-retencion-20261010.inventario.sh`, junto a este informe.

Lo hizo un agente de solo lectura; la sesión coordinadora comprobó contra el
repo las citas del hallazgo Media (`src/existence-cache.ts:47-70`) y del
primer Baja (`src/notes.ts:357-367`).

## Hallazgos priorizados

| Sev. | Hallazgo | Evidencia | Riesgo | Corrección |
| --- | --- | --- | --- | --- |
| Media | La caché de existencia guarda **tareas completas** en memoria (título, nota íntegra si se pidió, etiquetas, fechas) mucho más allá de su TTL de 5 s. La entrada caducada solo se borra si se vuelve a consultar ese mismo `taskId`, o si se descarta la caché del token entera. Eso ocurre tras 30 min sin actividad, pero solo se comprueba cuando llega otra petición (de cualquier token), o al superar 200 tokens. Sin tráfico nuevo, la entrada vive hasta que el proceso se reinicia. Lo único que se lee de lo cacheado es `parentId`. | `src/existence-cache.ts:47-55`, `64-70`, `182`, `189`, `193-245`; se llena con notas en `src/tools/tasks.ts:324`, `403`, `430` y `src/tools/batch.ts:619`; solo se lee `parentId` en `src/tools/task-existence.ts:45-46` y `src/lumbre-client.ts:1132` | El contenido de las tareas sigue en el heap mientras la sesión esté activa y después. Se vería en un volcado de memoria o en swap. Por esto la política no puede decir hoy que «el contenido solo pasa por memoria durante la petición». | Guardar solo la proyección `{id, parentId, archivedAt}`. Podar las entradas caducadas en `set`/`setAll`. Llamar a `pruneIdleTokens` desde el barrido horario (`http.ts:607-631`). |
| Baja | Pueden quedar **temporales de huella huérfanos que nunca caducan**. Si `writeFile` funciona pero `rename` falla, el `.notes-seen-*.tmp` se queda y nadie lo borra. La poda de 30 días solo reconoce `^notes-seen-[0-9a-f]{16}\.json$`. | `src/notes.ts:357-367`, `415` | Una copia de la huella (ids de tarea, fecha y longitud) sobrevive al borrado de la autorización y a la regla de 30 días. | `unlink(tmpPath)` en el `catch` e incluir `.notes-seen-*.tmp` en `pruneStaleAccountNotesSeen`. |
| Baja | Los ficheros de huella se crean **sin modo explícito**: `mkdir` sin `mode` y `writeFile` con el modo por defecto. Lo mitiga que el directorio queda en 0700, porque `loadOrCreateKey` lo crea con ese modo antes de abrir el listener. | `src/notes.ts:360-362`; `src/oauth.ts:2111-2112`; `src/http.ts:641-646` | Con umask 022 serían 0644 (HIPÓTESIS: umask del contenedor sin medir). El contenedor corre como root (`Dockerfile`, sin `USER`). | `mode: 0o600` en `writeFile` y `0o700` en `mkdir`. |
| Baja | La **clave AES está en el mismo volumen** que lo que cifra (`/state/lumbre-mcp/oauth.key`). | `src/oauth.ts:2113`, `2126-2132`; `deploy/README-deploy.md:31-36` lo reconoce | El cifrado protege si se filtra `oauth-store.json` solo, pero no si se compromete el volumen o una copia completa. | No prometer en la política más que «cifrada». Opcionalmente, mover la clave a un secreto fuera del volumen (ver M2 de `audit-seguridad-relay-oauth-20261010.md`). |
| Baja (HIPÓTESIS) | **Puede quedar registro en el borde** que el repo no controla. La segunda pieza del silencio de logs (el logger global `mcp_errores`) vive en `/srv/edge/Caddyfile`, que no está versionado. Los errores TLS del servidor HTTP de Caddy van al logger por defecto con la IP del cliente, y `http.log.*.mcp` no los cubre. | `deploy/README-deploy.md:217-258`; `deploy/mcp-lumbre-pro.caddy:112-137` | La IP de quien conecta podría quedar en el log de `edge-caddy`. | Repetir en vivo la prueba de `README-deploy.md:245-258` y revisar a qué logger van los errores TLS. El audit de despliegue del mismo día midió 25 líneas de `edge-caddy` con `mcp.lumbre.pro` en 72 h, todas de ACME o TLS. |
| Baja (HIPÓTESIS) | **Una dependencia imprime errores en bruto.** `@hono/node-server` hace `console.info` o `console.error(e)` cuando falla al escribir la respuesta. | `node_modules/@hono/node-server/dist/index.mjs:865-869`; `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js:9`, `57` | Suelen ser errores de stream sin datos de usuario, pero el texto no está bajo control del repo. | Aceptarlo y documentarlo, o filtrar stderr. |
| Informativo | El store guarda **metadatos de actividad**: `credentialId` (UUID que Lumbre puede asociar a la persona), `clientId` (si es Claude o Codex), alta (`familyExpiresAt` − 30 d) y último refresh (`accessExpiresAt` − 1 h). | `src/oauth.ts:154-167`, `1478-1491`, `1576-1579` | Dato seudónimo: el relé no guarda email ni id de usuario, pero Lumbre puede reidentificarlo. | Tenerlo en cuenta en el registro de actividades de tratamiento. |
| Informativo | **Peor caso de retención de la credencial cifrada: unos 60 días.** 30 d de familia sin prórroga, más hasta 30 d en la outbox si Lumbre nunca confirma la revocación. | `src/oauth.ts:27`, `1470`, `1566`, `72-73`, `2256-2258` | Afecta a cómo se redacta la frase de retención. | Ya incluido en la frase 3. |
| Informativo | Los **logs del contenedor** no llevan identificadores. Rotan por tamaño (3 × 10 MB), no por tiempo, y se borran al recrear el contenedor en cada despliegue. Docker añade la hora a cada línea. | `deploy/compose.yml:61-65`; `deploy/publicar.sh:89` | Con un solo usuario, las horas muestran su patrón de uso. | Si se quiere un plazo, poner rotación por tiempo. |
| Informativo | El **modo heredado** (Bearer directo o `/mcp/<token>`) no deja credencial en el relé. Su huella solo se borra tras 30 días sin escrituras, aunque el usuario borre su cuenta. | `src/notes.ts:421`, `458-486`; `src/oauth.ts:1901`; `README.md:1154-1158` | Una huella seudónima puede durar hasta 30 días después de la baja. | Ya incluido en la frase 4. |
| Informativo | **Comentarios desfasados**: «arnés provisional, no se despliega hasta integrar el broker» y «cuando se integre el broker». | `src/http.ts:31-33`; `deploy/mcp-lumbre-pro.caddy:42-43`; contradichos por `deploy/README-deploy.md:3`, `26-27` | Confunden a quien audite. | Actualizar los comentarios. |
| Informativo | Las promesas actuales son **coherentes con el código**, salvo que omiten la caché en memoria del hallazgo Media. `README.md:40` llama a la huella «estado interno, no datos del usuario en Lumbre», pero para el RGPD es un dato personal seudónimo. `docs/instalar.md` no promete nada sobre datos. | `README.md:1119-1167`; `deploy/README-deploy.md:63-114` | Ninguno inmediato. | Añadir lo de la memoria al corregir el hallazgo Media. |

## 1. Datos persistidos en disco

Todo está en `/state/lumbre-mcp/`, en el volumen `lumbre-mcp_state`:
`XDG_STATE_HOME=/state` (`compose.yml:44`, `48-49`) más `oauth.ts:305-308`.

HECHO: en todo `src/` solo hay tres sitios que escriben a disco: `oauth.key`
(`oauth.ts:2126-2132`), `oauth-store.json` mediante un temporal 0600 y `rename`
(`oauth.ts:2327-2350`, el temporal se borra en el `finally`) y
`notes-seen-<id>.json` (`notes.ts:357-367`).

En el transporte HTTP, `localFilesystem: false` (`http.ts:409-412`). Los adjuntos
viajan en memoria y no hay ningún otro `writeFile`, `appendFile` ni
`createWriteStream`. **El relé no escribe en disco texto de tareas, notas ni
adjuntos.** Lo único relacionado con tareas son las entradas `{u, n}` con clave
`taskId` (`notes.ts:649-653`), y solo de tareas que tienen nota (`notes.ts:757`;
`tasks.ts:331-333`, `509-510`).

### `oauth-store.json` (`oauth.ts:199-206`)

**`grants[]`** (`oauth.ts:154-167`)

| Campo | Qué identifica | Cifrado |
| --- | --- | --- |
| `credentialId` | UUID de la credencial que emite Lumbre; Lumbre lo puede asociar a la persona | No |
| `familyId` | Aleatorio interno de 16 B | No |
| `familyExpiresAt` | Alta + 30 d (`oauth.ts:1470`) | No |
| `clientId` | URL de metadatos del cliente (`claude.ai` o `chatgpt.com`; `oauth.ts:478-508`) | No |
| `resource`, `scope` | Constantes | No |
| `accessHash`, `refreshHash` | SHA-256 base64url de un token opaco de 32 B (`oauth.ts:314-316`, `1486-1488`) | Hash |
| `accessExpiresAt` | Último refresh + 1 h | No |
| `refreshExpiresAt` | Igual a `familyExpiresAt`; rotar no lo prorroga (`oauth.ts:1566`) | No |
| `upstream` | Token de Lumbre | AES-256-GCM, IV aleatorio de 12 B, AAD `[clientId, resource, scope]` (`oauth.ts:549-563`) |

Un grant se borra por revocación desde el cliente con `/revoke`
(`oauth.ts:1681-1705`); por reutilización de un refresh ya usado o credencial
inactiva al refrescar (`oauth.ts:1528-1536`, `1550-1573`); por caducidad de la
familia a los 30 d, que la limpieza de cada `mutateStore` pasa a la outbox
(`oauth.ts:2293-2296`) y que también corre en cada `/readyz` (`oauth.ts:1801`,
healthcheck cada 30 s en `compose.yml:52-60`); y por el barrido, que con
`{active:false}` purga directamente (`oauth.ts:1996-2013`).

**`authorizationRequests[]`** (`oauth.ts:131-138`, `147-152`): `clientId`,
`redirectUri`, el `challenge` PKCE, el `state` del cliente en claro (opaco,
≤1024), el `requestId` (UUID de Lumbre), `clientName` (por ejemplo «Claude»),
`transaction` (cifrado) y `expiresAt` (como mucho 10 min, `oauth.ts:25`,
`1161`). Se borra al aprobar (`oauth.ts:1244-1250`) o al caducar
(`oauth.ts:2314-2315`). Con `denied` no se borra: dura hasta caducar
(`oauth.ts:1239-1242`).

**`authorizationCodes[]`** (`oauth.ts:140-145`): mismos campos más `codeHash`,
`credentialId`, `upstream` cifrado y caducidad de 5 min (`oauth.ts:24`,
`1278-1293`). Se borra al canjearse (`oauth.ts:1477`); si caduca o la
credencial está inactiva, pasa a la outbox (`oauth.ts:1388-1409`,
`2298-2311`).

**`usedRefreshTokens[]`** (`oauth.ts:185-189`): `hash`, `familyId` y
`expiresAt` igual a `familyExpiresAt`. Se borra con la familia
(`oauth.ts:1599-1602`) o al caducar (`oauth.ts:2313`). Tope: 10 000 en total y
64 por familia (`oauth.ts:34-35`).

**`revocationOutbox[]`** (`oauth.ts:169-183`): `credentialId`, `clientId`,
`resource`, `scope`, `upstream` cifrado y `queuedAt`. Se borra cuando Lumbre
confirma la revocación (`oauth.ts:1667-1677`), cuando el barrido la ve inactiva
(`oauth.ts:2018-2029`), cuando un grant se purga (`oauth.ts:2008`), o por
caducidad de 30 d o tope de 256 (`oauth.ts:72-73`, `2245-2264`). Reintentos:
uno por cada `/readyz` (`oauth.ts:36`, `1658`, `1802`) y todos en cada barrido
(`oauth.ts:1944-1969`).

### `oauth.key`

Clave de 32 B en base64url, modo 0600 (`oauth.ts:2110-2143`). El código no la
borra nunca.

### `notes-seen-<id>.json`

- **Contenido:** `{ "<taskId>": { "u": "<ISO de la última edición de la nota>", "n": <longitud> } }`, máximo 2000 entradas (`notes.ts:244-258`, `629-661`). Sin cifrar y con modo no explícito.
- **Qué identifica el `<id>`:** los 16 primeros caracteres hex del SHA-256 del token de Lumbre (el token OAuth descifrado o el token de la API en modo heredado) (`notes.ts:393-408`). No es reversible; sí puede enlazarse con un grant teniendo a la vez el store y la clave.
- **Borrado:** al retirarse la autorización, justo después de escribir el store (`oauth.ts:2073-2101`, `2364`; `notes.ts:508-516`). Además, cualquier huella se borra tras 30 d sin escribirse (por `mtime`), en el barrido horario forzado (`oauth.ts:1901`) y en cada guardado, como mucho una vez cada 10 min (`notes.ts:421-486`, `565-566`).

## 2. Datos en memoria

| Estructura | Qué contiene | Cuánto vive |
| --- | --- | --- |
| `registryByToken` → `TaskExistenceCache` (`existence-cache.ts:37-84`, `191`) | Objetos `LumbreTask` completos: título, nota íntegra en `full`/`preview`/fase 2 de `auto`, etiquetas y fechas. Clave: el token de Lumbre en claro. | TTL lógico de 5 s, pero borrado físico tardío (hallazgo Media). Una tarea puede seguir en memoria toda la sesión activa, más 30 min de inactividad y hasta la siguiente petición, o hasta reiniciar. |
| `BrlExistenceCache` (`existence-cache.ts:95-131`) | Solo las claves `fecha::entryId` y su caducidad. | Mismo patrón de borrado tardío. |
| `cachedStore` (`oauth.ts:844`) | Copia del store en disco, con el `upstream` cifrado. | Hasta la siguiente escritura o lectura en `/readyz`. |
| `clientMetadataCache` (`oauth.ts:811`, `903-928`) | Documentos públicos de cliente. | Máximo 60 min y 128 entradas (`oauth.ts:31-33`, `976-980`). |
| `rateWindows` (`oauth.ts:804`, `1014-1051`, `1100-1120`) | Claves `authorize:`, `token:`, `revoke:` o `mcp-failed:` más la IP; contador y hora de inicio. | Ventana de 60 s, podada al llegar la siguiente petición pública o el siguiente 401; tope 2048. |
| `authorizeClientWindows` (`oauth.ts:809`) | `clientId` y un contador. | 60 s; tope 512. |
| Por petición (`http.ts:357-433`) | Cuerpo de hasta 2 MiB, respuesta y bytes de adjuntos. | Lo que dura la petición. |

## 3. Logs del contenedor

Todos van a stderr. Docker los guarda con la hora en json-file, rotación 3 × 10 MB.

| # | Línea | Campos | ¿Usuario, tarea, título/nota, token/hash, IP o UA? |
| --- | --- | --- | --- |
| 1 | `http.ts:273` `[lumbre-mcp-http] <method> <status>` | Se llama desde `http.ts:292` (`OTHER <ruta>` 405), `298` (403), `342` (429), `353` (401), `378` (413), `382` (400) y `428` (`POST <ruta> <método>` y el estado). La ruta es siempre `/mcp` o el literal `/mcp/<redactado>`. El método es uno de `initialize`, `ping`, `notifications/initialized`, `tools/list`, `tools/call`, `batch(N)` o `unknown` (`http.ts:253-268`). No incluye el nombre de la tool ni sus argumentos. | Ninguno |
| 2 | `http.ts:425` `error interno` | Texto fijo | Ninguno |
| 3 | `http.ts:617` fallo del barrido | Texto fijo | Ninguno |
| 4 | `http.ts:647` `escuchando en :<port> (relé hacia <baseUrl>)` | Puerto y URL de la app | Ninguno |
| 5 | `http.ts:651` estado OAuth no disponible | Texto fijo | Ninguno |
| 6 | `oauth.ts:1908-1913` barrido | Tres recuentos y si se cortó | Ninguno |
| 7 | `oauth.ts:2097-2100` huella sin borrar | Un recuento | Ninguno |
| 8 | `oauth.ts:2270-2274` outbox descartada | Un recuento y dos constantes | Ninguno |
| 9 | `index.ts:140` falta `LUMBRE_TOKEN` | Solo en el modo stdio local; no corre en el contenedor | Ninguno |

Las rutas OAuth (`/authorize`, `/token`, `/revoke` y el callback), `/healthz`,
`/readyz`, `.well-known` y los 404 no escriben ninguna línea. En
`src/tools/*.ts`, `lumbre-client.ts` y el backchannel no hay ningún `console.*`
(HECHO, por grep). En las dependencias, el SDK solo avisa de nombres de tool
estáticos al registrarlas, y hono hace lo descrito en el hallazgo Baja
(HIPÓTESIS). Un rechazo no capturado haría que Node imprimiera la traza
(HIPÓTESIS: no se encontró ningún camino que llegue a eso).

## 4. Qué ve un tercero

- HECHO: la única petición a un servicio que no es Lumbre es la descarga del documento de cliente (CIMD) en `/authorize` cuando no está en caché. Es un `GET` a la propia URL `client_id`, limitada a `https://claude.ai/...` o `https://chatgpt.com/oauth/codex/.../client.json` (`oauth.ts:478-508`), sin cookies, sin seguir redirecciones, con `accept: application/json` y timeout de 5 s (`oauth.ts:930-935`). No lleva ningún dato de Lumbre ni del usuario. El tercero solo ve que la IP del servidor del relé pidió su documento a esa hora. HIPÓTESIS: el `User-Agent` es el de Node por defecto.
- **Lumbre:** el backchannel va a `app.lumbre.pro/api/integrations/lumbre-mcp/{requests,exchange,introspect,revoke}` con el secreto del canal (`lumbre-oauth-backchannel.ts:239-249`). Las tools van a `LUMBRE_BASE_URL` con el token de Lumbre (`lumbre-client.ts:394-404`, `1196-1199`, `1349-1353`). No se reenvían la IP ni el UA del usuario.
- **Redirección del navegador:** termina en el `redirect_uri` del propio cliente, con `code` o `error`, `state` e `iss` (`oauth.ts:1314-1326`).
- Las URLs de `SERVER_INSTRUCTIONS` (`index.ts:128-135`) las abre el cliente de IA, no el relé.
- **Cabeceras entrantes:** Caddy reenvía las del cliente y añade `X-Forwarded-For` (por defecto; `mcp-lumbre-pro.caddy:66-99` no lo cambia). El relé solo lee `x-forwarded-for`, para limitar el ritmo en memoria (`oauth.ts:1006-1010`). El `User-Agent` llega al contenedor, pero ninguna línea lo lee (HECHO, por grep).

## 5. Derecho de supresión

**Cuando el usuario revoca en la app o borra su cuenta:**

- Lumbre no avisa al relé. El relé se entera en el barrido, al arrancar y cada 60 min (`http.ts:566`, `607-631`, `641-646`). También antes si el cliente refresca, porque cada refresh consulta a Lumbre (`oauth.ts:1532-1536`).
- Con `{active:false}` borra en una sola escritura el grant, sus tombstones, cualquier código o pendiente de la outbox con esa credencial, y su huella (`oauth.ts:1996-2013`, `2364`).
- Plazo: como mucho unos 60 min, mientras el contenedor esté en marcha, Lumbre responda y el secreto coincida. Con errores de red, 5xx, 429, 401 del canal o respuesta fuera de contrato no se purga nada (`oauth.ts:1852-1869`).
- Durante ese intervalo, el access token se sigue aceptando en el relé (`oauth.ts:1714-1736`), pero la app rechaza la credencial upstream, así que no salen datos (HIPÓTESIS: depende de que Lumbre aplique la revocación).
- **Lo que queda:** una huella huérfana si el borrado falla o una tool en vuelo la reescribe (cae a los 30 d); un posible `.tmp` huérfano sin caducidad (hallazgo Baja); la caché en memoria (hallazgo Media); líneas de log sin identificadores hasta que roten o se recree el contenedor; copias del volumen hechas antes, si existen (`README-deploy.md:113-114`; el audit de despliegue del mismo día no encontró ninguna).
- **Modo heredado:** solo cae a los 30 d sin escrituras.

**Cuando el relé se borra entero:** el relé no revoca nada al apagarse. Las
credenciales MCP emitidas por Lumbre (`credentialId`) siguen como estén en la
app hasta que el usuario las revoque allí o Lumbre las caduque; sus plazos y
su borrado en cascada están en el repo `lumbre` y no se verificaron. También
quedan en Lumbre las solicitudes de autorización pendientes (sin verificar si
Lumbre las limpia), el token personal de la API del modo heredado y las
tareas creadas a través del relé.

## 6. Redacción propuesta para la política de privacidad

Válidas para el SHA `3540a7e` siempre que lo desplegado coincida (el audit de
despliegue del mismo día comprobó por hash que `dist/` en el servidor es el de
HEAD):

1. «El relé `mcp.lumbre.pro` no guarda en disco el texto de tus tareas, notas ni adjuntos: solo escribe su almacén de autorizaciones con su clave de cifrado y, por cada conexión, un fichero con los identificadores de tus tareas con nota, la fecha de la última edición de cada nota y su longitud.» (`src/oauth.ts:2126-2132`, `2327-2336`; `src/notes.ts:244-247`, `357-363`, `649-653`; `src/http.ts:409-412`)
2. «En ese almacén, la credencial que conecta el relé con tu cuenta de Lumbre se guarda cifrada con AES-256-GCM, y de los tokens que el relé entrega a tu cliente de IA solo se guarda su huella SHA-256, nunca el token.» (`src/oauth.ts:154-167`, `314-316`, `557-563`, `1286-1290`, `1486-1488`, `1576-1578`)
3. «Cada autorización dura como máximo 30 días; cuando caduca, cuando la revocas desde tu cliente o cuando Lumbre indica que la revocaste o que borraste tu cuenta (lo comprueba cada 60 minutos mientras el servicio está en marcha y Lumbre responde), el relé la elimina junto con su fichero de identificadores; si no consigue confirmar con Lumbre la revocación, conserva la credencial cifrada un máximo de 30 días más con el único fin de revocarla.» (`src/oauth.ts:27`, `1470`, `1566`, `2293-2296`, `1681-1705`, `1879-2013`, `2073-2101`, `72-73`, `2245-2264`; `src/http.ts:566`, `607-631`)
4. «Si te conectas con el token personal de la API en lugar de con OAuth, el relé no guarda ese token, y el fichero de identificadores asociado se borra tras 30 días sin uso.» (`src/http.ts:308-325`; `src/notes.ts:393-408`, `421`, `458-486`, `556-569`; `src/oauth.ts:1901`)
5. «Los registros del relé solo anotan el tipo de petición y su código de respuesta, más avisos de mantenimiento con recuentos; tu dirección IP solo se usa en memoria para limitar el ritmo de peticiones y no se escribe en disco ni en esos registros, y el relé llama a Lumbre desde su propio servidor sin reenviar tu IP.» (`src/http.ts:251-274`, `292-428`; `src/oauth.ts:1003-1051`, `1100-1120`, `1905-1913`, `2096-2100`, `2266-2275`; `src/lumbre-client.ts:394-404`)

**No se puede escribir hoy:**

- «El contenido de tus tareas solo pasa por memoria durante la petición»: falso por el hallazgo Media. Se podrá escribir después de corregirlo.
- «No queda ningún registro de tu IP en el servidor»: el borde depende de una configuración fuera del repo y de los errores TLS.
- «Los datos están en la UE»: el repo no dice dónde está el VPS (el audit de despliegue deduce Helsinki por el hostname, sin confirmar con el proveedor).

## Nota RGPD

- La huella y el store son datos personales seudónimos: Lumbre puede reidentificarlos con `credentialId`, y la huella se puede enlazar a un grant teniendo el store y la clave.
- La minimización es buena en disco y mejorable en memoria (hallazgo Media).
- La supresión es automática pero con tres condiciones: relé en marcha, Lumbre respondiendo y secreto coincidente.
- Falta establecer dónde residen los datos y la política de copias del volumen.

## Fuera de alcance / no medido

- Servidor en vivo: contenido del volumen, coincidencia de la imagen desplegada con este SHA, el `/srv/edge/Caddyfile` real y su logger `mcp_errores`, qué hace el logger por defecto de Caddy con los errores TLS, el umask del contenedor, los logs del host (daemon de Docker, journald, firewall, proveedor). Parte de esto lo mide `audit-recuperacion-despliegue-20261010.md`.
- Ubicación del VPS y residencia en la UE; copias o snapshots del volumen.
- Lado de Lumbre (repo `lumbre`): qué registra de las llamadas del backchannel y de la API, si caduca las credenciales MCP y las solicitudes pendientes, y qué borra al dar de baja una cuenta.
- Si el `client_id` de Codex lleva un identificador por instalación, y el `User-Agent` real de las descargas CIMD.
- El modo stdio local (`notes-seen.json` en la máquina del usuario).
- Las dependencias solo se revisaron por grep de `console.*`.
