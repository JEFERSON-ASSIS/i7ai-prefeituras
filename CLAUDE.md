# i7ai-prefeituras — manual da equipe

Plataforma de IA para prefeituras, módulo do SGDM. Não tem login próprio: a sessão vem do SGDM.

As regras gerais da equipe (branch, PR, deploy só pelo Rafael, segredos) estão no `CLAUDE.md` global e valem aqui.
Este arquivo só diz o que é específico deste projeto.

## Stack

Node 24 · React 19 + Vite · Tailwind + `@sgdm/design` · NestJS 11 + Prisma 6 · PostgreSQL 16 + pgvector · Redis + BullMQ · MinIO.

Front na raiz, back em `backend/`. Migrações em `backend/prisma/migrations/`.

## Rodar local

1. Copie `.env.example` para `.env` e preencha. Nunca use valor de produção em máquina de dev.
2. Suba Postgres, Redis e MinIO; crie o bucket `i7ai-documents`.
3. Backend: `cd backend && npm run prisma:generate && npm run prisma:deploy && npm run prisma:seed`, depois `npm run dev` (porta 3000, prefixo `/api`).
4. Front: `npm run dev` (porta 5173). A prévia sem API fica em `/preview/sgdm.html`.

**Armadilha do lockfile:** `package-lock.json` resolve `@sgdm/design` por `git+ssh://git@github.com/...`. Máquina ou
container sem chave SSH falha no `npm ci`. O CI e o `Dockerfile` contornam com
`git config --global url.https://github.com/.insteadOf ssh://git@github.com/`. Faça o mesmo.

## Testes (o que cada um exige)

| Comando | O que roda | Precisa de |
|---|---|---|
| `npm test` | só o teste de event-stream | nada |
| `npm run audit:design` | **gate obrigatório** (abaixo) | nada |
| `cd backend && npm test` | `node --test backend/test/*.cjs` | nada |
| `cd backend && npm run test:integration` | sobe 3001/3002, cria schema descartável | Postgres, Redis, MinIO |
| `npm run test:visual` | Playwright | Microsoft Edge instalado |

**Como saber que ficou pronto:** `npm test`, `audit:design` e `cd backend && npm test` passando, sem os de integração.
Antes de pedir PR, os três têm de estar verdes.

**Gate `npm run audit:design`:** barra `className` ou `style` em componente do SGDM, tag nativa (`button`, `input`,
`select`, `textarea`, `table`, `fieldset`), token `--sd-*` novo ou sobrescrito, cor hex em CSS e sobrescrita de
`.card`, `.btn-primary`, `.input`, `.nav-item`, `.stat-card`, `.focus-ring`, `.modal`. É o erro mais comum do projeto:
use sempre o componente de `@sgdm/design`.

## Banco

Migração só aditiva, por `prisma migrate deploy` (o container `migrate` já roda antes do backend). Nunca
`migrate reset`. Nunca `prisma:seed` em produção — o próprio script recusa.

## Regras de negócio que um dev quebraria sem aviso

- Toda consulta é escopada por `tenantId`. Sem exceção.
- Agente só responde se estiver `ACTIVE`.
- Streaming nunca grava resposta parcial: grava só no evento `complete`.
- Reserva de tokens é feita com `SELECT ... FOR UPDATE` no tenant. Não invente contador nem recalcule cota.
- Anexo com `chatOnly=true` não entra no RAG nem na lista compartilhada.
- Limites de upload: 50 MB no geral (máximo 100), 20 MB por anexo de chat.
- Office: teto de 64 MB descompactado e recusa de `vbaProject.bin`. PDF: acima de 20 páginas de OCR é recusado.
- `main.ts` usa prefixo global `api` e `ValidationPipe` com `forbidNonWhitelisted`: DTO novo sem decorator devolve 400.
- Em produção o backend roda `read_only`, com `tmpfs`. Gravar arquivo em runtime funciona no local e quebra em produção.

## Sessão e acesso

Sem login próprio. A sessão vem do SGDM por `window.__SGDM_CONTEXT__` ou `sessionStorage`, JWT HS256 com `sub` e
`tenantId` que precisam existir e estar ativos. `SGDM_JWT_ISSUER` e `SGDM_JWT_AUDIENCE` são opcionais.

Perfis (definidos em `backend/scripts/permissions.cjs`):

| Perfil | O que pode |
|---|---|
| ADMIN, SUPER_ADMIN | `*` (o guard não checa mais nada) |
| CONSTRUTOR | tudo, exceto ler users, settings e licensing |
| GESTOR | read + execute |
| USUARIO | read + execute em dashboard, agents, models, conversations; write só em conversations |
| VISUALIZADOR | read |

Catálogo global e atribuição de SUPER_ADMIN exigem SUPER_ADMIN.

## Ferramentas e segredos

Cada ferramenta recebe segredo por `env:TOOL_SECRET_<NOME>`, obrigatório; toda saída passa por redaction. Rede
privada só é liberada com `NODE_ENV != production` **e** `TOOLS_ALLOW_PRIVATE_NETWORK=true`.

## Deploy

Deploy é do Rafael, só com o "confirmo" do dono. O único comando de docker liberado para o dev aqui é
`docker compose ... config --quiet` (validação). Não suba, não construa, não altere produção.

`docker-compose.production.yml` exige `MINIO_IMAGE` e `MINIO_MC_IMAGE`; o front usa a imagem `i7ai-frontend:${I7AI_IMAGE_TAG}`,
sem `build`. Juntar PR na `main` dispara deploy automático.
