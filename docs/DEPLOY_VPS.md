# Implantação do i7Ai na VPS do SGDM

Roteiro para subir a pilha `i7ai-plataforma` (i7Ai + LiteLLM) ao lado do SGDM, conferir que tudo funciona (fumaça) e desfazer se for preciso (rollback). Endereço final: `https://sgdm.com.br/i7ai/`.

Referências: [portainer/README.md](../portainer/README.md) (stack), [portainer/stack.env.example](../portainer/stack.env.example) (variáveis), [docs/LITELLM.md](./LITELLM.md) (gateway de IA).

**Convenções**

- **⚠ altera a VPS** marca todo comando ou ação que muda algo no servidor. O que não tem a marca só lê.
- Cada passo traz o **Esperado**. Se o resultado for outro, pare e investigue antes do passo seguinte.
- Nenhum segredo aparece aqui. Onde houver `<...>`, use o valor guardado no gerenciador de senhas.
- Comandos de VPS rodam por SSH no nó `cloud232` (como root ou usuário no grupo `docker`).

---

## 0. Fatos da VPS

| Item | Valor |
|------|-------|
| Swarm | um nó só, `cloud232` (162.141.109.168) |
| Proxy | Traefik v3.5.3, `--providers.swarm=true`; só ele expõe 80/443 |
| Firewall (ufw) | libera só 22, 80 e 443 |
| Rede compartilhada | `SGDMNET` (externa); nela já resolvem `sgdm-api`, `postgres`, `redis`, `minio` |
| Postgres compartilhado | `postgres:14`, stack `postgres`, serviço `postgres_postgres` |
| Banco do SGDM | banco **`postgres`**, usuário `postgres` (não o `sgdm` dos exemplos) |
| Stack do SGDM | `sgdm-app` → serviços `sgdm-app_sgdm-api` e `sgdm-app_sgdm-web`; hosts `sgdm.com.br` e `api.sgdm.com.br` |
| Stack nova | **`i7ai-plataforma`** → `i7ai-plataforma_i7ai-postgres`, `_i7ai-redis`, `_i7ai-minio`, `_litellm`, `_i7ai-backend`, `_i7ai-frontend` |
| Stack que NÃO se mexe | **`i7ai`** — é o site institucional `i7ai.com.br`. Nunca use esse nome nem rode `docker stack rm i7ai`. |
| Backup do SGDM | i7ai-cloud, backup diário do banco do SGDM (usuário `backup_leitura`, só leitura) |

Atalhos usados abaixo (rode no início de cada sessão SSH; só leem):

```bash
PG=$(docker ps -q -f name=postgres_postgres | head -1)                      # Postgres do SGDM
IPG=$(docker ps -q -f name=i7ai-plataforma_i7ai-postgres | head -1)         # Postgres do i7Ai (após o passo 7)
LLM=$(docker ps -q -f name=i7ai-plataforma_litellm | head -1)               # LiteLLM (após o passo 7)
```

O `| head -1` evita pegar dois contêineres durante uma atualização `start-first`. Se a variável sair vazia, o serviço não está rodando.

---

## 1. Liberação do código (antes de qualquer passo na VPS)

A ordem de liberação é 1.1 → 1.4. Os itens 1.1 a 1.3 são feitos agora. O item 1.4 (merge do SGDM) é conferido agora, mas só **executado no passo 5**, depois do backup (passo 3) e do ensaio da migration (passo 4): o merge dispara sozinho o deploy do SGDM, e o entrypoint da API aplica a migration `I7AI_*` direto no banco de produção. Feito antes, o backup e o ensaio não protegeriam nada.

### 1.1 i7Ai: `feat/central-ia` → `main`

Na máquina de desenvolvimento, no repositório `JEFERSON-ASSIS/i7ai-prefeituras`:

```bash
git status --short            # só arquivos fora do escopo (ex.: output/verification/*) podem aparecer; não os inclua
git fetch origin
git log --oneline origin/main..feat/central-ia   # confira a lista; este roteiro (docs/DEPLOY_VPS.md) precisa estar nela
git checkout main && git merge --ff-only feat/central-ia
git push origin main
```

