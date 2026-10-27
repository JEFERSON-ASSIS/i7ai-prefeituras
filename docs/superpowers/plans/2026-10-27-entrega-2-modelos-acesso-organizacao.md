# Entrega 2 — Modelos, acesso e organização

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O dono da plataforma ativa modelos do catálogo do LiteLLM, cadastra as chaves da plataforma e libera modelos por prefeitura e por usuário na Central de IA do SGDM. O i7Ai obedece a essas liberações, lê setores e configurações da prefeitura do SGDM e perde as telas Usuários, Departamentos e Configurações. O cadastro de Modelos do i7Ai vira consulta. As permissões `I7AI_*` saem do pacote do ADMINISTRADOR.

**Architecture:** O SGDM guarda o catálogo ativo (`ia_modelos`), as liberações (`ia_liberacoes`, `ia_liberacoes_usuarios`) e o último teste de cada chave (`ia_chaves_testes`). Ele escreve no LiteLLM com a chave administrativa (`/model/new`, `/model/delete`, `/credentials`) e expõe ao i7Ai três endpoints internos na família `/integracoes/i7ai/*`, com a mesma chave Bearer de hoje: `modelos`, `acesso` e `organizacao`. O i7Ai puxa esses dados e os guarda num cache curto, como já faz com a chave de IA (`TenantAiKeyService`). A partir deles sincroniza `ai_models` (com uma coluna nova, `active`), `departments` (com uma coluna nova, `externalId`) e `tenants.settings`, e recusa no servidor qualquer modelo não liberado. No sentido contrário, o SGDM pergunta ao i7Ai os nomes de agentes e os títulos de conversas por `POST /api/integracoes/sgdm/nomes`, com a mesma chave. Com isso a tela Consumo agrupa por agente e por conversa.

**Tech Stack:**
- i7Ai: NestJS + Prisma + `node:test` no backend; React/Vite + Playwright no frontend.
- SGDM: NestJS + Prisma + Jest na API; Next.js + React Query + Vitest na web.
- LiteLLM 1.106.4: `/public/litellm_model_cost_map`, `/model/info`, `/model/new`, `/model/delete`, `/credentials`, `/v1/chat/completions`.

**Spec:** `docs/superpowers/specs/2026-10-26-central-de-ia-design.md` (§2 decisões 3, 5, 9, 10, 11 e 12; §5.3; §6; §7; §8 entregas 1 e 2)

**Repositórios:**
- i7Ai: `C:/xampp/htdocs/producao/i7ai-IA`, branch `feat/central-ia`.
- SGDM: worktree `C:/xampp/htdocs/producao/prefeitura/SGDM-central-ia`, branch `feat/central-ia`.
- Nas tasks, os caminhos do SGDM são relativos à raiz do worktree.

**Decisão 12:** nada deste plano vai para produção. A pilha `i7ai-plataforma` em produção fica como está, e o deploy único acontece depois da entrega 6.

## Global Constraints

**Testes (máquina de 16 GB, nunca a suíte inteira):**
- API do SGDM: `cd apps/api && npx jest --runInBand <caminhos>`, só com os caminhos da task.
- Web do SGDM: `cd apps/web && npx vitest run <arquivos>`.
- Backend do i7Ai:
  - Durante a task: `cd backend && npm run build && node --test test/<arquivo>.cjs`.
  - `npm run build && npm test` uma vez no fim de cada task, porque os testes carregam `../dist`.
- Frontend do i7Ai: `npx playwright test <arquivos>`, só com os arquivos da task.

**Commits:**
- Separados por repositório, com `git add <caminhos explícitos>`.
- No i7Ai, nunca `output/verification/**`.
- No SGDM, nunca arquivos fora da task.

**Texto e visual:**
- Textos para o usuário em português; comentários de código em inglês.
- Nenhuma biblioteca nova.
- No SGDM, só os componentes visuais atuais: `PageHeader`, `.card`, `.stat-card`, `DataTable`, `Tabs`, `EmptyState`, `Skeleton`, `Toast`, `lucide-react`.

**Chaves:**
- Nenhuma chave de provedor e nenhuma chave administrativa do LiteLLM em banco do i7Ai, em log, em auditoria, em resposta de API ou no navegador.
- No SGDM, a chave da plataforma só passa pela requisição até o LiteLLM. Nunca é gravada, e a resposta mostra só a forma mascarada que o LiteLLM devolve.

**Auditoria e acesso:**
- Toda escrita da Central registra em `auditoria` (`AuditoriaService.registrar`), sem chaves. Use `entidade` `ia_modelo` | `ia_chave_plataforma` | `ia_liberacao` | `ia_liberacao_usuario` e `acao` `CRIAR` | `EDITAR` | `EXCLUIR` | `TESTAR`.
- O `tenantId` da auditoria é o da prefeitura afetada. Em ações globais (modelos, chaves), é o tenant do usuário que age.
- Isolamento:
  - Toda consulta de liberação, exceção, setor e usuário filtra por prefeitura.
  - Um `usuarioId` de outra prefeitura → 404.
  - As rotas `/central-ia/*` exigem `IA_CENTRAL` (`@RequirePermissions('IA_CENTRAL')` na classe).
- Os endpoints internos (`/integracoes/i7ai/*` no SGDM, `/api/integracoes/sgdm/*` no i7Ai) exigem a chave entre servidores. A comparação é com `timingSafeEqual` sobre sha256. Sem a chave configurada → 404; com chave errada → 401.

**Migrations:**
- Do SGDM:
  - SQL idempotente (`IF NOT EXISTS`, `WHERE NOT EXISTS`) e também no seed, conforme `docs/modulos/padrao-modulo.md`.
  - Os nomes ordenam depois de `20261211100000_ia_central_permissao`: `20261212100000_i7ai_fora_do_administrador` e `20261213100000_ia_modelos_liberacoes`.
- Do i7Ai:
  - Os nomes ordenam depois de `20261027000100_ai_usage_cache_cost`: `20261028000100_ai_models_active` e `20261028000200_departments_external_id`.
  - Gere com `npx prisma migrate dev --create-only`, revise e aplique no banco local.

**Fora do escopo:**
- A geração de peças do SGDM continua com o `modelo` de Cadastros › IA, ou o padrão do adapter, pelos curingas do LiteLLM. As liberações valem só para o i7Ai (§5.3).
- O link "ver no i7Ai" da linha de conversa fica para a entrega 6. Ele exige que alguém com `IA_CENTRAL` abra no i7Ai, com auditoria, a conversa de outra prefeitura.

**Sem integração configurada (i7Ai sem `SGDM_API_URL` ou `SGDM_INTEGRATION_KEY`):** o i7Ai não filtra modelos e não sincroniza a organização. É o modo local avulso de hoje.

## Review Focus

1. **SGDM fora do ar ou lento quando o usuário abre o chat ou envia mensagem.**
   - Esperado: o i7Ai usa o último valor do cache por até 600 s além do TTL.
   - Se nunca houve leitura, responde 503 com "Não foi possível confirmar os modelos liberados para você. Tente novamente em instantes.".
   - Nunca libera tudo e nunca devolve 500. (Task 6: testes `stale` e `nunca lido`.)
2. **Agente cujo modelo principal não está liberado para o usuário, ou `modelId` forçado na requisição.**
   - Esperado: 403 com "Este modelo não está liberado para você. Escolha outro no seletor do chat.". A recusa vale também em automações.
   - O seletor do chat abre no padrão liberado. (Task 6: teste de recusa; Task 11: chat abre no padrão.)
3. **Prefeitura com dois setores de mesmo nome em funções diferentes, ou setor inativado com usuários dentro.**
   - Esperado: o login não falha (sem P2002), o departamento fica `INACTIVE` e o `departmentId` do usuário vira `null`. (Task 7.)
4. **Ativar um modelo sem preço no mapa de custos do LiteLLM.**
   - Esperado: 400 com "Este modelo não tem preço no LiteLLM; o custo ficaria zerado." e nenhuma escrita no LiteLLM. (Task 2.)
5. **Salvar, testar ou listar uma chave com espaços, curta demais ou válida.**
   - Inválida → 400 "Informe uma chave de API válida, sem espaços.".
   - Válida → nem a resposta, nem `dadosNovos`/`dadosAnteriores` da auditoria, nem o log contêm a chave. (Task 3.)

---

