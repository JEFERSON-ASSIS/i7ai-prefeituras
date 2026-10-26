# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
# Debian/glibc and optional npm binaries support Prisma and PDF parsing.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl libfontconfig1 fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=true

FROM base AS build
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --include=optional --no-audit --no-fund
COPY . .
RUN npm run prisma:generate && npm run build
# The Prisma CLI is a devDependency; keep it (and its engines) across the prune
# so the entrypoint can run `migrate deploy` in the runtime image.
RUN mkdir -p /prisma-cli/@prisma \
 && cp -r node_modules/prisma /prisma-cli/prisma \
 && cp -r node_modules/@prisma/engines /prisma-cli/@prisma/engines \
 && npm prune --omit=dev --include=optional --no-audit --no-fund \
 && rm -rf node_modules/prisma node_modules/@prisma/engines \
 && cp -r /prisma-cli/prisma node_modules/prisma \
 && cp -r /prisma-cli/@prisma/engines node_modules/@prisma/engines

FROM base AS runtime
ENV NODE_ENV=production PORT=3000
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/presets ./presets
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
