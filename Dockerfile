FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build

FROM oven/bun:1.4.4-alpine
USER root
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY <<'EOF' /entrypoint.sh
#!/bin/sh
set -eu
mkdir -p /data
chown bun:bun /data
cd /app
exec su-exec bun:bun bun server/index.ts
EOF
RUN chmod 755 /entrypoint.sh
ENV NODE_ENV=production PORT=3001 HOST=0.0.0.0 HOME=/tmp DB_PATH=/data/quick-market.sqlite
EXPOSE 3001
ENTRYPOINT ["/entrypoint.sh"]
