# Entrega 1 — Marcação das chamadas, custo oficial e Central de IA (Visão geral + Consumo)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda chamada de IA (i7Ai e peças do SGDM) sai marcada com prefeitura, usuário, origem e conversa; o custo registrado é o do LiteLLM; e o dono da plataforma vê, no SGDM, as telas Visão geral (sem fluxo ao vivo) e Consumo e custo, só com a permissão `IA_CENTRAL`.

**Architecture:** O i7Ai e o SGDM enviam `user` = prefeitura e `metadata.tags` em cada chamada ao LiteLLM; o LiteLLM agrega por *customer* (prefeitura) e por *tag* (usuário, origem, conversa). O i7Ai grava em `ai_usage` o custo com os preços do LiteLLM (tabela sincronizada) e os tokens em cache; quando o LiteLLM devolve `x-litellm-response-cost`, esse valor prevalece. A API do SGDM lê os agregados do LiteLLM com a chave administrativa (que nunca chega ao navegador) e serve `/central-ia/*` protegido por `IA_CENTRAL`; a web do SGDM mostra as duas telas com os componentes atuais (`PageHeader`, `.card`, `.stat-card`, `DataTable`, `recharts`).

**Tech Stack:** i7Ai: NestJS + Prisma + `node:test`. SGDM: NestJS + Prisma + Jest (API), Next.js + React Query + Vitest (web). LiteLLM 1.106.4: `/customer/daily/activity/aggregated`, `/tag/daily/activity/aggregated`, `/model/info`.

**Spec:** `docs/superpowers/specs/2026-10-26-central-de-ia-design.md` (§5.1, §5.2, §6, §8 entrega 1)

## Global Constraints

- Tags por chamada, exatamente: `usuario:<uuid>` (quando há usuário), `origem:<i7ai-chat|i7ai-automacao|sgdm-pecas>`, `conversa:<uuid>` (quando há conversa); `user` = uuid da prefeitura. Nunca nomes de pessoas em tags.
- Chave de provedor e chave administrativa do LiteLLM nunca em banco do i7Ai, log, auditoria, resposta de API ou navegador.
- Texto de conversas não sai do i7Ai: a Central mostra ids, contagens e custos.
- Rotas da Central exigem `IA_CENTRAL`; sem ela, 403. `IA_CENTRAL` é reservada à plataforma (fora do pacote do ADMINISTRADOR).
- Testes do SGDM com `--runInBand` (API) e arquivos específicos (web); nunca a suíte inteira de uma vez (máquina de 16 GB).
- Textos para o usuário em português; comentários de código em inglês. Visual do SGDM sem biblioteca nova.
- Commits separados por repositório; no SGDM, `git add` explícito (há trabalho da saúde não commitado).

## Review Focus

1. LiteLLM fora do ar ao abrir a Central → a API responde 503 "O gateway de IA não respondeu" e a tela mostra erro com "Tentar novamente", não 500 nem tela em branco. (Task 6: teste do client com servidor inexistente; Task 7: estado de erro.)
2. Chamada de automação (sem usuário) → tags sem `usuario:` e a chamada segue; nunca `usuario:undefined`. (Task 1.)
3. Resposta em streaming (sem cabeçalho de custo) → custo calculado com os preços sincronizados e `costSource = 'catalog'`; nunca custo 0 silencioso quando há tokens e preço. (Task 2.)
4. Prefeitura sem chave própria e plataforma sem chave do provedor → geração de peça no SGDM falha com "A chave de IA não está cadastrada…" (mensagem clara), não 500. (Task 4.)
5. Período invertido ou maior que 366 dias na Central → 400 antes de consultar o LiteLLM. (Task 6.)

---

### Task 1 (i7Ai): tags e origem em toda chamada ao gateway

**Files:**
- Modify: `backend/src/ai/omnirouter.service.ts` (`OmniRouterInput`, montagem do corpo em `round()`)
- Modify: `backend/src/ai/ai-gateway.service.ts` (`AgentExecutionInput`, `chat()`, `runOmniRouter()`)
- Test: `backend/test/omnirouter.test.cjs`

**Interfaces:**
- `OmniRouterInput` += `origin: 'i7ai-chat' | 'i7ai-automacao'; conversationId?: string`.
- `AgentExecutionInput` += `conversationId?: string` (preenchido em `chat()` com `input.conversationId` quando a conversa já existe).
- Corpo enviado: `{ ...request, user: input.agent.tenantId, metadata: { tags: string[] }, api_key? }` com tags conforme Global Constraints.

