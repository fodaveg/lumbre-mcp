# Deploy del transporte HTTP remoto (M2)

`mcp.lumbre.pro` está **desplegado y verificado** desde el 25 ago 2026. Esto ya
no es un plan: es cómo se opera.

## Cómo está montado

| Pieza | Dónde | Qué |
|---|---|---|
| Servicio | `/srv/lumbre-mcp` del VPS | Copia de este repo + `deploy/compose.yml` |
| Contenedor | `lumbre-mcp` | `node dist/http.js`, escucha en 8787 |
| Borde | `/srv/edge/conf.d/mcp-lumbre-pro.caddy` | Caddy termina TLS y hace proxy |
| Estado | volumen `lumbre-mcp_state` | huella de notas + grants OAuth cifrados y clave estable |

El contenedor **no publica puertos al host**: Caddy lo alcanza por el DNS de la
red Docker externa `edge` (`lumbre-mcp:8787`), igual que hace con
`lumbre-app:3000`. El único camino de entrada es HTTPS por el borde.

No hay un `LUMBRE_TOKEN` global en el servidor. OAuth abre el consentimiento en
la sesión web de Lumbre y canjea por backchannel una credencial dedicada; el
relé la cifra y resuelve cada bearer OAuth opaco localmente. El bearer OAuth
nunca se reenvía a Lumbre y ningún token pasa por el navegador.

El despliegue falla cerrado si falta o mide menos de 32 caracteres
`LUMBRE_MCP_BACKCHANNEL_SECRET`. Debe configurarse con el mismo valor en los
contenedores de Lumbre y lumbre-mcp. Desde el 30 ago 2026 ambos lados de
producción lo tienen configurado y el flujo OAuth pasó QA real desde Codex. En
un despliegue nuevo hay que conservar esa igualdad y repetir el QA: discovery
verde solo certifica metadata, no el flujo OAuth.

`oauth.key` y `oauth-store.json` forman una unidad de backup: hay que copiar y
restaurar ambos juntos, con permisos `0600`, o descartar ambos y volver a
autorizar todos los clientes. Restaurar el store sin su clave, o con otra,
impide iniciar el listener; una instancia ya levantada respondería 503 en
`/readyz`. Nunca regenerar una clave encima de un store existente. El volumen
completo sigue siendo secreto aunque la credencial upstream esté cifrada. Los
stores provisionales v1/v2 se rechazan sin modificarlos: archiva store+clave,
retíralos manualmente y reautoriza por sesión web. La imagen actual corre con
el usuario de la imagen base;
moverla a non-root exige preparar ownership de `/state` en la imagen/volumen y
se deja para el cambio de runtime correspondiente, no para este lote OAuth.

El store se sirve de una **caché en memoria** que se sustituye dentro de la cola
de escritura, en cuanto el `rename` confirma: sin ella, cada petición con bearer
OAuth releía, parseaba y normalizaba el fichero entero. La premisa es que **un
solo proceso** escribe ese fichero, y hoy se cumple (un contenedor, un
`node dist/http.js`, sin réplicas). Si alguna vez se replica el servicio, dos
procesos no comparten esa memoria y se servirían grants viejos entre sí: habría
que mover el store a un almacén compartido o invalidarlo por `mtime` ANTES de
escalar. `/readyz` no se contesta desde la caché: relee del disco y adopta lo
leído (solo si nadie escribió mientras validaba), así que un cambio externo del
fichero acaba viéndose. El retraso máximo lo marca **el healthcheck, cada 30 s**
—es el único que consume `/readyz`, porque el borde no lo publica—, no los
cinco segundos de su caché interna, que solo evitan repetir la comprobación.

Cada reemplazo del store solicita `fsync` del temporal antes del `rename` y del
directorio de estado después. Los tests sabotean y verifican ese orden; esto no
equivale a certificar supervivencia a corte eléctrico del volumen o hardware del
VPS. `/readyz` comparte una sola comprobación concurrente, cacheada cinco
segundos, y Caddy la bloquea: solo la consume el healthcheck interno por
`127.0.0.1`.

