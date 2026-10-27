# Pesquisa na internet e em compras públicas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Todo agente da IA do SGDM pesquisa na internet (Serper/Google) e em compras públicas (PNCP) quando a prefeitura tem a pesquisa ligada pelo dono na Central, sem o usuário configurar nada, com fontes e custo visíveis.

**Architecture:** O SGDM ganha um item de otimização `PESQUISA_INTERNET` (alvo todos/prefeitura) e a chave do Serper + custo por pesquisa na configuração da plataforma, servidos ao i7Ai por `/integracoes/i7ai/*`. O i7Ai oferece duas funções embutidas ao modelo no laço de ferramentas do OmniRouter, executa-as localmente (Serper e PNCP), registra cada pesquisa numa tabela nova e expõe o total ao SGDM, que mostra na Central.

**Tech Stack:** i7Ai: NestJS + Prisma + node:test (backend), React/Vite + `@sgdm/design` (frontend). SGDM: NestJS + Prisma + Jest (api), Next.js + Vitest (web).

**Spec:** `docs/superpowers/specs/2026-10-27-pesquisa-na-internet-design.md`

Repos: i7Ai `C:/xampp/htdocs/producao/i7ai-IA` (branch `feat/central-ia`); SGDM worktree `C:/xampp/htdocs/producao/prefeitura/SGDM-central-ia` (branch `feat/central-ia`). Nunca tocar `C:/xampp/htdocs/producao/prefeitura/SGDM`.

## Global Constraints

- Usuário não vê nem configura nada técnico; nenhum texto visível diz "i7Ai" (usar "IA do SGDM").
- Padrão da pesquisa: **desligada**; liga o dono (`IA_CENTRAL`) em Central de IA › Otimização, alvo "todas as prefeituras" ou uma prefeitura.
- Saída de rede só para `google.serper.dev` (POST `https://google.serper.dev/search`, cabeçalho `X-API-KEY`) e `pncp.gov.br`; tempo limite 10 s por chamada; corpo de resposta lido até 1 MB.
- PNCP: busca `GET https://pncp.gov.br/api/search/?q=<termo>&tipos_documento=<edital|ata|contrato>&pagina=1&tam_pagina=10[&ufs=<UF>]`; itens `GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{sequencial}/itens?pagina=1&tamanhoPagina=50`; resultado de item `GET .../itens/{numeroItem}/resultados`; link ao usuário `https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}`.
- Até **5 pesquisas por resposta** (internet + compras somadas); cada busca de compras detalha até **5 compras** na mesma chamada; resultado de cada ferramenta cortado a **12.000 caracteres** antes de ir ao modelo.
- Termo enviado ao Serper passa por `maskPersonalData` (`backend/src/sgdm/personal-data.ts`).
- Chave do Serper: cifrada no SGDM (`criptografarSecret`/`descriptografarSecret` de `apps/api/src/common/utils/crypto-secret.util.ts`), nunca devolvida à tela (só final mascarado), nunca em log/auditoria.
- Custo por pesquisa na internet: configurável pelo dono, padrão **US$ 0,001**; PNCP custa 0 e também é registrado.
- Pesquisa só no caminho OmniRouter/LiteLLM; modelo sem `supportsTools` não recebe as funções.
- Testes focados (máquina de 16 GB): i7Ai `cd backend && npm run build && node --test <arquivos>`; SGDM `cd apps/api && npx jest --runInBand <specs>`, web `npx vitest run <arquivos>`. Nunca usar banco existente como shadow; migrations escritas à mão.
- Commits só com caminhos explícitos; nunca stash/reset/checkout de arquivos alheios. Sem deploy.

## Review Focus

1. PNCP fora do ar ou lento → a ferramenta devolve "fonte não respondeu" ao modelo e a resposta sai com o resto; o chat nunca quebra (teste na Task 4 e Task 6).
2. Termo com CPF/telefone indo ao Serper → sai mascarado (teste na Task 6).
3. Modelo pedindo a 6ª pesquisa → recebe "limite de pesquisas desta resposta atingido" e conclui; não estoura o teto de 8 rodadas (teste na Task 6).
4. Resposta final sem nenhum link mesmo tendo pesquisado → servidor acrescenta "Fontes" com os links coletados, no streaming e fora dele (teste na Task 6).
5. SGDM sem chave do Serper cadastrada e pesquisa ligada → só a função de compras é oferecida (PNCP não precisa de chave) (teste na Task 6).

---

### Task 1 (SGDM API): item `PESQUISA_INTERNET` e configuração da plataforma

