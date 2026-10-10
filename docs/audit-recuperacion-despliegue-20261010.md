# Operación y recuperación del despliegue (10 oct 2026)

Alcance: cómo se opera y se recupera `https://mcp.lumbre.pro/mcp`: contenedor
`lumbre-mcp`, volumen `lumbre-mcp_state`, Caddy del borde y
`deploy/publicar.sh`. Solo lectura, en el repo y en el servidor. Pregunta
central: si el servidor pierde disco, se corrompe un fichero o se reinicia mal,
qué pierde el servicio, cómo se recupera y cuánto tarda.

- **Repo:** `main` `3540a7e3b87ea89537841016dc12ec375f1ab84e`, igual a `origin/main` tras `git fetch`.
- **Servidor:** medido por `ssh` el 2026-10-10 entre las 04:50 y las 04:55 UTC (Docker 29.7.2, Compose v5.5.0).
- **Leídos completos:** `Dockerfile`, `deploy/compose.yml`, `deploy/mcp-lumbre-pro.caddy`, `deploy/publicar.sh`, `deploy/README-deploy.md`, `src/deploy-config.test.ts`, `src/caddy-config.test.ts`, `src/dist-al-dia.test.ts`.
- **Leídos en parte:** `src/oauth.ts` (persistencia, clave, readiness y refresh), `src/http.ts` (arranque, rutas de salud y barrido), `src/index.ts`, `src/notes.ts` (huella) y `src/oauth.test.ts:937-979`.
- **Secretos:** no se leyó ninguno. Del volumen solo nombre, tamaño, permisos y mtime. De las variables de entorno, solo los nombres.

El script de medición reproducible está en
`audit-recuperacion-despliegue-20261010.medicion.sh`, junto a este informe.

## Hallazgos priorizados