### Task 1 (SGDM API + web): `I7AI_*` fora do pacote do ADMINISTRADOR (decisão 11)

**Files:**
- Create: `apps/api/prisma/migrations/20261212100000_i7ai_fora_do_administrador/migration.sql`
  - Comentário de cabeçalho: os perfis de sistema deixam de ter `I7AI_*`, que só o dono concede; ver decisão 11.
  - SQL:
    ```sql
    DELETE FROM "perfil_permissoes" pp
    USING "perfis" pf, "permissoes" pm
    WHERE pp."perfil_id" = pf."id"
      AND pp."permissao_id" = pm."id"
      AND pm."codigo" IN ('I7AI_USAR','I7AI_CONSTRUIR','I7AI_ADMINISTRAR')
      AND pf."sistema" = true
      AND pf."nome" <> 'DONO_PLATAFORMA';
    ```
  - Idempotente: rodar de novo dá `DELETE 0`.
  - Comentário de rollback: o arquivo em `/root/backups/` do cloud232.
- Modify: `apps/api/prisma/seed.ts`
  - Nova constante `PERMISSOES_LIBERADAS_PELO_DONO = ['I7AI_USAR','I7AI_CONSTRUIR','I7AI_ADMINISTRAR']`, ao lado de `PERMISSOES_SO_PLATAFORMA` (L385).
  - `PERMISSOES_ADMIN` (L387) também as exclui.
  - Nenhum outro perfil de prefeitura as recebe. `PERMISSOES_DONO_PLATAFORMA` não muda.
- Modify: `apps/api/src/common/utils/escalonamento-privilegio.util.ts:55`
  - `PERMISSOES_RESERVADAS_PLATAFORMA` += os três códigos. Assim só o dono os concede (`assertApenasDonoConcedeReservadas`).
  - Os modelos de perfil `todasExcetoPlataforma` (`permissoesDoModelo` em `common/constants/modelos-perfil.ts:413`, usado em `perfis.service.ts`) deixam de incluí-los.
  - Conferido em `perfis.service.ts:291,323`: a lista serve só para os modelos de perfil e para a trava de concessão; não retira códigos de perfis existentes. O dono continua concedendo `I7AI_*` a perfis da prefeitura editando o perfil.
  - Atualizar o comentário: espelha `PERMISSOES_CROSS_TENANT + PERMISSOES_SO_PLATAFORMA + PERMISSOES_LIBERADAS_PELO_DONO`.
- Modify: `apps/web/lib/permissoes.ts`
  - Nova `PERMISSOES_LIBERADAS_PELO_DONO`.
  - `PERMISSOES_RECOMENDADAS_POR_PERFIL.ADMINISTRADOR` também as exclui.
  - O texto de `PERMISSAO_GUIA` dos três códigos passa a terminar com " Só o dono da plataforma concede."
- Modify: `apps/web/public/ajuda/manual.html`
  - No artigo `#permissoes-i7ai`, um parágrafo: "O acesso ao i7Ai é liberado pelo dono da plataforma; o administrador da prefeitura não concede estas permissões."
- Test:
  - Create `apps/api/src/common/__tests__/i7ai-fora-do-administrador.spec.ts`.
  - Existentes: `apps/api/src/common/__tests__/permissoes-em-migration.spec.ts`, `apps/web/lib/__tests__/permissoes.test.ts`.

**Interfaces:**
- Produces: `PERMISSOES_LIBERADAS_PELO_DONO` (seed e web), e `PERMISSOES_RESERVADAS_PLATAFORMA` com sete códigos.

- [ ] **Step 1: Testes**
  - API, `i7ai-fora-do-administrador.spec.ts`:
    - lê o SQL da migration e espera `DELETE FROM "perfil_permissoes"`, os três códigos e `<> 'DONO_PLATAFORMA'`;
    - lê `seed.ts` e espera `PERMISSOES_LIBERADAS_PELO_DONO` dentro do filtro de `PERMISSOES_ADMIN`;
    - `assertApenasDonoConcedeReservadas(adminPrefeitura, ['I7AI_USAR'])` lança `ForbiddenException` com "Somente o dono da plataforma pode conceder: I7AI_USAR.";
    - para o dono, não lança;
    - `permissoesDoModelo({ todasExcetoPlataforma: true, permissoes: [] }, ['I7AI_USAR','DOCUMENTO_CRIAR'], PERMISSOES_RESERVADAS_PLATAFORMA)` devolve `['DOCUMENTO_CRIAR']`.
  - Web: `PERMISSOES_RECOMENDADAS_POR_PERFIL.ADMINISTRADOR` não contém nenhum `I7AI_*`; `DONO_PLATAFORMA` contém os três.
- [ ] **Step 2: Rodar e ver falhar**
  - `npx jest --runInBand src/common/__tests__/i7ai-fora-do-administrador.spec.ts` → FAIL.
  - `npx vitest run lib/__tests__/permissoes.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
  - Aplicar a migration no banco local com `psql`.
  - Marcar como aplicada: `npx prisma migrate resolve --applied 20261212100000_i7ai_fora_do_administrador`.
- [ ] **Step 4: Rodar e ver passar**
  - Os dois comandos do Step 2 → PASS.
  - `npx jest --runInBand src/common/__tests__/permissoes-em-migration.spec.ts src/modules/perfis` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(i7ai): permissões I7AI_* só por liberação do dono da plataforma"`

---

### Task 2 (SGDM API): tabelas, catálogo do LiteLLM e ativação de modelos

**Files:**
- Modify: `apps/api/prisma/schema.prisma`. Modelos novos e relações inversas em `Tenant`/`Usuario`:
  - `IaModelo` (`@@map("ia_modelos")`). Uma linha significa modelo ativo na plataforma; o catálogo é global.
    - `id` String @id uuid
    - `slug` VarChar(160) @unique
    - `nome` VarChar(160)
    - `provedor` VarChar(20) (`OPENAI` | `ANTHROPIC` | `GEMINI`)
    - `padrao` Boolean @default(false)
    - `capacidades` Json
    - `litellmModelId` VarChar(80)?
    - `criadoPorId` String?
    - `criadoEm`, `atualizadoEm?`
  - `IaLiberacao` (`ia_liberacoes`):
    - `id`
    - `tenantId` @unique, relação com `Tenant` e onDelete Cascade
    - `provedores` String[]
    - `modelos` String[] (slugs; vazio significa todos os ativos dos provedores)
    - `modeloPadrao` VarChar(160)?
    - `atualizadoPorId?`, `atualizadoEm`
  - `IaLiberacaoUsuario` (`ia_liberacoes_usuarios`):
    - `id`, `tenantId`, `usuarioId` (relação `Usuario` Cascade)
    - `modelos` String[] (não vazio)
    - `modeloPadrao` VarChar(160)?
    - `atualizadoPorId?`, `atualizadoEm`
    - `@@unique([tenantId, usuarioId])`, `@@index([tenantId])`
  - `IaChaveTeste` (`ia_chaves_testes`):
    - `provedor` VarChar(20) @id
    - `ok` Boolean
    - `mensagem` VarChar(300)
    - `modelo` VarChar(160)?
    - `testadoEm`, `testadoPorId`
- Create: `apps/api/prisma/migrations/20261213100000_ia_modelos_liberacoes/migration.sql`
  - `CREATE TABLE IF NOT EXISTS` para as quatro tabelas, mais FKs e índices `IF NOT EXISTS`.
  - Índice único parcial `ia_modelos_um_padrao ON ia_modelos (padrao) WHERE padrao = true`.
  - Nenhuma permissão nova.
- Modify: `apps/api/src/modules/central-ia/litellm-admin.client.ts`
  - Novo método `enviar<T>(metodo: 'POST'|'PATCH'|'DELETE', path: string, corpo?: unknown, aceitar404 = false): Promise<T | null>`.
  - Mesmo mapeamento de erros de `get()`: 503 sem gateway ou sem resposta; 502 para HTTP ≠ 2xx, exceto 404 quando `aceitar404`, que devolve `null`.
  - A mensagem de erro do LiteLLM nunca é repassada crua quando o corpo enviado continha `api_key`.