**Files:**
- Modify: `apps/api/src/modules/central-ia/otimizacao.regras.ts` — `ITENS_OTIMIZACAO` += `'PESQUISA_INTERNET'`; `ESCOPOS_POR_ITEM.PESQUISA_INTERNET = ['TODOS','PREFEITURA']`; `OtimizacaoEfetiva` += `pesquisaInternet: { ligado: boolean }`; `PADROES_OTIMIZACAO.pesquisaInternet = { ligado: false }`; `CHAVE_DO_ITEM.PESQUISA_INTERNET = 'pesquisaInternet'`; `PARAMETROS.PESQUISA_INTERNET = {}`.
- Create migration `apps/api/prisma/migrations/20261216100000_ia_pesquisa_internet/migration.sql`: `ALTER TABLE ia_configuracao_plataforma ADD COLUMN IF NOT EXISTS serper_chave TEXT, ADD COLUMN IF NOT EXISTS custo_pesquisa_usd DECIMAL(10,6) NOT NULL DEFAULT 0.001;` + schema.prisma (`serperChave String? @map("serper_chave")`, `custoPesquisaUsd Decimal @default(0.001) @map("custo_pesquisa_usd") @db.Decimal(10,6)`).
- Modify: `configuracao.service.ts` / `configuracao.controller.ts` / dto — `ConfiguracaoPlataforma` += `serperChaveMascarada: string | null`, `custoPesquisaUsd: number`; `salvar` aceita `serperChave?: string` (string vazia = remover; não vazia = cifrar e gravar) e `custoPesquisaUsd?: number` (0 a 1); `POST central-ia/configuracao/serper/testar` → `{ ok: boolean; mensagem: string }` (POST ao Serper com `q: "teste"`, `num: 1`, 8 s).
- Create: `apps/api/src/modules/central-ia/i7ai-pesquisa.controller.ts` — `GET integracoes/i7ai/pesquisa` com o mesmo verificador de chave e `@SkipThrottle` de `i7ai-acesso.controller.ts` → `{ serperChave: string | null; custoPesquisaUsd: number }`.
- Tests: `__tests__/otimizacao.regras.spec.ts`, `__tests__/configuracao.spec.ts`, create `__tests__/i7ai-pesquisa.controller.spec.ts`.

**Interfaces — Produces:** `OtimizacaoEfetiva.pesquisaInternet`; `GET integracoes/i7ai/pesquisa` → `{ serperChave: string | null; custoPesquisaUsd: number }`; `ConfiguracaoPlataforma.serperChaveMascarada`, `.custoPesquisaUsd`.

- [ ] **Step 1: Tests**
  - regras: `PADROES_OTIMIZACAO.pesquisaInternet` é `{ ligado: false }`; item com `agenteId` → recusado (escopo).
  - configuração: salvar `serperChave: 'abc123xyz'` grava cifrado (valor no banco ≠ `'abc123xyz'`), `obter()` devolve `serperChaveMascarada` terminando em `'3xyz'` e nunca a chave; `serperChave: ''` → `null`; `custoPesquisaUsd: 2` → 400.
  - integração: sem chave de integração → 404; chave errada → 401; com chave → `{ serperChave: 'abc123xyz', custoPesquisaUsd: 0.001 }`.
  - testar: Serper 200 → `{ ok: true }`; 403 → `{ ok: false, mensagem: 'O Serper recusou a chave.' }`; log não contém a chave.
- [ ] **Step 2:** `cd apps/api && npx jest --runInBand src/modules/central-ia/__tests__/otimizacao.regras.spec.ts src/modules/central-ia/__tests__/configuracao.spec.ts src/modules/central-ia/__tests__/i7ai-pesquisa.controller.spec.ts` → FAIL.
- [ ] **Step 3:** Implementar; aplicar a migration no banco local com `npx prisma migrate deploy`.
- [ ] **Step 4:** mesmo comando → PASS; `npx jest --runInBand src/modules/central-ia` → PASS; `npx tsc --noEmit -p apps/api`.
- [ ] **Step 5:** commit `feat(ia): pesquisa na internet como item da Central e chave do Serper na plataforma`.

### Task 2 (SGDM web): chave, custo e interruptor

**Files:** `apps/web/app/(dashboard)/central-ia/otimizacao/page.tsx` (linha do item "Pesquisa na internet", com o aviso "Com a pesquisa ligada, as automações desta prefeitura deixam de reaproveitar respostas guardadas."); a seção de chaves da plataforma em Modelos e acesso (campo "Pesquisa na internet (Serper)", "Testar", máscara) e o campo "Custo por pesquisa (US$)"; `apps/web/lib/central-ia-otimizacao.ts` (rótulo do item), `apps/web/lib/central-ia-api.ts` (tipos); testes vitest dos libs tocados.