| # | Prioridad | Hallazgo | Evidencia | Impacto | Corrección propuesta |
| --- | --- | --- | --- | --- | --- |
| H1 | **Alta** | **No hay ninguna alerta para el relé.** Si no arranca (reinicio en bucle) o queda `unhealthy`, nadie se entera. Con Docker sin Swarm, un `unhealthy` no reinicia nada. | `docker ps` sin autoheal. Ninguna unit o script nombra `lumbre-mcp` o `mcp.lumbre.pro` con fines de monitorización (grep en `/etc/systemd/system` y los scripts de Lumbre: solo censos y checks de Lumbre). El repo no tiene Sentry ni uptime. `HostConfig.RestartPolicy=unless-stopped`. | Si el store se corrompe o se pierde la clave, cae todo: OAuth, Bearer heredado y discovery. Nadie lo detecta hasta que un usuario se queja. El tiempo de recuperación lo marca la detección, que no tiene límite. | Reutilizar el `lumbre-unit-failure@` que ya existe: un timer systemd cada 5 min que compruebe `docker inspect -f '{{.State.Health.Status}}' lumbre-mcp` y `RestartCount`, y llame al `OnFailure`. Además, un monitor externo de `https://mcp.lumbre.pro/healthz` (hoy responde 200 en público). |
| H2 | Media | **El log de fallo de arranque no dice la causa.** | `src/http.ts:650-652`: el error de `ensureReady()` se descarta y solo se imprime «estado OAuth no disponible; listener no iniciado». | Ante un bucle de reinicios, el operador no distingue entre clave ausente, clave inválida, JSON truncado, store incoherente, store v1/v2, secreto del backchannel corto o `LUMBRE_APP_BASE_URL` mal puesta. | Registrar una causa clasificada de un conjunto fijo (`clave_ausente`, `clave_invalida`, `store_json_invalido`, `store_incoherente`, `store_version`, `secreto_backchannel`, `io:<code>`). Nunca `error.message`: un `SyntaxError` de `JSON.parse` en Node 22 incluye un fragmento del texto. |
| H3 | Media | **Node corre como PID 1 sin `init` ni manejador de SIGTERM.** Cada parada espera 10 s y termina en SIGKILL. No se drenan las peticiones en vuelo. | `docker inspect`: sin `Init`, `StopSignal` ni `StopTimeout`. `/proc/<pid>/status`: `NSpid: … 1`. No hay `process.on` en el `src/` de producción (grep). Journal de dockerd, 2026-10-08: `07:02:15.198` *stopping* → `07:02:25.209` «Container failed to exit within 10s of signal 15 - using the force». | En cada deploy o `docker stop` mueren las peticiones en vuelo. Con la rotación de refresh, un refresh cortado entre el `rename` y la respuesta acaba revocando la familia (H8). | `init: true` y `stop_grace_period: 15s` en `compose.yml`. Un manejador SIGTERM/SIGINT en `http.ts` que haga `server.close()`, espere a la `writeQueue` y salga, con tope de unos 10 s. |
| H4 | Media | **El deploy no tiene rollback ni registra el SHA, y no espera al healthcheck.** | Solo existe la imagen `lumbre-mcp:latest` (`467ebf5557eb`, 2026-10-08 07:02:14). Imágenes colgantes: 0. `/srv/lumbre-mcp` no tiene `.git` y la imagen solo lleva las etiquetas de compose. `publicar.sh:89-97` hace `up -d --build`, imprime `docker ps` y deja el smoke como paso manual. | Una versión rota queda en producción hasta que alguien recompila otra desde el Mac. Tampoco se puede saber desde el servidor qué commit corre. | Etiquetar la imagen con el SHA (`lumbre-mcp:<sha>` y `latest`) y conservar la anterior. `LABEL org.opencontainers.image.revision`. Esperar a `healthy` con tope y, si falla, volver a la etiqueta anterior. Correr `smoke-remote.mjs` si hay token. |
| H5 | Media | **El log del contenedor se pierde en cada redeploy.** | Rotación json-file `10m × 3`. El fichero va ligado al ID del contenedor (238 369 B en unas 46 h; el contenedor actual se creó el 2026-10-08 07:02). Compose recrea el contenedor en cada `publicar.sh`. | La retención real es «desde el último deploy», no los ~240 días que permitirían 30 MB a ~124 KB/día. Si un incidente va seguido de un redeploy, se pierde el log del incidente. | Antes del `up`, en `publicar.sh`: `docker logs --timestamps lumbre-mcp > /var/log/lumbre-mcp/<fecha>.log` con logrotate. O el driver `journald` con `tag`. |
| H6 | Media | **El estado OAuth no tiene copia de seguridad.** Matiz: con la rotación de refresh, una copia vieja sirve de poco. | Sin crontab de root ni de otros usuarios. Las timers de backup (`lumbre-backup`, `lumbre-backup-blobs`, `lumbre-snapshot`) no mencionan `lumbre-mcp`, `mcp_state`, `oauth-store` ni `oauth.key`. La única herramienta de backup instalada es `rclone`, que ninguna unit usa para este volumen. Rotación: `src/oauth.ts:1566-1580` reescribe `refreshHash` en cada refresh y `:1510-1521` responde `invalid_grant` a un refresh desconocido. | Si se pierde el disco o el volumen, todos los clientes OAuth tienen que reautorizar. Las credenciales dedicadas que el relé tenía en Lumbre quedan huérfanas: el relé ya no puede revocarlas. Una copia diaria restaurada solo salvaría a los clientes que no hayan refrescado desde la copia, y los access duran 1 h. | No compensa un backup frecuente del store. Sí compensa: (a) copia cifrada y off-site solo de `oauth.key` y el store juntos, tras cada deploy o a diario, como forense y para revocar huérfanas; (b) un runbook escrito de «reautorizar todo»; (c) comprobar en Lumbre que las credenciales del backchannel caducan o se pueden revocar en bloque. |
| H7 | Media | **El disco está ajustado: 88 % usado y 4,4 GiB libres en un disco de 38 GiB compartido por todos los servicios.** El backup de blobs de Lumbre ha fallado hoy por falta de espacio. | `df -h /`: 32G usados de 38G, 4.4G libres. `docker system df`: 4,9 GB en imágenes y 1,99 GB en build cache recuperables. Journal de `lumbre-backup-blobs` del 2026-10-10 03:45: «no cabe ni rotando. Necesito ~7,20 GiB … libres: 4,31 GiB». | Para el relé: con el disco lleno falla la escritura del temporal antes del `rename`. El store queda íntegro (`oauth.ts:2329-2350`), pero fallan `/token` (code y refresh) y las escrituras de la outbox. En 1 h dejan de funcionar los clientes OAuth activos. La huella de notas deja de persistir sin avisar. | Fuera del alcance del relé: lo decide la sesión de Lumbre (poda de imágenes y build cache, tamaño del disco). Para el relé, basta con H1. |
| H8 | Baja | **Un refresh cortado después del `rename` revoca la familia.** | `oauth.ts:1538-1586`: el store se escribe antes de responder. Si el cliente reintenta con el refresh viejo, `:1528-1530` lo trata como replay y llama a `revokeFamily`. | Si un SIGKILL (H3) o un corte de red cae en ese intervalo de milisegundos, ese cliente tiene que reautorizar. Poco probable. | Resolver H3. Si se quiere más margen: ventana de gracia corta para el refresh anterior inmediato, como permite OAuth 2.1 BCP. |
| H9 | Baja | **`oauth.key` no se crea de forma atómica.** | `oauth.ts:2126-2137`: `open('wx')`, escritura y `sync`, sin temporal ni `rename`. | Un corte durante el primer arranque (sin store) deja una clave vacía. El siguiente arranque falla con «clave inválida» (`:2117`) y hay que borrarla a mano. Solo afecta al primer arranque. | Escribir a un temporal, `fsync`, `rename` y `fsync` del directorio. |
| H10 | Baja | **Los temporales huérfanos nunca se limpian.** | `oauth-store.json.<pid>.<hex>.tmp` se queda si hay SIGKILL entre `open` y `rename`. En `notes.ts:357-366`, si `writeFile` falla no se borra el `.notes-seen-….tmp`. La poda (`ACCOUNT_FILE_PATTERN`) no los casa. Hoy hay 0. | Basura de unos pocos KB. El temporal OAuth contiene secretos cifrados (0600). | Al arrancar, borrar `*.tmp` del directorio de estado antes de `ensureReady`. En `notes.ts`, `unlink` del temporal en el `catch`. |
| H11 | Baja | **El contenedor no tiene límite de memoria, corre como root y la imagen base es flotante.** | `Memory=0`, `PidsLimit=null`, `User=""` (uid 0 según `/proc`), `FROM node:22-alpine`. RSS actual de 45 a 69 MiB, sobre 3,7 GiB de RAM en el host. | Una fuga de memoria del relé compite con Postgres y la app de Lumbre en el mismo host. Un rebuild sin caché cambia la versión de Node sin avisar. | `mem_limit: 256m`. Fijar el digest de `node:22-alpine`. El paso a non-root ya está anotado en `README-deploy.md:38-41`. |
| H12 | Baja | **El árbol desplegado arrastra artefactos del Mac.** | `/srv/lumbre-mcp/.DS_Store`, propietario `501:staff`. `rsync -az` copia el árbol de trabajo, no un commit. `git diff --quiet -- dist` no ve ficheros nuevos sin seguimiento en `dist/`. | Se puede desplegar un `Dockerfile` o `compose.yml` sin commitear sin que quede rastro (H4). | `rsync` desde `git archive HEAD` o desde un worktree limpio, abortando si `git status --porcelain` no está vacío. `--chown=root:root` y `--exclude .DS_Store`. |
| I1 | Informativo | **El store se escribe de forma atómica y durable.** | Temporal `wx` 0600 → `fsync` → `rename` → `fsync` del directorio (`oauth.ts:2326-2346`). Test `oauth.test.ts:1202`. | Un corte o un SIGKILL no deja el store truncado. | |
| I2 | Informativo | **Falla cerrado si el store y la clave no casan.** | `oauth.ts:1744-1746`, `2124`, `2142`. Tests `oauth.test.ts:937-970`. | Nunca regenera una clave encima de un store existente. | |
| I3 | Informativo | **Lo desplegado coincide con el repo.** | sha256 agregado de `dist/**/*.js` en el servidor = HEAD = `62a2d144…`. El fragmento Caddy del servidor coincide con el del repo (`b37d6f4c…`). El global `/srv/edge/Caddyfile` tiene `log mcp_errores` con `include http.log.error.mcp` (líneas 20-22). | | |
| I4 | Informativo | **El borde no filtra tokens.** | En 72 h hay 25 líneas de `edge-caddy` con `mcp.lumbre.pro`, todas de ACME o TLS. Ninguna casa con `/mcp/<hex32>`. | | |
| I5 | Informativo | **El certificado está vigente.** | Let's Encrypt, `notAfter=Nov 23 12:19:40 2026 GMT`. Renovación ARI activa. Los volúmenes `lumbre_caddy_data` y `lumbre_caddy_config` no entran en ningún backup. | Si se pierden, Caddy reemite al arrancar, mientras haya DNS y puertos 80/443 y no se superen los límites de LE. | |
| I6 | Informativo | **`LiveRestore=false`.** | `docker info`. | Reiniciar dockerd reinicia todos los contenedores, incluido el relé, que tarda unos 0,5 s en levantar. | |
| I7 | Fuera de alcance | **Otro contenedor también recibe SIGKILL.** | `lumbre-staging-demo-app-1` acumula «failed to exit within 10s of signal 15» cada 30 min (`lumbre-demo-reset@staging`): 941 líneas de ese tipo en el journal desde el 20 sep, sumando todos los contenedores. | Mismo patrón que H3, en Lumbre. | Pasarlo a la sesión de Lumbre. |