- Create: `apps/api/src/modules/central-ia/modelos.regras.ts` (funções puras):
  - `PROVEDORES = ['OPENAI','ANTHROPIC','GEMINI'] as const`
  - `prefixoDoGateway` é reaproveitado de `configuracoes-ia/i7ai-integracao.regras.ts`.
  - `itensDoMapaDeCusto(mapa: Record<string, CustoLiteLlm>): ItemCatalogo[]`
    - `nome = slug.split('/')[1]`.
    - Mantém `mode === 'chat'` com `litellm_provider ∈ {openai, anthropic, gemini}`.
    - `slug = chave.startsWith(prov + '/') ? chave : chave.includes('/') ? descartar : prov + '/' + chave`.
    - Preços em USD por milhão com 6 casas: `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`.
    - `contexto = max_input_tokens`, `saidaMaxima = max_output_tokens`.
    - `visao = supports_vision === true`, `ferramentas = supports_function_calling === true`, `cachePrompt = supports_prompt_caching === true`, `raciocinio = supports_reasoning === true`.
  - `filtrarCatalogo(itens, { provedor?, busca?, pagina = 1, porPagina = 50 }): { itens; total }`. A busca é sem acento e sem caixa, sobre o slug.
  - `capacidadesDe(item): CapacidadesModelo = { contextWindow, maxOutputTokens, supportsVision, supportsTools, supportsReasoning, supportsPromptCaching }`. São os nomes que o i7Ai já usa em `ai_models.capabilities`.
- Create: `apps/api/src/modules/central-ia/modelos.service.ts`, `CentralIaModelosService`:
  - Construtor: `(client: LiteLlmAdminClient, prisma: PrismaService, auditoria: AuditoriaService)`.
  - `catalogo(filtro): Promise<{ itens: (ItemCatalogo & { ativo: boolean; padrao: boolean })[]; total: number }>`
    - Lê `GET /public/litellm_model_cost_map` (cerca de 4.300 entradas; nunca enviadas inteiras ao navegador).
    - Guarda o mapa em memória por 1 h.
  - `ativar(user, slug): Promise<IaModelo>`:
    - Slug fora do mapa → 404 "Modelo não encontrado no catálogo do LiteLLM.".
    - Sem preço de entrada ou de saída → 400 "Este modelo não tem preço no LiteLLM; o custo ficaria zerado.".
    - Já ativo → devolve a linha.
    - Se `/model/info` já tem `model_name === slug` (entradas do `config.yaml`), não escreve no LiteLLM e `litellmModelId = null`.
    - Senão:
      - `POST /model/new` com `{ model_name: slug, litellm_params: { model: slug, litellm_credential_name: prefixoDoGateway(provedor) } }`.
      - Depois lê `/model/info` e grava o `model_info.id` da entrada com `model_name === slug` e `db_model === true`.
    - Auditoria `CRIAR`.
  - `desativar(user, slug)`:
    - Com `litellmModelId`, chama `POST /model/delete { id }` (`aceitar404`).
    - Apaga a linha.
    - Na mesma transação, remove o slug de `ia_liberacoes.modelos` e de `ia_liberacoes_usuarios.modelos` e zera `modeloPadrao` que apontava para ele.
    - Exceções que ficarem vazias são apagadas.
    - Auditoria `EXCLUIR`.
  - `definirPadrao(user, slug)`: o slug precisa estar ativo, senão 400. Transação: todos `padrao=false`, depois este `true`. Auditoria `EDITAR`.
- Create: `apps/api/src/modules/central-ia/modelos.controller.ts`, `@Controller('central-ia')` + `@RequirePermissions('IA_CENTRAL')`:
  - `GET catalogo?provedor=&busca=&pagina=`
  - `GET modelos`, que lista os ativos
  - `POST modelos` com body `{ slug }`
  - `DELETE modelos?slug=`. O slug tem `/` e por isso vai em query, não em `:param`.
  - `PUT modelos/padrao` com body `{ slug }`
  - DTOs em `dto/modelos.dto.ts`: `slug` com `@Matches(/^(openai|anthropic|gemini)\/[A-Za-z0-9._:-]{1,140}$/)`.
- Modify: `central-ia.module.ts` (controller e provider).
- Test (`apps/api/src/modules/central-ia/__tests__/`):
  - `modelos.regras.spec.ts`, `modelos.service.spec.ts`, `modelos.controller.spec.ts`.
  - Fixture `fixtures/litellm-cost-map-amostra.json`: recorte real de `/public/litellm_model_cost_map` do LiteLLM local com `gpt-4o-mini`, `claude-sonnet-5-5`, `gemini/gemini-3.1-flash-lite-preview`, uma chave `anthropic.claude-sonnet-5` (bedrock), um modelo de embedding e um `openai` sem preço.

**Interfaces:**
- Produces:
  - `CentralIaModelosService.ativos(): Promise<IaModelo[]>`, usado pelas Tasks 4 e 5.
  - `LiteLlmAdminClient.enviar`, usado pela Task 3.
  - `ItemCatalogo { slug; nome; provedor; precoEntrada: number|null; precoSaida: number|null; precoCache: number|null; contexto: number|null; saidaMaxima: number|null; visao; ferramentas; cachePrompt; raciocinio }`.

- [ ] **Step 1: Testes**
  - Regras, `itensDoMapaDeCusto(amostra)`:
    - devolve `openai/gpt-4o-mini` com `precoEntrada 0.15`, `precoSaida 0.6`, `precoCache 0.075`, `contexto 128000`, `visao true`;
    - inclui `anthropic/claude-sonnet-5-5` e `gemini/gemini-3.1-flash-lite-preview`, este sem prefixo duplicado;
    - descarta a bedrock e o embedding.
  - Regras: `filtrarCatalogo(itens, { busca: 'SONNET' })` devolve só o claude.
  - Service:
    - ativar um slug do `config.yaml` não chama `enviar`;
    - ativar outro chama `enviar('POST','/model/new', { model_name, litellm_params: { model, litellm_credential_name: 'anthropic' } })` e grava `litellmModelId`;
    - ativar o modelo sem preço → `BadRequestException`, sem chamada;
    - `desativar` remove o slug das liberações e apaga exceção vazia;
    - auditoria chamada com `entidade: 'ia_modelo'`.
  - Controller (padrão de `central-ia.controller.spec.ts` com `AuthFalsoGuard`): sem `IA_CENTRAL` → 403 nas cinco rotas; slug `x/y` → 400.
- [ ] **Step 2: Rodar e ver falhar** — `npx jest --runInBand src/modules/central-ia/__tests__/modelos` → FAIL.
- [ ] **Step 3: Implementar.**
  - `npx prisma generate` e aplicar a migration no banco local com `psql` + `migrate resolve`.
  - Seed: nenhuma linha. A plataforma começa sem modelos ativos, e o dono ativa na tela.
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS; `npx jest --runInBand src/modules/central-ia` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): catálogo do LiteLLM e ativação de modelos na Central de IA"`

---

### Task 3 (SGDM API): chaves da plataforma na Central

**Files:**
- Create: `apps/api/src/modules/central-ia/chaves.service.ts`, `CentralIaChavesService`:
  - Construtor: `(client, prisma, auditoria)`.
  - Lógica portada de `i7ai-IA/backend/src/ai/provider-credentials.service.ts`:
    - nome da credencial = `openai` | `anthropic` | `gemini` (igual a `litellm_credential_name` do `config.yaml`);
    - corpo `{ credential_info: { custom_llm_provider }, credential_values: { api_key } }`;
    - `GET /credentials/by_name/:nome` (404 significa nova) e depois `POST /credentials` ou `PATCH /credentials/:nome`.
  - `listar(): Promise<{ provedor: 'OPENAI'|'ANTHROPIC'|'GEMINI'; nome: string; configurada: boolean; chaveMascarada: string|null; ultimoTeste: { ok; mensagem; modelo; testadoEm } | null }[]>`
  - `salvar(user, provedor, apiKey: unknown, ip?, userAgent?)`:
    - Valida 20–512 caracteres sem espaço, senão 400 "Informe uma chave de API válida, sem espaços.".
    - Auditoria `EDITAR`, `entidade 'ia_chave_plataforma'`, `entidadeId = provedor`, `dadosNovos { provedor, chaveAlterada: true }`.
  - `remover(user, provedor)`: auditoria `EXCLUIR`.
  - `testar(user, provedor)`:
    - Escolhe o primeiro modelo ativo daquele provedor em `ia_modelos`. Se não houver, usa a primeira entrada sem `*` de `/v1/models`. Se não houver nenhum, 400 "Ative um modelo deste provedor antes de testar a chave.".
    - Faz `POST /v1/chat/completions` com `max_tokens: 5`, `user` = tenant de quem testa e `metadata.tags: ['origem:central-teste', 'usuario:<id>']`.
    - Grava `IaChaveTeste` com `ok`, mensagem truncada em 300 e modelo.
    - Auditoria `TESTAR` com `{ provedor, ok }`.
  - Nomes exibidos: `OpenAI`, `Anthropic (Claude)`, `Google Gemini`.
