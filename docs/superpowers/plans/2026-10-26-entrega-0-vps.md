# Entrega 0 — Implantação do i7Ai + LiteLLM na VPS do SGDM

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Colocar o i7Ai e o LiteLLM no ar em `https://sgdm.com.br/i7ai`, como pilha Swarm própria ao lado do SGDM, sem alterar nada que já roda, com rollback de um comando.

**Architecture:** Pilha Swarm `i7ai` (postgres pgvector, redis, minio, backend, litellm, frontend) com rede interna própria; `backend`, `litellm` e `frontend` entram também na rede externa `SGDMNET` com aliases fixos. Traefik roteia `Host(sgdm.com.br) && PathPrefix(/i7ai)` para o nginx do frontend, que serve a SPA sob `/i7ai` e repassa `/i7ai/api` ao backend. Imagens no GHCR via GitHub Actions; migrations no entrypoint do backend, como no SGDM.

**Tech Stack:** Docker Swarm + Portainer + Traefik v3 (já na VPS), nginx 1.30, Node 24, Prisma, GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-10-26-central-de-ia-design.md` (§2 decisão 8, §7, §8 entrega 0)

## Global Constraints

- Nenhuma porta nova em `0.0.0.0` (regra de `prefeitura/SGDM/portainer/DEPLOY-VPS-NOVA.md`); só o Traefik publica 80/443.
- Nenhuma pilha existente do SGDM é removida ou recriada; `sgdm-app` só recebe variáveis novas.
- LiteLLM fixado por digest: `ghcr.io/berriai/litellm@sha256:c169fb3adc514fcf210377c203f3de406d54f10bfdacf13948a4a839db9af7de` (1.106.4).
- Limites de memória por serviço: litellm 1200M, backend 768M, postgres 512M, minio 256M, redis 128M, frontend 128M.
- Imagens: `ghcr.io/jeferson-assis/i7ai-backend:main` e `ghcr.io/jeferson-assis/i7ai-frontend:main` (repositório público `JEFERSON-ASSIS/i7ai-prefeituras`).
- Segredos só em `stack.env` na VPS, nunca no Git. Chaves de provedor nunca em banco do i7Ai, log ou auditoria.
- Textos para o usuário e documentação em português; comentários de código em inglês (padrão do repositório).

## Review Focus

1. Usuário abre `https://sgdm.com.br/i7ai` sem sessão no SGDM → tela "Sessão do SGDM indisponível" com botão que leva a `/login`, nunca 404/502. (Task 1: `GET /i7ai/qualquer/rota` → 200 index; Task 6: fumaça.)
2. `https://sgdm.com.br/i7ai/api/health` com backend fora → 502 texto; com backend → JSON `status: ok`. (Task 1.)
3. Migration que falha → backend **não** sobe e o log diz o motivo; o serviço anterior continua (`update_config.order: start-first`). (Task 2: teste do entrypoint; Task 3: `start-first` na pilha.)
4. Reinício do LiteLLM → chaves salvas continuam valendo e os modelos do `config.yaml` continuam listados. (Task 6, fumaça: `docker service update --force i7ai_litellm` e conferir `/v1/models`.)
5. Variável esquecida na pilha → serviço não sobe com "Set X" (`${VAR:?...}`), nunca com valor vazio. (Task 3: teste de `docker stack config` sem `LITELLM_SALT_KEY`.)

---

### Task 1: Frontend servido sob `/i7ai`

**Files:**
- Modify: `nginx.conf`
- Test: `test/nginx-i7ai.test.mjs` (novo; usa Docker local)

**Interfaces:**
- Produces: contêiner `i7ai-frontend` na porta 8080 respondendo em `/i7ai/`, `/i7ai/<rota SPA>`, `/i7ai/assets/*`, `/i7ai/api/*` (proxy para `http://backend:3000/api/*`), `/healthz`; `/` → 404.

- [ ] **Step 1: Escrever o teste**

