#!/bin/sh
# Applies pending Prisma migrations and ensures the S3 bucket before starting
# the API. Swarm has no depends_on ordering, so the image does it itself.
# `migrate deploy` only applies versioned migrations and is idempotent.
set -e

if [ "${RUN_MIGRATIONS:-true}" != "true" ]; then
  echo "[entrypoint] RUN_MIGRATIONS=false - pulando migrations e bucket."
else
  echo "[entrypoint] aplicando migrations pendentes..."
  node node_modules/prisma/build/index.js migrate deploy
  echo "[entrypoint] garantindo o bucket..."
  node scripts/ensure-bucket.cjs
fi

echo "[entrypoint] iniciando API..."
exec "$@"