- Create: `apps/api/src/modules/central-ia/chaves.controller.ts` (`IA_CENTRAL`):
  - `GET central-ia/chaves`
  - `PUT central-ia/chaves/:provedor` com body `{ apiKey }`
  - `DELETE central-ia/chaves/:provedor`
  - `POST central-ia/chaves/:provedor/teste`
  - `:provedor` com `@IsIn(PROVEDORES)` após `toUpperCase()`; inválido → 400 "Provedor de IA não suportado.".
- Modify: `central-ia.module.ts`.
- Test: `__tests__/chaves.service.spec.ts`, `__tests__/chaves.controller.spec.ts`.

**Interfaces:**
- Consumes: `LiteLlmAdminClient.enviar` e `get` (Task 2).
- Produces: `CentralIaChavesService.configuradas(): Promise<Set<'OPENAI'|'ANTHROPIC'|'GEMINI'>>`, usado pela Task 4 para mostrar qual chave atende cada prefeitura.

- [ ] **Step 1: Testes**
  - Salvar uma nova faz `GET by_name` (404), depois `POST /credentials` com `credential_name: 'anthropic'`. Existente → `PATCH`.
  - `' sk-abc '` e uma chave de 10 caracteres → 400 sem chamada ao client.
  - A chave usada no teste (`'sk-ant-' + 'x'.repeat(40)`) não aparece em `JSON.stringify` de: retorno de `salvar`, argumentos de `auditoria.registrar`, chamadas a `Logger`.
  - `listar` devolve `chaveMascarada` exatamente como o LiteLLM devolveu (`'sk****88'`) e `ultimoTeste` da tabela.
  - `testar` sem modelo → 400 com a mensagem acima. Com LiteLLM respondendo 401 → `{ ok: false }` gravado.
  - Controller: sem `IA_CENTRAL` → 403; `PUT chaves/xai` → 400.
- [ ] **Step 2: Rodar e ver falhar** — `npx jest --runInBand src/modules/central-ia/__tests__/chaves` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): chaves da plataforma cadastradas na Central de IA"`

---

### Task 4 (SGDM API): liberações por prefeitura e exceções por usuário

**Files:**
- Create: `apps/api/src/modules/central-ia/liberacoes.regras.ts`:
  ```ts
  export interface AcessoEfetivo { modelos: string[]; padrao: string | null }
  export function acessoEfetivo(
    ativos: { slug: string; provedor: string; padrao: boolean }[],
    liberacao: { provedores: string[]; modelos: string[]; modeloPadrao: string | null } | null,
    excecao: { modelos: string[]; modeloPadrao: string | null } | null,
  ): AcessoEfetivo
  ```
  - Sem liberação e sem exceção → `{ modelos: [], padrao: null }` (fechado por padrão).
  - Com exceção, a lista da exceção substitui a da prefeitura: `modelos = excecao.modelos ∩ ativos`.
  - Sem exceção: `modelos` = ativos com `provedor ∈ liberacao.provedores` e (`liberacao.modelos` vazio ou `slug ∈ liberacao.modelos`).
  - `padrao` é o primeiro que estiver em `modelos`, nesta ordem: `excecao.modeloPadrao`, `liberacao.modeloPadrao`, padrão da plataforma, `modelos[0]`. Se não houver, `null`.
  - `modelos` ordenado por slug.
  - `chaveQueAtende(provedor, configIa: { habilitado; provedor; temChave } | null, plataforma: Set<string>): 'propria' | 'plataforma' | 'nenhuma'`
- Create: `apps/api/src/modules/central-ia/liberacoes.service.ts`, `CentralIaLiberacoesService`:
  - Construtor: `(prisma, modelos: CentralIaModelosService, chaves: CentralIaChavesService, auditoria)`.
  - `resumo(): Promise<{ tenantId; nome; provedores; totalModelos; modeloPadrao; excecoes: number; chaves: Record<Provedor, 'propria'|'plataforma'|'nenhuma'> }[]>`
    - Todas as prefeituras ativas (`tenant.ativo`), ordenadas por `nome`. O SGDM não tem um "tenant da plataforma" marcado, então nenhuma fica de fora.
    - A chave própria vem de `TenantConfiguracaoIa`: `habilitado && apiKey` e o provedor dela.
  - `detalhe(tenantId)`:
    - Devolve `{ liberacao | null, excecoes: { usuarioId; nome; email; modelos; modeloPadrao }[], chaves, ultimosTestes }`.
    - Tenant inexistente → 404.
  - `salvarLiberacao(user, tenantId, dto: { provedores: string[]; modelos: string[]; modeloPadrao: string | null })`:
    - Valida provedores ⊂ `PROVEDORES`, modelos ⊂ ativos e de provedores listados, e `modeloPadrao` ∈ efetivos.
    - Erro → 400 "O modelo padrão precisa estar entre os liberados." ou "Modelo não ativo na plataforma: <slug>.".
    - Upsert. Auditoria `CRIAR`/`EDITAR` com antes e depois.
  - `salvarExcecao(user, tenantId, usuarioId, dto: { modelos: string[] (1..50); modeloPadrao: string | null })`:
    - Usuário de outra prefeitura → 404 "Usuário não encontrado nesta prefeitura.".
    - Modelos ⊂ ativos.
  - `removerExcecao(user, tenantId, usuarioId)`.
  - `buscarUsuarios(tenantId, busca)`:
    - Filtra `usuario.tenantId = tenantId AND ativo`, com `nome`/`email` `contains` sem caixa.
    - Devolve `take: 20`, só `id, nome, email`.
  - `acesso(tenantId, usuarioId?): Promise<AcessoEfetivo>`: usado pelo endpoint interno (Task 5).
- Create: `apps/api/src/modules/central-ia/liberacoes.controller.ts` (`IA_CENTRAL`):
  - `GET central-ia/acesso`
  - `GET central-ia/acesso/:tenantId`
  - `PUT central-ia/acesso/:tenantId`
  - `GET central-ia/acesso/:tenantId/usuarios?busca=` (mínimo 2 caracteres)
  - `PUT central-ia/acesso/:tenantId/usuarios/:usuarioId`
  - `DELETE central-ia/acesso/:tenantId/usuarios/:usuarioId`
  - DTOs em `dto/liberacoes.dto.ts`; ids com `@IsId()`.
- Test: `__tests__/liberacoes.regras.spec.ts`, `__tests__/liberacoes.service.spec.ts`, `__tests__/liberacoes.controller.spec.ts`.

**Interfaces:**
- Consumes: `CentralIaModelosService.ativos()` (Task 2), `CentralIaChavesService.configuradas()` (Task 3).
- Produces: `CentralIaLiberacoesService.acesso(tenantId, usuarioId?)` e `acessoEfetivo`, usados pela Task 5.

- [ ] **Step 1: Testes**
  - Regras, com `ativos = [openai/gpt-4o-mini (padrão), openai/gpt-5.5, anthropic/claude-sonnet-5-5]`:
    - sem liberação → `{ modelos: [], padrao: null }`;
    - `{ provedores: ['OPENAI'], modelos: [] }` → os dois openai, `padrao 'openai/gpt-4o-mini'`;
    - exceção `{ modelos: ['anthropic/claude-sonnet-5-5'], modeloPadrao: null }` → só o claude, `padrao` o claude;
    - exceção com slug que deixou de ser ativo → ignorado.
  - `chaveQueAtende('ANTHROPIC', { habilitado: true, provedor: 'ANTHROPIC', temChave: true }, new Set()) === 'propria'`. Sem config e com plataforma → `'plataforma'`. Sem nada → `'nenhuma'`.
  - Service:
    - `salvarExcecao` com usuário de outro tenant → `NotFoundException` (`esperarSoDoTenant` de `common/testing/isolamento-tenant.ts`);
    - `buscarUsuarios` passa `tenantId` no `where`;
    - padrão fora da lista → 400;
    - auditoria em toda escrita com `entidade 'ia_liberacao'` ou `'ia_liberacao_usuario'`.
  - Controller: sem `IA_CENTRAL` → 403 nas seis rotas.