**Esperado:** o merge é fast-forward. Em GitHub → Actions, o workflow **Docker Publish** termina verde e publica `ghcr.io/jeferson-assis/i7ai-backend` e `ghcr.io/jeferson-assis/i7ai-frontend` com as tags `main`, `latest` e o SHA do commit.

### 1.2 Pacotes do GHCR públicos

GitHub → perfil → **Packages** → `i7ai-backend` → Package settings → Change visibility → **Public**. Repita para `i7ai-frontend`. Os pacotes nascem privados.

Alternativa (se ficarem privados): ⚠ **altera a VPS** — `echo <TOKEN_read:packages> | docker login ghcr.io -u JEFERSON-ASSIS --password-stdin` na VPS, ou crie o secret `GHCR_PULL_TOKEN` no repositório (o Deploy VPS faz o login com ele).

**Esperado:** da VPS, `docker manifest inspect ghcr.io/jeferson-assis/i7ai-backend:main >/dev/null && echo ok` imprime `ok` (o mesmo para `i7ai-frontend`).

### 1.3 Secrets do deploy automático

GitHub → `JEFERSON-ASSIS/i7ai-prefeituras` → Settings → Secrets and variables → Actions. Crie `VPS_HOST`, `VPS_USER` e `VPS_SSH_KEY` com **os mesmos valores do repositório do SGDM**. Opcionais: `VPS_PORT` (padrão 22) e `VPS_STACK_NAME` (padrão `i7ai-plataforma`; não crie se for usar o padrão).

**Esperado:** o primeiro **Deploy VPS** (disparado após o Docker Publish do 1.1, ou à mão) **falha** com `Stack i7ai-plataforma não encontrada — crie no Portainer primeiro.` Isso é o esperado: a stack ainda não existe. Ele é rodado de novo no passo 8.

### 1.4 SGDM: `feat/i7ai-integracao` → `main` (conferir agora, executar no passo 5)

O repositório do SGDM tem trabalho em andamento da Saúde **sem commit** (arquivos `saude-*` modificados e a migration não versionada `20261208100000_saude_mensagem_profissional/`). Ele não pode ir para a `main` por engano. Confira, na máquina de desenvolvimento, no repositório `JEFERSON-ASSIS/SGDM`:

```bash
git fetch origin
git log --oneline origin/main..feat/i7ai-integracao
git diff --stat origin/main..feat/i7ai-integracao | grep -i saude
git diff --stat origin/main..feat/i7ai-integracao -- apps/api/prisma/migrations
```

**Esperado:** o `log` mostra só `004138d feat(i7ai): permissões I7AI_*, menu e integração da chave de IA` e `60e00fc feat(i7ai): variáveis de integração com o LiteLLM e o i7Ai na pilha`; o `grep saude` não imprime nada; a única migration é `20261210100000_i7ai_permissoes/migration.sql`. Nunca use `git add -A` nem `git commit -a` nesse repositório.

---

## 2. Antes: retrato da VPS e fumaça do SGDM

Só leitura. Guarde as saídas (cole na seção **Execução** no fim deste arquivo): o passo 12 e o rollback comparam com elas.

```bash
ss -tulpn | grep LISTEN
docker service ls
docker stack ls
free -h
df -h /var/lib/docker
docker service inspect sgdm-app_sgdm-api --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
docker service inspect sgdm-app_sgdm-web --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

**Esperado:** `docker stack ls` lista `sgdm-app`, `postgres`, `i7ai` (site) e as demais stacks, **sem** `i7ai-plataforma`. Em `ss`, as portas abertas em `0.0.0.0`/`[::]` ficam anotadas (o ufw só deixa passar 22, 80 e 443). As duas imagens do SGDM saem como `ghcr.io/jeferson-assis/sgdm-api:main@sha256:...` e `...sgdm-web:main@sha256:...`: **guarde esses digests**, são o alvo do rollback do SGDM.

Fumaça do SGDM:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://sgdm.com.br/login
curl -s -o /dev/null -w "%{http_code}\n" https://api.sgdm.com.br/api/v1/auth/me
```

**Esperado:** `200` e `401`.

---

## 3. Backup novo do banco do SGDM

No i7ai-cloud, rode à mão o backup **"SGDM - banco principal"** e acompanhe até o fim.

