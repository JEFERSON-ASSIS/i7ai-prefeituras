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
| MinIO compartilhado | stack `minio`, serviço `minio_minio`; o i7Ai usa o bucket `i7ai-documents` e um usuário próprio (passo 6.1) |
| Stack nova | **`i7ai-plataforma`** → `i7ai-plataforma_i7ai-postgres`, `_i7ai-redis`, `_i7ai-redis-cache`, `_litellm`, `_i7ai-backend`, `_i7ai-frontend` |
| Stack que NÃO se mexe | **`i7ai`** — é o site institucional `i7ai.com.br`. Nunca use esse nome nem rode `docker stack rm i7ai`. |
| Backup do SGDM | i7ai-cloud, backup diário do banco do SGDM (usuário `backup_leitura`, só leitura) |

Atalhos usados abaixo (rode no início de cada sessão SSH; só leem):

```bash
PG=$(docker ps -q -f label=com.docker.swarm.service.name=postgres_postgres | head -1)   # Postgres do SGDM
IPG=$(docker ps -q -f label=com.docker.swarm.service.name=i7ai-plataforma_i7ai-postgres | head -1)   # Postgres do i7Ai (após o passo 7)
LLM=$(docker ps -q -f label=com.docker.swarm.service.name=i7ai-plataforma_litellm | head -1)   # LiteLLM (após o passo 7)
```

O filtro pelo rótulo `com.docker.swarm.service.name` (que o Swarm preenche com `<stack>_<serviço>`) casa o nome **exato** do serviço. Não use `-f name=...`: ele casa por trecho do nome e, com várias stacks na VPS, pode pegar o Postgres de outra stack (ex.: `n8n-postgres_postgres...`). O `| head -1` evita pegar dois contêineres durante uma atualização `start-first`. Se a variável sair vazia, o serviço não está rodando.

---

## 1. Liberação do código (antes de qualquer passo na VPS)

A ordem de liberação é 1.1 → 1.4. Os itens 1.1 a 1.3 são feitos agora. O item 1.4 (merge do SGDM) é conferido agora, mas só **executado no passo 5**, depois do backup (passo 3) e do ensaio da migration (passo 4): o merge dispara sozinho o deploy do SGDM, e o entrypoint da API aplica a migration `I7AI_*` direto no banco de produção. Feito antes, o backup e o ensaio não protegeriam nada.

### 1.1 i7Ai: `feat/central-ia` → `main`

Na máquina de desenvolvimento, no repositório `JEFERSON-ASSIS/i7ai-prefeituras`:

```bash
git fetch origin
git merge-base --is-ancestor origin/main feat/central-ia && echo ff-ok
git log --oneline origin/main..feat/central-ia   # confira a lista; este roteiro (docs/DEPLOY_VPS.md) precisa estar nela
git push origin feat/central-ia:main
```

**Esperado:** `ff-ok`; o push é fast-forward (sem checkout: alterações locais fora do escopo, como `output/verification/*`, não entram). Em GitHub → Actions, o workflow **Docker Publish** termina verde e publica `ghcr.io/jeferson-assis/i7ai-backend` e `ghcr.io/jeferson-assis/i7ai-frontend` com as tags `main`, `latest` e o SHA do commit.

### 1.2 Pacotes do GHCR públicos

GitHub → perfil → **Packages** → `i7ai-backend` → Package settings → Change visibility → **Public**. Repita para `i7ai-frontend`. Os pacotes nascem privados.

Os pacotes **precisam ser públicos** (como o repositório): o deploy da stack pelo Portainer puxa as imagens sem credenciais, e um `docker login` na VPS não vale para o deploy Swarm do Portainer.

