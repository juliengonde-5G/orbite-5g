# Orbite 5G — image du serveur (Node 24, aucune dépendance d'exécution).
# Étape 1 : compilation TypeScript et SCSS sur la machine de build (multi-plateforme sans émulation).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json tsconfig.client.json ./
COPY src ./src
RUN npm run build

# Étape 2 : image d'exécution minimale.
FROM node:24-alpine
RUN apk add --no-cache su-exec tzdata
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    ORBITE_DATA_DIR=/data \
    TZ=Europe/Paris
WORKDIR /app
COPY package.json ./
COPY public ./public
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/orbite-entrypoint
RUN chmod 755 /usr/local/bin/orbite-entrypoint && mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3210
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3210/healthz >/dev/null || exit 1
ENTRYPOINT ["orbite-entrypoint"]
CMD ["node", "dist/server/server.js"]