### Una sola instancia, y por qué

El relé corre como **un único proceso** y tiene que seguir así: nada de
`docker compose up --scale`, de un segundo contenedor sobre el mismo volumen ni
de despliegues azul/verde que dejen dos vivos a la vez. `container_name` fijo ya
impide `--scale`, y `publicar.sh` recrea el contenedor (para el viejo y luego
arranca el nuevo), así que nunca hay dos. Lo que se rompería con dos:

- **Se pierden escrituras del store OAuth.** Cada proceso reescribe el fichero
  entero desde su caché en memoria. Medido el 10 oct 2026
  (`docs/audit-abuso-y-limites-20261010.md`, hallazgo 5): dos procesos sobre el
  mismo directorio, 10 `/authorize` alternados, todos 302, y solo 5 pendientes
  en disco. En la práctica: callbacks que responden «caducada o no existe» y
  refresh tokens que desaparecen.
- **Los topes se multiplican.** Los límites de ritmo de OAuth, las ventanas de
  `/authorize` y el tope de `tools/call` en vuelo son de cada proceso: con N
  réplicas, N veces el cupo.
- **Las cachés divergen.** La de existencia de tareas (`src/existence-cache.ts`)
  y la del store no se invalidan entre procesos.

Si algún día hace falta escalar, antes hay que mover el store a un almacén
compartido (o poner un lock de fichero y releer antes de cada escritura) y
llevar los contadores a un sitio común.

### Límites del transporte

Medidos y elegidos el 11 oct 2026 a partir de
`docs/audit-abuso-y-limites-20261010.md` (hallazgos 1 y 3):

| Límite | Valor | Dónde se cambia | Al pasarse |
| --- | --- | --- | --- |
| Lotes JSON-RPC (array) en `/mcp` | no se admiten | — | 400, `-32600` |
| `tools/call` en vuelo, todo el proceso | 32 | `LUMBRE_MCP_MAX_TOOL_CALLS` | 429, `-32003`, `Retry-After: 1` |
| `tools/call` en vuelo, misma credencial | 8 | `LUMBRE_MCP_MAX_TOOL_CALLS_PER_BEARER` | 429, ídem |
| Recibir la petición entera | 60 s | `MCP_REQUEST_TIMEOUT_MS` (`src/http.ts`) | 408 |
| Recibir las cabeceras | 20 s | `MCP_HEADERS_TIMEOUT_MS` | 408 |
| Conexiones abiertas a la vez | 64 | `MCP_MAX_CONNECTIONS` | la nueva se cierra en el acto (502 en el borde) |
| Memoria del contenedor | 512 MB límite, 128 MB reserva | `mem_limit` / `mem_reservation` (`deploy/compose.yml`) | el kernel mata el proceso y `restart` lo levanta |

- **Por qué estos topes de `tools/call`.** El uso real son 1-3 cuentas y un
  cliente MCP lanza un puñado de tools en paralelo; 32 da para cuatro cuentas
  con 8 a la vez cada una. El global es el que frena a quien inventa un bearer
  distinto en cada petición; el de credencial (contada por el hash de la
  credencial upstream, nunca en claro) impide que una cuenta se coma el cupo de
  las demás. Lo que no cabe recibe 429 en el acto, sin cola: una cola también
  retiene memoria, y los clientes ya reintentan. El hueco se devuelve cuando la
  tool termina con la app, aunque el cliente se haya ido antes.
- **Cambiarlos.** Las dos variables se leen al arrancar; ponerlas en
  `/srv/lumbre-mcp.env` (Compose las pasa al contenedor) y recrear el
  contenedor. Un valor que no sea un entero entre 1 y 10 000 cae al defecto y
  deja una línea en el log; nunca quita el tope.