**Interfaces — Consumes:** Task 1.

- [ ] **Step 1: Tests (vitest):** rótulo `PESQUISA_INTERNET` = "Pesquisa na internet"; escopos oferecidos = todas/prefeitura; payload de salvar com chave vazia envia `serperChave: ''` só quando o usuário clicou em "Remover".
- [ ] **Step 2:** rodar → FAIL. **Step 3:** implementar. **Step 4:** vitest PASS, `npx tsc --noEmit -p apps/web`, `npx next lint --dir "app/(dashboard)/central-ia" --dir components/central-ia --dir lib` sem erros.
- [ ] **Step 5:** commit `feat(ia): Central liga a pesquisa na internet e guarda a chave do Serper`.

### Task 3 (i7Ai backend): configuração da pesquisa e registro

**Files:**
- Modify: `backend/src/sgdm/optimization-defaults.ts` (`pesquisaInternet: { ligado: false }`, idêntico ao SGDM) e o tipo usado pelo `SgdmOptimizationService`.
- Create: `backend/src/research/research-config.service.ts` — `ResearchConfigService.get(): Promise<{ serperKey: string | null; costPerSearchUsd: number }>` lendo `GET /integracoes/i7ai/pesquisa` via `cached-fetch` (60 s; falha → `{ serperKey: null, costPerSearchUsd: 0.001 }` por 15 s; nunca loga a chave).
- Migration `backend/prisma/migrations/20261101000100_research_calls/migration.sql` + schema: `model ResearchCall { id uuid; tenantId uuid; userId uuid?; agentId uuid?; conversationId uuid?; source String /* web | pncp */; status String /* ok | erro | limite */; costUsd Decimal(12,6) default 0; createdAt DateTime default now(); @@index([tenantId, createdAt]); @@map("research_calls") }`.
- Create: `backend/src/research/research.module.ts` (exporta o serviço; importado onde o gateway precisar).
- Test: `backend/test/research-config.test.cjs`.

**Interfaces — Produces:** `ResearchConfigService.get()`; tabela `research_calls`; `optimization.pesquisaInternet.ligado`.

- [ ] **Step 1: Tests:** SGDM responde `{ serperChave:'k', custoPesquisaUsd:0.002 }` → `{ serperKey:'k', costPerSearchUsd:0.002 }`; SGDM 503 → `serperKey: null`; duas chamadas em 60 s → 1 fetch; `OPTIMIZATION_DEFAULTS.pesquisaInternet.ligado === false`.
- [ ] **Step 2–4:** `cd backend && npm run build && node --test test/research-config.test.cjs` FAIL → implementar (+ `npx prisma migrate deploy` local) → PASS.
- [ ] **Step 5:** commit `feat(ia): configuração e registro das pesquisas na IA do SGDM`.

### Task 4 (i7Ai backend): clientes Serper e PNCP

**Files:** Create `backend/src/research/serper.client.ts`, `backend/src/research/pncp.client.ts`, `backend/src/research/research-text.ts`; Test `backend/test/research-clients.test.cjs` (fetch simulado; nenhum teste vai à rede).

**Interfaces — Produces:**
```ts
type Fonte = { titulo: string; link: string };
searchWeb(query: string, key: string, signal?: AbortSignal): Promise<{ resultados: { titulo: string; link: string; trecho: string }[] }>; // até 8 de `organic`
searchPurchases(input: { termo: string; tipo?: 'edital' | 'ata' | 'contrato'; uf?: string }, signal?: AbortSignal): Promise<{ compras: CompraPncp[] }>;
type CompraPncp = { orgao: string; municipio: string; uf: string; modalidade: string; data: string; link: string;
  itens: { descricao: string; unidade: string; quantidade: number; precoEstimado: number | null; precoContratado: number | null }[] };
clip(value: unknown, maxChars = 12000): string; // JSON truncado com marcador "…(cortado)"
```
`searchPurchases`: busca (padrão `tipo` = `edital`), pega até 5 compras, para cada uma lê `/itens` e mantém só os itens cuja `descricao` contém alguma palavra (≥ 4 letras, sem acento, minúscula) do termo; para cada item mantido com `temResultado` lê `/resultados` e usa `valorUnitarioHomologado`. Uma compra que falhar é pulada.

