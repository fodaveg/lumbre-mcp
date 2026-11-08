#!/usr/bin/env bash
# Publica el transporte HTTP remoto (mcp.lumbre.pro) en el server de productos
# POR EL REGISTRO de imágenes del Forgejo propio, con despliegue por huella y
# vuelta atrás. `./deploy/publicar.sh --help` para las opciones.
#
#   ./deploy/publicar.sh                 despliega el HEAD
#   ./deploy/publicar.sh --anterior      vuelve a la imagen anterior
#   ./deploy/publicar.sh --version <sha> despliega la imagen de ese commit
#   ./deploy/publicar.sh --historial     historial de despliegues del server
#
# Deploy normal del HEAD (árbol limpio y HEAD dentro de origin/main):
#   - si `git.dualhand.com/fodaveg/lumbre-mcp:<sha completo>` ya está en el
#     registro para la arquitectura del server, se despliega esa imagen tal cual
#     (sin gate ni build; vale desde Fedora, sin Node);
#   - si no: `dist/` recompilado tiene que coincidir con lo commiteado, gate
#     (`npm test`: typecheck + vitest), `docker buildx build --push` para la
#     arquitectura del server y huella del registro. Registro caído o sin
#     credenciales: para ANTES del gate.
#   - En el server: candado, compose.yml del commit (solo si lee
#     LUMBRE_MCP_IMAGE), `.env` con la imagen por huella, `docker compose pull`
#     de esa huella, `up -d --wait`, y una línea en el historial. El log del
#     contenedor saliente se vuelca a $LUMBRE_MCP_LOG_DIR antes de recrearlo
#     (Docker lo borra con el contenedor).
#   - Después, con LUMBRE_TOKEN en el entorno, corre el smoke remoto.
#
# La mecánica común vive en deploy/lib/deploy-registro.sh (lado local) y
# deploy/lib/remote-release.sh (lado server). Credenciales: `docker login
# git.dualhand.com` con escritura en el Mac o en Fedora; el server, de solo
# lectura (este script no las crea ni las pide).
#
# Variables: SSH_HOST (alias, default `lumbre-arm`), REMOTE_DIR (default
# /srv/lumbre-mcp), LUMBRE_MCP_ENV_FILE (secretos, default /srv/lumbre-mcp.env),
# LUMBRE_MCP_LOG_DIR (default /var/log/lumbre-mcp), DEPLOY_REGISTRY, DOCKER_PLATFORM,
# LUMBRE_MCP_SMOKE_URL (default https://mcp.lumbre.pro/mcp) y LUMBRE_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOY_SERVICE="mcp"             # servicio de deploy/compose.yml
DEPLOY_CONTAINER="lumbre-mcp"    # container_name del compose
DEPLOY_ENV_VAR="LUMBRE_MCP_IMAGE" # DEBE coincidir con image: de deploy/compose.yml
DEPLOY_IMAGE="lumbre-mcp"
DEPLOY_CONTEXT="."
REMOTE_DIR="${REMOTE_DIR:-/srv/lumbre-mcp}"
# Secretos del server: fuera de REMOTE_DIR, 0600. Compose los lee con --env-file.
DEPLOY_SECRETS_ENV="${LUMBRE_MCP_ENV_FILE:-/srv/lumbre-mcp.env}"
DEPLOY_LOG_DIR="${LUMBRE_MCP_LOG_DIR:-/var/log/lumbre-mcp}"
SMOKE_URL="${LUMBRE_MCP_SMOKE_URL:-https://mcp.lumbre.pro/mcp}"

# Rutas del server que viajan por SSH: absolutas y sin caracteres raros.
is_canonical_remote_path() {
  local path="$1"
  [[ "$path" =~ ^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] &&
    [[ "$path" != *"/./"* && "$path" != */. && "$path" != *"/../"* && "$path" != */.. ]]
}

# Alias de `~/.ssh/config` o `usuario@host`; el primer carácter alfanumérico para
# que ssh no lo lea como opción.
is_valid_host() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]]
}

