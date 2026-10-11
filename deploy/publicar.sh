#!/usr/bin/env bash
# Publica el transporte HTTP remoto (mcp.lumbre.pro) en el VPS.
#
#   ./deploy/publicar.sh
#
# Publica un COMMIT, no el árbol de trabajo: aborta si hay cambios sin
# commitear o ficheros sin seguimiento, exporta HEAD con `git archive` y copia
# ese export a /srv/lumbre-mcp por rsync. NO usa `git pull` en el servidor
# porque la clave de despliegue que hay allí solo da acceso a `fodaveg/lumbre`,
# no a este repo. Si algún día se le añade una clave de despliegue propia a
# `fodaveg/lumbre-mcp`, la copia se cambia por un `git -C /srv/lumbre-mcp pull`
# y el resto sigue igual.
#
# Lo que va al servidor es `dist/` YA COMPILADO (viene versionado en el repo,
# ver la sección "Actualizar sin toolchain" del README): si has tocado `src/`
# y no has recompilado, publicarías la versión vieja sin ningún síntoma. Por
# eso el script recompila y ABORTA si eso deja `dist/` distinto de lo
# commiteado.
#
# En el servidor (H4 y H5 de docs/audit-recuperacion-despliegue-20261010.md):
#   1. etiqueta la imagen que corre como `lumbre-mcp:anterior`;
#   2. construye `lumbre-mcp:<sha>` con la etiqueta OCI de la revisión;
#   3. para el contenedor saliente (apagado ordenado) y vuelca su log a
#      $LUMBRE_MCP_LOG_DIR, con las líneas del apagado (Compose lo borra al
#      recrearlo);
#   4. levanta `<sha>` y espera a `healthy` con tope en segundos;
#   5. si llega, la etiqueta también como `latest`; si el `up` falla o no
#      llega, vuelca su log y vuelve a `anterior`, y sale con 1.
# Esa parte corre DESACOPLADA del ssh (`setsid nohup`, con su salida en
# $LUMBRE_MCP_LOG_DIR/deploy-<fecha>-<sha>.log): si el canal se cae a mitad,
# el deploy sigue en el servidor y la vuelta atrás también. Desde aquí solo se
# sigue ese log y se recoge el código de salida que deja.
# Después, si hay `LUMBRE_TOKEN` en el entorno, corre el smoke remoto.
#
# Variables: LUMBRE_MCP_HOST (alias ssh, default `lumbre`), LUMBRE_MCP_DEST
# (default /srv/lumbre-mcp), LUMBRE_MCP_ENV_FILE (default /srv/lumbre-mcp.env),
# LUMBRE_MCP_LOG_DIR (default /var/log/lumbre-mcp), LUMBRE_MCP_HEALTH_TIMEOUT
# (segundos, default 90), LUMBRE_MCP_SMOKE_URL (default
# https://mcp.lumbre.pro/mcp) y LUMBRE_TOKEN (opcional, para el smoke).
set -euo pipefail

HOST="${LUMBRE_MCP_HOST:-lumbre}"
DEST="${LUMBRE_MCP_DEST:-/srv/lumbre-mcp}"
ENV_FILE="${LUMBRE_MCP_ENV_FILE:-/srv/lumbre-mcp.env}"
LOG_DIR="${LUMBRE_MCP_LOG_DIR:-/var/log/lumbre-mcp}"
HEALTH_TIMEOUT="${LUMBRE_MCP_HEALTH_TIMEOUT:-90}"
SMOKE_URL="${LUMBRE_MCP_SMOKE_URL:-https://mcp.lumbre.pro/mcp}"

