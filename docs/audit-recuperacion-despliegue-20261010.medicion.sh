#!/usr/bin/env bash
# Medición de solo lectura del despliegue de lumbre-mcp (audit 2026-10-10).
# No imprime secretos: ni valores de entorno ni contenido de oauth.key / oauth-store.json.
# Uso: medicion.sh [alias-ssh] [ruta-repo]
set -euo pipefail
HOST="${1:-lumbre}"
REPO="${2:-$HOME/code/lumbre-mcp}"

git -C "$REPO" fetch -q && git -C "$REPO" rev-parse HEAD origin/main

ssh -o BatchMode=yes "$HOST" bash -s <<'EOF'
set -u
date -u +%FT%TZ; hostname; uptime
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
df -h /
docker system df
docker inspect lumbre-mcp --format 'Created={{.Created}} StartedAt={{.State.StartedAt}} RestartCount={{.RestartCount}}
Health={{.State.Health.Status}} FailingStreak={{.State.Health.FailingStreak}} OOMKilled={{.State.OOMKilled}}
Restart={{json .HostConfig.RestartPolicy}} Memory={{.HostConfig.Memory}} PidsLimit={{json .HostConfig.PidsLimit}} User={{json .Config.User}}
Healthcheck={{json .Config.Healthcheck}}
LogConfig={{json .HostConfig.LogConfig}}
Mounts={{json .Mounts}}
EnvNames={{range .Config.Env}}{{index (split . "=") 0}} {{end}}'
docker inspect lumbre-mcp | grep -E '"(StopSignal|StopTimeout|Init)"' || echo "sin StopSignal/StopTimeout/Init"
P=$(docker inspect -f '{{.State.Pid}}' lumbre-mcp)
grep -E '^(NSpid|Uid|SigIgn|SigCgt|VmRSS)' /proc/$P/status
V=/var/lib/docker/volumes/lumbre-mcp_state/_data/lumbre-mcp
ls -la --time-style=+%FT%T "$V" | awk '{print $1, $3, $4, $5, $6, $7}'
find "$V" -name '*.tmp' | wc -l
L=$(docker inspect -f '{{.LogPath}}' lumbre-mcp); ls -la "$(dirname "$L")" | grep json
docker logs --timestamps lumbre-mcp 2>&1 | grep -E 'escuchando|listener no iniciado' | head -3
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}' | grep lumbre-mcp
docker images -f dangling=true -q | wc -l
(cd /srv/lumbre-mcp && find dist -type f -name '*.js' | sort | xargs sha256sum | sha256sum)
crontab -l 2>&1 | grep -v '^#' || true
systemctl list-timers --all --no-pager
grep -rlsE 'lumbre-mcp_state|oauth-store|oauth\.key' /etc/systemd /etc/cron* /root/lumbre/scripts || echo "sin backup del estado MCP"
docker info --format 'LiveRestore={{.LiveRestoreEnabled}}'
docker logs edge-caddy --since 72h 2>&1 | grep 'mcp.lumbre.pro' | grep -cE '/mcp/[0-9a-f]{32}' || true
grep -nE 'mcp_errores|http.log.error.mcp' /srv/edge/Caddyfile
sha256sum /srv/edge/conf.d/mcp-lumbre-pro.caddy
journalctl -u docker --no-pager 2>&1 | grep -iE 'failed to exit within' | tail -5
EOF

( cd "$REPO" && git ls-files dist | grep '\.js$' | sort | xargs sha256sum | sha256sum )
shasum -a 256 "$REPO/deploy/mcp-lumbre-pro.caddy"
echo | openssl s_client -connect mcp.lumbre.pro:443 -servername mcp.lumbre.pro 2>/dev/null | openssl x509 -noout -enddate
curl -s -o /dev/null -w 'healthz=%{http_code}\n' https://mcp.lumbre.pro/healthz
curl -s -o /dev/null -w 'readyz=%{http_code}\n' https://mcp.lumbre.pro/readyz
