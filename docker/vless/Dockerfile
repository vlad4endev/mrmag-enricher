# Клиент VLESS для сети enricher: наружу — VLESS, внутрь Docker — SOCKS :1080 и HTTP :7890.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine
FROM ${NODE_IMAGE}

ARG XRAY_VERSION=25.3.6
RUN apk add --no-cache ca-certificates curl unzip \
  && curl -fsSL -o /tmp/xray.zip \
    "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip" \
  && unzip -o /tmp/xray.zip xray -d /usr/local/bin \
  && chmod +x /usr/local/bin/xray \
  && rm -f /tmp/xray.zip \
  && xray version

WORKDIR /app
COPY render-config.mjs entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV VLESS_LINK= \
    VLESS_SOCKS_PORT=1080 \
    VLESS_HTTP_PORT=7890 \
    XRAY_LOG_LEVEL=warning

EXPOSE 1080 7890
ENTRYPOINT ["/app/entrypoint.sh"]