- [ ] **Step 1: Tests:** Serper recebe POST com `X-API-KEY` e `{ q, gl:'br', hl:'pt-br', num: 8 }`; 403 → erro `SERPER_RECUSOU`; PNCP busca com `ufs=MT` quando `uf:'MT'`; termo "arroz merenda" mantém item "ARROZ TIPO 1" e descarta "AÇÚCAR"; item com resultado → `precoContratado` preenchido; compra cujo `/itens` dá 500 é pulada e as demais voltam; timeout de 10 s respeitado (AbortSignal); `link` = `https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}`; `clip` de 20 mil caracteres termina com `…(cortado)`.
- [ ] **Step 2–4:** `node --test test/research-clients.test.cjs` FAIL → implementar → PASS.
- [ ] **Step 5:** commit `feat(ia): clientes de pesquisa no Google (Serper) e em compras públicas (PNCP)`.

### Task 5 (i7Ai backend): funções embutidas no laço de ferramentas

**Files:** Create `backend/src/research/research-tools.ts`; Modify `backend/src/ai/omnirouter.service.ts` (laço das linhas ~153–200), `backend/src/ai/ai-gateway.service.ts` (montagem das funções ~260 e instruções), `backend/src/ai/instructions.ts`; Test `backend/test/research-tools.test.cjs` e acréscimos em `backend/test/omnirouter.test.cjs`.

**Interfaces — Consumes:** Tasks 3 e 4. **Produces:**
```ts
const BUILTIN_WEB = 'pesquisar_internet';      // args { consulta: string (3..300) }
const BUILTIN_PNCP = 'pesquisar_compras_publicas'; // args { termo: string (3..200), tipo?: 'edital'|'ata'|'contrato', uf?: string (2 letras) }
builtinResearchFunctions(opts: { web: boolean; pncp: boolean }): AgentFunction[]; // toolId 'builtin:web' / 'builtin:pncp'
class ResearchSession { constructor(ctx: { tenantId; userId?; agentId; conversationId?; serperKey: string | null; costPerSearchUsd: number }, deps);
  execute(call: AgentToolCall): Promise<AgentToolResult>; // conta, mascara, registra, coleta fontes
  readonly sources: Fonte[]; }
appendSourcesIfMissing(answer: string, sources: Fonte[]): string; // acrescenta "\n\n**Fontes**\n- [titulo](link)" (até 10, sem repetir) se nenhum link coletado aparece na resposta
RESEARCH_INSTRUCTIONS: string; // bloco do prompt, só quando há função de pesquisa
```
Regras: as funções embutidas só entram quando `optimization.pesquisaInternet.ligado`, o caminho é OmniRouter e o modelo tem `supportsTools`; `web` só com `serperKey`. A 6ª chamada de pesquisa numa resposta devolve ao modelo `{ erro: 'Limite de 5 pesquisas desta resposta atingido. Responda com o que já encontrou.' }` (registro `status: 'limite'`, custo 0). Cada chamada passa pelo limite por minuto do usuário existente (`sgdm-limits`). Erro de fonte → `{ erro: 'A fonte não respondeu agora.' }`, `status: 'erro'`, custo 0. Termo do Serper passa por `maskPersonalData`. As funções embutidas são executadas pela `ResearchSession`, nunca por `agentTools.execute`; ferramentas do agente continuam como hoje. No streaming, as fontes acrescentadas saem como último delta antes do fim.

`RESEARCH_INSTRUCTIONS` (texto exato):
"Você pode pesquisar na internet e em compras públicas (PNCP). Pesquise quando o pedido precisar de informação atual ou de fora da prefeitura, como preços praticados, normas, índices e notícias. Toda informação que vier de pesquisa deve trazer o link da fonte. Nunca invente preço, número, data ou norma: se não encontrar, diga que não encontrou. Para preços, responda com uma tabela: órgão, município/UF, item, unidade, preço unitário (estimado e contratado, quando houver), data e link; com 3 ou mais preços, informe média, mediana e menor, dizendo se usou o preço contratado ou o estimado. Faça no máximo 5 pesquisas."