Alternativa (se ficarem privados): no Portainer, **Registries › Add registry › GitHub/Custom** (`ghcr.io`, usuário `JEFERSON-ASSIS`, token com `read:packages`) e implante a stack com esse registro; para o `docker pull` direto na VPS (e para o Deploy VPS automático), ⚠ **altera a VPS** — `echo <TOKEN_read:packages> | docker login ghcr.io -u JEFERSON-ASSIS --password-stdin`, ou crie o secret `GHCR_PULL_TOKEN` no repositório (o Deploy VPS faz o login com ele).

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
ATD=$(docker service ls --format '{{.Name}}' | grep -E '_sgdm-atendimento$' | head -1); echo "atendimento=$ATD"
[ -n "$ATD" ] && docker service inspect "$ATD" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
docker ps -q -f label=com.docker.swarm.service.name=postgres_postgres | wc -l
docker ps --format '{{.Names}}' -f label=com.docker.swarm.service.name=postgres_postgres
```

**Esperado:** `docker stack ls` lista `sgdm-app`, `postgres`, `i7ai` (site) e as demais stacks, **sem** `i7ai-plataforma`. Em `ss`, as portas abertas em `0.0.0.0`/`[::]` ficam anotadas (o ufw só deixa passar 22, 80 e 443). As duas imagens do SGDM saem como `ghcr.io/jeferson-assis/sgdm-api:main@sha256:...` e `...sgdm-web:main@sha256:...`: **guarde esses digests**, são o alvo do rollback do SGDM. Guarde também o nome e a imagem do serviço `*_sgdm-atendimento` (o Deploy VPS do SGDM também o atualiza); se ele não existir, `atendimento=` sai vazio. A contagem do Postgres compartilhado é **exatamente `1`** e o nome do contêiner começa com `postgres_postgres.`; se sair `0` ou mais de `1`, pare: os comandos dos passos 4 e 5 dependem dessa busca.

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
docker exec -i $(docker ps -q -f label=com.docker.swarm.service.name=postgres_postgres) psql -U postgres -Atc "SELECT pg_size_pretty(pg_database_size('postgres'))"
df -h /var/lib/docker
```

**Esperado:** o espaço livre é pelo menos o dobro do tamanho do banco.

Copie o arquivo da migration da sua máquina para a VPS (do checkout do SGDM na branch `feat/i7ai-integracao`).

⚠ **altera a VPS** (grava um arquivo na pasta do usuário):

```bash
# na sua máquina
scp apps/api/prisma/migrations/20261210100000_i7ai_permissoes/migration.sql <VPS_USER>@162.141.109.168:~/i7ai_permissoes.sql
```

Na VPS — ⚠ **altera a VPS** (cria e depois apaga o banco `sgdm_teste`; o banco `postgres` só é lido):

```bash
docker exec -i $(docker ps -q -f label=com.docker.swarm.service.name=postgres_postgres) psql -U postgres -c 'CREATE DATABASE sgdm_teste'
docker exec -i $(docker ps -q -f label=com.docker.swarm.service.name=postgres_postgres) sh -c 'pg_dump -U postgres --no-owner --no-privileges -d postgres | psql -q -U postgres -d sgdm_teste' > ~/sgdm_teste_restore.log 2>&1
grep -c ERROR ~/sgdm_teste_restore.log
```

**Esperado:** `CREATE DATABASE`; o `grep -c` imprime `0`. Se houver erros, leia o log: só são aceitáveis os de extensão ou objeto já existente que não tocam as tabelas `permissoes`, `perfis` e `perfil_permissoes`.

Primeira aplicação:

```bash
docker exec -i $(docker ps -q -f label=com.docker.swarm.service.name=postgres_postgres) psql -U postgres -d sgdm_teste -v ON_ERROR_STOP=1 < ~/i7ai_permissoes.sql
```

**Esperado:** `INSERT 0 3` (as três permissões) e `INSERT 0 N`, com N = 3 × número de perfis de sistema (`perfis.sistema = true`: ADMINISTRADOR e DONO_PLATAFORMA). Nenhum `ERROR`.

Segunda aplicação (prova de idempotência):

```bash
docker exec -i $(docker ps -q -f label=com.docker.swarm.service.name=postgres_postgres) psql -U postgres -d sgdm_teste -v ON_ERROR_STOP=1 < ~/i7ai_permissoes.sql
```