- [ ] **Step 2: Rodar e ver falhar** — `npx jest --runInBand src/modules/central-ia/__tests__/liberacoes` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): liberações de modelos por prefeitura e exceções por usuário"`

---

### Task 5 (SGDM API): endpoints internos `modelos`, `acesso` e `organizacao` para o i7Ai

**Files:**
- Modify: `apps/api/src/modules/configuracoes-ia/i7ai-integracao.regras.ts`
  - Nova função pura `exigirChaveIntegracao(chaveEsperada: string | null | undefined, authorization?: string): void`, com a ordem atual: sem chave esperada → `NotFoundException`; `!chaveIntegracaoValida(...)` → `UnauthorizedException('Chave de integração inválida.')`.
- Modify: `apps/api/src/modules/configuracoes-ia/i7ai-integracao.controller.ts`: a rota `ia/:tenantId` passa a chamá-la com `config.get('i7ai.chaveIntegracao')`.
- Create: `apps/api/src/modules/central-ia/i7ai-acesso.controller.ts`, `@ApiExcludeController() @Controller('integracoes/i7ai')`, todas `@Public()`:
  - Cada rota começa com `exigirChaveIntegracao(config.get('i7ai.chaveIntegracao'), authorization)`.
  - `GET modelos` → `{ modelos: { slug; nome; provedor: 'openai'|'anthropic'|'gemini'; padrao: boolean; capacidades: CapacidadesModelo }[] }`.
  - `GET acesso/:tenantId?usuarioId=` → `AcessoEfetivo`.
    - `tenantId` e `usuarioId` com `UUID_TENANT`, senão 404.
    - Usuário que não é daquela prefeitura → 404.
  - `GET organizacao/:tenantId` → `OrganizacaoI7ai`:
    ```ts
    interface OrganizacaoI7ai {
      prefeitura: { nome: string; cidade: string | null; estado: string | null; fuso: string };
      setores: { id: string; nome: string; sigla: string | null; ativo: boolean; ordem: number;
                 membros: { usuarioId: string; papel: 'MEMBRO' | 'CHEFE' }[] }[];
    }
    ```
    - `fuso = estado ? fusoDaUf(estado) : 'America/Cuiaba'` (`modules/protocolos/fuso-horario.util.ts:8`).
    - Setores do tenant (`where: { tenantId }`, ativos e inativos), membros por `SetorUsuario`.
    - Tenant inexistente → 404.
- Modify: `central-ia.module.ts` (o controller novo; `ConfigService` já global).
- Test:
  - Create `apps/api/src/modules/central-ia/__tests__/i7ai-acesso.controller.spec.ts`.
  - Existente: `configuracoes-ia/__tests__/i7ai-integracao.spec.ts`, que deve continuar verde.

**Interfaces:**
- Consumes: `CentralIaModelosService.ativos()`, `CentralIaLiberacoesService.acesso()`.
- Produces: o contrato HTTP acima, que o i7Ai consome nas Tasks 6 e 7. Os nomes de campo são exatamente esses.

- [ ] **Step 1: Testes**
  - Para cada uma das três rotas:
    - sem chave configurada → 404;
    - `Authorization: Bearer errada…` → 401;
    - UUID inválido → 404.
  - `acesso` com `usuarioId` de outro tenant → 404.
  - `acesso` sem `usuarioId` → resultado de `acesso(tenantId)`.
  - `organizacao` de um tenant com `estado 'MT'` → `fuso 'America/Cuiaba'`; com `estado 'AM'` → `'America/Manaus'`; com `estado null` → `'America/Cuiaba'`.
  - Setores com membros e `papel`.
  - `modelos` devolve `provedor` em minúsculas.
- [ ] **Step 2: Rodar e ver falhar** — `npx jest --runInBand src/modules/central-ia/__tests__/i7ai-acesso.controller.spec.ts src/modules/configuracoes-ia` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): endpoints internos de modelos, acesso e organização para o i7Ai"`

---

### Task 6 (i7Ai backend): catálogo vindo do SGDM, liberações obedecidas e Modelos só leitura

**Files:**
- Create: `backend/src/sgdm/sgdm.module.ts`
  - `SgdmModule` é a casa única da integração com o SGDM: exporta `SgdmAccessService` (aqui) e `SgdmOrganizationService` (Task 7) e hospeda o controller de nomes (Task 8).
  - Não importa `AuthModule`, `CatalogModule` nem `AiGatewayModule`, para não criar ciclo.
  - É importado por `AiGatewayModule`, `CatalogModule` e `AuthModule`.
- Create: `backend/src/sgdm/sgdm-integration.ts`
  - `sgdmIntegrationGet<T>(path: string, env = process.env): Promise<T>`, com o mesmo comportamento de `TenantAiKeyService.fetchKey`:
    - base `SGDM_API_URL` validada por `gatewayBaseAllowed(base, env, 'SGDM_INTERNAL_HOSTS')`;
    - `Authorization: Bearer SGDM_INTEGRATION_KEY`, `redirect: 'error'`, `AbortSignal.timeout(8000)`.
  - Erros lançados:
    - 404 → `SgdmNotFound`.
    - Outro erro → `SgdmUnavailable`, com mensagem sem a chave.
  - `sgdmIntegrationEnabled(env)`: exige `SGDM_API_URL` e `SGDM_INTEGRATION_KEY`.
  - `TenantAiKeyService.fetchKey` passa a usá-lo, sem mudar o comportamento.
- Create: `backend/src/sgdm/sgdm-access.service.ts`, `SgdmAccessService`:
  - `allowed(tenantId: string, userId?: string): Promise<{ slugs: string[]; defaultSlug: string | null } | null>`
    - `null` quando a integração está desligada, e então não há filtro.
    - `GET /integracoes/i7ai/acesso/:tenantId[?usuarioId=]`.
    - Cache com chave `tenantId:userId|-`.
    - TTL `SGDM_ACCESS_CACHE_SECONDS`, padrão 60.
    - Em erro, serve o valor vencido por até 600 s. Sem valor → `ServiceUnavailableException('Não foi possível confirmar os modelos liberados para você. Tente novamente em instantes.')`.
    - `MAX_CACHE = 5000`, FIFO.
  - `assertAllowed(tenantId, userId: string | undefined, slug: string): Promise<void>`: fora da lista → `ForbiddenException('Este modelo não está liberado para você. Escolha outro no seletor do chat.')`.
- Modify: `backend/prisma/schema.prisma` (`AiModel.active Boolean @default(true)`) + migration `20261028000100_ai_models_active`.
- Modify: `backend/src/ai/model-pricing-sync.service.ts`
  - Novo `syncCatalog(): Promise<{ upserted: number; deactivated: number }>`:
    - Faz `GET /integracoes/i7ai/modelos`.
    - Upsert de `AiProvider` por slug: `openai → 'OpenAI'`, `anthropic → 'Anthropic (Claude)'`, `gemini → 'Google Gemini'`.
    - Upsert de `AiModel` por `(providerId, slug)`, com `name`, `capabilities` (mescla com as existentes; `contextWindow` do SGDM só quando o atual for vazio) e `active: true`.
    - Os demais modelos ficam `active: false`. Nunca apaga, porque há FKs de uso e conversas e `AgentModel` em Cascade.
  - A rodada passa a ser `syncCatalog()`, depois `sync()` (preços, sem mudança).
  - Intervalo `MODEL_SYNC_SECONDS`, padrão 300, substituindo `SIX_HOURS`.
  - Integração desligada → só `sync()`, como hoje.
- Modify: `backend/src/ai/ai-gateway.service.ts`, `generate()` logo após L164 (o modelo resolvido):
  - `await this.access.assertAllowed(agent.tenantId, input.userId, model.slug)`.
  - Vale para chat, stream e `executeAgent` (automações sem usuário usam a lista da prefeitura).
  - Modelo com `active: false` → a mesma `ForbiddenException`.
- Modify: `backend/src/ai/chat-catalog.controller.ts`
  - `models` = ativos ∩ `allowed(...)`, ou todos os ativos sem integração.
  - Resposta ganha `defaultModelId: string | null`: o id do `defaultSlug`.
