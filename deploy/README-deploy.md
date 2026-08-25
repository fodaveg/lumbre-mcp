# Deploy del transporte HTTP remoto (M2)

Notas de despliegue de `src/http.ts` (mcp.lumbre.pro). El DNS de
`mcp.lumbre.pro` ya existe.

Los dos bloques de abajo son DRAFT y se aplican en el repo de la app/edge
(donde vive el resto de la infraestructura de Lumbre), NO en este repo:
aquí solo vive el código del servidor MCP y su Dockerfile.

## Caddy (DRAFT)

```
mcp.lumbre.pro {
	reverse_proxy localhost:8787
}
```

Ajustar el puerto si se cambia `PORT` en el `docker-compose` de abajo. El
servidor no valida TLS ni certificados, eso lo hace Caddy delante.

## docker-compose (DRAFT)

```yaml
services:
  lumbre-mcp-http:
    build: ./lumbre-mcp  # o la imagen ya publicada
    restart: unless-stopped
    ports:
      - "8787:8787"
    environment:
      PORT: "8787"
      LUMBRE_BASE_URL: "https://app.lumbre.pro"
      # NO hay LUMBRE_TOKEN aquí: el servidor es un relé stateless, cada
      # petición trae su propio token en `Authorization: Bearer` — ver el
      # JSDoc de cabecera de `src/http.ts`.
```

## Smoke test tras cada deploy

`scripts/smoke-remote.mjs` es el guardarraíl del deploy: sin dependencias,
habla Streamable HTTP crudo contra la URL ya desplegada.

```
node scripts/smoke-remote.mjs https://mcp.lumbre.pro/mcp <token-de-prueba>
```

Comprueba `initialize` + `tools/list` con token (200, 25 tools, techo de
bytes) y el caso NEGATIVO sin token (401 fail-closed). Un deploy no se da
por bueno solo con el camino feliz en verde: si el caso negativo alguna vez
sale distinto de 401 (por ejemplo 200, o un 500 que delate un fail-open), el
script sale con exit 1 igual que si fallara el camino feliz.

Exit 0 = las 5 comprobaciones en verde. Exit 1 = al menos una en rojo, con
el detalle impreso por comprobación.