## Las 7 preguntas

### 1. Qué estado es irrecuperable y si tiene copia

HECHO, del listado del volumen en `/var/lib/docker/volumes/lumbre-mcp_state/_data/lumbre-mcp`, directorio `drwx------ root`:

| Fichero | Tamaño | Permisos | mtime (UTC) | ¿Irrecuperable? |
| --- | --- | --- | --- | --- |
| `oauth.key` | 43 B | `-rw------- root` | 2026-08-30 07:49 | Sí. Sin ella, el store no se puede descifrar. |
| `oauth-store.json` | 10 146 B | `-rw------- root` | 2026-10-10 04:39 | Sí. Grants, rotación de refresh, outbox y credenciales upstream cifradas. |
| `notes-seen-<16hex>.json` (9 ficheros) | 81 B – 64 KB | `-rw-r--r-- root` | 2026-09-18 … 2026-10-10 | No. Si se pierden, las notas pasan a mostrarse como marcador (`notes.ts:317-343`). |

Total del volumen: 224 KB. Temporales: 0. El volumen se creó el 2026-08-25.
**Copia: ninguna** (H6). Fuera del volumen hay otro estado necesario:
`/srv/lumbre-mcp.env` (95 B, `0600 root`, no leído) con
`LUMBRE_MCP_BACKCHANNEL_SECRET`, recuperable porque tiene que coincidir con el
del contenedor de Lumbre (`README-deploy.md:24-29`); no verificado si el
entorno de Lumbre tiene copia. Hay que reautorizar si se pierde cualquiera de
los dos primeros ficheros.