**Esperado:** `INSERT 0 0` e `INSERT 0 0`.

Limpeza — ⚠ **altera a VPS**:

```bash
docker exec -i $(docker ps -q -f label=com.docker.swarm.service.name=postgres_postgres) psql -U postgres -c 'DROP DATABASE sgdm_teste'
rm ~/sgdm_teste_restore.log ~/i7ai_permissoes.sql
docker exec -i $(docker ps -q -f label=com.docker.swarm.service.name=postgres_postgres) psql -U postgres -Atc "SELECT datname FROM pg_database WHERE datname = 'sgdm_teste'"
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
| `REDIS_CACHE_PASSWORD` | `openssl rand -hex 32`, diferente do `REDIS_PASSWORD` (Redis só do cache exato do LiteLLM) |
| `I7AI_S3_ACCESS_KEY` | `i7ai-app` (usuário do MinIO do SGDM criado no passo 6.1) |
| `I7AI_S3_SECRET_KEY` | `openssl rand -hex 32`; o mesmo valor é usado no passo 6.1 e na stack |
| `S3_BUCKET` | `i7ai-documents` (criado no passo 6.1) |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `SGDM_JWT_SECRET` | **o `JWT_SECRET` da stack `sgdm-app`** (Portainer → Stacks → `sgdm-app` → Environment variables) |
| `SGDM_INTEGRATION_KEY` | `openssl rand -hex 32`, gerado **uma vez**; o mesmo valor vai em `I7AI_INTEGRACAO_CHAVE` do `sgdm-app` no passo 9 |
| `LITELLM_MASTER_KEY` | `echo sk-$(openssl rand -hex 32)` (precisa começar com `sk-`); o mesmo valor vai em `LITELLM_ADMIN_KEY` do `sgdm-app` |
| `LITELLM_SALT_KEY` | `openssl rand -hex 32`. **Guarde uma cópia segura e nunca troque** depois de cadastrar chaves de provedor |
| `OMNIROUTER_ALLOWED_PREFIXES` | vazio (padrão do backend) |
| `CHAT_ATTACHMENT_MAX_BYTES` | `20971520` |
| `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL` | vazios (base de conhecimento sem embeddings) |

**Esperado:** nenhuma variável obrigatória vazia nem com o texto de exemplo (`change-...`).

---

## 6.1 Bucket e usuário do i7Ai no MinIO do SGDM

⚠ **altera a VPS** (cria um bucket, uma política e um usuário no MinIO do SGDM; nenhum bucket existente é tocado). O MinIO deixou de publicar imagens públicas, então a stack do i7Ai **não** sobe MinIO próprio: usa o MinIO que o SGDM já roda (stack `minio`, serviço `minio_minio`, resolvido como `minio:9000` na `SGDMNET`), com o bucket `i7ai-documents` e um usuário que só enxerga esse bucket. O `mc` roda **dentro** do contêiner do MinIO, sem baixar imagem. Faça isto **antes** do passo 7.

Tenha à mão `I7AI_S3_ACCESS_KEY` (`i7ai-app`) e `I7AI_S3_SECRET_KEY` do passo 6. As credenciais raiz do MinIO estão em Portainer → Stacks → `minio` → Environment variables (`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`).

**a. Achar o contêiner e conferir o `mc`** (só lê):

```bash
docker ps -q -f label=com.docker.swarm.service.name=minio_minio | wc -l
M=$(docker ps -q -f label=com.docker.swarm.service.name=minio_minio)
docker exec $M sh -c 'command -v mc && mc --version'
```

**Esperado:** `1` na contagem (se vier `0` ou `2`, **pare**: o MinIO não está como esperado); o caminho do `mc` e sua versão. **Se o `mc` não existir no contêiner, PARE e não continue:** reporte ao responsável pelo deploy; o deploy do i7Ai espera uma solução (não instale nada no MinIO do SGDM por conta própria).

**b. Alias administrativo** (senha lida sem eco, fora do histórico do shell; o `mc` guarda o alias na pasta pessoal do contêiner, por isso ele é removido no item f):

```bash
read -r -p 'MINIO_ROOT_USER: ' RU
read -r -s -p 'MINIO_ROOT_PASSWORD: ' RP; echo
docker exec -e RU="$RU" -e RP="$RP" $M sh -c 'mc alias set local http://127.0.0.1:9000 "$RU" "$RP"'
unset RU RP
```

**Esperado:** ``Added `local` successfully.``

**c. Bucket privado:**

```bash
docker exec $M sh -c 'mc mb --ignore-existing local/i7ai-documents && mc anonymous set none local/i7ai-documents'
```

**Esperado:** ``Bucket created successfully `local/i7ai-documents`.`` (ou nada, se já existia) e a permissão do bucket como `private`.

**d. Política restrita e usuário** (mesma política do bucket-init do `docker-compose.production.yml`, só para este bucket):

```bash
read -r -p 'I7AI_S3_ACCESS_KEY: ' AK
read -r -s -p 'I7AI_S3_SECRET_KEY: ' SK; echo
docker exec $M sh -c 'cat > /tmp/i7ai-app-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket","s3:ListBucketMultipartUploads"],"Resource":["arn:aws:s3:::i7ai-documents"]},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":["arn:aws:s3:::i7ai-documents/*"]}]}
EOF'
docker exec $M mc admin policy create local i7ai-app /tmp/i7ai-app-policy.json
docker exec -e AK="$AK" -e SK="$SK" $M sh -c 'mc admin user add local "$AK" "$SK" && mc admin policy attach local i7ai-app --user "$AK"'
docker exec $M rm -f /tmp/i7ai-app-policy.json
```

**Esperado:** ``Created policy `i7ai-app` ``, ``Added user `i7ai-app` successfully.`` e a política `i7ai-app` anexada ao usuário. O MinIO de 2024 aceita `mc admin policy create/attach` (existem desde 2023). Se algum for "not recognized", use a sintaxe antiga: `mc admin policy add local i7ai-app <arquivo>` e `mc admin policy set local i7ai-app user="$AK"`.

**e. Verificar que o usuário funciona e está confinado:**

```bash
docker exec -e AK="$AK" -e SK="$SK" $M sh -c 'mc alias set i7test http://127.0.0.1:9000 "$AK" "$SK" && mc ls i7test/i7ai-documents; echo "saida_i7ai=$?"; mc ls i7test/sgdm-arquivos; echo "saida_sgdm=$?"'
unset AK SK
```

**Esperado:** o `mc ls` de `i7ai-documents` termina com `saida_i7ai=0` (bucket vazio, sem listagem); o de `sgdm-arquivos` mostra `Access Denied` e `saida_sgdm=1`. Se o segundo listar arquivos, **pare**: a política não está restrita; desfaça com o item g e revise.

**f. Limpar os aliases** (removem a credencial raiz da pasta pessoal do contêiner):

```bash
docker exec $M sh -c 'mc alias rm i7test; mc alias rm local'
```

**Esperado:** ``Removed `i7test` successfully.`` e ``Removed `local` successfully.``

**g. Rollback deste passo** (só se o i7Ai não vai usar o MinIO). Refaça o alias (item b) e rode — ⚠ **altera a VPS**:

```bash
docker exec $M sh -c 'mc admin user remove local i7ai-app; mc admin policy remove local i7ai-app'
# só se o bucket estiver vazio/sem uso (confira com "mc ls local/i7ai-documents"):
docker exec $M mc rb --force local/i7ai-documents
docker exec $M sh -c 'mc alias rm local'
```

Nunca toque em outros buckets do MinIO; o `--force` apaga tudo do bucket indicado.

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
docker exec $(docker ps -q -f label=com.docker.swarm.service.name=i7ai-plataforma_i7ai-frontend | head -1) sh -c 'touch /tmp/x && echo ok'
docker exec $(docker ps -q -f label=com.docker.swarm.service.name=i7ai-plataforma_i7ai-backend | head -1) sh -c 'touch /tmp/x && echo ok'
docker exec $(docker ps -q -f label=com.docker.swarm.service.name=i7ai-plataforma_i7ai-backend | head -1) sh -c 'touch /app/x'; echo "saida=$?"
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

**Esperado:** `{"service":"i7ai-api","status":"ok","dependencies":{"database":true,"queue":true,"storage":true},...}`; `200`; `301` (redireciona para `/i7ai/`); `200` e `401` — o SGDM segue respondendo, a rota nova (`i7ai_plataforma`, prioridade 100) só pega `/i7ai`. Se o health responder `503` com `"status":"degraded"`, o item `false` em `dependencies` diz o que falhou (`database` = Postgres, `queue` = Redis, `storage` = MinIO do SGDM, com o usuário e o bucket do passo 6.1).

Deploy automático: GitHub → Actions → **Deploy VPS** → Run workflow (branch `main`). ⚠ **altera a VPS** (atualiza backend e frontend).

**Esperado:** verde; o bloco `--- estado final ---` lista os serviços `i7ai-plataforma_*` com `1/1`. Daqui em diante, cada push na `main` do i7Ai publica e implanta sozinho.

---

## 9. Ligar a integração no `sgdm-app`

⚠ **altera a VPS** (reinicia a API do SGDM). Portainer → Stacks → `sgdm-app`:

1. Confira o `environment` do `sgdm-api` no Editor da stack. O Swarm só repassa ao contêiner as variáveis listadas ali.
   - Stack do tipo **Repository**: o arquivo da `main` (após o passo 5) já traz as três linhas abaixo; não edite o compose.
   - Stack do tipo **Web editor**: **não cole o arquivo inteiro do repositório** (mudaria tudo o que difere do que está no ar). Compare o conteúdo atual com as três linhas abaixo e, se faltarem, acrescente **só elas** dentro do `environment:` do `sgdm-api`, com a mesma indentação das vizinhas (ex.: logo após `SMTP_FROM`). Nada mais muda no compose.
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
   - **Chaves da plataforma** (valem para todas as prefeituras): cadastradas pelo dono da plataforma no SGDM, em **Central de IA › Modelos e acesso › Chaves da plataforma** (permissão `IA_CENTRAL`). Cadastre a da OpenAI e/ou da Anthropic e clique em **Testar**. A chave segue direto para o LiteLLM e fica cifrada no banco `litellm`; o SGDM e o i7Ai não a gravam. ⚠ **altera a VPS** (grava a chave cifrada no banco `litellm`).
   - **Chave da prefeitura** (cobrança direta da prefeitura): fica no SGDM, em **Cadastros › Inteligência Artificial** (`/cadastros/ia`, permissão `IA_CONFIGURAR`; a mensagem de erro do i7Ai a chama de "Cadastros › IA"). O i7Ai a busca pela integração.

   **Esperado:** **Testar** mostra a resposta do provedor; a tela exibe a chave mascarada (ex.: `sk****88`).
4. **Licença da prefeitura.** Em produção, uma prefeitura sem licença é recusada (*"Prefeitura sem licença ativa"*): sem este passo, criar o agente (passo 5) e o chat (passo 6) falham. O SGDM cria a prefeitura no i7Ai sem licença.
   - **Pela tela** (qualquer prefeitura): no SGDM, **Central de IA › Licenças i7Ai** (permissão `IA_CENTRAL`; o i7Ai não tem mais a tela Licenciamento). Edite a prefeitura, escolha a situação Ativa, a vigência e os limites (usuários, agentes, automações, bases de conhecimento, tokens do mês e armazenamento em GB) e salve; o i7Ai aplica em até `SGDM_LICENSE_SYNC_SECONDS` (60 s). **Importar** copia para o SGDM as licenças que já existem no i7Ai (só cria as que faltam). Licenças não são apagadas: para revogar, suspenda.
   - **Por script** (outra prefeitura, ou se a tela não servir). Liste as prefeituras e os usuários que já entraram (`$IPG` é o contêiner do Postgres do i7Ai, definido nas seções anteriores) e use o `tenant` e o e-mail de um deles (o slug de uma prefeitura vinda do SGDM é `sgdm-<UUID do tenant>`; o e-mail precisa ser de um usuário dessa prefeitura, senão o script cria outro administrador). ⚠ **altera a VPS** (cria a licença só se não houver nenhuma; nunca altera uma existente):
     ```bash
     docker exec -i $IPG psql -U i7ai -d i7ai -c 'SELECT t.id AS tenant, t.name, u.id AS usuario, u.email FROM tenants t JOIN users u ON u."tenantId" = t.id'
     docker exec -e PROVISION_TENANT_NAME='<nome da prefeitura>' -e PROVISION_TENANT_SLUG='sgdm-<UUID_DO_TENANT>' -e PROVISION_ADMIN_EMAIL='<email do usuário>' -e PROVISION_ADMIN_NAME='<nome do usuário>' -e PROVISION_CREATE_LICENSE=true -e PROVISION_MAX_USERS=50 -e PROVISION_MAX_AGENTS=20 -e PROVISION_MAX_AUTOMATIONS=20 -e PROVISION_MAX_KNOWLEDGE_BASES=20 -e PROVISION_MAX_TOKENS=100000000 -e PROVISION_MAX_STORAGE_BYTES=10737418240 $(docker ps -q -f label=com.docker.swarm.service.name=i7ai-plataforma_i7ai-backend | head -1) node scripts/provision.cjs
     ```
   **Esperado:** a aba Licenças i7Ai mostra a licença **Ativa** com os limites; pelo script, a saída JSON traz `"license": true` em `created` e um `licenseId`.
5. **Catálogo e agente.** Os modelos são ativados no SGDM, em **Central de IA › Modelos e acesso** (ativar, escolher o padrão e liberar por prefeitura e por usuário): **ative os modelos na Central antes de criar o agente**. O i7Ai copia o catálogo a cada `MODEL_SYNC_SECONDS` (5 min por padrão); **Modelos** no i7Ai é só consulta e os preços vêm do LiteLLM. Uma prefeitura sem liberação não recebe nenhum modelo no i7Ai (fechado por padrão). Os agentes se criam em **Agentes**, ou pelo script, que **só cria o agente**: ele não cadastra modelos, exige que cada modelo de `--models` já esteja ativo no catálogo sincronizado (senão recusa com *"Ative o modelo na Central de IA (SGDM) primeiro"*) e lê `/v1/models` do LiteLLM (⚠ **altera a VPS** só com `--apply`; o UUID do `tenant` e do `usuario` vêm do `SELECT` do passo 4):
   ```bash
   docker exec $(docker ps -q -f label=com.docker.swarm.service.name=i7ai-plataforma_i7ai-backend | head -1) node scripts/configure-omniroute.cjs --models=openai/gpt-4o-mini,anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5-5 --tenant=<UUID> --user=<UUID>
   # confira a saída (mode "review") e repita com --apply
   ```
   **Esperado:** a revisão lista os três modelos (com o id do catálogo); com `--apply`, imprime `configuredModels` e o agente `Assistente da Prefeitura`. Os preços (USD por milhão de tokens) vêm do LiteLLM; confira em **Modelos** (só consulta). O script não libera modelos: faça a liberação da prefeitura na Central de IA.
   **Ensaio (agentes presos a modelo inativo).** Linhas antigas (provedor `google`, slugs sem prefixo) são adotadas pela sincronização sem trocar o id. Mesmo assim, confira se sobrou algum agente em modelo inativo (ele recebe 403 no chat); o resultado esperado é vazio:
   ```bash
   docker exec -i $IPG psql -U i7ai -d i7ai -c 'SELECT a.id, a.name, m.slug, m.active FROM agents a JOIN agent_models am ON am."agentId" = a.id JOIN ai_models m ON m.id = am."modelId" WHERE m.active = false'
   ```
6. **Chat.** Abra o agente e envie uma pergunta curta. **Esperado:** a resposta chega. Sem chave válida, a mensagem é *"A chave do provedor de IA não está cadastrada ou foi recusada. Cadastre a chave da prefeitura no SGDM (Cadastros › IA) ou a chave da plataforma em Central de IA › Modelos e acesso › Chaves da plataforma, no SGDM."*

---

## 11. O LiteLLM mantém as chaves após reiniciar

⚠ **altera a VPS** (reinicia o LiteLLM; o chat fica indisponível por até ~90 s):

```bash
docker service update --force i7ai-plataforma_litellm
LLM=$(docker ps -q -f label=com.docker.swarm.service.name=i7ai-plataforma_litellm | head -1)
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