**Esperado:** a execução aparece como concluída com sucesso, com data e hora de agora e tamanho maior que zero. Sem backup concluído, **não siga**.

---

## 4. Ensaio da migration `I7AI_*` numa cópia descartável

A migration roda contra uma cópia do banco `postgres` criada no próprio Postgres do SGDM. Os dados não saem do servidor. Antes, confira o espaço:

```bash
docker exec -i $(docker ps -q -f name=postgres_postgres) psql -U postgres -Atc "SELECT pg_size_pretty(pg_database_size('postgres'))"
df -h /var/lib/docker
```

**Esperado:** o espaço livre é pelo menos o dobro do tamanho do banco.

Copie o arquivo da migration da sua máquina para a VPS (do checkout do SGDM na branch `feat/i7ai-integracao`):

```bash
# na sua máquina
scp apps/api/prisma/migrations/20261210100000_i7ai_permissoes/migration.sql <VPS_USER>@162.141.109.168:/root/i7ai_permissoes.sql
```

Na VPS — ⚠ **altera a VPS** (cria e depois apaga o banco `sgdm_teste`; o banco `postgres` só é lido):

```bash
docker exec -i $(docker ps -q -f name=postgres_postgres) psql -U postgres -c 'CREATE DATABASE sgdm_teste'
docker exec -i $(docker ps -q -f name=postgres_postgres) sh -c 'pg_dump -U postgres --no-owner --no-privileges -d postgres | psql -q -U postgres -d sgdm_teste' > /root/sgdm_teste_restore.log 2>&1
grep -c ERROR /root/sgdm_teste_restore.log
```

**Esperado:** `CREATE DATABASE`; o `grep -c` imprime `0`. Se houver erros, leia o log: só são aceitáveis os de extensão ou objeto já existente que não tocam as tabelas `permissoes`, `perfis` e `perfil_permissoes`.

Primeira aplicação:

```bash
docker exec -i $(docker ps -q -f name=postgres_postgres) psql -U postgres -d sgdm_teste -v ON_ERROR_STOP=1 < /root/i7ai_permissoes.sql
```

**Esperado:** `INSERT 0 3` (as três permissões) e `INSERT 0 N`, com N = 3 × número de perfis de sistema (`perfis.sistema = true`: ADMINISTRADOR e DONO_PLATAFORMA). Nenhum `ERROR`.

Segunda aplicação (prova de idempotência):

```bash
docker exec -i $(docker ps -q -f name=postgres_postgres) psql -U postgres -d sgdm_teste -v ON_ERROR_STOP=1 < /root/i7ai_permissoes.sql
```

**Esperado:** `INSERT 0 0` e `INSERT 0 0`.

Limpeza — ⚠ **altera a VPS**:

```bash
docker exec -i $(docker ps -q -f name=postgres_postgres) psql -U postgres -c 'DROP DATABASE sgdm_teste'
rm /root/sgdm_teste_restore.log /root/i7ai_permissoes.sql
docker exec -i $(docker ps -q -f name=postgres_postgres) psql -U postgres -Atc "SELECT datname FROM pg_database WHERE datname = 'sgdm_teste'"
```

**Esperado:** `DROP DATABASE`; a última consulta não imprime nada.

---

## 5. Publicar o SGDM com a integração

Executa o item 1.4 — ⚠ **altera a VPS** (o GitHub Actions do SGDM atualiza `sgdm-app` e a migration roda no banco de produção). Na máquina de desenvolvimento, repositório do SGDM, depois de repetir as conferências do 1.4:

```bash
git push origin feat/i7ai-integracao:main
```

(Ou faça merge de um pull request `feat/i7ai-integracao` → `main` no GitHub. Não faça checkout da `main` com o trabalho da Saúde pendente na árvore.)

**Esperado:** o push é fast-forward; no GitHub do SGDM, **Docker Publish** e depois **Deploy VPS** terminam verdes.

Na VPS:

```bash
docker service ps sgdm-app_sgdm-api --format '{{.Name}} {{.CurrentState}} {{.Error}}' | head -3
docker service logs sgdm-app_sgdm-api --since 30m 2>&1 | grep -i migrat
docker exec -i $PG psql -U postgres -d postgres -Atc "SELECT codigo FROM permissoes WHERE codigo LIKE 'I7AI_%' ORDER BY codigo"
docker exec -i $PG psql -U postgres -d postgres -Atc "SELECT migration_name, finished_at IS NOT NULL FROM _prisma_migrations WHERE migration_name LIKE '%i7ai%'"
curl -s -o /dev/null -w "%{http_code}\n" https://sgdm.com.br/login
curl -s -o /dev/null -w "%{http_code}\n" https://api.sgdm.com.br/api/v1/auth/me
```

**Esperado:** a tarefa mais recente está `Running`; o log mostra `[entrypoint] aplicando migrations pendentes...`, a aplicação de `20261210100000_i7ai_permissoes` e `[entrypoint] migrations em dia.`; a consulta lista `I7AI_ADMINISTRAR`, `I7AI_CONSTRUIR`, `I7AI_USAR`; a migration aparece com `t`; o SGDM responde `200` e `401` como no passo 2. As variáveis `I7AI_INTEGRACAO_CHAVE`, `LITELLM_URL` e `LITELLM_ADMIN_KEY` ainda estão vazias: a integração fica desligada até o passo 9.

---

## 6. Segredos da pilha `i7ai-plataforma`

Parta de [portainer/stack.env.example](../portainer/stack.env.example) e preencha fora do Git (gerenciador de senhas). Gere cada segredo com `openssl rand -hex 32` (só hex: as senhas entram em URLs `postgresql://` e `redis://`).

| Variável | Valor |
|----------|-------|
| `WEB_HOST` | `sgdm.com.br` |
| `I7AI_IMAGE_TAG` | `main` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` |
| `REDIS_PASSWORD` | `openssl rand -hex 32` |
| `MINIO_ROOT_USER` | `i7ai` |
| `MINIO_ROOT_PASSWORD` | `openssl rand -hex 32` |
| `S3_BUCKET` | `i7ai-documents` |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `SGDM_JWT_SECRET` | **o `JWT_SECRET` da stack `sgdm-app`** (Portainer → Stacks → `sgdm-app` → Environment variables) |
| `SGDM_INTEGRATION_KEY` | `openssl rand -hex 32`, gerado **uma vez**; o mesmo valor vai em `I7AI_INTEGRACAO_CHAVE` do `sgdm-app` no passo 9 |
| `LITELLM_MASTER_KEY` | `echo sk-$(openssl rand -hex 32)` (precisa começar com `sk-`); o mesmo valor vai em `LITELLM_ADMIN_KEY` do `sgdm-app` |
| `LITELLM_SALT_KEY` | `openssl rand -hex 32`. **Guarde uma cópia segura e nunca troque** depois de cadastrar chaves de provedor |
| `OMNIROUTER_ALLOWED_PREFIXES` | vazio (padrão do backend) |
| `CHAT_ATTACHMENT_MAX_BYTES` | `20971520` |
| `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL` | vazios (base de conhecimento sem embeddings) |

**Esperado:** nenhuma variável obrigatória vazia nem com o texto de exemplo (`TROQUE_...`, `COPIE_...`).

---

## 7. Criar a stack no Portainer

⚠ **altera a VPS.** Portainer → **Stacks → Add stack**, método **Repository**. O Web editor não serve: a stack lê `deploy/litellm/config.yaml` e `portainer/litellm-db.sql` do repositório como *configs* do Swarm.

| Campo | Valor |
|-------|-------|
| Name | `i7ai-plataforma` |
| Build method | **Repository** |
| Repository URL | `https://github.com/JEFERSON-ASSIS/i7ai-prefeituras` (público; sem autenticação) |
| Repository reference | `refs/heads/main` |
| Compose path | `portainer/i7ai.stack.yml` |
| Environment variables | as do passo 6 (Advanced mode → colar `CHAVE=valor`) |

**Deploy the stack.**

**Esperado:** o Portainer cria a stack sem erro. Uma variável obrigatória esquecida aparece como `Set <VARIÁVEL>` e nada sobe. `docker stack ls` passa a listar `i7ai-plataforma` **e continua listando `i7ai`** (site) intocada.

---

## 8. Conferir a pilha

Na primeira subida o Postgres cria o banco `litellm`; o LiteLLM e o backend podem reiniciar uma vez enquanto ele fica pronto. Aguarde até 3 minutos e defina os atalhos `IPG` e `LLM` do passo 0.