```js
// test/nginx-i7ai.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'; import { execSync } from 'node:child_process';
const image = 'i7ai-frontend-test';
test('frontend serve sob /i7ai e repassa /i7ai/api ao backend', async t => {
  execSync(`docker build -t ${image} .`, { stdio: 'inherit' });
  const id = execSync(`docker run -d --rm -p 127.0.0.1:18080:8080 ${image}`).toString().trim();
  t.after(() => execSync(`docker rm -f ${id}`));
  await new Promise(r => setTimeout(r, 1500));
  const base = 'http://127.0.0.1:18080';
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const index = await fetch(base + '/i7ai/'); assert.equal(index.status, 200);
  assert.match(await index.text(), /src="\/i7ai\/assets\//);
  assert.equal((await fetch(base + '/i7ai/qualquer/rota')).status, 200);
  assert.equal((await fetch(base + '/i7ai/api/health')).status, 502);
  assert.equal((await fetch(base + '/')).status, 404);
});
```

- [ ] **Step 2: Rodar e ver falhar** — Run: `node --test test/nginx-i7ai.test.mjs` — Expected: FAIL (`/i7ai/` → 404 e `/` → 200 com o nginx atual).

- [ ] **Step 3: Reescrever o bloco `server {}` de `nginx.conf`**

Blocos, nesta ordem: `location = /healthz`; `location ~ ^/i7ai/api(?:/|$)` com `rewrite ^/i7ai(/api.*)$ $1 break;` e `proxy_pass $backend_origin` (mesmos headers e timeouts de hoje); `location ^~ /i7ai/assets/` → `alias /usr/share/nginx/html/assets/` com `Cache-Control: public, max-age=31536000, immutable`; `location = /i7ai` → `return 301 /i7ai/`; `location /i7ai/` → `alias /usr/share/nginx/html/`, `try_files $uri $uri/ /i7ai/index.html`; `location = /i7ai/index.html` com `Cache-Control: no-store`; `location / { return 404; }`. Manter `resolver 127.0.0.11`, `client_max_body_size 52m` e os cabeçalhos de segurança.

- [ ] **Step 4: Rodar e ver passar** — `node --test test/nginx-i7ai.test.mjs` — PASS.

- [ ] **Step 5: Commit** — `git add nginx.conf test/nginx-i7ai.test.mjs && git commit -m "feat(deploy): serve o frontend sob /i7ai com proxy da API"`

---

### Task 2: Entrypoint do backend com migrations e bucket

**Files:**
- Create: `backend/docker-entrypoint.sh`
- Create: `backend/scripts/ensure-bucket.cjs`
- Modify: `backend/Dockerfile`
- Test: `backend/test/docker-entrypoint.test.cjs`

**Interfaces:**
- Produces: imagem do backend que, com `RUN_MIGRATIONS` ausente ou `true`, executa `node node_modules/prisma/build/index.js migrate deploy`, depois `node scripts/ensure-bucket.cjs`, depois o comando (`node dist/main.js`); com `RUN_MIGRATIONS=false`, só o comando. Falha em qualquer etapa → exit ≠ 0 sem iniciar a API.
- `ensure-bucket.cjs`: lê `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`; `HeadBucket` → se 404, `CreateBucket`; exit 0 quando existe ou foi criado, 1 em outro erro.

- [ ] **Step 1: Teste do script com stubs no `PATH`**

```js
// backend/test/docker-entrypoint.test.cjs — cria pasta temporária com `node` stub (shell) que grava os argumentos em um log e
// sai com o código lido de STUB_EXIT_<n>; roda `sh docker-entrypoint.sh node dist/main.js` com PATH=<stubs>:$PATH.
test('roda migrate deploy, bucket e o comando, nesta ordem', ...)      // log === ['node_modules/prisma/build/index.js migrate deploy', 'scripts/ensure-bucket.cjs', 'dist/main.js']
test('RUN_MIGRATIONS=false pula migrations e bucket', ...)             // log === ['dist/main.js']
test('falha na migration aborta sem iniciar a API', ...)               // STUB_EXIT_1=1 → exit 1, log sem 'dist/main.js'
```