- Modify: `backend/src/catalog/catalog.controller.ts` + `catalog.service.ts`
  - Remove `POST /models`, `PATCH /models/:id`, `createModel`, `updateModel`, `requireGlobalModelAdmin`, `validateModelPrice` e os DTOs `CreateModelDto`/`UpdateModelDto`/`ModelCapabilitiesDto`.
  - `GET /models` devolve só `active: true`. Nova assinatura: `models(actor: { sub: string; tenantId: string; roles: string[] })`. Para quem não é `SUPER_ADMIN`, devolve também só os liberados para o usuário.
- Delete: `backend/src/ai/provider-credentials.controller.ts`, `provider-credentials.service.ts`, o registro em `ai-gateway.module.ts` e `backend/test/provider-credentials.test.cjs`.
  - `litellm-admin.ts` fica, porque a sincronização de preços usa.
- Modify: `backend/src/ai/ai-gateway.module.ts` e `backend/src/catalog/catalog.module.ts`: importam `SgdmModule`.
- Test:
  - Create `backend/test/sgdm-access.test.cjs`.
  - Modify `backend/test/model-pricing-sync.test.cjs`, `backend/test/chat-model-selection.test.cjs`, `backend/test/model-catalog.cjs` (remover casos de escrita e afirmar que as rotas não existem).

**Interfaces:**
- Consumes: os contratos `GET /integracoes/i7ai/modelos` e `acesso` (Task 5).
- Produces:
  - `sgdmIntegrationGet`, `SgdmNotFound`, `SgdmUnavailable` e `sgdmIntegrationEnabled`, usados pela Task 7.
  - `SgdmAccessService.allowed()`, usado pela Task 7 em `settings()`.
  - `/chat/catalog` → `{ agents, models, defaultModelId }`, usado pela Task 11.

- [ ] **Step 1: Testes**, com o servidor HTTP falso do padrão de `tenant-ai-key.test.cjs`:
  - `sgdm-access.test.cjs`:
    - devolve `slugs` do SGDM e repete do cache sem nova chamada dentro do TTL;
    - `stale`: TTL vencido e SGDM 500 → devolve o valor antigo;
    - `nunca lido`: SGDM fora → `ServiceUnavailableException` com a mensagem exata;
    - integração desligada → `null`;
    - `assertAllowed` com slug fora → `ForbiddenException` com a mensagem exata.
  - `chat-model-selection.test.cjs`:
    - `modelId` forçado de um modelo ativo não liberado → 403, sem chamada ao gateway;
    - modelo principal do agente não liberado → 403;
    - automação (sem `userId`) consulta `acesso` sem `usuarioId`;
    - `/chat/catalog` só com os liberados e `defaultModelId` do padrão.
  - `model-pricing-sync.test.cjs`:
    - `syncCatalog` cria provedor e modelo ausentes;
    - marca `active:false` um modelo que saiu, sem apagar;
    - não sobrescreve preços.
  - `model-catalog.cjs`: `CatalogController.prototype` não tem `createModel`/`updateModel`.
- [ ] **Step 2: Rodar e ver falhar** — `cd backend && npm run build && node --test test/sgdm-access.test.cjs test/chat-model-selection.test.cjs test/model-pricing-sync.test.cjs` → FAIL.
- [ ] **Step 3: Implementar** e rodar `npm run prisma:generate`.
- [ ] **Step 4: Rodar e ver passar** — `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git add backend/prisma backend/src/ai backend/src/sgdm backend/src/catalog backend/test && git commit -m "feat(ia): i7Ai obedece às liberações do SGDM e Modelos vira consulta"`

---

### Task 7 (i7Ai backend): setores como departamentos e configurações vindas do SGDM

**Files:**
- Modify: `backend/prisma/schema.prisma`
  - `Department.externalId String?`.
  - Troca `@@unique([tenantId, name])` por `@@unique([tenantId, externalId])`, porque o SGDM permite o mesmo nome em funções diferentes.
  - Migration `20261028000200_departments_external_id`.
- Create: `backend/src/sgdm/sgdm-organization.service.ts`, `SgdmOrganizationService`. Exportado por `SgdmModule`; `AuthModule` passa a importar `SgdmModule`.
  - `sync(tenantId: string): Promise<OrganizacaoI7ai | null>`
    - `null` com a integração desligada.
    - Cache por prefeitura, TTL `SGDM_ORG_CACHE_SECONDS`, padrão 300.
    - Ao renovar, numa transação:
      - `tenant.update({ name: prefeitura.nome, settings: settingsFromSgdm(prefeitura) })`;
      - upsert de `departments` por `(tenantId, externalId = setor.id)`, com `name = setor.nome` e `status = ativo ? 'ACTIVE' : 'INACTIVE'`;
      - departamentos da prefeitura com `externalId` nulo ou fora da lista → `INACTIVE`.
    - Em erro: `logger.warn`, devolve o valor em cache ou `null`. O login não falha por isso.
  - `departmentExternalIdFor(org: OrganizacaoI7ai, userId: string): string | null`
    - Considera só setores ativos onde o usuário é membro.
    - Prefere `papel 'CHEFE'`; depois menor `ordem`; depois `nome` (`localeCompare` pt-BR).
- Create: `backend/src/catalog/tenant-settings.ts`
  - `settingsFromSgdm(p: OrganizacaoI7ai['prefeitura'])`.
  - Mapeamento completo dos campos de `settings` (decisão 10):

    | Campo do i7Ai | Valor |
    | --- | --- |
    | `organizationName` | `p.nome` |
    | `timezone` | `p.fuso` |
    | `locale` | `'pt-BR'` (fixo) |
    | `theme` | `'system'` (fixo; o i7Ai segue o tema do SGDM) |
    | `allowSignups` | `false` (fixo; usuários só pelo SGDM) |
    | `retentionDays` | `null` (fixo: sem exclusão automática) |
    | `defaultModelId` | não gravado; `settings()` calcula a partir de `SgdmAccessService.allowed(tenantId)?.defaultSlug` |
- Modify: `backend/src/auth/sgdm-identity.service.ts`
  - Em `sync()`, depois do upsert do usuário (L115–121): `const org = await this.organization.sync(tenantId)`.
  - Se `org`, `departmentId` = id do `Department` com o `externalId` escolhido (ou `null`), gravado só quando mudar.
  - Injeção com `@Optional()`, como `tenantKeys`.
- Modify: `backend/src/catalog/catalog.controller.ts` + `catalog.service.ts` + `catalog.dto.ts`
  - Remove `PATCH /settings`, `POST/PATCH /departments`, `POST/PATCH /users` e os DTOs `SettingsDto`, `DepartmentDto`, `UpdateDepartmentDto`, `CreateUserDto` e `UpdateUserDto`. Remove também `validateUserRelations`.
  - `GET /users`, `/departments`, `/roles` e `/settings` continuam, só leitura.
  - `settings()`:
    - devolve `settingsFromSgdm` gravado;
    - `defaultModelId` vem como acima;
    - mantém os padrões atuais quando `settings` estiver vazio, no modo sem integração.
- Test:
  - Create `backend/test/sgdm-organization.test.cjs`.
  - Modify `backend/test/sgdm-identity.test.cjs` e `backend/test/audit-crud.test.cjs` (remover os casos de criação e edição de usuário, departamento e configurações; afirmar que os handlers não existem).
  - `backend/test/retention.test.cjs` deve continuar verde.

**Interfaces:**
- Consumes: `sgdmIntegrationGet` (Task 6), o contrato `GET /integracoes/i7ai/organizacao/:tenantId` (Task 5) e `SgdmAccessService.allowed` (Task 6).
- Produces: `settingsFromSgdm`, `SgdmOrganizationService`.

- [ ] **Step 1: Testes**
  - `sgdm-organization.test.cjs`, com o SGDM falso e o Prisma em memória:
    - dois setores `"Compras"` (funções diferentes) viram dois departamentos sem erro;
    - setor `ativo:false` → `INACTIVE`;
    - departamento legado sem `externalId` → `INACTIVE`;
    - `departmentExternalIdFor`: CHEFE vence MEMBRO; empate → menor `ordem`; usuário sem setor → `null`;
    - cache: a segunda chamada dentro do TTL não chama o SGDM.
  - `settingsFromSgdm({ nome: 'Prefeitura de Sinop', cidade: 'Sinop', estado: 'MT', fuso: 'America/Cuiaba' })` → `{ organizationName: 'Prefeitura de Sinop', timezone: 'America/Cuiaba', locale: 'pt-BR', theme: 'system', allowSignups: false, retentionDays: null }`.
  - `sgdm-identity.test.cjs`:
    - o login põe o usuário no departamento do setor dele;
    - setor inativado no SGDM → `departmentId null` no próximo login;
    - `/organizacao` respondendo 500 → login conclui e `departmentId` não muda.