- [ ] **Step 1: Teste**

```js
test('cada chamada leva user = prefeitura e as tags de usuário, origem e conversa', async t => {
  const { requests } = await provider(t, (_b, r) => json(r, completion()));
  const { service, input } = fixture();
  input.origin = 'i7ai-chat'; input.conversationId = 'conv-1';
  await service.generate(input);
  assert.equal(requests[0].body.user, 'tenant-a');
  assert.deepEqual(requests[0].body.metadata.tags.sort(), ['conversa:conv-1', 'origem:i7ai-chat', 'usuario:user-a']);
  const auto = fixture(); auto.input.origin = 'i7ai-automacao'; delete auto.input.userId; delete auto.input.conversationId;
  await auto.service.generate(auto.input);
  assert.deepEqual(requests[1].body.metadata.tags, ['origem:i7ai-automacao']);
});
```

- [ ] **Step 2: Rodar e ver falhar** — `cd backend && npm run build && node --test test/omnirouter.test.cjs` — FAIL (`metadata` indefinido).
- [ ] **Step 3: Implementar** — função `private tags(input: OmniRouterInput): string[]` em `omnirouter.service.ts`; `runOmniRouter()` passa `origin: input.automationId ? 'i7ai-automacao' : 'i7ai-chat'` e `conversationId: input.conversationId`. Todas as fixtures existentes dos testes ganham `origin: 'i7ai-chat'`.
- [ ] **Step 4: Rodar e ver passar** — `npm run build && npm test` — 239 testes PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(ia): marca cada chamada ao gateway com prefeitura, usuário, origem e conversa"`

---

### Task 2 (i7Ai): custo e tokens em cache vindos do LiteLLM

**Files:**
- Modify: `backend/src/ai/ai-quota.service.ts` (`QuotaUsage`, `QuotaScope`, `record()`)
- Modify: `backend/src/ai/omnirouter.service.ts` (`usageFrom()`, `round()`, `stream()`)
- Modify: `backend/src/ai/ai-gateway.service.ts` (`quota.scope(...)` recebe `cachedInputPrice`; `calculateUsageCost` ganha os dois parâmetros novos)
- Create: `backend/prisma/migrations/20261027000100_ai_usage_cache_cost/migration.sql` (`ALTER TABLE ai_usage ADD COLUMN cached_input_tokens INT NOT NULL DEFAULT 0, ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'catalog'; ALTER TABLE ai_models ADD COLUMN "cachedInputPrice" DECIMAL(12,6);`) + `schema.prisma` (`AiUsage.cachedInputTokens`, `AiUsage.costSource`, `AiModel.cachedInputPrice`)
- Test: `backend/test/omnirouter.test.cjs`, `backend/test/quota.test.cjs`

**Interfaces:**
- `QuotaUsage = { inputTokens; outputTokens; measured; cachedInputTokens?: number; gatewayCost?: number }`.
- `QuotaScope` += `cachedInputPrice: number` (0 quando ausente).
- `calculateUsageCost(inputTokens, outputTokens, inputPrice, outputPrice, cachedInputTokens = 0, cachedInputPrice = inputPrice): number` — `((input - cached) * inputPrice + cached * cachedInputPrice + output * outputPrice) / 1e6`, 6 casas.
- `record()`: `cost = usage.gatewayCost ?? calculateUsageCost(...)`; `costSource = usage.gatewayCost !== undefined ? 'gateway' : 'catalog'`; grava `cachedInputTokens`.
- `usageFrom()`: lê `prompt_tokens_details.cached_tokens` (inteiro ≥ 0, ≤ prompt_tokens; senão erro de protocolo). `round()`: cabeçalho `x-litellm-response-cost` numérico ≥ 0 → `gatewayCost` (ignorado se ausente ou inválido; no stream, nunca presente).

- [ ] **Step 1: Testes**