- **Memoria, medida en `node:22-alpine`** con las sondas del audit más una de
  peor caso: reposo de la sonda ~90 MB (el contenedor real en reposo, 28 MiB
  en local y 45-69 MiB en producción); 500 `tools/call` concurrentes con el
  upstream a 3 s, 32 × 200 y el resto 429 o conexión cerrada, ~110 MB;
  64 cuerpos de 2 MB a medio llegar, ~225 MB; 32 `add_attachment` de 1 MiB en
  vuelo, ~320 MB de pico, que es el peor caso y lo que fija el límite en 512 MB.
  `maxConnections` es lo que acota los cuerpos a medio llegar: con 256 eran
  ~520 MB.

### Arranque fallido y parada

Si el relé no puede arrancar, la línea del log dice la causa, de un conjunto
fijo y sin el texto del error (un `JSON.parse` fallido copiaría un trozo del
store):

```
[lumbre-mcp-http] estado OAuth no disponible (causa: store_json_invalido); listener no iniciado
```

| Causa | Qué es |
| --- | --- |
| `clave_ausente` | hay `oauth-store.json` y falta `oauth.key` |
| `clave_invalida` | la clave no mide 32 bytes o no descifra el store |
| `store_json_invalido` | el store no es JSON (truncado o editado a mano) |
| `store_incoherente` | JSON válido que no cumple el contrato |
| `store_version` | store provisional v1/v2 |
| `secreto_backchannel` | `LUMBRE_MCP_BACKCHANNEL_SECRET` falta o no mide 32-512 caracteres |
| `app_base_url` | `LUMBRE_APP_BASE_URL` no es `https://app.lumbre.pro` |
| `io:<código>` | error del sistema de ficheros (`io:EACCES`, `io:ENOSPC`…) |
| `desconocido` | ninguna de las anteriores |

Al parar (`docker stop`, deploy), `init: true` pone un init como PID 1 que
entrega SIGTERM a Node, y el relé deja de aceptar conexiones, espera a las
peticiones en vuelo y a la cola de escritura del store, y sale. Si en 10 s no ha
terminado, corta lo que quede y sale con 1; `stop_grace_period: 15s` deja 5 s
más antes del SIGKILL de Docker. Medido en local con la imagen: `docker stop`
tarda menos de un segundo y sale con 0 (antes, 10 s y SIGKILL en cada deploy).

### Qué guarda el volumen de cada conexión y cuándo se borra

Por cada conexión OAuth hay dos cosas en `/state/lumbre-mcp`: la credencial
dedicada de Lumbre, cifrada, dentro de `oauth-store.json`, y un fichero de
huella de notas `notes-seen-<id>.json` (identificadores de tarea, fecha de la
última edición de su nota y longitud; ni texto de notas ni credencial, y el
`<id>` es un hash, no el token).

- **Al salir la autorización del almacén** (revocación desde el cliente,
  refresh reutilizado, credencial inactiva al refrescar, familia caducada a
  los 30 días) se retira del store y se borra su fichero de huella en la misma
  operación. Si la revocación nace aquí, la credencial cifrada queda en la
  outbox hasta el ACK de Lumbre o 30 días.
- **Barrido de credenciales**: al arrancar el proceso (con el store ya
  validado) y cada 60 minutos, el relé introspecciona en serie cada credencial
  que guarda. Solo un `{ "active": false }` explícito de Lumbre (credencial
  revocada desde la app, cuenta borrada o usuario no activo) purga la
  autorización, sus tombstones y su huella. Así, revocar en la app o borrar la
  cuenta se refleja aquí como mucho unos 60 minutos después, **siempre que el
  contenedor esté en marcha y `app.lumbre.pro` responda**. El barrido también
  aplica la caducidad de las familias, reintenta la outbox entera y borra las
  huellas con más de 30 días sin escrituras.

Qué esperar al operarlo:

- Red caída, timeout, 5xx, 429, 401 del canal (el secreto no coincide) o una
  respuesta fuera de contrato **no purgan nada** y cortan el barrido hasta el
  ciclo siguiente. Con Lumbre caída o el secreto mal puesto no se borra nada
  por error, pero tampoco se purga lo revocado hasta que se arregle.