- [ ] **Step 2: Rodar e ver falhar** — `npm run build && node --test test/sgdm-organization.test.cjs test/sgdm-identity.test.cjs` → FAIL.
- [ ] **Step 3: Implementar** e rodar `npm run prisma:generate`.
- [ ] **Step 4: Rodar e ver passar** — `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(org): departamentos e configurações da prefeitura vêm do SGDM"`

---

### Task 8 (i7Ai backend): tag `agente:` e nomes para a Central

**Files:**
- Modify: `backend/src/ai/omnirouter.service.ts:214`
  - `tags()` acrescenta `'agente:' + input.agent.id` em toda chamada. `agent.id` é uuid; nunca nome.
- Create: `backend/src/sgdm/sgdm-names.controller.ts` + `sgdm-names.service.ts`
  - Registrados no `SgdmModule` (Task 6), que passa a ser importado também no `app.module.ts`.
  - `POST /api/integracoes/sgdm/nomes`, sem `@RequirePermission`:
    - sem `SGDM_INTEGRATION_KEY` → 404;
    - Bearer comparado com `timingSafeEqual` sobre sha256 → 401 se diferente.
  - Body `{ agentes?: string[]; conversas?: string[] }`: só uuids, no máximo 200 cada, senão 400.
  - Resposta `{ agentes: Record<string, string>; conversas: Record<string, string | null> }`, com `agent.name` e `conversation.title`.
  - Nunca devolve mensagens. Log só com as contagens.
- Test: `backend/test/omnirouter.test.cjs` (expectativas de tags), create `backend/test/sgdm-names.test.cjs`.

**Interfaces:**
- Produces: tag `agente:<uuid>` e o contrato `POST /api/integracoes/sgdm/nomes`, usados pela Task 9.

- [ ] **Step 1: Testes**
  - Tags de chat: `['agente:agent-a','conversa:conv-1','origem:i7ai-chat','usuario:user-a']` (ordenadas).
  - Tags de automação: `['agente:agent-a','origem:i7ai-automacao']`.
  - Nomes:
    - sem chave configurada → 404; chave errada → 401;
    - 201 ids → 400;
    - ids conhecidos → nomes e títulos;
    - id desconhecido → ausente do mapa.
- [ ] **Step 2: Rodar e ver falhar** — `npm run build && node --test test/omnirouter.test.cjs test/sgdm-names.test.cjs` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): tag do agente em cada chamada e nomes de agentes e conversas para a Central"`

---

### Task 9 (SGDM API + web): Consumo agrupado por agente e por conversa

**Files:**
- Modify: `apps/api/src/config/configuration.ts`
  - `i7ai.apiUrl = preenchida(process.env.I7AI_API_URL)`. Em produção, `http://i7ai-backend:3000/api`.
- Create: `apps/api/src/modules/central-ia/i7ai-nomes.client.ts`
  - `I7aiNomesClient.nomes(agentes: string[], conversas: string[]): Promise<{ agentes: Record<string,string>; conversas: Record<string,string|null> }>`
    - `POST ${i7ai.apiUrl}/integracoes/sgdm/nomes` com `Bearer i7ai.chaveIntegracao`, timeout 8 s e lotes de 200.
    - Qualquer falha ou falta de configuração → mapas vazios e `logger.warn`. A tela nunca falha por isso.
- Modify: `apps/api/src/modules/central-ia/central-ia.regras.ts:82-83`
  - `Agrupamento` e `AGRUPAMENTOS` += `'agente'`, `'conversa'`.
  - `linhasDe` usa os prefixos `agente:` e `conversa:`.
  - `conversa` limitado às 200 linhas de maior custo (`MAX_LINHAS_CONVERSA = 200`).
- Modify: `central-ia.service.ts`
  - Nomes de agente e o tema da conversa (título; sem título → "Conversa sem título") vêm do `I7aiNomesClient`.
  - Id desconhecido → `abreviarId`.
  - Também no CSV.
- Modify: `apps/web/lib/central-ia.ts:4,13`
  - `Agrupamento` e `AGRUPAMENTOS` += `{ id: 'agente', rotulo: 'Agente' }`, `{ id: 'conversa', rotulo: 'Conversa' }`.
  - Na tela Consumo, a coluna "Nome" da conversa mostra o tema.
  - `rotuloOrigem('central-teste') === 'Central · teste de chave'`.
- Test:
  - `apps/api/src/modules/central-ia/__tests__/central-ia.regras.spec.ts`, `central-ia.service.spec.ts`.
  - Create `__tests__/i7ai-nomes.client.spec.ts`.
  - `apps/web/lib/__tests__/central-ia.test.ts`.

**Interfaces:**
- Consumes: a tag `agente:` e o endpoint de nomes (Task 8).

- [ ] **Step 1: Testes**
  - `linhasDe` com entidades `agente:a1`, `conversa:c1` e `usuario:u1` em `agrupar 'agente'` → só `a1`.
  - 250 conversas → 200 linhas, ordenadas por `gastoUsd` desc.
  - Service com o client devolvendo `{ agentes: { a1: 'Assistente de Licitações' } }` → `nome` igual.
  - Client que lança → nome abreviado e status 200.
  - `nomes` sem `apiUrl` → mapas vazios, sem `fetch`.
  - Web: `AGRUPAMENTOS.map(a => a.id)` inclui `'agente'` e `'conversa'`; `rotuloOrigem('central-teste') === 'Central · teste de chave'`.
- [ ] **Step 2: Rodar e ver falhar**
  - `npx jest --runInBand src/modules/central-ia` → FAIL.
  - `npx vitest run lib/__tests__/central-ia.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — os dois comandos → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): consumo por agente e por conversa na Central de IA"`

---

### Task 10 (SGDM web): aba Modelos e acesso

**Files (`apps/web/`):**
- Modify: `lib/central-ia.ts:117-120`: `ABAS_CENTRAL` += `{ id: 'modelos', rotulo: 'Modelos e acesso', href: '/central-ia/modelos' }`.
- Modify: `lib/constants.ts`: `PAGE_TITLES['/central-ia/modelos'] = 'Modelos e acesso'`.
- Create: `lib/central-ia-modelos.ts`
  - `formatarPrecoMilhao(n: number | null): string`: `0.15 → 'US$ 0,15'`, `0.075 → 'US$ 0,075'`, `null → '—'`.
  - `rotuloChave(c: 'propria'|'plataforma'|'nenhuma'): string`: `'Chave da prefeitura' | 'Chave da plataforma' | 'Sem chave'`.
  - `resumoLiberacao(l: { provedores: string[]; modelos: string[] } | null): string`:
    - `null → 'Nada liberado'`;
    - `{ provedores: ['OPENAI'], modelos: [] } → 'OpenAI: todos os modelos ativos'`;
    - `{ provedores: ['OPENAI','ANTHROPIC'], modelos: ['a','b','c'] } → '3 modelos de OpenAI e Anthropic'`.
  - `validarLiberacao(form): string | null`: devolve a mesma mensagem da API para padrão fora da lista.
- Create: `lib/central-ia-modelos-api.ts`: funções finas sobre as rotas das Tasks 2, 3 e 4 (`buscarCatalogo`, `ativarModelo`, `desativarModelo`, `definirPadrao`, `listarChaves`, `salvarChave`, `removerChave`, `testarChave`, `buscarAcessos`, `buscarAcesso`, `salvarLiberacao`, `buscarUsuariosPrefeitura`, `salvarExcecao`, `removerExcecao`).
- Create: `app/(dashboard)/central-ia/modelos/page.tsx`, com `AbasCentral` e `Tabs` internas "Catálogo" · "Chaves da plataforma" · "Liberações":
  - Catálogo:
    - `DataTable` paginada com filtro por provedor e busca.
    - Colunas: modelo, provedor, entrada, saída e cache (US$/milhão), contexto, visão, ferramentas, ativo (interruptor) e padrão (botão "Tornar padrão").
    - Antes de desativar, confirma com "Desativar remove o modelo das liberações das prefeituras."
  - Chaves: um `.card` por provedor, com estado, chave mascarada, último teste e ações "Cadastrar/Trocar", "Testar" e "Remover".
    - O campo da chave é `type="password"` e `autoComplete="off"`, e é limpo depois de salvar.
  - Liberações: `DataTable` de prefeituras com o resumo, as exceções e a chave que atende cada provedor. A linha abre o detalhe.