```js
// omnirouter.test.cjs
test('tokens em cache e custo do cabeçalho entram no consumo; stream sem cabeçalho usa o catálogo', ...)
// não-stream: usage {prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: {cached_tokens: 60}} + header 'x-litellm-response-cost: 0.000123'
//   → records.usage[0]: cachedInputTokens 60, cost 0.000123, costSource 'gateway'
// stream (sse): usage frame com cached_tokens 60, sem header → costSource 'catalog', cost === calculateUsageCost(100,10,1,2,60,0.5) com scope cachedInputPrice 0.5
// cached_tokens > prompt_tokens → rejeita com /consumo inválidos/
// quota.test.cjs
test('calculateUsageCost cobra tokens em cache pelo preço de cache', () => assert.equal(calculateUsageCost(100, 10, 1, 2, 60, 0.5), 0.00009));
```

- [ ] **Step 2: Rodar e ver falhar** — `node --test test/omnirouter.test.cjs test/quota.test.cjs` — FAIL.
- [ ] **Step 3: Implementar** (migration via `npx prisma migrate dev --name ai_usage_cache_cost` no banco local; `npm run prisma:generate`).
- [ ] **Step 4: Rodar e ver passar** — `npm run build && npm test` — PASS.
- [ ] **Step 5: Commit** — `git add -A backend/prisma backend/src/ai backend/test && git commit -m "feat(ia): registra tokens em cache e custo do gateway em cada chamada"`

---

### Task 3 (i7Ai): preços sincronizados do LiteLLM

**Files:**
- Create: `backend/src/ai/model-pricing-sync.service.ts`
- Modify: `backend/src/ai/ai-gateway.module.ts` (provider)
- Modify: `docs/LITELLM.md` (seção "Modelos": preços vêm do LiteLLM; os campos em Modelos viram informativos)
- Test: `backend/test/model-pricing-sync.test.cjs`

**Interfaces:**
- `ModelPricingSyncService.sync(): Promise<{ updated: number; unknown: string[] }>` — `GET /model/info` via `litellmCall` (de `litellm-admin.ts`); para cada `data[i]` com `model_name` igual a um `ai_models.slug` (ignorando entradas com `*`): grava `inputPrice = model_info.input_cost_per_token * 1e6`, `outputPrice = output_cost_per_token * 1e6`, `cachedInputPrice = cache_read_input_token_cost * 1e6` (ou `null`), `capabilities.contextWindow = max_input_tokens` quando válido. Slugs do catálogo sem entrada → `unknown`.
- Agenda: ao iniciar a API (1 min depois) e a cada 6 h, no mesmo padrão de `backend/src/retention`; desligado quando `OMNIROUTER_BASE_URL` vazio.

- [ ] **Step 1: Teste** — servidor HTTP falso em `/model/info` com dois modelos (um com cache price, outro sem) e um curinga `openai/*`; Prisma em memória com três slugs; asserts: `updated === 2`, preços em USD/milhão com 6 casas, `unknown === ['anthropic/x']`, curinga ignorado; erro HTTP → lança `ServiceUnavailableException` sem alterar nada.
- [ ] **Step 2: Rodar e ver falhar.** — [ ] **Step 3: Implementar.** — [ ] **Step 4: `npm test` PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): sincroniza preços e contexto dos modelos a partir do LiteLLM"`

---

### Task 4 (SGDM): geração de peças pelo LiteLLM, com chave da plataforma quando a prefeitura não tem a sua

**Files (repositório `prefeitura/SGDM/apps/api`):**
- Create: `src/modules/ia/providers/litellm.provider.ts`
- Modify: `src/modules/ia/providers/ia-provider.interface.ts` (`IaRequisicao` += `tenantId: string; usuarioId?: string`; `apiKey: string | null`)
- Modify: `src/modules/ia/ia-provider.registry.ts` (`obter(codigo)` devolve `LiteLlmProvider` para `OPENAI|GEMINI|ANTHROPIC` quando `litellm.url` está configurado; senão os adapters atuais)
- Modify: `src/modules/configuracoes-ia/configuracoes-ia.service.ts` (`resolver()` e `status()`)
- Modify: `src/modules/ia/ia.service.ts` (passar `tenantId`/`usuarioId` em cada `provider.gerar`)
- Test: `src/modules/ia/__tests__/litellm.provider.spec.ts`, `src/modules/configuracoes-ia/__tests__/configuracoes-ia-litellm.spec.ts`