- Un barrido que purga o descarta algo escribe UNA línea en stderr,
  `[lumbre-mcp-oauth] barrido de credenciales: …`, con recuentos y nada más
  (ni tokens, ni identificadores, ni nombres de fichero). Uno que no hace nada
  no escribe nada. Si un fichero de huella no se pudo borrar, sale otra línea
  con el recuento, `[lumbre-mcp-oauth] huella de notas: …`.
- No marca `/readyz` ni reinicia el contenedor: un barrido fallido se
  reintenta en el siguiente ciclo. No tiene configuración: el intervalo es una
  constante (`CREDENTIAL_SWEEP_INTERVAL_MS` en `src/http.ts`).
- Coste hacia Lumbre: una introspección por autorización guardada y hora. La
  ruta `/introspect` de la app solo limita los intentos con secreto inválido,
  así que con el secreto correcto no hay límite que gastar.

Límites que se quedan:

- La **conexión antigua por token de la API** (Bearer directo o `/mcp/<token>`)
  no deja credencial en el relé: el relé no puede saber que el token se rotó o
  que la cuenta se borró. Su fichero de huella se borra a los 30 días sin
  escrituras, que ahora aplica el barrido sin depender de que haya tráfico.
- Un 401 de la app durante una tool no borra nada; lo cubre el barrido.
- Si el borrado de una huella falla, o una tool en vuelo la reescribe justo
  después de la retirada, queda un fichero huérfano hasta esos mismos 30 días.
- Esto borra del volumen en uso. Una copia de `oauth-store.json` hecha antes
  de la purga conserva lo que tuviera.

### Un `.env` local nunca acaba en git, en la imagen ni en el servidor

El repo es público y `.env.example` invita a crear un `.env` local con una
clave de configuración. Tres capas lo mantienen fuera:

- `.gitignore` y `.dockerignore` ignoran `.env` y `.env.*`, con la excepción
  `!.env.example` para que la plantilla siga versionada (compruébalo con
  `git check-ignore -v .env .env.local .env.example`: solo los dos primeros
  deben salir en la lista).
- `deploy/publicar.sh` excluye `.env*` del `rsync` que copia el árbol al
  servidor, con `--include '.env.example'` antes del `--exclude` (rsync evalúa
  los filtros en orden). Excluir no borra lo que ya estuviera copiado de antes
  por error; hay que retirarlo a mano en el servidor.
- `LUMBRE_MCP_HOST` pasa por la misma validación de formato que `DEST` y
  `ENV_FILE`: alias de `~/.ssh/config` o `usuario@host`, solo letras, dígitos,
  punto, guion, guion bajo y arroba, primer carácter alfanumérico. Un valor
  inválido aborta antes de tocar `ssh` o `rsync`.

### Secreto del backchannel

El secreto vive en `/srv/lumbre-mcp.env`, fuera de `/srv/lumbre-mcp`: el script
de publicación sincroniza ese árbol con `rsync --delete` y borraría un `.env`
guardado dentro. Crear el fichero una sola vez con permisos restrictivos:

```bash
sudo install -m 0600 -o "$USER" /dev/null /srv/lumbre-mcp.env
sudoedit /srv/lumbre-mcp.env
```

Contenido (valor aleatorio estable de 32 caracteres o más, igual al configurado
en el contenedor Lumbre):

```dotenv
LUMBRE_MCP_BACKCHANNEL_SECRET=<secreto-aleatorio>
```

`deploy/publicar.sh` comprueba que el fichero existe, es legible y tiene modo
exacto `0600` antes del `rsync`, y pasa explícitamente
`--env-file /srv/lumbre-mcp.env` a Compose. `LUMBRE_MCP_ENV_FILE` permite otra
ruta absoluta canónica si el operador la necesita, siempre fuera de
`LUMBRE_MCP_DEST`; el script rechaza rutas equivalentes con `.`/`..` o dobles
barras. Para rotar, preparar el mismo valor
nuevo en ambos servicios y reiniciarlos en una ventana coordinada; mientras no
coincidan, `/requests` falla cerrado y no se emiten grants locales.