is_valid_smoke_url() {
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9/._-]*$ ]]
}

# shellcheck source=deploy/lib/deploy-registro.sh
source "$(dirname "$0")/lib/deploy-registro.sh"

is_valid_host "$SSH_HOST" || {
  echo "ERROR: SSH_HOST debe ser un alias o usuario@host válido." >&2
  exit 1
}
for p in "$REMOTE_DIR" "$DEPLOY_SECRETS_ENV" "$DEPLOY_LOG_DIR"; do
  is_canonical_remote_path "$p" || {
    echo "ERROR: '$p' debe ser una ruta absoluta canónica simple." >&2
    exit 1
  }
done
is_valid_smoke_url "$SMOKE_URL" || {
  echo "ERROR: LUMBRE_MCP_SMOKE_URL debe ser una URL http(s) simple." >&2
  exit 1
}

# La etiqueta es el sha COMPLETO del commit.
deploy_tag_for_commit() {
  echo "$1"
}

deploy_build_steps() {
  echo "    1/3 npm run build y comprobar que dist/ coincide con lo commiteado"
  echo "    2/3 npm test (typecheck + vitest)"
  echo "    3/3 (el build de la imagen copia dist/ tal cual)"
}

# Solo corre si hay que construir la imagen (no está en el registro). Se llama
# como `deploy_prepare_build || return 1`, y ahí bash NO aplica `set -e`: cada
# paso lleva su `|| return 1`.
deploy_prepare_build() {
  deploy_require_node || return 1
  [ -d node_modules ] || {
    echo "ERROR: falta node_modules (npm ci) para compilar y pasar el gate." >&2
    return 1
  }

  # `dist/` viene versionado y la imagen lo copia SIN compilar: si se tocó src/
  # sin recompilar, se publicaría la versión vieja sin ningún síntoma.
  echo "==> 1/2 Recompilando dist/ para comprobar que lo commiteado está al día…"
  npm run build >/dev/null || return 1
  # `--porcelain` y no `git diff --quiet`: también ve un fichero NUEVO en dist/.
  if [ -n "$(git status --porcelain -- dist)" ]; then
    echo "ERROR: dist/ recompilado NO coincide con lo commiteado. Commitea el dist/ regenerado:" >&2
    git status --short -- dist >&2
    return 1
  fi

  echo "==> 2/2 Gate (npm test: typecheck + vitest)…"
  npm test || {
    echo "ERROR: gate en rojo: no se construye ni se despliega." >&2
    return 1
  }
}

# smoke_after_deploy: con LUMBRE_TOKEN corre el smoke remoto. Sin él, o sin Node
# (Fedora), el deploy queda SIN VERIFICAR y lo dice; no es un fallo del deploy.
smoke_after_deploy() {
  local rollback="./deploy/publicar.sh --anterior"
  if [ -z "${LUMBRE_TOKEN:-}" ] || ! command -v node >/dev/null 2>&1; then
    echo "AVISO: sin LUMBRE_TOKEN o sin Node no hay smoke: el deploy NO está verificado."
    echo "       Verifícalo con: LUMBRE_TOKEN=… node scripts/smoke-remote.mjs $SMOKE_URL"
    return 0
  fi
  # El token se lee del entorno: en la línea de órdenes lo vería cualquiera con `ps`.
  echo "==> Smoke contra $SMOKE_URL"
  node scripts/smoke-remote.mjs "$SMOKE_URL" || {
    echo "ERROR: el smoke ha fallado con la imagen desplegada. Para volver a la anterior:" >&2
    echo "  $rollback" >&2
    return 1
  }
}

deploy_main "./deploy/publicar.sh" "$@" || exit $?

if [ "$DEPLOY_DRY_RUN" = 0 ] && [ "$DEPLOY_MODE" != ayuda ] && [ "$DEPLOY_MODE" != historial ]; then
  smoke_after_deploy || exit 1
  echo
  echo "Para volver a la versión anterior:  ./deploy/publicar.sh --anterior"
fi
