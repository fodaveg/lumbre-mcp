# Deploy del transporte HTTP remoto (M2)

`mcp.lumbre.pro` está **desplegado y verificado** desde el 25 ago 2026. Esto ya
no es un plan: es cómo se opera.

## Cómo está montado

| Pieza | Dónde | Qué |
|---|---|---|
| Servicio | `/srv/lumbre-mcp` del VPS | Copia de este repo + `deploy/compose.yml` |
| Contenedor | `lumbre-mcp` | `node dist/http.js`, escucha en 8787 |
| Borde | `/srv/edge/conf.d/mcp-lumbre-pro.caddy` | Caddy termina TLS y hace proxy |
| Estado | volumen `lumbre-mcp_state` | huella de notas vistas (`notes-seen.json`) |

El contenedor **no publica puertos al host**: Caddy lo alcanza por el DNS de la
red Docker externa `edge` (`lumbre-mcp:8787`), igual que hace con
`lumbre-app:3000`. El único camino de entrada es HTTPS por el borde.

No hay `LUMBRE_TOKEN` en el servidor: es un relé stateless y cada petición trae
el suyo en `Authorization: Bearer`. Sin token, 401.

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

## Smoke test tras cada deploy

`scripts/smoke-remote.mjs` es el guardarraíl del deploy: sin dependencias,
habla Streamable HTTP crudo contra la URL ya desplegada.

```bash
node scripts/smoke-remote.mjs https://mcp.lumbre.pro/mcp "$LUMBRE_TOKEN"
```

Comprueba `initialize` + `tools/list` con token (200, 25 tools, techo de
bytes) y el caso NEGATIVO sin token (401 fail-closed). Un deploy no se da
por bueno solo con el camino feliz en verde: si el caso negativo alguna vez
sale distinto de 401 (por ejemplo 200, o un 500 que delate un fail-open), el
script sale con exit 1 igual que si fallara el camino feliz.

Exit 0 = las 6 comprobaciones en verde. Exit 1 = al menos una en rojo, con
el detalle impreso por comprobación.

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

Claude Code, transporte HTTP con cabecera estática:

```bash
claude mcp add --transport http lumbre https://mcp.lumbre.pro/mcp \
  --header "Authorization: Bearer $LUMBRE_TOKEN"
```

claude.ai (web y móvil) NO acepta cabecera estática salvo que la cuenta tenga
la beta de `static_headers`; sin ella hace falta OAuth 2.1 (tarea M3). El
transporte stdio de siempre sigue funcionando y no se retira.