### `LUMBRE_APP_BASE_URL`

Origen de la app de Lumbre al que el relé OAuth llama por backchannel
(`/api/integrations/lumbre-mcp/…`, con el secreto de arriba como bearer). Lo
lee `src/oauth.ts` y lo valida `src/lumbre-oauth-backchannel.ts`: si falta o
está vacío vale `https://app.lumbre.pro`, y cualquier otro valor (otro
origen, con ruta, query o credenciales) aborta el arranque con un error. En
`deploy/compose.yml` ya va fijado a ese valor; no es lo mismo que
`LUMBRE_BASE_URL`, que es la API de tareas a la que el relé reenvía las
llamadas de las tools.

## Publicar una versión nueva

```bash
./deploy/publicar.sh
```

Publica **HEAD**, no el árbol de trabajo:

1. Aborta si `git status --porcelain` no está vacío (cambios sin commitear o
   ficheros sin seguimiento): lo que llega al servidor tiene que poder
   reconstruirse desde un commit.
2. Recompila `dist/` y aborta si lo recompilado no coincide con lo commiteado,
   incluidos ficheros nuevos (es `dist/` lo que viaja, no `src/`: publicar sin
   recompilar dejaría la versión vieja corriendo sin ningún síntoma).
3. Exporta HEAD con `git archive` y lo copia con `rsync -rlptz --delete`,
   excluyendo `.DS_Store`; después `chown -R 0:0` del destino y borra los
   `.DS_Store` que quedaran de copias anteriores. No usa `--chown=root:root`
   porque el `rsync` de macOS (openrsync) no lo admite; sin `-o`/`-g`, los
   ficheros nuevos ya nacen del usuario remoto.
4. En el servidor: etiqueta la imagen en marcha como `lumbre-mcp:anterior`,
   construye `lumbre-mcp:<sha>` (con `LABEL org.opencontainers.image.revision`
   = el SHA), guarda el log del contenedor saliente, levanta la nueva y espera
   a `healthy` (tope `LUMBRE_MCP_HEALTH_TIMEOUT`, 90 s por defecto; el
   healthcheck comprueba cada 2 s mientras arranca). Si llega, la etiqueta
   también como `latest` y borra las etiquetas por SHA que no sean la nueva ni
   la anterior. Si no llega, guarda también el log de la fallida, vuelve a
   `anterior` y sale con 1; `latest` no se mueve.
5. Si hay `LUMBRE_TOKEN` en el entorno, corre `scripts/smoke-remote.mjs`
   (el token va por el entorno, no por la línea de órdenes). Si falla, sale con
   1 e imprime el comando para volver a la anterior. Sin token, lo deja
   indicado como paso manual.

Qué commit corre en el servidor:

```bash
ssh lumbre "docker inspect -f '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' lumbre-mcp"
```

Volver a la versión anterior a mano (la imagen sigue en el servidor, sin
recompilar ni red):

```bash
ssh lumbre 'cd /srv/lumbre-mcp && LUMBRE_MCP_IMAGE_TAG=anterior \
  docker compose --env-file /srv/lumbre-mcp.env -f deploy/compose.yml up -d --no-build'
```

**Logs de contenedores anteriores.** Compose recrea el contenedor en cada
deploy y Docker borra su log con él, así que `publicar.sh` lo guarda antes en
`/var/log/lumbre-mcp/<fecha UTC>-saliente-<sha12>.log.gz` (y
`…-fallido.log.gz` si la nueva no llega a healthy), `0600`, conservando los 30
más recientes. `LUMBRE_MCP_LOG_DIR` cambia el directorio; tiene que quedar
fuera de `/srv/lumbre-mcp`, que `rsync --delete` vacía. Se leen con
`zcat <fichero> | tail`.

