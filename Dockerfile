# Зависимостей нет — образ это Node плюс исходники.
FROM node:22-alpine

WORKDIR /app
# Только то, что нужно в рантайме: тесты и кэши в образ не попадают.
COPY package.json ./
COPY lib.js catalog.js server.js enricher_mrmag.js index_final.html ./

# Кэш страниц и выгрузки — на том, иначе перезапуск заставляет обходить раздел заново.
RUN mkdir -p /data/cache /data/out && chown -R node:node /data
ENV PAGE_CACHE_DIR=/data/cache \
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