- [ ] **Step 1: Tests**
  - `builtinResearchFunctions({web:false,pncp:true})` → só `pesquisar_compras_publicas`.
  - gateway: `pesquisaInternet.ligado=false` → nenhuma função embutida e sem `RESEARCH_INSTRUCTIONS`; ligado sem `serperKey` → só PNCP; modelo `supportsTools:false` → nenhuma.
  - sessão: consulta `'preço CPF 123.456.789-00'` chega ao Serper sem o CPF; 6 chamadas → a 6ª devolve o erro de limite e grava `status:'limite'`; erro do PNCP → `{erro:'A fonte não respondeu agora.'}` e a conversa termina normalmente; cada pesquisa web grava `costUsd` = `costPerSearchUsd`, PNCP grava 0.
  - omnirouter: modelo pede `pesquisar_internet` e depois responde sem links → resposta final termina com "**Fontes**" e o link coletado (streaming e não streaming); resposta que já cita um link coletado → nada é acrescentado.
  - ferramentas do agente (HTTP) continuam sendo executadas por `agentTools.execute` no mesmo laço.
- [ ] **Step 2–4:** `npm run build && node --test test/research-tools.test.cjs test/omnirouter.test.cjs` FAIL → implementar → PASS; `npm test` uma vez.
- [ ] **Step 5:** commit `feat(ia): agentes pesquisam na internet e em compras públicas com fontes e limite por resposta`.

### Task 6 (i7Ai backend): total de pesquisas para a Central

**Files:** Create `backend/src/sgdm/sgdm-research.controller.ts` (+ registro no `SgdmModule`); Test `backend/test/sgdm-research.test.cjs`.

**Interfaces — Produces:** `GET /api/integracoes/sgdm/pesquisas?inicio=YYYY-MM-DD&fim=YYYY-MM-DD[&tenantId=<uuid>]` (mesmo verificador de chave e validação de período das rotas `temas`) →
```ts
{ periodo: { inicio: string; fim: string }; total: number; custoUsd: number;
  porPrefeitura: { tenantId: string; pesquisas: number; internet: number; compras: number; custoUsd: number }[] } // desc por pesquisas
```
Conta só `status = 'ok'`.

- [ ] **Step 1: Tests:** sem chave 404 / chave errada 401; período > 366 dias → 400; 3 pesquisas web (0,001) + 2 PNCP na prefeitura A e 1 web na B → A `{pesquisas:5, internet:3, compras:2, custoUsd:0.003}`, B depois; `status:'erro'` não conta; `tenantId` filtra.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** commit `feat(ia): total de pesquisas por prefeitura para a Central de IA`.

### Task 7 (SGDM API + web): pesquisas na Central

**Files:** Create `apps/api/src/modules/central-ia/i7ai-pesquisas.client.ts` (padrão do `I7aiTemasClient`: 8 s, falha → `null`, `logger.warn` só com status); `GET central-ia/pesquisas` (`@RequirePermissions('IA_CENTRAL')`, `PeriodoDto`) → resposta da Task 6 + `indisponivel: boolean` e nome da prefeitura em cada linha; web: cartão "Pesquisas na internet" na Visão geral (`N pesquisas · US$ X`, "—" quando indisponível) e tabela "Pesquisas por prefeitura" em Consumo e custo; tests jest do client/controller e vitest do formatador.

- [ ] **Step 1: Tests:** client sem `apiUrl` → `null` sem fetch; 500 → `null` e log sem a chave; controller sem `IA_CENTRAL` → 403 (metadados); client `null` → `{ total: 0, custoUsd: 0, porPrefeitura: [], indisponivel: true }`; web: indisponível → "—".
- [ ] **Step 2–4:** FAIL → implementar → PASS; `jest --runInBand src/modules/central-ia`; tsc; lint.
- [ ] **Step 5:** commit `feat(ia): Central mostra as pesquisas na internet e o custo por prefeitura`.

### Task 8: documentação e fumaça

**Files:** i7Ai `docs/LITELLM.md` (seção "Pesquisa na internet": como ligar, fontes, limites, custo, privacidade); SGDM `apps/web/public/ajuda/manual.html` (seção para o dono e para o usuário, sem jargão).

- [ ] **Step 1: Fumaça local** (SGDM + i7Ai + LiteLLM locais):
  1. Pesquisa desligada → "quanto outras prefeituras pagaram em arroz para merenda escolar" não pesquisa e a IA diz que a pesquisa não está liberada.
  2. Ligada só com PNCP (sem chave do Serper) → tabela com ≥ 3 compras, preços e links que abrem no PNCP.
  3. Com chave do Serper (se o dono fornecer uma de teste) → "qual foi o IPCA de setembro" traz número e link; sem chave → SKIPPED.
  4. Central mostra as pesquisas e o custo da prefeitura.
  5. `grep` da chave do Serper e de "X-API-KEY" nos logs das duas APIs e em `audit_logs`/`auditoria_logs` → nada.
- [ ] **Step 2:** commits de documentação em cada repositório com o resultado da fumaça no corpo.