- [ ] **Step 2: Rodar e ver falhar** — `cd backend && node --test test/docker-entrypoint.test.cjs` — FAIL (script inexistente).

- [ ] **Step 3: Implementar.** `docker-entrypoint.sh` (`#!/bin/sh`, `set -e`, mesma estrutura de `prefeitura/SGDM/docker/entrypoint-api.sh`). `ensure-bucket.cjs` com o cliente S3 já usado pelo backend (ver `backend/src/knowledge` para o pacote em uso). Dockerfile: o CLI do Prisma precisa sobreviver ao `npm prune --omit=dev` → copiar `node_modules/prisma` e `node_modules/.bin/prisma` do estágio `build` após o prune, ou mover `prisma` para `dependencies` (escolha do implementador; o teste de build confere `node node_modules/prisma/build/index.js --version`). `COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/` + `ENTRYPOINT ["docker-entrypoint.sh"]`, mantendo o `CMD`.

- [ ] **Step 4: Rodar e ver passar** — `node --test test/docker-entrypoint.test.cjs` — PASS; `docker build -t i7ai-backend-test backend && docker run --rm --entrypoint node i7ai-backend-test node_modules/prisma/build/index.js --version` — imprime a versão.

- [ ] **Step 5: Commit** — `git add backend/docker-entrypoint.sh backend/scripts/ensure-bucket.cjs backend/Dockerfile backend/test/docker-entrypoint.test.cjs && git commit -m "feat(deploy): entrypoint do backend aplica migrations e garante o bucket"`

---

### Task 3: Pilha Swarm `portainer/i7ai.stack.yml`

**Files:**
- Create: `portainer/i7ai.stack.yml`
- Create: `portainer/stack.env.example`
- Create: `portainer/litellm-db.sql` (`CREATE DATABASE litellm;`)
- Create: `portainer/README.md` (primeira subida, atualização, rollback — espelha `prefeitura/SGDM/portainer/README.md`)
- Test: `test/stack-config.test.mjs`

**Interfaces:**
- Produces: serviços `postgres`, `redis`, `minio`, `litellm`, `backend`, `frontend`; redes `interna` (driver overlay, `internal: true`) e `SGDMNET` (externa). Aliases em `SGDMNET`: `litellm` (para o SGDM chamar `http://litellm:4000`), `i7ai-backend`. O i7Ai chama o SGDM por `http://sgdm-api:3001/api/v1` (alias do serviço `sgdm-api` da pilha `sgdm-app`).
- Variáveis obrigatórias (`${VAR:?Set VAR}`): `WEB_HOST`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `JWT_SECRET`, `SGDM_JWT_SECRET`, `SGDM_INTEGRATION_KEY`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`.

- [ ] **Step 1: Teste**

```js
// test/stack-config.test.mjs — exporta as variáveis de portainer/stack.env.example e roda `docker stack config -c portainer/i7ai.stack.yml`.
test('a pilha renderiza com o exemplo e não publica portas', ...)   // saída contém 'SGDMNET', 'aliases', 'litellm', 'start-first', 'memory: 1200M'; não contém 'published:'
test('variável obrigatória ausente derruba a renderização', ...)   // sem LITELLM_SALT_KEY → exit ≠ 0 e stderr contém 'LITELLM_SALT_KEY'
```

- [ ] **Step 2: Rodar e ver falhar** — `node --test test/stack-config.test.mjs` — FAIL.

- [ ] **Step 3: Escrever a pilha** (`version: "3.8"`), convertendo `docker-compose.production.yml`: sem `build`, `container_name`, `depends_on.condition`, serviços `migrate`/`bucket-init` (substituídos pelo entrypoint da Task 2); `deploy.resources.limits.memory` do Global Constraints; `deploy.update_config: {order: start-first, failure_action: rollback}` em `backend` e `frontend`; `placement.constraints: [node.role == manager]`; volumes `i7ai_postgres`, `i7ai_redis`, `i7ai_minio`; `configs`: `litellm_config` → `/app/config.yaml` (de `../deploy/litellm/config.yaml`) e `litellm_db` → `/docker-entrypoint-initdb.d/10-litellm.sql` no postgres. `litellm`: imagem por digest, `DATABASE_URL=postgresql://i7ai:${POSTGRES_PASSWORD}@postgres:5432/litellm`, `STORE_MODEL_IN_DB=True`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, redes `interna` + `SGDMNET` (alias `litellm`). `backend`: variáveis de `docker-compose.production.yml` mais `OMNIROUTER_BASE_URL=http://litellm:4000/v1`, `OMNIROUTER_API_KEY=${LITELLM_MASTER_KEY}`, `OMNIROUTER_INTERNAL_HOSTS=litellm`, `SGDM_API_URL=http://sgdm-api:3001/api/v1`, `SGDM_INTERNAL_HOSTS=sgdm-api`, `SGDM_INTEGRATION_KEY`, `TRUST_PROXY=uniquelocal`, `CORS_ORIGINS=https://${WEB_HOST}`. `frontend`: labels Traefik `traefik.enable=true`, `traefik.http.routers.i7ai.rule=Host(\`${WEB_HOST}\`) && PathPrefix(\`/i7ai\`)`, `traefik.http.routers.i7ai.priority=100`, `entrypoints=websecure`, `tls.certresolver=letsencryptresolver`, `traefik.http.services.i7ai.loadbalancer.server.port=8080`, `traefik.docker.network=SGDMNET`. Nenhum `ports:`.