**No usa `git pull` en el servidor** porque la clave de despliegue que hay allí
solo da acceso a `fodaveg/lumbre`, no a este repo. Si algún día se le añade una
clave de despliegue propia a `fodaveg/lumbre-mcp`, el script se cambia por un
`git -C /srv/lumbre-mcp pull` y lo demás sigue igual.

## Cambiar el fragmento de Caddy

`deploy/mcp-lumbre-pro.caddy` es la copia versionada de
`/srv/edge/conf.d/mcp-lumbre-pro.caddy`. Vive aquí porque **`/srv/edge` del VPS
no es un checkout de git** y el repo `edge-infra` lleva divergido desde el 31
jul 2026 (le faltan `app-lumbre-pro.caddy`, `admin`, `preview`,
`demo-lumbre-pro`, `lumbre-staging` y `vega.caddy`): no es la fuente de verdad
de nada.

```bash
scp deploy/mcp-lumbre-pro.caddy lumbre:/srv/edge/conf.d/
ssh lumbre 'cd /srv/edge && docker compose --env-file .env exec -T caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
ssh lumbre 'cd /srv/edge && docker compose --env-file .env exec -T caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile'
```

El fragmento trae además dos cosas que hay que recargar para que surtan efecto:
`request_body { max_size 2MB }` (el borde corta un cuerpo desmedido antes de que
ocupe al contenedor; el tope de la app, 2 MiB, queda como red de seguridad para
quien lo alcance por la red `edge` sin pasar por aquí) y un HSTS con
`includeSubDomains` — sin `preload`, que se pide desde el ápice y afecta a todo
el dominio. `src/caddy-config.test.ts` comprueba que el `max_size` del borde no
se despega de la constante de la app.

Cada `reverse_proxy` lleva además plazos hacia el contenedor (`transport http`):
`dial_timeout 5s`, `response_header_timeout 90s` (las cabeceras salen cuando la
tool termina, y una tool puede encadenar varias peticiones de hasta 30 s a la
app) y `write_timeout 60s`, igual que el `requestTimeout` del relé. Validado con
`caddy adapt` de Caddy v2.11.6; el test comprueba que los tres bloques llevan
los mismos valores.

Validar ANTES de recargar: el `reload` de Caddy es en caliente y no corta
conexiones vivas, pero una config inválida deja el borde entero (Lumbre, Senda,
fodaveg, Vega y las demos) sirviendo la anterior sin avisar de por qué.

### La pieza que NO está en este repo

El silencio del log de este host son DOS piezas, y la segunda vive en
`/srv/edge/Caddyfile` (el bloque global del borde, que no es de este repo ni
está en git en ninguna parte). Si alguna vez se reconstruye ese fichero, esto
tiene que volver a entrar o el token vuelve a caer en el log:

```
{
	email {$ACME_EMAIL}

	log mcp_errores {
		output discard
		include http.log.error.mcp
	}
}

import conf.d/*.caddy
```

Por qué hacen falta las dos: el bloque `log mcp { output discard }` del sitio
solo tapa `http.log.access.mcp`. La entrada que lleva la URI completa (y por
tanto el token del path) sale por `http.log.error.mcp`, y el `include` que la
atrapa no se admite dentro del bloque `log` de un sitio, solo en el global.

**Cómo se comprueba, porque validar y recargar NO lo prueban** (el bloque puede
estar puesto y no tapar nada; pasó dos veces el 25 ago 2026):

```bash
ssh lumbre 'docker stop lumbre-mcp'
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://mcp.lumbre.pro/mcp/f00dfacef00dfacef00dfacef00dface   # 502 esperado
ssh lumbre 'docker start lumbre-mcp
  docker logs edge-caddy --since 2m 2>&1 | grep -c f00dface'    # tiene que ser 0
```

El token del `curl` es FALSO a propósito: si la prueba sale mal, lo que queda
escrito en el log no es un secreto de verdad. Y el control que hace falta al
lado: `docker exec edge-caddy wget -q -O - http://127.0.0.1:2019/config/` y
mirar `logging.logs.default.exclude`, que debe listar SOLO
`http.log.access.mcp` y `http.log.error.mcp`. Si excluye más cosas, has
apagado el registro de otro host sin querer.