**Interfaces:**
- `class LiteLlmProvider implements IaProvider { constructor(readonly codigo: 'OPENAI'|'GEMINI'|'ANTHROPIC', url: string, adminKey: string); readonly modeloPadrao: string /* mesmo dos adapters atuais */; gerar(req) }` — `POST ${url}/v1/chat/completions` com `Authorization: Bearer <adminKey>`, corpo `{ model: '<prefixoDoGateway(codigo)>/<req.modelo>', messages: [system, user], max_tokens, temperature (regra `suportaTemperatura` da OpenAI mantida), user: req.tenantId, metadata: { tags: ['origem:sgdm-pecas', ...(usuarioId ? ['usuario:'+usuarioId] : [])] }, ...(req.apiKey ? { api_key: req.apiKey } : {}) }`. Erros: 401/403 → `IaProviderError('CREDENCIAL', 'A chave de IA não está cadastrada para este provedor. Cadastre a chave da prefeitura em Cadastros › IA ou a chave da plataforma na Central de IA.')`; demais via `classificarStatus`.
- `ConfiguracoesIaService.resolver(tenantId)`: com `litellm.url` configurado, nunca lança por falta de chave: devolve `apiKey: null` quando `!habilitado || !chave` (chave da plataforma no gateway). `status()`: `habilitado = litellmConfigurado || (row.habilitado && Boolean(chave))`.

- [ ] **Step 1: Testes** — provider: corpo com `model`, `user`, `metadata.tags`, `api_key` presente/ausente; 401 → mensagem acima; 200 → `{ texto, tokensEntrada, tokensSaida }`. Registry: com `litellm.url` → instância `LiteLlmProvider` com o código pedido; sem → adapter atual. Configurações: `resolver` sem chave e com LiteLLM → `apiKey null`; sem LiteLLM → 403 como hoje; `status` idem.
- [ ] **Step 2: `npx jest --runInBand src/modules/ia src/modules/configuracoes-ia` — FAIL.** — [ ] **Step 3: Implementar.** — [ ] **Step 4: mesmo comando — PASS.**
- [ ] **Step 5: Commit (só estes arquivos)** — `git commit -m "feat(ia): geração de peças pelo LiteLLM com chave da prefeitura ou da plataforma"`

---

### Task 5 (SGDM): permissão `IA_CENTRAL` e menu

**Files (repositório `prefeitura/SGDM`):**
- Create: `apps/api/prisma/migrations/20261027100000_ia_central_permissao/migration.sql` (padrão de `20261101100000_manual_sistema_permissao`: insere `IA_CENTRAL` módulo `ia`, descrição "Central de IA: consumo, custos, modelos e limites de todas as prefeituras"; concede só a `DONO_PLATAFORMA`)
- Modify: `apps/api/prisma/seed.ts` (`PERMISSOES` += `IA_CENTRAL`; `PERMISSOES_SO_PLATAFORMA` += `IA_CENTRAL`)
- Modify: `apps/api/src/common/utils/escalonamento-privilegio.util.ts` (`PERMISSOES_RESERVADAS_PLATAFORMA` += `IA_CENTRAL`)
- Modify: `apps/web/lib/permissoes.ts` (`PERMISSAO_LABELS`, `PERMISSAO_GUIA`, `PERMISSOES_SO_PLATAFORMA` += `IA_CENTRAL`; `MODULO_LABELS.ia = 'Inteligência Artificial'`)
- Modify: `apps/web/lib/navigation.ts` (`IA_NAV_FILTERED` += `{ href: '/central-ia', label: 'Central de IA', icon: 'Gauge', permissions: ['IA_CENTRAL'] }`; em `getSecoesVisiveis`, a seção `ia` é filtrada por permissão mesmo para DONO_PLATAFORMA sem prefeitura selecionada), `apps/web/lib/nav-icons.ts` (`Gauge`), `apps/web/lib/constants.ts` (`PAGE_TITLES['/central-ia'] = 'Central de IA'`, `['/central-ia/consumo'] = 'Consumo e custo'`)
- Modify: `apps/web/public/ajuda/manual.html` (artigo `permissoes-ia` ganha a entrada `#permissao-IA_CENTRAL`)
- Test: `apps/web/lib/__tests__/permissoes.test.ts`, `apps/web/lib/__tests__/navigation.test.ts` (snapshots de DONO_PLATAFORMA atualizados com `-u` só para esse arquivo), `apps/api/src/common/__tests__/permissoes-em-migration.spec.ts` (já cobre a regra)