### 2. Si se pierde `oauth.key` y el store sigue

HECHO (código y test): el arranque falla y la clave no se regenera.
`ensureReady` lanza «store OAuth presente sin su clave» (`oauth.ts:1744-1746`,
`loadOrCreateKey` en `:2124`). En `http.ts:641-653` el listener no se abre, se
imprime la línea genérica y se pone `exitCode=1`. Lo cubre
`oauth.test.ts:958-963`. Una clave vacía, truncada o de otra longitud falla con
«clave inválida» (`:2117`). Con una clave distinta, `decrypt` falla en
`ensureReady` (`:1768-1773`) y se cae igual (test `:965-969`). Nunca quedan
grants a medias en un servicio en marcha.

INFERENCIA: no hay timers vivos antes del listener, así que el proceso sale con
código 1 y `unless-stopped` lo reinicia en bucle con backoff. Resultado: caída
total, también del Bearer heredado y de `/.well-known`, hasta que alguien
intervenga (procedimiento B).

### 3. Si el JSON del store está truncado

HECHO: `readStore` (`oauth.ts:2217-2235`) solo trata `ENOENT` como store
vacío. Un `SyntaxError` de `JSON.parse`, o un `normalizeStore` que lanza
«inválido» o «incoherente» (`:606-771`), se propaga; mismo cuadro que la
pregunta 2. El store incoherente está probado en `oauth.test.ts:949-955`; el
JSON truncado no tiene test propio.

