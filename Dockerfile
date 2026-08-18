# Зависимостей нет — образ это Node плюс исходники.
FROM node:24-alpine

WORKDIR /app
# Только то, что нужно в рантайме: тесты и кэши в образ не попадают.
COPY package.json ./
# smoke.mjs — внутрь образа намеренно: после обновления проверять сервис надо
# там, где он работает, а node на хосте может отсутствовать.
COPY lib.js catalog.js server.js enricher_mrmag.js index_final.html smoke.mjs ./

# Кэш страниц и выгрузки — на том, иначе перезапуск заставляет обходить раздел заново.
RUN mkdir -p /data/cache /data/out && chown -R node:node /data
# Встроенная поддержка HTTPS_PROXY в fetch — появилась в Node 24. Нужна там,
# где до openrouter.ai не достучаться напрямую: сам прокси задаётся в .env.
ENV NODE_USE_ENV_PROXY=1 \
    PAGE_CACHE_DIR=/data/cache \
    OUT_DIR=/data/out \
    HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

USER node
EXPOSE 3000

# healthz отвечает без аутентификации — именно для этой пробы.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Через exec-форму: иначе SIGTERM уйдёт shell, а не node, и graceful shutdown не сработает.
CMD ["node", "server.js"]
