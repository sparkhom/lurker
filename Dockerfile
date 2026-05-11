# Stage 1: Build Vue client
FROM node:lts-alpine AS vue-builder

WORKDIR /app/vue_client

COPY vue_client/package*.json ./
RUN npm install

COPY vue_client/ ./
# Vue and server both import shared/settingsRegistry.js via relative paths,
# so the shared/ tree has to land at /app/shared regardless of which stage
# is doing the work.
COPY shared/ /app/shared/
RUN npm run build

# Stage 2: Install server dependencies (with toolchain for native modules)
FROM node:lts-alpine AS server-deps

WORKDIR /app

# better-sqlite3 builds from source on alpine when no prebuild matches
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --omit=dev

# Stage 3: Runtime image
FROM node:lts-alpine

WORKDIR /app

RUN apk add --no-cache tini

COPY --from=server-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=vue-builder /app/vue_client/dist ./vue_client/dist

RUN mkdir -p /app/data

EXPOSE 8015

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/server.js"]
