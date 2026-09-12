#!/usr/bin/env bash
# Туннель с Mac: внешний HTTP/SOCKS → skyputh:11079 → proxy-bridge:11080 → Docker.
# Окно не закрывать. На сервере должен работать: docker compose up -d proxy-bridge
#
# Usage:
#   ./scripts/mac-proxy-tunnel.sh skyputh@77.93.125.36
#   PROXY_UPSTREAM=178.208.87.245:57771 ./scripts/mac-proxy-tunnel.sh skyputh@HOST

set -euo pipefail
REMOTE="${1:?укажите user@host сервера Ogran, напр. skyputh@77.93.125.36}"
UPSTREAM="${PROXY_UPSTREAM:-178.208.87.245:57771}"

echo "SSH -R 127.0.0.1:11079 → ${UPSTREAM}  (через ${REMOTE})"
echo "В UI: http://USER:PASS@host.docker.internal:11080"
echo "Ctrl+C — остановить туннель."
exec ssh -N -R "127.0.0.1:11079:${UPSTREAM}" "${REMOTE}"