## Smoke test tras cada deploy

`scripts/smoke-remote.mjs` es el guardarraíl del deploy: sin dependencias,
habla Streamable HTTP crudo contra la URL ya desplegada. `publicar.sh` lo corre
solo si hay `LUMBRE_TOKEN` en el entorno; si no, a mano (sin el segundo
argumento lo lee de `LUMBRE_TOKEN`, que no queda a la vista en `ps`):

```bash
node scripts/smoke-remote.mjs https://mcp.lumbre.pro/mcp
```

Comprueba el descubrimiento OAuth (PRM path-specific + alias y metadata del
authorization server), el challenge exacto del 401, `initialize` +
`tools/list` con token directo en cabecera (200, todas las tools, techo de bytes), y
las dos mismas comprobaciones con el token en el PATH (`<url>/<token>`,
compatibilidad temporal), más su propio NEGATIVO con un segmento mal formado.
Un deploy no se da por bueno solo con el camino feliz en verde: si un caso
negativo alguna vez sale distinto de 401 (por ejemplo 200, o un 500 que
delate un fail-open), el script sale con exit 1 igual que si fallara el
camino feliz.

Este smoke remoto **no certifica OAuth**: PRM/AS y el challenge pueden estar
perfectos con code/refresh/revoke rotos o con el backchannel ausente. Los canary
locales son `npx vitest run src/lumbre-oauth-backchannel.test.ts` y
`npx vitest run src/oauth.test.ts`; cubren el contrato HTTP negativo, code+PKCE,
persistencia tras reinicio, introspect, refresh/replay y el outbox de revoke con
Lumbre simulada. La aceptación real exige además el secreto desplegado en
Lumbre y QA de claude.ai web/móvil.

Exit 0 = todas las comprobaciones en verde (el propio script imprime `N/N` al
final, no hace falta contar a mano). Exit 1 =
al menos una en rojo, con el detalle impreso por comprobación.

**El smoke no prueba el relé.** `initialize` y `tools/list` los contesta el
servidor MCP sin hablar con `app.lumbre.pro`: pasarían igual con la API caída o
con el `LUMBRE_BASE_URL` mal puesto. Tras un deploy, una llamada real:

```bash
curl -s --max-time 30 -X POST https://mcp.lumbre.pro/mcp \
  -H "Authorization: Bearer $LUMBRE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_lists","arguments":{}}}'
```

## Conectar un cliente

Claude Code, transporte HTTP con cabecera estática heredada:

```bash
claude mcp add --transport http lumbre https://mcp.lumbre.pro/mcp \
  --header "Authorization: Bearer $LUMBRE_TOKEN"
```

claude.ai (web y móvil) se conecta desde «Añadir conector personalizado»
pegando **solo**:

```
https://mcp.lumbre.pro/mcp
```

Claude descubre OAuth 2.1 y el callback exacto es
`https://claude.ai/api/mcp/auth_callback`; el consentimiento sucede en
`app.lumbre.pro`. Las formas stdio, Bearer directo y `/mcp/<token>` se conservan
solo por compatibilidad; las configuraciones nuevas deben usar OAuth.

La compatibilidad con `/mcp/<token>` sigue tocando las DOS piezas del deploy:
además de `./deploy/publicar.sh` (recompila y sube `dist/`), hay que volver a
subir `deploy/mcp-lumbre-pro.caddy` con los pasos de "Cambiar el fragmento de
Caddy" de arriba — trae el bloque `log` que apaga el registro del borde para
este host (necesario porque Caddy vuelca la URI completa en sus entradas de
error, y con el token en el path eso lo dejaría en claro en el log del
contenedor `edge-caddy`). Publicar solo el contenedor sin recargar Caddy deja
el borde sirviendo la config vieja: sin el bloque `log`, el token seguiría
cayendo en `http.log.error` cada 502 o timeout.