HECHO: la escritura atómica con `fsync` (I1) hace que un corte no deje un store
truncado. Para que esté truncado hace falta corrupción del sistema de ficheros,
una edición manual o una restauración defectuosa.

HIPÓTESIS: si el fichero se corrompe con el proceso en marcha, el servicio sigue
sirviendo desde la caché; `/readyz` da 503 a los ≤30 s, pero no se reinicia
nada (H1). La siguiente escritura reescribe el fichero desde la caché. Si se
reinicia antes, se cae.

### 4. Política de reinicio, healthcheck y SIGTERM

HECHO (`docker inspect`): `RestartPolicy=unless-stopped`, `RestartCount=0`,
arrancado el 2026-10-08 07:02:25. Healthcheck `wget --spider
http://127.0.0.1:8787/readyz`, intervalo 30 s, timeout 5 s, 3 reintentos,
`start_period` 10 s; estado `healthy`, `FailingStreak=0`. `/readyz` relee el
disco, descifra todos los grants, códigos, pendientes y la outbox, y llama a
`flushRevocationOutbox` (máximo 1 elemento, timeout 3 s); el resultado se
cachea 5 s (`oauth.ts:1805-1827`). Caddy responde 404 a `/readyz` en público y
200 a `/healthz`. Un `unhealthy` no tiene ningún efecto: no reinicia, no avisa,
Caddy no lo consulta.

HECHO, SIGTERM: sin manejador en la aplicación (H3); PID 1 sin `init`.
`SigCgt=0x4602` incluye SIGTERM: es el manejador interno de Node, que reenvía la
señal y que, siendo PID 1, se ignora. Medido en el deploy del 2026-10-08:
SIGTERM a las 07:02:15.198, SIGKILL a las 07:02:25.209.

INFERENCIA: durante esos 10 s el proceso viejo sigue vivo y atiende
peticiones. Lo que esté en vuelo al llegar el SIGKILL se corta y el cliente ve
un reset o un 502. Una tool de escritura ya ejecutada en Lumbre puede devolver
error al cliente aunque se haya aplicado.

### 5. Cómo se despliega una versión (`publicar.sh`)

HECHO, pasos: (1) `npm run build` en local; aborta si `dist/` difiere de lo
commiteado (`:58-65`); (2) comprueba `/srv/lumbre-mcp.env` con modo 0600
(`:69-72`); (3) `rsync -az --delete` del árbol de trabajo a `/srv/lumbre-mcp`
(`:80-86`); (4) `docker compose … up -d --build` (`:89`); (5) `docker ps`; el
smoke queda manual (`:92-97`).

Ventana sin servicio (HECHO, journal y log, 2026-10-08): 07:02:14 imagen
construida (antes de parar el contenedor); 07:02:15.198 SIGTERM al viejo, que
sigue vivo; 07:02:25.209 SIGKILL; 07:02:25.382 arranca el nuevo; 07:02:25.884
«escuchando en :8787». Unos 0,7 s sin listener, precedidos de 10 s con el
proceso viejo sirviendo.

Rollback: no automatizado y sin imagen anterior (H4). Para volver atrás: en el
Mac, worktree del SHA anterior y `deploy/publicar.sh` desde él, que recompila
en el servidor (necesita registro npm y `node:22-alpine`). No medido cuánto
tarda. Healthcheck antes de dar por bueno: no se comprueba. Lo desplegado
coincide con HEAD (I3), pero el servidor no guarda qué SHA es.

