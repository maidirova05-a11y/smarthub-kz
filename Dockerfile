# SmartHub в контейнере — запасной вариант на случай, если Vercel или база
# недоступны. Как запускать и восстанавливать данные — BACKUP.md.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Функции (api/, lib/) и сервер, который их вызывает вместо Vercel.
COPY vercel.json ./
COPY api ./api
COPY lib ./lib
COPY docker/serve.mjs ./docker/serve.mjs
# Сам сайт — только это доступно по URL.
COPY *.html robots.txt sitemap.xml site.webmanifest ./public/
COPY en ./public/en
COPY kz ./public/kz
COPY assets ./public/assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/robots.txt').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "docker/serve.mjs"]
