#!/bin/sh
# Atualiza as imagens da stack i7Ai na VPS (após o GitHub Actions publicar no GHCR)
# Uso: sh portainer/deploy-vps.sh
# Requer login GHCR se os pacotes forem privados: echo TOKEN | docker login ghcr.io -u USER --password-stdin

set -e

STACK_NAME="${VPS_STACK_NAME:-i7ai-plataforma}"
BACKEND_IMAGE="${I7AI_BACKEND_IMAGE:-ghcr.io/jeferson-assis/i7ai-backend:main}"
FRONTEND_IMAGE="${I7AI_FRONTEND_IMAGE:-ghcr.io/jeferson-assis/i7ai-frontend:main}"

echo ">> Pull $BACKEND_IMAGE"
docker pull "$BACKEND_IMAGE"

echo ">> Pull $FRONTEND_IMAGE"
docker pull "$FRONTEND_IMAGE"

if docker stack ls --format '{{.Name}}' | grep -qx "$STACK_NAME"; then
  echo ">> Atualizando serviços da stack $STACK_NAME (backend primeiro: aplica as migrations)"
  docker service update --image "$BACKEND_IMAGE" --with-registry-auth "${STACK_NAME}_i7ai-backend"
  docker service update --image "$FRONTEND_IMAGE" --with-registry-auth "${STACK_NAME}_i7ai-frontend"
  echo ">> Concluído."
else
  echo "Stack '$STACK_NAME' não existe."
  echo "Primeira vez: crie a stack no Portainer (portainer/README.md — Fase 1)."
  exit 1
fi