### 6. Logs: rotación, tamaño y retención

- **`lumbre-mcp` (HECHO):** json-file `max-size 10m`, `max-file 3`. Hoy 238 KB en unas 46 h (2105 líneas `[lumbre-mcp-http]` y 1 `[lumbre-mcp-oauth]`). Retención real: hasta el siguiente deploy (H5).
- **`edge-caddy` (HECHO):** json-file 10m×3. Ficheros de 7,9 MB, 10 MB (4 oct) y 10 MB (26 sep): unas 2 semanas. Para `mcp.lumbre.pro`, acceso y error se descartan a propósito; solo quedan ACME y TLS.
- **Docker:** sin `/etc/docker/daemon.json`; el límite viene de cada compose.
- **dockerd:** al journal, con eventos desde al menos el 20 sep. Retención de journald no medida.

### 7. Dependencias externas al arrancar

HECHO (`oauth.ts:1742-1803`, `http.ts:637-655`):

| Dependencia | ¿Bloquea el arranque? |
| --- | --- |
| `LUMBRE_MCP_BACKCHANNEL_SECRET` | Sí. Si falta, Compose aborta (`compose.yml:30`). Si mide menos de 32 caracteres, `ensureConfigured` lanza (test `oauth.test.ts:972-979`). |
| `LUMBRE_APP_BASE_URL` | Sí, si no es exactamente `https://app.lumbre.pro` (`lumbre-oauth-backchannel.ts:78,88`). Se lanza al construir el servicio, fuera de la promesa: excepción no capturada y reinicio en bucle (INFERENCIA). |
| Volumen `/state` legible y escribible | Sí (preguntas 2 y 3). |
| App Lumbre | No. Solo se le habla si la outbox tiene elementos: 1 elemento, timeout 3 s, error ignorado (`:1659-1670`). El barrido inicial va después del listener. |
| DNS externo | No, salvo esa llamada. Caddy encuentra a `lumbre-mcp` por el DNS interno de Docker. |
| Certificados de Caddy | No afectan al arranque del relé; sin certificado el servicio no es accesible (I5). |
| Registro npm y Docker Hub | Solo en el deploy, no al reiniciar. |

## Procedimiento de recuperación hoy

No hay alertas, así que todo empieza cuando alguien detecta la caída.

### A. El contenedor está parado o reiniciándose en bucle

1. `docker ps -a --filter name=lumbre-mcp --format "{{.Status}}"` y `docker inspect -f "{{.RestartCount}} {{.State.ExitCode}} {{.State.Health.Status}}" lumbre-mcp`.
2. `docker logs --tail 30 lumbre-mcp`. Si aparece «estado OAuth no disponible; listener no iniciado», el problema es la clave, el store o la configuración, y la línea no dice cuál (H2).
3. Distinguir la causa sin ver el contenido: `ls -la` del directorio del volumen (si existe `oauth-store.json` y falta `oauth.key`, es la pregunta 2); longitud del secreto con `awk -F= '/^LUMBRE_MCP_BACKCHANNEL_SECRET=/{print length($2)}' /srv/lumbre-mcp.env`; validez del JSON sin imprimirlo con `node -e 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("json ok")}catch{console.log("json invalido")}' <ruta>` (no verificado que haya `node` en el host; si no, `python3 -c` con el mismo patrón).
4. Si la causa es el secreto o la configuración: corregir `/srv/lumbre-mcp.env` y `cd /srv/lumbre-mcp && docker compose --env-file /srv/lumbre-mcp.env -f deploy/compose.yml up -d`.

### B. La clave o el store no sirven: hay que reautorizar a todos