```bash
docker stack services i7ai-plataforma --format '{{.Name}} {{.Replicas}}'
docker service ps i7ai-plataforma_i7ai-backend --format '{{.Name}} {{.CurrentState}} {{.Error}}' | head -3
docker service logs i7ai-plataforma_i7ai-backend 2>&1 | grep -i -E 'migrat|bucket|iniciando'
docker exec -i $IPG psql -U i7ai -d i7ai -Atc "SELECT datname FROM pg_database WHERE datname = 'litellm'"
```

**Esperado:** os seis serviços em `1/1`; a tarefa mais recente do backend `Running`; o log mostra `[entrypoint] aplicando migrations pendentes...`, a saída do Prisma (`All migrations have been successfully applied.` na primeira vez, `No pending migrations to apply.` depois), `[entrypoint] garantindo o bucket...` e `[entrypoint] iniciando API...`; a consulta imprime `litellm`.

Raiz somente leitura com `/tmp` gravável (tmpfs do Swarm). O `touch` cria um arquivo no tmpfs do contêiner, que some quando ele reinicia:

```bash
docker exec $(docker ps -q -f name=i7ai-plataforma_i7ai-frontend | head -1) sh -c 'touch /tmp/x && echo ok'
docker exec $(docker ps -q -f name=i7ai-plataforma_i7ai-backend | head -1) sh -c 'touch /tmp/x && echo ok'
docker exec $(docker ps -q -f name=i7ai-plataforma_i7ai-backend | head -1) sh -c 'touch /app/x'; echo "saida=$?"
```

**Esperado:** `ok`, `ok`; o terceiro falha com `Read-only file system` e `saida=1` (a raiz é `read_only` e o Prisma rodou mesmo assim).

Pelo Traefik:

```bash
curl -s https://sgdm.com.br/i7ai/api/health; echo
curl -s -o /dev/null -w "%{http_code}\n" https://sgdm.com.br/i7ai/
curl -s -o /dev/null -w "%{http_code}\n" https://sgdm.com.br/i7ai
curl -s -o /dev/null -w "%{http_code}\n" https://sgdm.com.br/login
curl -s -o /dev/null -w "%{http_code}\n" https://api.sgdm.com.br/api/v1/auth/me
```

**Esperado:** `{"service":"i7ai-api","status":"ok","dependencies":{"database":true,"queue":true,"storage":true},...}`; `200`; `301` (redireciona para `/i7ai/`); `200` e `401` — o SGDM segue respondendo, a rota nova (`i7ai_plataforma`, prioridade 100) só pega `/i7ai`. Se o health responder `503` com `"status":"degraded"`, o item `false` em `dependencies` diz o que falhou (`database` = Postgres, `queue` = Redis, `storage` = MinIO).

Deploy automático: GitHub → Actions → **Deploy VPS** → Run workflow (branch `main`). ⚠ **altera a VPS** (atualiza backend e frontend).

**Esperado:** verde; o bloco `--- estado final ---` lista os serviços `i7ai-plataforma_*` com `1/1`. Daqui em diante, cada push na `main` do i7Ai publica e implanta sozinho.

---

## 9. Ligar a integração no `sgdm-app`

⚠ **altera a VPS** (reinicia a API do SGDM). Portainer → Stacks → `sgdm-app`:

1. Se a stack for do tipo Web editor, confira que o `environment` do `sgdm-api` tem as três linhas abaixo; se faltarem, cole o `portainer/sgdm-app.stack.yml` atual da `main` do SGDM. O Swarm só repassa ao contêiner as variáveis listadas ali.
   ```yaml
   I7AI_INTEGRACAO_CHAVE: ${I7AI_INTEGRACAO_CHAVE}
   LITELLM_URL: ${LITELLM_URL}
   LITELLM_ADMIN_KEY: ${LITELLM_ADMIN_KEY}
   ```
2. Em Environment variables, defina:
   - `I7AI_INTEGRACAO_CHAVE` = o `SGDM_INTEGRATION_KEY` do passo 6
   - `LITELLM_URL` = `http://litellm:4000`
   - `LITELLM_ADMIN_KEY` = o `LITELLM_MASTER_KEY` do passo 6