- Create: `app/(dashboard)/central-ia/modelos/[tenantId]/page.tsx`
  - Formulário da prefeitura: provedores (checkbox), modelos (lista dos ativos filtrada pelos provedores; nenhum marcado significa "todos") e padrão (select).
  - Seção "Exceções por usuário": busca de usuário (mínimo 2 letras) mais a lista de modelos e o padrão, com "Remover exceção".
- Sem `IA_CENTRAL`, as páginas fazem `router.replace('/dashboard')`, como as da Entrega 1.
- Estados: `Skeleton`, `EmptyState` com "Tentar novamente", `Toast` em sucesso ou erro.
- Test: create `lib/__tests__/central-ia-modelos.test.ts`; `lib/__tests__/central-ia.test.ts` (abas).

**Interfaces:**
- Consumes: as rotas das Tasks 2, 3 e 4.

- [ ] **Step 1: Testes**
  - `formatarPrecoMilhao`, `rotuloChave` e `resumoLiberacao` com os valores acima.
  - `abaAtivaCentral('/central-ia/modelos/abc') === 'modelos'`.
  - `ABAS_CENTRAL` tem três itens, nesta ordem.
- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run lib/__tests__/central-ia-modelos.test.ts lib/__tests__/central-ia.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar**
  - vitest PASS.
  - `npx tsc --noEmit -p .` sem erros novos (os da saúde já existiam).
  - Abrir `http://localhost:3000/central-ia/modelos` como `owner@sgdm.app` e confirmar:
    - ativar `openai/gpt-4o-mini`;
    - cadastrar e testar a chave OpenAI;
    - liberar OpenAI para a prefeitura de teste;
    - criar uma exceção.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): tela Modelos e acesso da Central de IA"`

---

### Task 11 (i7Ai frontend): telas que saem e Modelos só leitura

**Files:**
- Modify: `src/app-shell.jsx`
  - `moduleNavigationGroups` (L17–25): o grupo "Organização" fica só com `licensing`; o grupo "Preferências" sai.
  - `titles` (L26–43) perde `users`, `departments` e `settings`.
  - A escolha de página (L96) não referencia mais `OrganizationPage`. Um `active` desconhecido continua caindo em dashboard.
  - `ModelPage` sem `canWrite`.
- Modify: `src/standalone-host.jsx`: sem mudança de código, porque os ids vêm de `moduleNavigationGroups`. Confirmar que `#/users` cai em dashboard.
- Delete: `src/features/OrganizationPages.jsx`.
  - O bloco de licenciamento dele era inalcançável; `LicensePage.jsx` fica.
- Modify: `src/features/ModelPages.jsx`
  - Remove `ModelEditor`, `ProviderKeys`, `ProviderKeyEditor` e o botão "Configurar".
  - Fica a tabela: nome, slug, provedor, entrada, saída e cache (US$/milhão), contexto e capacidades.
  - Aviso fixo: "Os modelos são ativados e liberados pelo dono da plataforma na Central de IA do SGDM. Os preços vêm do LiteLLM."
- Modify: `src/features/ChatPage.jsx` (L52–60, L117, L131, L176)
  - O modelo inicial é o do agente se estiver em `catalog.models`; senão `catalog.defaultModelId`; senão o primeiro.
  - Com `models` vazio, o seletor fica desabilitado e a área de envio mostra "Nenhum modelo de IA foi liberado para você. Fale com o administrador da plataforma."
  - Um 403 da API mostra a mensagem do servidor.
- Modify (Playwright):
  - `test/visual/fixtures.js`: `/chat/catalog` ganha `defaultModelId`; remover fixtures de escrita de `/users` e `/settings`.
  - `test/visual/sgdm.spec.js`:
    - remover os casos de criar usuário e departamento e de configurações (L40–57);
    - remover 'Novo modelo', 'Novo usuário' e 'Novo departamento' da L29;
    - novo caso: `?module=models` sem o botão "Novo modelo" e com o aviso;
    - novo caso: `?module=users` cai no Dashboard.
  - `test/visual/host-preview.spec.js`: tirar "Usuários", "Departamentos" e "Configurações" da lista de links.
  - `test/visual/chat.spec.js`:
    - novo caso: agente com modelo fora de `models` abre no `defaultModelId`;
    - novo caso: `models: []` mostra a mensagem acima.

- [ ] **Step 1: Atualizar os specs Playwright** (casos acima).
- [ ] **Step 2: Rodar e ver falhar** — `npx playwright test test/visual/sgdm.spec.js test/visual/host-preview.spec.js test/visual/chat.spec.js` → FAIL nos casos novos.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**
  - Mesmo comando → PASS.
  - `npm run build` sem erros.
  - `npm test` → PASS.
- [ ] **Step 5: Commit** — `git add src test/visual && git commit -m "feat(ui): Usuários, Departamentos e Configurações saem do i7Ai; Modelos vira consulta"`. Nunca `output/verification`.

---

### Task 12: documentação e fumaça local

**Files:**
- Modify: `i7ai-IA/docs/LITELLM.md`
  - A seção "Chaves dos provedores" passa a apontar para a Central de IA › Modelos e acesso › Chaves da plataforma, no SGDM.
  - A seção "Modelos" fica assim:
    - ativação na Central por `/model/new`;
    - curingas mantidos no `config.yaml`;
    - `ai_models` sincronizado do SGDM a cada `MODEL_SYNC_SECONDS`;
    - preços de `/model/info`.
  - Variáveis novas: `SGDM_ACCESS_CACHE_SECONDS`, `SGDM_ORG_CACHE_SECONDS`, `MODEL_SYNC_SECONDS` no backend do i7Ai; `I7AI_API_URL` na API do SGDM.
- Modify: `i7ai-IA/portainer/i7ai.stack.yml` e `portainer/stack.env.example`: apenas comentários e variáveis com padrão. Sem deploy (decisão 12).
- Modify (SGDM): `apps/web/public/ajuda/manual.html`
  - Nova seção funcional `id="central-ia"` com subseções `#central-ia-visao-geral`, `#central-ia-consumo` (agente e conversa) e `#central-ia-modelos` (catálogo, ativar, padrão, chaves da plataforma, liberações, exceções e "qual chave atende").
  - Ligar a seção a partir de `#permissao-IA_CENTRAL`.
- O resultado da fumaça (itens abaixo, marcados) vai na descrição do commit de documentação, sem arquivo novo.

- [ ] **Step 1: Fumaça local** (SGDM local + i7Ai pelo proxy `scripts/local-sgdm-proxy.cjs` + LiteLLM local):
  1. Como `owner@sgdm.app`:
     - ativar `openai/gpt-4o-mini` e `anthropic/claude-haiku-5-5`;
     - tornar o primeiro padrão;
     - cadastrar e testar as chaves.
  2. Liberar só OpenAI para a prefeitura de teste. Criar uma exceção para um usuário com só o claude.
  3. Entrar no i7Ai com um usuário comum: o seletor mostra só `gpt-4o-mini`. Forçar `modelId` do claude com `curl` → 403 com a mensagem exata.
  4. Entrar com o usuário da exceção: só o claude.
  5. O menu do i7Ai não tem Usuários, Departamentos nem Configurações. Modelos sem botões de edição.
  6. No i7Ai, os departamentos são iguais aos setores da prefeitura, e o usuário está no setor dele.
  7. Nome e fuso da prefeitura iguais aos do SGDM (`GET /api/settings`).
  8. Consumo agrupado por agente e por conversa, com nomes e temas.
  9. ADMINISTRADOR de prefeitura não recebe `I7AI_*` e não consegue concedê-las em Perfis.
  10. `grep -ri "sk-" ` nos logs das duas APIs e em `auditoria`/`audit_logs` → nada.
  11. Derrubar a API do SGDM com o chat aberto: a mensagem seguinte usa o cache por até 10 min.
- [ ] **Step 2: Commit em cada repositório** — `git commit -m "docs(ia): Central de IA — modelos, acesso e organização"`.