- [ ] **Step 4: Rodar e ver passar** — `node --test test/stack-config.test.mjs` — PASS.

- [ ] **Step 5: Commit** — `git add portainer test/stack-config.test.mjs && git commit -m "feat(deploy): pilha Swarm do i7Ai com LiteLLM na SGDMNET"`

---

### Task 4: GitHub Actions — publicar imagens e implantar

**Files:**
- Create: `.github/workflows/docker-publish.yml` — cópia de `prefeitura/SGDM/.github/workflows/docker-publish.yml` com jobs `build-backend` (context `./backend`, file `backend/Dockerfile`) e `build-frontend` (context `.`, file `Dockerfile`); tags `latest`, `${{ github.sha }}`, `main`; `provenance: false`; sem `build-args`.
- Create: `.github/workflows/deploy-vps.yml` — cópia do SGDM; `STACK_NAME` padrão `i7ai`; `docker service update --image ... --with-registry-auth i7ai_backend` e `i7ai_frontend`.
- Create: `portainer/deploy-vps.sh` — equivalente ao do SGDM com os dois serviços.
- Test: `test/workflows.test.mjs`

- [ ] **Step 1: Teste** — os dois YAML parseiam (usar `yaml` se já estiver em `node_modules`, senão parse mínimo por regex) e contêm `ghcr.io/jeferson-assis/i7ai-backend`, `ghcr.io/jeferson-assis/i7ai-frontend`, `i7ai_backend`, `i7ai_frontend`, `workflows: ['Docker Publish']`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Escrever os workflows e o script.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** — `git add .github portainer/deploy-vps.sh test/workflows.test.mjs && git commit -m "ci: publica imagens no GHCR e implanta na VPS"`

Pós-task (pessoa): cadastrar em Settings › Secrets › Actions de `JEFERSON-ASSIS/i7ai-prefeituras` os mesmos `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (e `VPS_PORT`, se houver) do SGDM.

---

### Task 5: SGDM — variáveis de integração na pilha e na configuração

**Files (repositório `prefeitura/SGDM`):**
- Modify: `apps/api/src/config/configuration.ts` — `litellm: { url: preenchida(process.env.LITELLM_URL), adminKey: preenchida(process.env.LITELLM_ADMIN_KEY) }` (o bloco `i7ai.chaveIntegracao` já existe)
- Modify: `portainer/sgdm-app.stack.yml` e `portainer/COLE-NO-PORTAINER.stack.yml` — em `sgdm-api.environment`: `I7AI_INTEGRACAO_CHAVE: ${I7AI_INTEGRACAO_CHAVE}`, `LITELLM_URL: ${LITELLM_URL}`, `LITELLM_ADMIN_KEY: ${LITELLM_ADMIN_KEY}`
- Modify: `portainer/stack.env.example` e `docs/deploy-portainer.md` — as três variáveis (vazias = integração desligada; o SGDM segue como hoje)
- Test: `apps/api/src/config/__tests__/configuration.spec.ts` (criar): `litellm.url` ausente → `undefined`; `LITELLM_URL=http://litellm:4000` → igual; `i7ai.chaveIntegracao` idem.