3. **Update the stack** (com *Re-pull image*: a imagem `:main` já é a do passo 5).

Conferência (mostra só os nomes, não os valores):

```bash
docker service inspect sgdm-app_sgdm-api --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | grep -oE '^(I7AI_INTEGRACAO_CHAVE|LITELLM_URL|LITELLM_ADMIN_KEY)=.' | cut -d= -f1
docker service ps sgdm-app_sgdm-api --format '{{.Name}} {{.CurrentState}}' | head -2
docker service logs sgdm-app_sgdm-api --since 10m 2>&1 | grep -i migrat
curl -s -o /dev/null -w "%{http_code}\n" https://sgdm.com.br/login
curl -s -o /dev/null -w "%{http_code}\n" https://api.sgdm.com.br/api/v1/auth/me
```

**Esperado:** os três nomes aparecem (o `=.` garante valor não vazio); a tarefa nova `Running`; o log mostra `[entrypoint] migrations em dia.` (nada pendente — a migration entrou no passo 5); `200` e `401`.

---

## 10. Primeiro acesso e conversa

1. Entre no SGDM (`https://sgdm.com.br/login`) como **dono da plataforma** (perfil com `PLATAFORMA_ADMINISTRAR`, que no i7Ai vira `SUPER_ADMIN`).
2. Menu **Inteligência Artificial › i7Ai**. **Esperado:** abre `https://sgdm.com.br/i7ai/` em outra aba, já logado; a prefeitura e o usuário são criados no i7Ai nesse primeiro acesso.
3. **Chaves de IA.** Cada chave fica num lugar:
   - **Chaves da plataforma** (valem para todas as prefeituras): cadastradas pelo `SUPER_ADMIN` no i7Ai, em **Modelos › Chaves dos provedores de IA** (só ele vê a seção). Cadastre a da OpenAI e/ou da Anthropic e clique em **Testar**. ⚠ **altera a VPS** (grava a chave cifrada no banco `litellm`).
   - **Chave da prefeitura** (cobrança direta da prefeitura): fica no SGDM, em **Cadastros › Inteligência Artificial** (`/cadastros/ia`, permissão `IA_CONFIGURAR`; a mensagem de erro do i7Ai a chama de "Cadastros › IA"). O i7Ai a busca pela integração.

   **Esperado:** **Testar** mostra a resposta do provedor; a tela exibe a chave mascarada (ex.: `sk****88`).
4. **Catálogo e agente.** Uma prefeitura nova não tem modelos nem agentes. Cadastre-os em **Modelos** e **Agentes**, ou pelo script, que lê `/v1/models` do LiteLLM (⚠ **altera a VPS** só com `--apply`):
   ```bash
   docker exec -i $IPG psql -U i7ai -d i7ai -c 'SELECT t.id AS tenant, t.name, u.id AS usuario, u.email FROM tenants t JOIN users u ON u."tenantId" = t.id'
   docker exec $(docker ps -q -f name=i7ai-plataforma_i7ai-backend | head -1) node scripts/configure-omniroute.cjs --models=openai/gpt-4o-mini,anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5-5 --tenant=<UUID> --user=<UUID>
   # confira a saída (mode "review") e repita com --apply
   ```
   **Esperado:** a revisão lista os três modelos; com `--apply`, imprime `configuredModels` e o agente `Assistente da Prefeitura`. Depois ajuste os preços (USD por milhão de tokens) em **Modelos**.
5. **Chat.** Abra o agente e envie uma pergunta curta. **Esperado:** a resposta chega. Sem chave válida, a mensagem é *"A chave do provedor de IA não está cadastrada ou foi recusada. Cadastre a chave da prefeitura no SGDM (Cadastros › IA) ou a chave da plataforma em Modelos › Chaves dos provedores de IA."*

---

## 11. O LiteLLM mantém as chaves após reiniciar

⚠ **altera a VPS** (reinicia o LiteLLM; o chat fica indisponível por até ~90 s):