- [ ] **Step 1: Testes** — web: migration concede `IA_CENTRAL` só ao `DONO_PLATAFORMA`; `PERMISSOES_SO_PLATAFORMA` contém; rótulo, guia e manual existem; `getSecoesVisiveis(dono, null)` inclui a seção `ia` com `/central-ia`; `getSecoesVisiveis(administrador, null)` não inclui `/central-ia`.
- [ ] **Step 2: `npx vitest run lib/__tests__/permissoes.test.ts lib/__tests__/navigation.test.ts` — FAIL.** — [ ] **Step 3: Implementar; aplicar a migration no banco local (`psql` como em Entrega 0 do SGDM) e `npx prisma migrate resolve --applied ...`.** — [ ] **Step 4: vitest PASS; `npx jest --runInBand src/common/__tests__/permissoes-em-migration.spec.ts` PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): permissão IA_CENTRAL e item Central de IA no menu"`

---

### Task 6 (SGDM API): módulo `central-ia`

**Files (`prefeitura/SGDM/apps/api/src/modules/central-ia/`):**
- Create: `litellm-admin.client.ts`, `central-ia.service.ts`, `central-ia.controller.ts`, `central-ia.module.ts`, `dto/periodo.dto.ts`, `central-ia.regras.ts`
- Modify: `src/app.module.ts` (importar `CentralIaModule`)
- Test: `__tests__/central-ia.service.spec.ts`, `__tests__/central-ia.regras.spec.ts`, `__tests__/periodo.dto.spec.ts`

**Interfaces:**
- `LiteLlmAdminClient.get<T>(path: string, query: Record<string, string>): Promise<T>` — `${litellm.url}${path}?…` com `Authorization: Bearer ${litellm.adminKey}`, timeout 15 s; rede/timeout → `ServiceUnavailableException('O gateway de IA não respondeu.')`; HTTP ≠ 2xx → `BadGatewayException('O gateway de IA recusou a consulta (HTTP n).')`; sem `litellm.url` → `ServiceUnavailableException('Central de IA não configurada no servidor.')`.
- `PeriodoDto { inicio: string /* YYYY-MM-DD */; fim: string; tenantId?: string }` — `fim >= inicio`, diferença ≤ 366 dias (validador em `central-ia.regras.ts`: `periodoValido(inicio, fim): boolean`).
- `CentralIaService.visaoGeral(p): Promise<VisaoGeral>` com `{ gastoUsd, chamadas, erros, tokensEntrada, tokensSaida, tokensCache, economiaCacheUsd, prefeiturasAtivas, usuariosAtivos, conversas, custoPorConversaUsd, porDia: {data, gastoUsd, chamadas}[], porProvedor: {provedor, gastoUsd}[], porOrigem: {origem, chamadas, gastoUsd}[] }` — fontes: `/customer/daily/activity/aggregated` (metadata + breakdown.providers + entities = prefeituras) e `/tag/daily/activity/aggregated` (entities com prefixo `origem:`, `usuario:`, `conversa:`); `custoPorConversaUsd = gastoUsd / conversas` (0 quando não há conversas).
- `CentralIaService.consumo(p, agrupar: 'prefeitura'|'usuario'|'modelo'|'origem'|'provedor'): Promise<LinhaConsumo[]>` com `{ id, nome, chamadas, tokensEntrada, tokensSaida, tokensCache, gastoUsd, conversas, custoPorConversaUsd }`; nomes: prefeitura via `prisma.tenant`, usuário via `prisma.usuario` (id → `nome`; desconhecido → id abreviado), modelo/provedor/origem = o próprio valor. `tenantId` filtra (`entities` do customer) e, para `usuario`, restringe às tags do customer (query `api_key`/`user_id` não servem: usar `/customer/daily/activity?end_user_ids=` quando `tenantId` vier; sem `tenantId`, o agregado global).
- `CentralIaService.exportarCsv(p, agrupar): string` — cabeçalho em português, separador `;`, UTF-8 com BOM.
- Controller `@Controller('central-ia')`, `@RequirePermissions('IA_CENTRAL')` em todas as rotas: `GET visao-geral`, `GET consumo?agrupar=`, `GET consumo.csv?agrupar=` (`Content-Disposition: attachment; filename="central-ia-consumo.csv"`). `@ApiExcludeController()` não (é rota de usuário); Swagger normal.
- `central-ia.regras.ts`: `periodoValido`, `agruparTags(entities, prefixo)`, `custoPorConversa(gasto, conversas)`, `linhasDe(...)` — funções puras testadas sem HTTP.

