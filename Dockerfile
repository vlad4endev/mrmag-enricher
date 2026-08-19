# Зависимостей нет — образ это Node плюс исходники.
FROM node:24-alpine

WORKDIR /app
# Только то, что нужно в рантайме: тесты и кэши в образ не попадают.
COPY package.json ./
# Перечислять файлы поимённо оказалось ловушкой: добавленный в репозиторий
# socks.js в список не попал, и контейнер ушёл в рестарт-цикл на оборванном
# импорте. Берём всё, а лишнее отсекает .dockerignore (тесты, кэши, выгрузки).
# smoke.mjs внутри образа намеренно: проверять сервис надо там, где он
# работает, а node на хосте может отсутствовать.
COPY *.js *.mjs *.html ./

# Оборванный импорт должен падать на сборке, а не в рестарт-цикле на проде.
RUN node -e "Promise.all([import('./lib.js'),import('./catalog.js'),import('./socks.js')]).then(()=>console.log('импорты на месте'))"

# Кэш страниц и выгрузки — на том, иначе перезапуск заставляет обходить раздел заново.
# Там же фоновые прогоны: перезапуск контейнера обязан их доводить, а не терять
# оплаченные товары.
RUN mkdir -p /data/cache /data/out /data/jobs && chown -R node:node /data
# Встроенная поддержка HTTPS_PROXY в fetch — появилась в Node 24. Нужна там,
# где до openrouter.ai не достучаться напрямую: сам прокси задаётся в .env.
ENV NODE_USE_ENV_PROXY=1 \
    PAGE_CACHE_DIR=/data/cache \
    OUT_DIR=/data/out \
    JOBS_DIR=/data/jobs \
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