```bash
docker service update --force i7ai-plataforma_litellm
LLM=$(docker ps -q -f name=i7ai-plataforma_litellm | head -1)
docker exec $LLM python -c "import json,os,urllib.request as u; r=u.Request('http://127.0.0.1:4000/v1/models',headers={'Authorization':'Bearer '+os.environ['LITELLM_MASTER_KEY']}); print(sorted(m['id'] for m in json.load(u.urlopen(r))['data']))"
docker exec $LLM python -c "import json,os,urllib.request as u; r=u.Request('http://127.0.0.1:4000/credentials',headers={'Authorization':'Bearer '+os.environ['LITELLM_MASTER_KEY']}); print(sorted(c['credential_name'] for c in json.load(u.urlopen(r)).get('credentials',[])))"
```

A imagem do LiteLLM não traz `curl`; o Python é o mesmo do healthcheck. Só os nomes das credenciais são impressos, nunca os valores.

**Esperado:** o serviço volta a `1/1`; a lista de modelos **contém** `openai/gpt-4o-mini`, `anthropic/claude-haiku-5-5` e `anthropic/claude-sonnet-5-5` (os curingas `openai/*`, `anthropic/*`, `gemini/*` também podem aparecer); a lista de credenciais mantém os provedores cadastrados no passo 10 (ex.: `['anthropic', 'openai']`). Uma nova conversa no i7Ai responde.

---

## 12. Nenhuma porta nova

```bash
ss -tulpn | grep LISTEN
free -h
```

**Esperado:** comparado ao passo 2, nenhuma porta nova em `0.0.0.0` ou `[::]` (a pilha não publica portas; só o Traefik expõe 80/443). A memória livre caiu no máximo uns 3 GB (limites: Postgres 512M, Redis 128M, MinIO 256M, LiteLLM 1200M, backend 768M, frontend 128M). Opcional, da sua máquina: `nmap -Pn -p 4000,5432,6379,9000,9001 162.141.109.168` → todas `filtered` ou `closed`.

---

## 13. Rollback

### Voltar só a última versão do i7Ai

⚠ **altera a VPS:** `docker service rollback i7ai-plataforma_i7ai-backend` (e/ou `i7ai-plataforma_i7ai-frontend`). **Esperado:** o serviço volta à imagem anterior e fica `1/1`.

### Tirar o i7Ai do ar

⚠ **altera a VPS:**

```bash
docker stack rm i7ai-plataforma          # NUNCA "docker stack rm i7ai": isso derruba o site i7ai.com.br
docker stack ls
docker volume ls | grep i7ai-plataforma
```

**Esperado:** `i7ai-plataforma` some da lista (`i7ai`, `sgdm-app` e `postgres` continuam); os volumes `i7ai-plataforma_i7ai_postgres`, `i7ai-plataforma_i7ai_redis` e `i7ai-plataforma_i7ai_minio` **continuam existindo** — `docker stack rm` remove serviços, não dados. Um novo deploy da stack (passo 7) volta com os mesmos dados e chaves. Os volumes só são apagados de propósito, com `docker volume rm <nome>`, depois de decidir que os dados do i7Ai não serão mais usados.

### Desligar a integração no SGDM

⚠ **altera a VPS:** Portainer → Stacks → `sgdm-app` → remova os valores de `I7AI_INTEGRACAO_CHAVE`, `LITELLM_URL` e `LITELLM_ADMIN_KEY` (vazias = integração desligada) → **Update the stack**.

Se for preciso voltar também a imagem do SGDM à anterior ao passo 5, defina `SGDM_API_IMAGE` e `SGDM_WEB_IMAGE` com os digests guardados no passo 2 (`ghcr.io/jeferson-assis/sgdm-api:main@sha256:...`) e atualize a stack. Não use `docker service rollback` para isso: ele só desfaz a última mudança do serviço, que pode ser a das variáveis. Lembre que o próximo push na `main` do SGDM volta a implantar a imagem nova.

**Esperado:** `https://sgdm.com.br/login` → `200`, `https://api.sgdm.com.br/api/v1/auth/me` → `401`, e `docker service ls` igual ao do passo 2. As permissões `I7AI_USAR`, `I7AI_CONSTRUIR` e `I7AI_ADMINISTRAR` **continuam no banco do SGDM, sem efeito** (a migration não muda tabelas e nada as usa sem o i7Ai). Elas não são removidas.

---

## Execução de <data>

(Preenchido durante a implantação: saídas de cada passo, digests guardados no passo 2 e desvios do roteiro.)
