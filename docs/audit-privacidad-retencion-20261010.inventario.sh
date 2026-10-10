#!/usr/bin/env bash
# Inventario reproducible del audit de privacidad de lumbre-mcp. Solo lectura.
# Uso: inventario.sh [ruta-repo] [sha]
set -euo pipefail
REPO="${1:-$HOME/code/lumbre-mcp}"
REV="${2:-3540a7e3b87ea89537841016dc12ec375f1ab84e}"
g() { git -C "$REPO" grep -nE "$1" "$REV" -- "${@:2}" | grep -v '\.test\.ts:' || true; }
echo '== Escrituras a disco (src) =='; g 'writeFile|appendFile|createWriteStream|mkdtemp|open\(' src
echo '== Llamadas a consola (src y dist) =='; g 'console\.(log|warn|error|info|debug)|process\.std(out|err)' src dist
echo '== Peticiones salientes (src) =='; g 'fetch\(|fetchFn\(' src
echo '== Cachés de módulo (src) =='; g '^(const|let) [A-Za-z_]+ = new (Map|Set)' src
echo '== Cabeceras del cliente leídas (src) =='; g 'x-forwarded|user-agent|x-real-ip' src
echo '== Poblado de la caché de tareas (src) =='; g 'taskCache\.(set|setAll)\(' src
echo '== Log del borde =='; git -C "$REPO" show "$REV:deploy/mcp-lumbre-pro.caddy" | grep -nE '^\s*log |output'
echo '== Rotación de logs del contenedor =='; git -C "$REPO" show "$REV:deploy/compose.yml" | grep -nA4 'logging:'