1. `docker stop lumbre-mcp` (tarda 10 s por H3).
2. Archivar la pareja fuera del volumen: `install -d -m 0700 /root/lumbre-mcp-incidente-$(date -u +%Y%m%dT%H%MZ)` y `mv` de `oauth-store.json` y `oauth.key` desde `/var/lib/docker/volumes/lumbre-mcp_state/_data/lumbre-mcp/`. Las huellas `notes-seen-*` pueden quedarse. Nunca regenerar una clave dejando el store en su sitio (`README-deploy.md:31-38`).
3. `docker start lumbre-mcp`. Crea una clave nueva y arranca con el store vacío (`oauth.ts:2124-2137`, `2223-2231`).
4. Verificar: `docker logs --since 1m lumbre-mcp | grep escuchando`; `docker inspect -f '{{.State.Health.Status}}' lumbre-mcp` → `healthy` en unos 40 s; `curl -s -o /dev/null -w '%{http_code}' https://mcp.lumbre.pro/healthz` → 200; `node scripts/smoke-remote.mjs https://mcp.lumbre.pro/mcp "$LUMBRE_TOKEN"` desde el Mac.
5. Avisar a los usuarios de que vuelvan a conectar el conector. Las conexiones con Bearer heredado siguen funcionando.
6. Credenciales huérfanas en Lumbre: el relé ya no puede revocarlas. No verificado cómo se revocan desde la app ni si caducan solas. Confirmar con la sesión de Lumbre.

Tiempo de manos: unos 5 min, más la reautorización de cada usuario. La detección no tiene cota (H1).

### C. Se pierde el VPS o el disco entero

Hace falta: host nuevo con Docker; la red `edge`; `/srv/edge` reconstruido (el
global `Caddyfile` no está en git; `README-deploy.md:217-235` documenta la
parte del relé) más `conf.d/mcp-lumbre-pro.caddy` del repo;
`/srv/lumbre-mcp.env` con el secreto de Lumbre; `publicar.sh` desde el Mac; DNS
apuntando al host; después, el paso B.5. Depende de la recuperación del propio
Lumbre, fuera de alcance. Sin tiempos medidos.

### D. Una versión nueva está rota

1. `git worktree add --detach ../lumbre-mcp-rollback <sha-anterior>`
2. `(cd ../lumbre-mcp-rollback && npm ci && ./deploy/publicar.sh)`
3. Smoke.
4. Retirar el worktree.

El SHA «anterior» hay que sacarlo de `git log -- dist`, porque el servidor no lo guarda.

## Fuera de alcance / no medido

- Backups del proveedor (snapshots de Hetzner Cloud; el hostname sugiere `hel1`, en la UE): no se ven desde dentro del VPS. No verificado.
- Monitorización externa de `mcp.lumbre.pro`: no aparece en el servidor ni en el repo.
- Cuánto tarda la build de la imagen y si funciona sin red. Cuánto tarda un arranque tras reiniciar el host: no hay reinicios en 41 días de uptime.
- El efecto real de un SIGTERM sobre una petición concreta: no se paró nada; la evidencia es el journal del deploy del 8 oct.
- El número de grants OAuth vivos: haría falta leer el store, y está prohibido. Referencia: 9 ficheros de huella, que incluyen conexiones heredadas y huérfanas.
- Retención de journald; si hay `node` o `python3` en el host.
- Cómo revoca o caduca Lumbre las credenciales del backchannel huérfanas tras un paso B.
- Que el correo de `lumbre-unit-failure@` llegue (hoy ha saltado por `lumbre-backup-blobs`).
- Para la sesión de Lumbre: `lumbre-backup-blobs` ha fallado el 2026-10-10 03:45 por falta de espacio (necesita ~7,20 GiB, hay 4,31 GiB libres); `lumbre-staging-demo-app-1` recibe SIGKILL cada 30 min (I7).

Nota RGPD: el relé guarda lo mínimo (credenciales cifradas y huellas de notas
con ids, fechas y longitudes, sin texto ni el token en el nombre del fichero,
`README-deploy.md:65-69`), y lo borra por revocación o barrido. Parece alojado
en la UE (Helsinki), deducido del hostname, sin comprobar con el proveedor. Si
se añade el backup off-site de H6, debe ir cifrado con una clave distinta, a un
destino en la UE, con retención corta; restaurarlo reintroduce autorizaciones
ya revocadas (`README-deploy.md:113-114`), así que solo sirve para forense o
para revocar credenciales.