**Esperado:** comparado ao passo 2, nenhuma porta nova em `0.0.0.0` ou `[::]` (a pilha não publica portas; só o Traefik expõe 80/443). A memória livre caiu no máximo uns 3 GB (limites: Postgres 512M, Redis 128M, Redis do cache 256M, LiteLLM 1200M, backend 768M, frontend 128M). Opcional, da sua máquina: `nmap -Pn -p 4000,5432,6379,9000,9001 162.141.109.168` → todas `filtered` ou `closed`.

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

**Esperado:** `i7ai-plataforma` some da lista (`i7ai`, `sgdm-app` e `postgres` continuam); os volumes `i7ai-plataforma_i7ai_postgres` e `i7ai-plataforma_i7ai_redis` **continuam existindo** — `docker stack rm` remove serviços, não dados. Os documentos ficam no bucket `i7ai-documents` do MinIO do SGDM, que o `docker stack rm` também não toca (para removê-lo, veja o item g do passo 6.1). Um novo deploy da stack (passo 7) volta com os mesmos dados e chaves. Os volumes só são apagados de propósito, com `docker volume rm <nome>`, depois de decidir que os dados do i7Ai não serão mais usados.

### Desligar a integração no SGDM

⚠ **altera a VPS:** Portainer → Stacks → `sgdm-app` → remova os valores de `I7AI_INTEGRACAO_CHAVE`, `LITELLM_URL` e `LITELLM_ADMIN_KEY` (vazias = integração desligada) → **Update the stack**.

