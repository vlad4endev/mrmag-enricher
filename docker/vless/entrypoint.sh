#!/bin/sh
set -eu

if [ -z "${VLESS_LINK:-}" ]; then
  echo "vless-proxy: задайте VLESS_LINK в .env (vless://UUID@host:port?… из панели)."
  echo "vless-proxy: жду ссылку (контейнер жив, прокси не слушает)."
  # Не restart-loop: enricher может работать без прокси (DeepSeek напрямую).
  exec sleep infinity
fi

node /app/render-config.mjs /tmp/xray.json
echo "vless-proxy: Xray → $(node -e 'const u=new URL(process.env.VLESS_LINK); console.log(u.hostname+":"+(u.port||443))')"
exec xray run -c /tmp/xray.json