- [ ] **Step 1: Teste** — `cd apps/api && npx jest --runInBand src/config` — FAIL.
- [ ] **Step 2: Implementar.**
- [ ] **Step 3: `npx jest --runInBand src/config` — PASS.**
- [ ] **Step 4: Commit no SGDM** — só os arquivos desta task (`git add` explícito; os arquivos da saúde em andamento ficam de fora): `git commit -m "feat(i7ai): variáveis de integração com o LiteLLM e o i7Ai na pilha"`.

---

### Task 6: Roteiro de implantação, fumaça e rollback

**Files:**
- Create: `docs/DEPLOY_VPS.md`
- Modify: `docs/LITELLM.md` — seção "VPS (produção)" passa a apontar para `docs/DEPLOY_VPS.md`.

- [ ] **Step 1: Escrever o roteiro**, com comando e resultado esperado em cada passo:
  1. Antes: `ss -tulpn | grep LISTEN`, `docker service ls`, `free -h` (guardar); fumaça do SGDM: `curl -o /dev/null -w "%{http_code}" https://sgdm.com.br/login` → 200; `https://api.sgdm.com.br/api/v1/auth/me` → 401.
  2. Segredos (`openssl rand -hex 32`): `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MINIO_ROOT_PASSWORD`, `JWT_SECRET`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, `SGDM_INTEGRATION_KEY`; `SGDM_JWT_SECRET` = `JWT_SECRET` da pilha do SGDM; `WEB_HOST=sgdm.com.br`.
  3. Portainer → Stacks → Add stack `i7ai` (Web editor: `portainer/i7ai.stack.yml`; variáveis de `stack.env`).
  4. Verificar: `docker service ls` (6 serviços 1/1); `docker service logs i7ai_backend 2>&1 | grep -i migrat`; `curl https://sgdm.com.br/i7ai/api/health` → `"status":"ok"`; `curl -o /dev/null -w "%{http_code}" https://sgdm.com.br/i7ai/` → 200.
  5. Pilha `sgdm-app`: acrescentar `I7AI_INTEGRACAO_CHAVE` (= `SGDM_INTEGRATION_KEY`), `LITELLM_URL=http://litellm:4000`, `LITELLM_ADMIN_KEY` (= `LITELLM_MASTER_KEY`); atualizar a imagem do SGDM (migration `I7AI_*` roda na subida); `docker service logs sgdm-app_sgdm-api 2>&1 | grep -i migrat`.
  6. Entrar no SGDM como dono da plataforma → `Inteligência Artificial › i7Ai` → chat responde (chave em `Cadastros › IA` ou em Modelos).
  7. `docker service update --force i7ai_litellm`; depois `docker exec` no contêiner: `/v1/models` lista os três modelos e `/credentials` mantém as chaves.
  8. `ss -tulpn | grep LISTEN`: nenhuma porta nova em `0.0.0.0`.
  9. Rollback: `docker stack rm i7ai`; remover as três variáveis de `sgdm-app` e atualizar; o SGDM volta ao estado do passo 1 (as permissões `I7AI_*` ficam no banco sem efeito).
- [ ] **Step 2: Conferir o roteiro contra Global Constraints.**
- [ ] **Step 3: Commit** — `git add docs/DEPLOY_VPS.md docs/LITELLM.md && git commit -m "docs: roteiro de implantação na VPS com fumaça e rollback"`.
- [ ] **Step 4 (pessoa + assistente, por SSH):** executar o roteiro e registrar as saídas em `docs/DEPLOY_VPS.md` (seção "Execução de <data>").