Se for preciso voltar também a imagem do SGDM à anterior ao passo 5, fixe nos serviços os digests guardados no passo 2, como faz o Deploy VPS do SGDM — sem mexer nas variáveis da stack (`SGDM_API_IMAGE`/`SGDM_WEB_IMAGE` ficam como estão). ⚠ **altera a VPS:**

```bash
docker service update --image <imagem do sgdm-api guardada no passo 2> --with-registry-auth sgdm-app_sgdm-api
docker service update --image <imagem do sgdm-web guardada no passo 2> --with-registry-auth sgdm-app_sgdm-web
# só se o atendimento existia no passo 2:
docker service update --image <imagem do atendimento guardada no passo 2> --with-registry-auth <serviço *_sgdm-atendimento do passo 2>
docker service inspect sgdm-app_sgdm-api --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

**Esperado:** cada serviço volta a `1/1` e o `inspect` mostra o digest do passo 2. Não use `docker service rollback` para isso: ele só desfaz a última mudança do serviço, que pode ser a das variáveis. A migration `I7AI_*` não é desfeita (a imagem antiga ignora as permissões). O próximo push na `main` do SGDM, ou um **Update the stack** com *Re-pull image* no Portainer, volta a implantar a imagem `:main` — faça isso só com a correção pronta.

**Esperado:** `https://sgdm.com.br/login` → `200`, `https://api.sgdm.com.br/api/v1/auth/me` → `401`, e `docker service ls` igual ao do passo 2. As permissões `I7AI_USAR`, `I7AI_CONSTRUIR` e `I7AI_ADMINISTRAR` **continuam no banco do SGDM, sem efeito** (a migration não muda tabelas e nada as usa sem o i7Ai). Elas não são removidas.

---

## Execução de <data>

(Preenchido durante a implantação: saídas de cada passo, digests guardados no passo 2 e desvios do roteiro.)