- [ ] **Step 1: Testes** — regras: `periodoValido('2026-10-01','2026-09-30') === false`, 367 dias false, 366 true; `agruparTags` ignora tags de outro prefixo e soma `metrics`; `custoPorConversa(10, 0) === 0`. Service (client mockado com as formas de resposta reais capturadas em `__tests__/fixtures/litellm-*.json`): `visaoGeral` soma e converte; `consumo('prefeitura')` nomeia pela tabela `tenant`; LiteLLM 500 → `BadGatewayException`; sem `litellm.url` → 503 sem chamar o client. DTO: `inicio` inválido → erro de validação.
- [ ] **Step 2: `npx jest --runInBand src/modules/central-ia` — FAIL.** — [ ] **Step 3: Implementar.** — [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): API da Central de IA (visão geral e consumo) sobre o LiteLLM"`

---

### Task 7 (SGDM web): telas Visão geral e Consumo e custo

**Files (`prefeitura/SGDM/apps/web/`):**
- Create: `app/(dashboard)/central-ia/page.tsx`, `app/(dashboard)/central-ia/consumo/page.tsx`
- Create: `components/central-ia/CartoesResumo.tsx`, `components/central-ia/GraficoDiario.tsx` (recharts `BarChart`, padrão de `components/relatorios/RelatorioBarChart.tsx`), `components/central-ia/TabelaConsumo.tsx` (`DataTable`), `components/central-ia/SeletorPeriodo.tsx` (Hoje / 7 dias / 30 dias / Mês; estado na URL via `lib/lista-url.ts`)
- Create: `lib/central-ia-api.ts` (`buscarVisaoGeral(token, p)`, `buscarConsumo(token, p, agrupar)`, `urlCsv(p, agrupar)`), `lib/central-ia.ts` (`formatarUsd(n)`, `formatarBrl(n, cotacao)`, `periodoPadrao(hoje, preset)`, `rotuloOrigem(origem)`)
- Test: `lib/__tests__/central-ia.test.ts`

**Interfaces:**
- Consome a API da Task 6. Página sem permissão → `router.replace('/dashboard')` (padrão das páginas gated por `hasPermission`).
- Cotação US$→R$: `NEXT_PUBLIC_COTACAO_USD` (número; ausente → mostra só US$). Decisão do autor para esta entrega; configuração por tela fica para a entrega 3.
- Estados: carregando (`Skeleton`), erro (`EmptyState` com mensagem da `ApiError` e botão "Tentar novamente"), vazio ("Sem consumo no período").

- [ ] **Step 1: Testes** — `formatarUsd(0.00636) === 'US$ 0,0064'`; `formatarUsd(184.2) === 'US$ 184,20'`; `formatarBrl(184.2, 5.6) === 'R$ 1.031,52'`; `periodoPadrao(new Date('2026-10-26'), '7d')` → `{ inicio: '2026-10-20', fim: '2026-10-26' }`; `rotuloOrigem('sgdm-pecas') === 'SGDM · peças'`.
- [ ] **Step 2: `npx vitest run lib/__tests__/central-ia.test.ts` — FAIL.** — [ ] **Step 3: Implementar páginas e componentes.** — [ ] **Step 4: vitest PASS; `npx tsc --noEmit -p apps/web` sem erros novos; abrir `http://localhost:3000/central-ia` como `owner@sgdm.app` pelo proxy local e conferir as duas telas com dados reais do LiteLLM local.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): telas Visão geral e Consumo e custo da Central de IA"`

---

### Task 8: documentação e fumaça

- Modify: `docs/LITELLM.md` (i7Ai): seção "Central de IA no SGDM" (o que é, quem vê, de onde vêm os números, tags por chamada).
- Modify: `prefeitura/SGDM/docs/deploy-portainer.md`: variáveis `LITELLM_*` já descritas na Entrega 0; acrescentar "Central de IA exige `IA_CENTRAL`".
- Fumaça local (proxy `scripts/local-sgdm-proxy.cjs`): chat no i7Ai → `/spend/logs` do LiteLLM mostra `user` = prefeitura e `request_tags` com `origem:i7ai-chat`; peça gerada no SGDM → `origem:sgdm-pecas`; Central mostra as duas origens e o custo por conversa.
- [ ] Commit da documentação em cada repositório.