is_canonical_remote_path() {
	local path="$1"
	[[ "$path" =~ ^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] &&
		[[ "$path" != *"/./"* && "$path" != */. && "$path" != *"/../"* && "$path" != */.. ]]
}

# Alias de `~/.ssh/config` o `usuario@host`: solo letras, dígitos, punto,
# guion, guion bajo y arroba, y el primer carácter alfanumérico (para que no
# empiece por un carácter que `ssh`/`rsync` pudieran interpretar como opción).
is_valid_host() {
	local host="$1"
	[[ "$host" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]]
}

if ! is_valid_host "$HOST"; then
	echo "ERROR: LUMBRE_MCP_HOST debe ser un alias o usuario@host válido." >&2
	exit 1
fi
if ! is_canonical_remote_path "$DEST"; then
	echo "ERROR: LUMBRE_MCP_DEST debe ser una ruta absoluta canónica simple." >&2
	exit 1
fi
if ! is_canonical_remote_path "$ENV_FILE"; then
	echo "ERROR: LUMBRE_MCP_ENV_FILE debe ser una ruta absoluta canónica simple." >&2
	exit 1
fi
if ! is_canonical_remote_path "$LOG_DIR"; then
	echo "ERROR: LUMBRE_MCP_LOG_DIR debe ser una ruta absoluta canónica simple." >&2
	exit 1
fi
case "$ENV_FILE" in
"$DEST" | "$DEST"/*)
	echo "ERROR: LUMBRE_MCP_ENV_FILE debe quedar fuera de LUMBRE_MCP_DEST." >&2
	exit 1
	;;
esac
case "$LOG_DIR" in
"$DEST" | "$DEST"/*)
	# `rsync --delete` lo vaciaría en el siguiente deploy.
	echo "ERROR: LUMBRE_MCP_LOG_DIR debe quedar fuera de LUMBRE_MCP_DEST." >&2
	exit 1
	;;
esac
if ! [[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,3}$ ]]; then
	echo "ERROR: LUMBRE_MCP_HEALTH_TIMEOUT debe ser un número de segundos entre 1 y 9999." >&2
	exit 1
fi
if ! [[ "$SMOKE_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9/._-]*$ ]]; then
	echo "ERROR: LUMBRE_MCP_SMOKE_URL debe ser una URL http(s) simple." >&2
	exit 1
fi

cd "$(dirname "$0")/.."

# Se publica un commit: si el árbol tiene algo que no está en HEAD, lo que
# acabara en el servidor no se podría reconstruir desde git (H12).
if [[ -n "$(git status --porcelain)" ]]; then
	echo "ERROR: el árbol tiene cambios sin commitear o ficheros sin seguimiento." >&2
	echo "       Se publica HEAD tal cual: commitea, aparta o borra esto antes:" >&2
	git status --short >&2
	exit 1
fi

echo "==> Recompilando dist/ para comprobar que lo commiteado está al día"
npm run build >/dev/null
# `--porcelain` y no `git diff --quiet`: también ve un fichero NUEVO en dist/
# que el commit no trae.
if [[ -n "$(git status --porcelain -- dist)" ]]; then
	echo "ERROR: dist/ recompilado NO coincide con lo commiteado." >&2
	echo "       Commitea el dist/ regenerado antes de publicar:" >&2
	git status --short -- dist >&2
	exit 1
fi

SHA="$(git rev-parse HEAD)"
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
	echo "ERROR: no se pudo leer el SHA de HEAD." >&2
	exit 1
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/lumbre-mcp-publicar.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
git archive --format=tar HEAD | tar -x -C "$STAGE"

echo "==> Copiando $SHA a $HOST:$DEST"
echo "==> Validando secreto remoto fuera del árbol sincronizado: $ENV_FILE"
ssh "$HOST" "test -r $ENV_FILE && test \$(stat -c %a $ENV_FILE) = 600" || {
	echo "ERROR: falta $ENV_FILE legible y con permisos 0600 en $HOST." >&2
	exit 1
}
ssh "$HOST" "mkdir -p $DEST"
# Un `.env` local nunca debe viajar al servidor (el repo es público y
# `.env.example` invita a crear uno con una clave de configuración). El
# `--include` va ANTES que el `--exclude` porque rsync evalúa los filtros en
# el orden dado: si `.env*` llegara primero, `.env.example` también caería.
# Ojo: excluir un fichero no lo borra en destino si ya está ahí de una copia
# anterior; hay que retirarlo a mano si alguna vez se copió por error.
#
# `-rlptz` y no `-a`: sin `-o`/`-g`, los ficheros nuevos quedan del usuario
# remoto (root) y no del uid del Mac (`501:staff`, H12). `--chown=root:root`
# haría lo mismo, pero el rsync de macOS (openrsync) no lo admite; el `chown`
# de después cubre los ficheros que ya estaban.
rsync -rlptz --delete \
	--exclude '.DS_Store' \
	--exclude '.git' \
	--exclude 'node_modules' \
	--exclude '.claude' \
	--include '.env.example' \
	--exclude '.env*' \
	"$STAGE/" "$HOST:$DEST/"
# El `.DS_Store` que dejaron copias anteriores no lo borra `--delete` (está
# excluido), así que se retira aquí.
ssh "$HOST" "chown -R 0:0 $DEST && find $DEST -name .DS_Store -type f -delete"

# La parte del servidor se sube a un directorio de trabajo bajo LOG_DIR y se
# lanza desacoplada del ssh: si el canal se cae a mitad, ni un SIGHUP ni un
# EPIPE al escribir la matan, y la vuelta atrás sigue pudiendo ocurrir.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$LOG_DIR/.deploy-$STAMP-${SHA:0:12}"
DEPLOY_LOG="$LOG_DIR/deploy-$STAMP-$SHA.log"
echo "==> Subiendo la parte del servidor a $HOST:$WORK"
ssh "$HOST" "install -d -m 0700 $LOG_DIR $WORK && cat >$WORK/desplegar.sh" <<'REMOTO'
set -euo pipefail
DEST="$1"
ENV_FILE="$2"
SHA="$3"
HEALTH_TIMEOUT="$4"
LOG_DIR="$5"
WORK="$6"
NAME=lumbre-mcp
# El PID para que `publicar.sh` lo siga con `tail --pid`, y el código de
# salida, escrito de forma atómica, para que lo recoja al terminar.
echo "$$" >"$WORK/pid"
# shellcheck disable=SC2329 # la invoca el `trap … EXIT` de abajo
write_code() {
	local code=$?
	echo "$code" >"$WORK/codigo.tmp" && mv "$WORK/codigo.tmp" "$WORK/codigo"
}
trap write_code EXIT
cd "$DEST"
# Los logs de deploy: los 30 más recientes (el de este, el más nuevo, queda).
{ ls -1t "$LOG_DIR"/deploy-*.log 2>/dev/null || true; } | tail -n +31 | while read -r old; do rm -f -- "$old"; done

compose() { docker compose --env-file "$ENV_FILE" -f deploy/compose.yml "$@"; }

revision_of_running() {
	local rev
	rev="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NAME" 2>/dev/null || true)"
	if [[ "$rev" =~ ^[0-9a-f]{40}$ ]]; then echo "$rev"; fi
}

# Docker borra el log json-file al recrear el contenedor: se guarda antes,
# comprimido, con los 30 más recientes (H5).
dump_logs() {
	local label="$1" rev file
	docker inspect "$NAME" >/dev/null 2>&1 || return 0
	rev="$(revision_of_running)"
	install -d -m 0700 "$LOG_DIR"
	file="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$label${rev:+-${rev:0:12}}.log.gz"
	if docker logs --timestamps "$NAME" 2>&1 | gzip >"$file"; then
		chmod 0600 "$file"
		echo "    log del contenedor $label: $file"
	else
		echo "AVISO: no se pudo volcar el log del contenedor $label." >&2
	fi
	{ ls -1t "$LOG_DIR"/*.log.gz 2>/dev/null || true; } | tail -n +31 | while read -r old; do rm -f -- "$old"; done
}

# El tope es en SEGUNDOS reales (`SECONDS`), no en vueltas: cada vuelta hace
# dos `docker inspect`, que en un host cargado no tardan cero.
wait_healthy() {
	local status=desconocido restarts=0 deadline=$((SECONDS + HEALTH_TIMEOUT)) started=$SECONDS
	while ((SECONDS < deadline)); do
		status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sin-healthcheck{{end}}' "$NAME" 2>/dev/null || echo ausente)"
		restarts="$(docker inspect -f '{{.RestartCount}}' "$NAME" 2>/dev/null || echo 0)"
		[[ "$status" == healthy ]] && return 0
		# Un `unhealthy` o un reinicio no se arreglan esperando más.
		if [[ "$status" == unhealthy || "$restarts" != 0 ]]; then break; fi
		sleep 1
	done
	echo "    estado: $status, reinicios: $restarts, tras $((SECONDS - started)) s" >&2
	return 1
}

# Para el contenedor (apagado ordenado, ver `src/http-lifecycle.ts`) ANTES de
# volcar su log: así el volcado lleva también las líneas del apagado.
stop_and_dump() {
	local label="$1"
	docker inspect "$NAME" >/dev/null 2>&1 || return 0
	docker stop -t 15 "$NAME" >/dev/null || echo "AVISO: docker stop del contenedor $label falló." >&2
	dump_logs "$label"
}

docker_ps() {
	docker ps -a --filter "name=$NAME" --format '{{.Names}}\t{{.Status}}\t{{.Image}}' || true
}

PREV_IMAGE="$(docker inspect -f '{{.Image}}' "$NAME" 2>/dev/null || true)"
PREV_REV="$(revision_of_running)"
if [[ -n "$PREV_IMAGE" ]]; then
	docker tag "$PREV_IMAGE" lumbre-mcp:anterior
	echo "==> [servidor] imagen en marcha guardada como lumbre-mcp:anterior (${PREV_REV:-sin revisión})"
fi

echo "==> [servidor] construyendo lumbre-mcp:$SHA"
LUMBRE_MCP_IMAGE_TAG="$SHA" LUMBRE_MCP_REVISION="$SHA" compose build

stop_and_dump saliente

echo "==> [servidor] levantando lumbre-mcp:$SHA"
# `up` y la espera en la misma condición: con `set -e`, un `up` que fallara
# fuera de un `if` mataría el script antes de la vuelta atrás.
if LUMBRE_MCP_IMAGE_TAG="$SHA" compose up -d --no-build && wait_healthy; then
	docker tag "lumbre-mcp:$SHA" lumbre-mcp:latest
	# Solo se conservan la versión nueva, la anterior y las etiquetas fijas:
	# el disco del VPS va justo (H7).
	for tag in $(docker image ls lumbre-mcp --format '{{.Tag}}'); do
		[[ "$tag" =~ ^[0-9a-f]{40}$ ]] || continue
		[[ "$tag" == "$SHA" || "$tag" == "$PREV_REV" ]] && continue
		docker image rm "lumbre-mcp:$tag" >/dev/null || true
	done
	echo "==> [servidor] healthy: lumbre-mcp:$SHA es ahora latest"
	docker_ps
	exit 0
fi

echo "ERROR: lumbre-mcp:$SHA no arrancó o no llegó a healthy en $HEALTH_TIMEOUT s." >&2
# Si el `up` falló a medias puede no haber contenedor; `stop_and_dump` lo
# tolera. El saliente ya está parado y sigue disponible como imagen
# `anterior`.
stop_and_dump fallido
if [[ -n "$PREV_IMAGE" ]]; then
	echo "==> [servidor] volviendo a lumbre-mcp:anterior (${PREV_REV:-sin revisión})" >&2
	if LUMBRE_MCP_IMAGE_TAG=anterior compose up -d --no-build && wait_healthy; then
		echo "    la anterior vuelve a estar healthy; latest no se ha movido" >&2
	else
		echo "    ¡la anterior TAMPOCO llega a healthy! Revisa el log." >&2
	fi
else
	echo "    no había imagen anterior a la que volver" >&2
fi
docker_ps >&2
exit 1
REMOTO

echo "==> Construyendo, levantando y esperando a healthy (tope ${HEALTH_TIMEOUT} s); log en $HOST:$DEPLOY_LOG"
ssh "$HOST" "setsid nohup bash $WORK/desplegar.sh $DEST $ENV_FILE $SHA $HEALTH_TIMEOUT $LOG_DIR $WORK >$DEPLOY_LOG 2>&1 </dev/null &"

# Seguir el log hasta que el proceso remoto termine. Si el ssh se cae, se
# vuelve a enganchar (sin repetir lo ya visto); el deploy no depende de esto.
follow() {
	local from="$1"
	ssh "$HOST" "for i in \$(seq 1 60); do [ -s $WORK/pid ] && break; sleep 1; done; [ -s $WORK/pid ] || exit 3; tail -n $from -F --pid=\$(cat $WORK/pid) $DEPLOY_LOG 2>/dev/null"
}
attempts=0
from='+1'
until follow "$from"; do
	attempts=$((attempts + 1))
	if ((attempts >= 30)); then
		echo "ERROR: no consigo seguir el deploy remoto. Sigue en el servidor; su log: $HOST:$DEPLOY_LOG" >&2
		exit 1
	fi
	from='0'
	sleep 2
done
CODE="$(ssh "$HOST" "cat $WORK/codigo 2>/dev/null" || true)"
if ! [[ "$CODE" =~ ^[0-9]+$ ]]; then
	echo "ERROR: el deploy remoto terminó sin dejar código de salida; mira $HOST:$DEPLOY_LOG" >&2
	exit 1
fi
ssh "$HOST" "rm -rf $WORK" || true
if ((CODE != 0)); then
	echo "ERROR: el deploy remoto salió con $CODE; log completo en $HOST:$DEPLOY_LOG" >&2
	exit "$CODE"
fi

# `latest` también vuelve atrás: si no, un `up -d` a mano resucitaría la rota.
ROLLBACK="ssh $HOST 'cd $DEST && docker tag lumbre-mcp:anterior lumbre-mcp:latest && LUMBRE_MCP_IMAGE_TAG=anterior docker compose --env-file $ENV_FILE -f deploy/compose.yml up -d --no-build'"

echo
if [[ -n "${LUMBRE_TOKEN:-}" ]]; then
	# El token se lee del entorno (`smoke-remote.mjs` lo coge de
	# `LUMBRE_TOKEN`): en la línea de órdenes lo vería cualquiera con `ps`.
	echo "==> Smoke contra $SMOKE_URL"
	if ! node scripts/smoke-remote.mjs "$SMOKE_URL"; then
		echo "ERROR: el smoke ha fallado con $SHA desplegado. Para volver a la anterior:" >&2
		echo "  $ROLLBACK" >&2
		exit 1
	fi
else
	echo "Sin LUMBRE_TOKEN en el entorno: el smoke, que es el guardarraíl del"
	echo "deploy, queda manual:"
	echo "  node scripts/smoke-remote.mjs $SMOKE_URL \"\$LUMBRE_TOKEN\""
fi
echo "Para volver a la versión anterior:"
echo "  $ROLLBACK"
