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

Cada reemplazo del store solicita `fsync` del temporal antes del `rename` y del
directorio de estado después. Los tests sabotean y verifican ese orden; esto no
equivale a certificar supervivencia a corte eléctrico del volumen o hardware del
VPS. `/readyz` comparte una sola comprobación concurrente, cacheada cinco
segundos, y Caddy la bloquea: solo la consume el healthcheck interno por
`127.0.0.1`.

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

## Publicar una versión nueva

```bash
./deploy/publicar.sh
```

Recompila `dist/`, aborta si lo recompilado no coincide con lo commiteado (es
`dist/` lo que viaja, no `src/`: publicar sin recompilar dejaría la versión
vieja corriendo sin ningún síntoma), copia el árbol por `rsync` y reconstruye
el contenedor.

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
habla Streamable HTTP crudo contra la URL ya desplegada.

```bash
node scripts/smoke-remote.mjs https://mcp.lumbre.pro/mcp "$LUMBRE_TOKEN"
```

Comprueba el descubrimiento OAuth (PRM path-specific + alias y metadata del
authorization server), el challenge exacto del 401, `initialize` +
`tools/list` con token directo en cabecera (200, 20 tools, techo de bytes), y
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
