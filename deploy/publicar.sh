#!/usr/bin/env bash
# Publica el transporte HTTP remoto (mcp.lumbre.pro) en el VPS.
#
#   ./deploy/publicar.sh
#
# Copia el árbol a /srv/lumbre-mcp por rsync y reconstruye el contenedor. NO
# usa `git pull` en el servidor porque la clave de despliegue que hay allí solo
# da acceso a `fodaveg/lumbre`, no a este repo. Si algún día se le añade una
# clave de despliegue propia a `fodaveg/lumbre-mcp`, este script se cambia por
# un `git -C /srv/lumbre-mcp pull` y el resto sigue igual.
#
# Lo que va al servidor es `dist/` YA COMPILADO (viene versionado en el repo,
# ver la sección "Actualizar sin toolchain" del README): si has tocado `src/`
# y no has recompilado, publicarías la versión vieja sin ningún síntoma. Por
# eso el script recompila y ABORTA si eso deja `dist/` distinto de lo
# commiteado.
set -euo pipefail

HOST="${LUMBRE_MCP_HOST:-lumbre}"
DEST="${LUMBRE_MCP_DEST:-/srv/lumbre-mcp}"

cd "$(dirname "$0")/.."

echo "==> Recompilando dist/ para comprobar que lo commiteado está al día"
npm run build >/dev/null
if ! git diff --quiet -- dist; then
	echo "ERROR: dist/ recompilado NO coincide con lo commiteado." >&2
	echo "       Commitea el dist/ regenerado antes de publicar:" >&2
	git --no-pager diff --stat -- dist >&2
	exit 1
fi

echo "==> Copiando a $HOST:$DEST"
ssh "$HOST" "mkdir -p $DEST"
rsync -az --delete \
	--exclude '.git' \
	--exclude 'node_modules' \
	--exclude '.claude' \
	./ "$HOST:$DEST/"

echo "==> Reconstruyendo y levantando el contenedor"
ssh "$HOST" "cd $DEST && docker compose -f deploy/compose.yml up -d --build"

echo "==> Estado"
ssh "$HOST" "docker ps --filter name=lumbre-mcp --format '{{.Names}}\t{{.Status}}'"

echo
echo "Falta el smoke, que es el guardarraíl del deploy y NO lo corre este"
echo "script (necesita un token real):"
echo "  node scripts/smoke-remote.mjs https://mcp.lumbre.pro/mcp \"\$LUMBRE_TOKEN\""
