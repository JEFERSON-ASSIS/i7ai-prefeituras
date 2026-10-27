# Entrega 5 — Fluxo ao vivo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Visão geral da Central de IA ganha o cartão **Fluxo ao vivo**: um diagrama Prefeituras → Origem → LiteLLM → Provedores que se atualiza a cada 10 s, com partículas proporcionais ao volume, cache %, erro % e latência no LiteLLM e gasto por provedor. Clicar numa caixa abre a tela Consumo já filtrada. Antes disso, as leituras globais por tag ficam limitadas (ruling A5 da Entrega 1).

**Architecture:**
- A API do SGDM ganha `GET central-ia/fluxo`. Ela lê **uma janela curta de chamadas** do LiteLLM (`/spend/logs/v2`, últimos 5 min, uma página de no máximo 1.000 linhas) e o gasto de hoje por provedor (`/customer/daily/activity/aggregated` de um dia). Cada leitura fica num cache em memória com uma só requisição em voo; N navegadores abertos geram no máximo uma consulta ao LiteLLM a cada 5 s.
- O SGDM reduz as linhas a contagens (prefeitura, origem, provedor, status, latência, tokens em cache) e devolve só números e ids de prefeitura. Ids de usuário e conversa das tags nunca saem da API.
- A web desenha o diagrama em SVG puro, com `<animateMotion>`. Não há biblioteca nova.
- O fluxo nunca usa os agregados por tag. Mesmo assim, as leituras globais por tag da Visão geral e do Consumo passam a ser paginadas e limitadas.
- Nada muda no i7Ai, só a documentação.

**Tech Stack:**
- SGDM: NestJS + Jest (API); Next.js + React Query + Vitest (web).
- LiteLLM 1.106.4, conferido no container local `i7ai-prefeituras-local-litellm` em 2026-10-27:
  - `/spend/logs/v2`: aceita `start_date`/`end_date` com hora (`YYYY-MM-DD HH:MM:SS`, UTC), `page_size` ≤ 1000 e `exclude_internal_health_checks`, e devolve as linhas em ordem decrescente de `startTime`. Responde com `{ data, total, page, page_size, total_pages, total_is_capped }`.
  - Cada linha traz `status` (`success`|`failure`), `cache_hit` (texto: `'True'`|`'False'`|`'None'`), `request_duration_ms`, `custom_llm_provider`, `end_user`, `spend`, `prompt_tokens`, `request_tags`, `metadata.usage_object.prompt_tokens_details.cached_tokens` e também `api_key`. O `api_key` é um apelido do LiteLLM; mesmo assim, nunca é repassado.
  - `/tag/daily/activity` é paginado (`page`, `page_size` sem máximo, `metadata.total_pages`, `metadata.has_more`), com resultados `{ date, metrics, breakdown.entities }` iguais aos do agregado.
  - `/tag/daily/activity/aggregated` aceita `tags=` (lista separada por vírgula) e devolve só essas entidades.

**Spec:** `docs/superpowers/specs/2026-10-26-central-de-ia-design.md`: §3 (objetivo "fluxo ao vivo"), §4 (visual), §5.1 (Fluxo ao vivo), §6 (leitura de consumo, isolamento), §7, §8 entrega 5, §9 (frequência e animação: SVG puro, sem dependência nova).

**Repositórios:**
- i7Ai: `C:/xampp/htdocs/producao/i7ai-IA`, branch `feat/central-ia` (só `docs/LITELLM.md`).
- SGDM: worktree `C:/xampp/htdocs/producao/prefeitura/SGDM-central-ia`, branch `feat/central-ia`. Nas tasks, os caminhos do SGDM são relativos à raiz do worktree.

**Depende de:**
- Entrega 1: `LiteLlmAdminClient.get`, `CentralIaService`, `central-ia.regras.ts` (`agruparTags`, `metricasDe`, `arredondar`, `abreviarId`), `ErroCentral`, `useFiltrosCentral`, `TabelaConsumo`, `CartoesResumo`.
- Entrega 2: `Agrupamento` com `'agente'` e `'conversa'`, e `MAX_LINHAS_CONVERSA`.
- Entregas 3 e 4: só a Visão geral já tem os cartões de alertas e de sugestões. O fluxo entra entre os cartões de resumo e o gráfico diário. Não dependa de mais nada delas.

**Decisão 12:** nada deste plano vai para produção. O deploy único vem depois da entrega 6.

## Decisões do autor (o que a spec deixa em aberto)

1. **Fonte do fluxo e custo por atualização (resolve A5 para o fluxo).**
   - Cada atualização faz no máximo uma chamada a `/spend/logs/v2`: `start_date = agora − 300 s`, `end_date = agora`, `page_size = 1000`, `page = 1`, `exclude_internal_health_checks = true`, mais `end_user = tenantId` quando houver prefeitura selecionada.
   - Nunca pagina. Com `total > 1000`, os números vêm das 1.000 chamadas mais recentes e a resposta leva `amostra: true`. A tela mostra "Volume alto: números das 1.000 chamadas mais recentes."
   - O gasto de hoje por provedor vem de uma chamada a `/customer/daily/activity/aggregated` só do dia UTC de hoje. O tamanho dela é limitado pelo número de prefeituras.
   - O fluxo nunca chama `/tag/daily/activity*`.
2. **Cache no servidor.**
   - `FluxoCache` em memória no processo da API, chave `tenantId ?? '*'`.
   - Janela: TTL de 5 s. Gasto de hoje: TTL de 60 s.
   - Uma só promessa em voo por chave: pedidos simultâneos esperam a mesma consulta.
   - No máximo 50 chaves; a mais antiga sai.
   - Com duas instâncias da API, cada uma tem o seu cache. É aceitável: duas consultas a cada 5 s.
3. **O que cada número quer dizer** (sobre as linhas da janela; nenhuma chamada → `null`, que a tela mostra como "—", pela regra da Entrega 1):
   - `erroPercentual` = linhas com `status === 'failure'` ÷ linhas × 100, com uma casa decimal.
   - `cachePercentual` = Σ tokens de entrada lidos do cache ÷ Σ `prompt_tokens`, só nas linhas `success`, × 100, com uma casa.
     - Tokens lidos do cache por linha = `metadata.usage_object.prompt_tokens_details.cached_tokens`; na falta, `metadata.usage_object.cache_read_input_tokens`; na falta, 0. O valor é limitado a `prompt_tokens`.
     - O rótulo na tela é "tokens do cache". É o cache de prompt do provedor.
   - `respostasRepetidas` = linhas com `cache_hit === 'True'`, o cache exato do LiteLLM. Aparece no detalhe da caixa LiteLLM.
   - `latenciaP50Ms` e `latenciaP95Ms` = percentil por posição (*nearest rank*) de `request_duration_ms` nas linhas `success` com `cache_hit !== 'True'`. Uma resposta servida do cache exato levaria a mediana para perto de zero.
   - `gastoJanelaUsd` por provedor = Σ `spend` das linhas da janela. `gastoHojeUsd` = `breakdown.providers[p].metrics.spend` somado nos resultados do dia.
4. **Caixas do diagrama.**
   - Prefeituras: as 5 com mais chamadas na janela, com o nome da tabela `tenant`. As demais e as chamadas sem `end_user` somam na caixa "Outras", que tem `id: null`.
   - Origens: sempre 4, nesta ordem: `i7ai-chat`, `i7ai-automacao`, `sgdm-pecas`, `outras`. `outras` reúne a tag `origem:sgdm-teste`, a `origem:central-teste` e as chamadas sem tag `origem:`.
   - LiteLLM: uma caixa.
   - Provedores: a união dos provedores da janela e dos de hoje. `custom_llm_provider` vazio vira `'desconhecido'`.
   - Ligações: prefeitura → origem (contagem por par) e provedor (contagem por provedor). A ligação origem → LiteLLM é a soma da origem.
5. **Partículas.** Seja `maximo` a maior contagem entre as ligações do diagrama.
   - `particulas(chamadas, maximo)`: 0 → 0; senão `clamp(round(8 × chamadas ÷ maximo), 1, 8)`.
   - Espessura da ligação: `1,5 + 4,5 × chamadas ÷ maximo` px; com 0 chamadas, 1 px tracejada.
   - Cada partícula percorre a ligação em 2,4 s, com início escalonado (`i × 2,4 ÷ n` s).
   - É proporcional ao volume relativo, e o número absoluto fica escrito na ligação.
6. **Atualização e acessibilidade.**
   - React Query com `refetchInterval` dado por `intervaloFluxo(falhasSeguidas)`: 0 ou 1 falha → 10.000 ms; 2 ou mais → 30.000 ms.
   - `refetchIntervalInBackground: false`: com a aba oculta não há consulta. As animações também param quando `document.visibilityState === 'hidden'`.
   - `prefers-reduced-motion: reduce` → nenhuma partícula. Espessura e números continuam.
   - O SVG tem `role="img"` e um `aria-label` com o resumo, por exemplo "Últimos 5 minutos: 42 chamadas, 2,4% de erro, latência mediana 1,2 s".
   - Logo abaixo, um `<details>` "Ver em tabela" repete todos os números.
   - Cada caixa clicável é um `<a>` focável dentro do SVG, com `aria-label`. Erro alto não depende só de cor: o texto "erro 12,5%" aparece sempre.
7. **LiteLLM fora do ar.** A API mantém o mapeamento da Entrega 1 (503 "O gateway de IA não respondeu."; 502 em HTTP ≠ 2xx).
   - A tela mantém o último retrato desbotado (`opacity-60`), pausa as partículas e marca a caixa LiteLLM em vermelho com "Sem resposta desde HH:MM:SS", no horário do navegador.
   - Sem nenhum retrato anterior, mostra `ErroCentral` com "Tentar novamente".
   - Uma falha do gasto de hoje não derruba a janela: `gastoHojeUsd` fica `null`, e a tela mostra "—".
8. **Clicar filtra o Consumo.** O contrato é o URL que a tela Consumo já lê (`useFiltrosCentral`) mais o filtro de prefeitura que já existe no SGDM (`useTenantContextStore.setOperatingTenantId`), que a spec §6 define como o filtro da Central. Não há parâmetro novo na API.
   - Prefeitura com id → `setOperatingTenantId(id)` e `/central-ia/consumo?periodo=hoje&agrupar=usuario`.
   - "Outras" → `/central-ia/consumo?periodo=hoje&agrupar=prefeitura`, sem mexer na prefeitura selecionada.
   - Origem `o` → `/central-ia/consumo?periodo=hoje&agrupar=origem&destaque=<o>`.
   - LiteLLM → `/central-ia/consumo?periodo=hoje&agrupar=modelo`.
   - Provedor `p` → `/central-ia/consumo?periodo=hoje&agrupar=provedor&destaque=<p>`.
   - `destaque` realça a linha de mesmo `id` na `TabelaConsumo` (`bg-blue-50`, `aria-current="true"`) e abre a página da tabela que a contém. O parâmetro some quando o agrupamento muda.
9. **Leituras globais por tag limitadas (resolve A5 nas telas existentes).**
   - Origens da Visão geral: `/tag/daily/activity/aggregated?tags=` com a lista fixa `TAGS_ORIGEM` (as cinco origens conhecidas). Tamanho limitado.
   - `usuario:`, `agente:` e `conversa:` sem prefeitura: `/tag/daily/activity` paginado, com `page_size = 1000` e no máximo `MAX_PAGINAS_TAGS = 100` páginas. Cada página é somada e descartada, então a memória não cresce com o limite.
   - Consequência aceita: são cerca de 100 mil pares dia × tag (por exemplo, 20 prefeituras × 150 conversas por dia × 30 dias). Acima disso, a Visão geral global de 30 dias mostra o custo por conversa como "—" até o dono escolher um período menor ou uma prefeitura. Se isso acontecer em produção, o próximo passo é um cache de 5 min da leitura global, não um limite maior.
   - Acima do limite:
     - na Visão geral, `usuariosAtivos`, `conversas` e `custoPorConversaUsd` = `null` e `tagsLimitadas: true`. A tela mostra "—" e a dica "Período com conversas demais para contar; escolha um período menor ou filtre uma prefeitura.";
     - no Consumo, `agrupar` `usuario`, `agente` ou `conversa`, sem prefeitura → 400 com a mesma frase.
   - Com prefeitura selecionada, o caminho por `/spend/logs/v2` da Entrega 1 não muda.

## Global Constraints

**Testes (máquina de 16 GB, nunca a suíte inteira):**
- API do SGDM: `cd apps/api && npx jest --runInBand <caminhos da task>`.
- Web do SGDM: `cd apps/web && npx vitest run <arquivos da task>`.
- i7Ai: esta entrega não muda código. Se mudar, `cd backend && npm run build && node --test test/<arquivo>.cjs` e `npm test` uma vez no fim da task.

**Commits:**
- Um por repositório, com `git add <caminhos explícitos>`.
- No i7Ai, nunca `output/verification/**`.
- No SGDM, nunca arquivos fora da task (o checkout principal tem trabalho da Saúde).

**Texto e visual:**
- Textos para o usuário em português; comentários de código em inglês.
- Nenhuma biblioteca nova: o diagrama é SVG puro com `<animateMotion>`.
- Só `PageHeader`, `.card`, `.stat-card`, `DataTable`, `Tabs`, `EmptyState`, `Skeleton`, `Toast`, `recharts` e `lucide-react`.

**Chaves e dados:**
- Nenhuma chave de provedor e nenhuma chave administrativa do LiteLLM em log, auditoria, resposta de API ou navegador.
- A resposta do fluxo leva só contagens, percentuais, US$ e ids e nomes de prefeitura. Nunca ids de usuário ou conversa, tags, `api_key` nem `request_id`.
- O texto das conversas não passa pelo fluxo; `/spend/logs/v2` não o devolve.

**Acesso e isolamento:**
- `GET central-ia/fluxo` com `@RequirePermissions('IA_CENTRAL')` na classe, como as demais rotas `/central-ia/*`. Sem a permissão → 403.
- `tenantId` opcional, uuid, em minúsculas. Com ele, tudo é filtrado por `end_user` / `end_user_ids` e o cache é separado.

**Migrations:** nenhuma nesta entrega, em nenhum dos dois repositórios.

## Review Focus

1. **Janela sem nenhuma chamada** (madrugada, ou prefeitura selecionada sem uso).
   - Esperado: caixas com 0, ligações tracejadas sem partículas e LiteLLM com "—" em cache, erro e latência. Nunca `NaN`, "0%" inventado ou tela vazia.
   - Teste: Task 2 (`resumirJanela([])`) e Task 4 (render com fixture vazia).
2. **LiteLLM cai no meio da observação.**
   - Esperado: o último retrato continua, desbotado, com "Sem resposta desde …", e a consulta passa a cada 30 s depois de duas falhas. Ao voltar, tudo volta sozinho.
   - Teste: Task 3 (`intervaloFluxo`) e Task 4 (estado com `data` anterior e `isError`).
3. **Pico com mais de 1.000 chamadas em 5 min.**
   - Esperado: uma só página lida, `amostra: true` e o aviso "Volume alto…". O tempo de resposta não cresce com o volume.
   - Teste: Task 2, com `total: 4200` no mock: uma única chamada ao client.
4. **Dez abas da Visão geral abertas ao mesmo tempo, ou duas requisições no mesmo milissegundo.**
   - Esperado: uma consulta ao LiteLLM por janela de 5 s.
   - Teste: Task 2 (`Promise.all` de 10 chamadas ao service → `client.get` chamado 2 vezes: janela + hoje).
5. **Usuário com movimento reduzido, ou aba em segundo plano.**
   - Esperado: nenhuma partícula com `prefers-reduced-motion`; nenhuma consulta e nenhuma animação com a aba oculta. Os números continuam no SVG e na tabela.
   - Teste: Task 4 (markup com `animar` verdadeiro e falso, contagem de `animateMotion`).

---

### Task 1 (SGDM API + web): leituras globais por tag limitadas (A5)

Paralelizável com Task 2 e Task 3.

**Files:**
- Modify: `apps/api/src/modules/central-ia/central-ia.service.ts`
  - `tags(p)` sem `tenantId` deixa de chamar `/tag/daily/activity/aggregated` sem filtro.
  - Novo método privado `tagsGlobais(p, prefixos: string[]): Promise<{ entidades: LiteLlmEntidades[]; limitado: boolean }>`, que lê `/tag/daily/activity` paginado com o limite da Decisão 9 e mantém só as entidades dos prefixos pedidos.
  - Novo método privado `origensGlobais(p)`, que lê `/tag/daily/activity/aggregated` com `tags: TAGS_ORIGEM.join(',')`.
  - `visaoGeral` usa `origensGlobais` para `porOrigem` e `tagsGlobais(p, ['usuario:', 'conversa:'])` para usuários e conversas.
  - `consumo(p, 'origem')` sem `tenantId` também usa `origensGlobais`.
  - `consumo` com `agrupar` `usuario`, `agente` ou `conversa`, sem `tenantId`: lança `BadRequestException(MSG_TAGS_LIMITADAS)` quando `limitado`.
- Modify: `apps/api/src/modules/central-ia/central-ia.regras.ts`
  - `export const TAGS_ORIGEM = ['origem:i7ai-chat','origem:i7ai-automacao','origem:sgdm-pecas','origem:sgdm-teste','origem:central-teste']`
  - `export const MAX_PAGINAS_TAGS = 100`
  - `export const MSG_TAGS_LIMITADAS = 'Período com conversas demais para contar; escolha um período menor ou filtre uma prefeitura.'`
  - `VisaoGeral`: `usuariosAtivos: number | null`, `conversas: number | null`, `custoPorConversaUsd: number | null`, `tagsLimitadas: boolean`.
- Modify: `apps/web/lib/central-ia-api.ts` (`VisaoGeral` igual ao da API).
- Modify: `apps/web/components/central-ia/CartoesResumo.tsx`: `null` → "—" (`formatarInteiro`, `formatarCustoPorConversa`), e a dica `MSG_TAGS_LIMITADAS` quando `tagsLimitadas`.
- Modify: `apps/web/app/(dashboard)/central-ia/page.tsx`: a variação do custo por conversa exige `conversas` não nulo nos dois períodos.
- Test: `apps/api/src/modules/central-ia/__tests__/central-ia.service.spec.ts`, `__tests__/central-ia.regras.spec.ts`, `apps/web/lib/__tests__/central-ia.test.ts`.

**Interfaces:**
- Consumes: `LiteLlmAdminClient.get`, `agruparTags`, `conversasDasTags` (Entrega 1).
- Produces: `VisaoGeral` com campos anuláveis e `tagsLimitadas`; `TAGS_ORIGEM` e `MAX_PAGINAS_TAGS`.

- [ ] **Step 1: Testes** (client mockado por caminho)
  - `visaoGeral` sem `tenantId`:
    - chama `/tag/daily/activity/aggregated` com `tags` igual a `TAGS_ORIGEM.join(',')`;
    - nunca chama `/tag/daily/activity/aggregated` sem `tags`.
  - Três páginas de `/tag/daily/activity` (`has_more` true, true, false) → `usuariosAtivos` e `conversas` somam as três; `tagsLimitadas false`.
  - `metadata.total_pages: 101` na primeira página → só uma chamada a `/tag/daily/activity`; `usuariosAtivos`, `conversas` e `custoPorConversaUsd` `null`; `tagsLimitadas true`; status 200.
  - `consumo(p, 'conversa')` sem `tenantId` e com 101 páginas → `BadRequestException` com `MSG_TAGS_LIMITADAS`.
  - Com `tenantId`: nenhuma chamada a `/tag/daily/activity*`. O caminho de `/spend/logs/v2` não muda.
  - Web: `formatarInteiro(null) === '—'` (já existe) e o `VisaoGeral` tipado aceita `null`.
- [ ] **Step 2: Rodar e ver falhar** — `cd apps/api && npx jest --runInBand src/modules/central-ia/__tests__/central-ia.service.spec.ts src/modules/central-ia/__tests__/central-ia.regras.spec.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**
  - O comando do Step 2 → PASS.
  - `npx jest --runInBand src/modules/central-ia` → PASS.
  - `cd apps/web && npx vitest run lib/__tests__/central-ia.test.ts` → PASS.
  - `npx tsc --noEmit -p .` sem erros novos.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/central-ia apps/web/lib/central-ia-api.ts apps/web/components/central-ia/CartoesResumo.tsx "apps/web/app/(dashboard)/central-ia/page.tsx" apps/web/lib/__tests__/central-ia.test.ts && git commit -m "fix(ia): leituras globais por tag da Central limitadas e paginadas"`

---

### Task 2 (SGDM API): `GET central-ia/fluxo`

Paralelizável com Task 1 e Task 3.

**Files:**
- Create: `apps/api/src/modules/central-ia/fluxo.regras.ts` (funções puras):
  - `JANELA_SEGUNDOS = 300`, `MAX_LINHAS_JANELA = 1000`, `TOP_PREFEITURAS = 5`
  - `ORIGENS_FLUXO = ['i7ai-chat','i7ai-automacao','sgdm-pecas','outras'] as const`
  - `origemDaLinha(tags: unknown): OrigemFluxo`. As tags que não são texto são ignoradas, o que fecha o minor "acumularLogs assume strings" da Entrega 1.
  - `percentil(valores: number[], p: number): number | null`, por posição (*nearest rank*).
  - `resumirJanela(linhas: LinhaLog[], total: number): JanelaResumo`, com tudo da Decisão 3 e 4, exceto os nomes e o gasto de hoje.
  - `gastoHojePorProvedor(atividade: LiteLlmAtividade): Map<string, number>`
  - `janelaDeDatas(agora: Date): { start_date: string; end_date: string }` → `'YYYY-MM-DD HH:MM:SS'` em UTC.
- Create: `apps/api/src/modules/central-ia/fluxo-cache.ts`: `class FluxoCache<T> { constructor(ttlMs: number, maxChaves = 50); obter(chave: string, carregar: () => Promise<T>): Promise<T> }`. Guarda a promessa em voo; uma falha não fica no cache.
- Create: `apps/api/src/modules/central-ia/fluxo.service.ts`, `CentralIaFluxoService.fluxo(tenantId?: string): Promise<FluxoAoVivo>`.
  - Exige o gateway, como `CentralIaService`.
  - Janela pelo cache de 5 s; hoje pelo cache de 60 s, com falha → `null` por provedor.
  - Nomes das prefeituras pela tabela `tenant`; id sem linha → `abreviarId`.
- Create: `apps/api/src/modules/central-ia/fluxo.controller.ts`
  - `@Controller('central-ia')`, `@RequirePermissions('IA_CENTRAL')` na classe.
  - `@Get('fluxo')` com `FluxoQueryDto { @IsOptional() @IsUUID() tenantId?: string }`, que vai para minúsculas, como em `periodo()`.
  - `@Header('Cache-Control', 'no-store')`.
- Modify: `apps/api/src/modules/central-ia/central-ia.module.ts` (controller e provider).
- Create: `apps/api/src/modules/central-ia/__tests__/fixtures/litellm-spend-logs-janela-real.json`. É capturado no Step 1, sem os campos `api_key`, `requester_ip_address` e `metadata.user_api_key*`.
- Test: create `__tests__/fluxo.regras.spec.ts`, `__tests__/fluxo.service.spec.ts`, `__tests__/fluxo.controller.spec.ts`.

**Interfaces:**
- Consumes: `LiteLlmAdminClient.get`, `litellmConfig`, `abreviarId`, `LiteLlmAtividade` (Entrega 1).
- Produces (contrato HTTP; nomes exatos):
  ```ts
  type OrigemFluxo = 'i7ai-chat' | 'i7ai-automacao' | 'sgdm-pecas' | 'outras';
  interface FluxoAoVivo {
    geradoEm: string;                 // ISO, server clock
    janelaSegundos: 300;
    amostra: boolean;                 // window had more than 1000 calls
    chamadas: number;                 // rows summarized
    prefeituras: { id: string | null; nome: string; chamadas: number }[]; // top 5, then { id: null, nome: 'Outras' } when > 0
    origens: { origem: OrigemFluxo; chamadas: number }[];                 // always 4, ORIGENS_FLUXO order
    ligacoes: { prefeituraId: string | null; origem: OrigemFluxo; chamadas: number }[];
    gateway: { erroPercentual: number | null; cachePercentual: number | null; respostasRepetidas: number;
               latenciaP50Ms: number | null; latenciaP95Ms: number | null };
    provedores: { provedor: string; chamadas: number; gastoJanelaUsd: number; gastoHojeUsd: number | null }[]; // by chamadas desc, then gastoHojeUsd desc
  }
  ```

- [ ] **Step 1: Capturar o formato real.**
  - Faça uma chamada de chat no i7Ai local e gere uma peça no SGDM local.
  - Leia `/spend/logs/v2` dos últimos 5 min com a chave de desenvolvimento lida de `.env`, sem imprimir a chave.
  - Salve a resposta na fixture, sem os campos acima.
  - Confira e anote no ledger:
    - a ordem decrescente de `startTime`;
    - o tipo de `cache_hit`;
    - onde vem `cached_tokens`;
    - o atraso entre a chamada e o aparecimento no log.
- [ ] **Step 2: Testes**
  - `percentil([], 50) === null`; `percentil([300, 100, 200], 50) === 200`; `percentil([1,2,3,4,5,6,7,8,9,10], 95) === 10`.
  - `resumirJanela([], 0)`: `chamadas` 0, as 4 origens com 0, `prefeituras` `[]`, `ligacoes` `[]`, e os três percentuais e latências `null`.
  - Com a fixture real, `chamadas` igual ao número de linhas, e nenhuma chave `request_tags`, `api_key`, `usuario`, `conversa` em `JSON.stringify(resultado)`.
  - Linhas sintéticas:
    - 3 `success` e 1 `failure` → `erroPercentual` 25;
    - `prompt_tokens` 1000 e `cached_tokens` 600, mais `prompt_tokens` 1000 e `cached_tokens` 0 → `cachePercentual` 30;
    - `cached_tokens` 5000 com `prompt_tokens` 1000 → limitado, 100;
    - uma linha `cache_hit 'True'` com 5 ms fica fora da latência e conta em `respostasRepetidas`;
    - tag `origem:sgdm-teste` → `outras`; sem tag de origem → `outras`; tag não texto ignorada;
    - 7 prefeituras → 5 mais "Outras" com a soma das 2 menores; `end_user` vazio → "Outras".
  - `janelaDeDatas(new Date('2026-10-27T12:00:00Z'))` → `{ start_date: '2026-10-27 11:55:00', end_date: '2026-10-27 12:00:00' }`.
  - Service:
    - `client.get('/spend/logs/v2', …)` com `page_size '1000'`, `page '1'`, `exclude_internal_health_checks 'true'` e, com `tenantId`, `end_user`;
    - `total: 4200` → `amostra true` e uma só chamada a `/spend/logs/v2`;
    - 10 chamadas simultâneas a `fluxo()` → `client.get` 2 vezes; outra depois de 5 s (relógio falso) → nova leitura da janela, mas não de hoje;
    - falha em `/customer/daily/activity/aggregated` → `gastoHojeUsd null` e status 200;
    - falha na janela → a exceção do client (503/502) sobe, e a chamada seguinte tenta de novo (falha fora do cache);
    - sem `LITELLM_URL` → 503 sem chamar o client.
  - Controller: sem `IA_CENTRAL` → 403 (metadados do decorator, como em `central-ia.controller.spec.ts`); `tenantId` inválido → 400.
- [ ] **Step 3: Rodar e ver falhar** — `cd apps/api && npx jest --runInBand src/modules/central-ia/__tests__/fluxo` → FAIL.
- [ ] **Step 4: Implementar.**
- [ ] **Step 5: Rodar e ver passar** — mesmo comando → PASS; `npx jest --runInBand src/modules/central-ia` → PASS.
- [ ] **Step 6: Commit** — `git add apps/api/src/modules/central-ia && git commit -m "feat(ia): fluxo ao vivo da Central de IA a partir de uma janela curta do LiteLLM"`

---

### Task 3 (SGDM web): regras do fluxo e destaque no Consumo

Paralelizável com Task 1 e Task 2 (o contrato `FluxoAoVivo` está fixado na Task 2).

**Files:**
- Create: `apps/web/lib/central-ia-fluxo.ts` (funções puras):
  - `particulas(chamadas: number, maximo: number): number` (Decisão 5).
  - `espessura(chamadas: number, maximo: number): number` (Decisão 5).
  - `intervaloFluxo(falhasSeguidas: number): number` (Decisão 6).
  - `destinoCaixa(c: CaixaFluxo): { href: string; prefeituraId?: string }` (Decisão 8), com `type CaixaFluxo = { tipo: 'prefeitura'; id: string | null } | { tipo: 'origem'; origem: string } | { tipo: 'gateway' } | { tipo: 'provedor'; provedor: string }`.
  - `formatarLatencia(ms: number | null): string`: `null → '—'`, `850 → '850 ms'`, `1234 → '1,2 s'`.
  - `formatarPercentual(n: number | null): string`: `null → '—'`, `2.44 → '2,4%'`.
  - `resumoAcessivel(f: FluxoAoVivo): string`, como no exemplo da Decisão 6.
  - `ROTULO_ORIGEM_FLUXO`: `outras → 'Outras origens'`; as demais pelo `rotuloOrigem` existente.
- Modify: `apps/web/lib/central-ia-api.ts`: tipos `FluxoAoVivo` e `OrigemFluxo` (espelho da Task 2) e `buscarFluxo(token: string, tenantId?: string | null): Promise<FluxoAoVivo>`.
- Modify: `apps/web/components/central-ia/TabelaConsumo.tsx`
  - Prop nova `destaque?: string`.
  - A linha com `id === destaque` ganha `bg-blue-50` e `aria-current="true"`, e a página inicial é a que contém essa linha.
- Modify: `apps/web/app/(dashboard)/central-ia/consumo/page.tsx`
  - Passa `filtros.destaque`.
  - Ao mudar `agrupar`, chama `mudar({ agrupar, destaque: '' })`; `escreverEstadoLista` já omite valores vazios.
- Test: create `apps/web/lib/__tests__/central-ia-fluxo.test.ts`.

**Interfaces:**
- Consumes: `FluxoAoVivo` (Task 2), `rotuloOrigem`, `SEM_VALOR` (Entrega 1).
- Produces: as funções acima e `buscarFluxo`, usadas pela Task 4.

- [ ] **Step 1: Testes**
  - `particulas(0, 10) === 0`, `particulas(1, 1000) === 1`, `particulas(10, 10) === 8`, `particulas(5, 10) === 4`.
  - `espessura(0, 10) === 1`, `espessura(10, 10) === 6`.
  - `intervaloFluxo(0) === 10000`, `intervaloFluxo(1) === 10000`, `intervaloFluxo(2) === 30000`.
  - `destinoCaixa`:
    - `{ tipo:'prefeitura', id:'t1' }` → `{ href:'/central-ia/consumo?periodo=hoje&agrupar=usuario', prefeituraId:'t1' }`;
    - `{ tipo:'prefeitura', id:null }` → `href` com `agrupar=prefeitura`, sem `prefeituraId`;
    - `{ tipo:'origem', origem:'sgdm-pecas' }` → `'/central-ia/consumo?periodo=hoje&agrupar=origem&destaque=sgdm-pecas'`;
    - `{ tipo:'gateway' }` → `agrupar=modelo`;
    - `{ tipo:'provedor', provedor:'openai' }` → `agrupar=provedor&destaque=openai`.
  - `formatarLatencia(1234) === '1,2 s'`, `formatarPercentual(null) === '—'`.
  - `resumoAcessivel` de uma janela vazia contém "0 chamadas" e "—".
- [ ] **Step 2: Rodar e ver falhar** — `cd apps/web && npx vitest run lib/__tests__/central-ia-fluxo.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — o comando do Step 2 e `npx vitest run lib/__tests__/central-ia.test.ts` → PASS; `npx tsc --noEmit -p .` sem erros novos.
- [ ] **Step 5: Commit** — `git add apps/web/lib/central-ia-fluxo.ts apps/web/lib/central-ia-api.ts apps/web/lib/__tests__/central-ia-fluxo.test.ts apps/web/components/central-ia/TabelaConsumo.tsx "apps/web/app/(dashboard)/central-ia/consumo/page.tsx" && git commit -m "feat(ia): regras do fluxo ao vivo e linha em destaque no Consumo"`

---

### Task 4 (SGDM web): cartão Fluxo ao vivo na Visão geral

Depende das Tasks 2 e 3.

**Files:**
- Create: `apps/web/components/central-ia/FluxoAoVivo.tsx`. O componente é só apresentação e recebe props, para ser testado sem rede.
  - Props: `{ dados: FluxoAoVivo | undefined; carregando: boolean; animar: boolean; semRespostaDesde: Date | null; erroInicial: unknown | null; onRetry: () => void; onAbrir: (c: CaixaFluxo) => void }`.
  - `.card` com título "Fluxo ao vivo" e subtítulo "Últimos 5 minutos · atualiza a cada 10 s".
  - SVG `viewBox="0 0 960 360"` em 4 colunas (x = 80, 330, 580, 830). Caixas `rect` com `rx 10`; ligações `path` cúbicas.
  - Partículas: `circle r=3` com `<animateMotion dur="2.4s" repeatCount="indefinite" begin=…><mpath href="#lig-…"/></animateMotion>`.
  - Caixa LiteLLM: "cache X%", "erro Y%" e "latência Z" (`formatarLatencia` da p50; p95 no `<title>`).
  - Caixa de provedor: "hoje US$ …" e "N chamadas".
  - `animar === false` → nenhum `animateMotion` é renderizado. A decisão fica fora do componente (abaixo), para o teste sem DOM.
  - Estados:
    - `carregando` sem dados → `Skeleton h-80`;
    - `erroInicial` → `ErroCentral` com `onRetry`;
    - `semRespostaDesde` com dados → `opacity-60`, caixa LiteLLM com `stroke` vermelho e o texto "Sem resposta desde HH:MM:SS";
    - `amostra` → a frase da Decisão 1;
    - `chamadas === 0` → "Nenhuma chamada nos últimos 5 minutos." dentro do cartão, com o diagrama zerado.
  - `<details>` "Ver em tabela", com uma tabela simples (`table`, classes do SGDM) de todas as caixas e ligações.
- Create: `apps/web/components/central-ia/useAnimacaoPermitida.ts`: `useAnimacaoPermitida(): boolean` = `!matchMedia('(prefers-reduced-motion: reduce)').matches && document.visibilityState === 'visible'`, atualizado pelos eventos `change` e `visibilitychange`. No servidor, `false`.
- Modify: `apps/web/app/(dashboard)/central-ia/page.tsx`
  - Passa `animar={useAnimacaoPermitida()}`.
  - `useQuery(['central-ia','fluxo', tenantId], () => buscarFluxo(token!, tenantId), { refetchInterval: (q) => intervaloFluxo(q.state.fetchFailureCount), refetchIntervalInBackground: false, retry: false, enabled: !!token && pode })`.
  - Guarda `semRespostaDesde`: o horário da primeira falha seguida, que volta a `null` no sucesso.
  - O fluxo não depende do período escolhido.
  - `onAbrir`: aplica `destinoCaixa`, chama `setOperatingTenantId(prefeituraId)` quando houver e depois `router.push(href)`.
  - O cartão fica depois de `CartoesResumo` e antes do gráfico diário.
- Test: create `apps/web/lib/__tests__/fluxo-ao-vivo-markup.test.ts`. A web do SGDM testa componentes sem DOM: `environment: 'node'`, só `**/__tests__/**/*.test.ts`. Por isso o teste usa `renderToStaticMarkup(createElement(FluxoAoVivo, props))`, como os testes de `Breadcrumbs` e `DataTable` (M12).

**Interfaces:**
- Consumes: `buscarFluxo`, `particulas`, `espessura`, `intervaloFluxo`, `destinoCaixa`, `formatarLatencia`, `formatarPercentual`, `resumoAcessivel` (Task 3); `ErroCentral`, `Skeleton`; `useTenantContextStore.setOperatingTenantId`.

- [ ] **Step 1: Testes** (fixtures de `FluxoAoVivo` escritas no teste)
  - Janela com 3 ligações e movimento permitido → número de `animateMotion` = soma de `particulas` das ligações.
  - Mesmo dado com `animar: false` → 0 `animateMotion`, e os números das ligações continuam no markup.
  - Janela vazia → "Nenhuma chamada nos últimos 5 minutos." e "—" na caixa LiteLLM.
  - `semRespostaDesde` com dados → "Sem resposta desde" e a classe `opacity-60`.
  - `amostra true` → "Volume alto".
  - O `aria-label` do SVG é igual a `resumoAcessivel(dados)`.
  - Cada caixa é um `<a>` com `aria-label`.
- [ ] **Step 2: Rodar e ver falhar** — `cd apps/web && npx vitest run lib/__tests__/fluxo-ao-vivo-markup.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar**
  - vitest PASS; `npx tsc --noEmit -p .` sem erros novos.
  - Abrir `http://localhost:3000/central-ia` como `owner@sgdm.app` pelo proxy local. Mandar mensagens no chat do i7Ai: as partículas aparecem em até 20 s.
  - Clicar na caixa da prefeitura: o Consumo abre filtrado nela e agrupado por usuário.
  - Parar o container `i7ai-prefeituras-local-litellm`: "Sem resposta desde" aparece. Subir de novo: o fluxo volta sozinho.
  - Ativar "reduzir movimento" no sistema (ou no DevTools, Rendering → `prefers-reduced-motion`): sem partículas.
  - Largura de 390 px: o SVG escala sem rolagem horizontal.
- [ ] **Step 5: Commit** — `git add apps/web/components/central-ia/FluxoAoVivo.tsx apps/web/components/central-ia/useAnimacaoPermitida.ts apps/web/lib/__tests__/fluxo-ao-vivo-markup.test.ts "apps/web/app/(dashboard)/central-ia/page.tsx" && git commit -m "feat(ia): fluxo ao vivo na Visão geral da Central de IA"`

---

### Task 5: documentação e fumaça local

**Files:**
- Modify (i7Ai): `docs/LITELLM.md`, seção "Central de IA no SGDM", subseção "Fluxo ao vivo":
  - a fonte (janela de 5 min em `/spend/logs/v2`, 1.000 linhas no máximo, cache de 5 s);
  - o significado exato de cache %, erro % e latência (Decisão 3);
  - o atraso de escrita dos logs do LiteLLM anotado na Task 2;
  - as leituras por tag limitadas (`MAX_PAGINAS_TAGS`).
- Modify (SGDM): `apps/web/public/ajuda/manual.html`, subseção `#central-ia-fluxo` dentro de `#central-ia`: o que cada caixa mostra, o clique em cada caixa, "Volume alto", "Sem resposta desde" e o movimento reduzido.
- Modify (SGDM): `docs/deploy-portainer.md`: sem variável nova; a frase "O fluxo ao vivo consulta o LiteLLM no máximo a cada 5 s por instância da API."

- [ ] **Step 1: Fumaça local** (proxy `scripts/local-sgdm-proxy.cjs`; marcar cada item e colar o resultado na descrição do commit de documentação)
  1. Visão geral como `owner@sgdm.app`: o fluxo aparece, e com 5 mensagens no chat do i7Ai a ligação `i7ai-chat` ganha partículas e o número sobe.
  2. Gerar uma peça no SGDM: a ligação `sgdm-pecas` e o provedor dela se movem.
  3. Com 3 abas abertas por 1 min, o log da API do SGDM (ou um contador temporário em `fluxo.service.ts`, não commitado) mostra no máximo 12 leituras da janela.
  4. Um modelo com chave inválida forçado em Cadastros › IA gera falha: o erro % sobe.
  5. Cada caixa clicada abre o Consumo como na Decisão 8.
  6. LiteLLM parado e depois de volta (Task 4, Step 4).
  7. Como administrador de prefeitura (sem `IA_CENTRAL`): `GET /api/v1/central-ia/fluxo` → 403.
  8. Resposta de `/central-ia/fluxo` no DevTools: nenhuma ocorrência de `usuario:`, `conversa:`, `api_key` ou `sk-`.
  9. Visão geral de 30 dias continua abrindo, e o DevTools mostra `/tag/daily/activity` paginado e nenhum `/tag/daily/activity/aggregated` sem `tags`.
- [ ] **Step 2: Commit em cada repositório** — `git commit -m "docs(ia): Central de IA — fluxo ao vivo"` (i7Ai: `git add docs/LITELLM.md`; SGDM: `git add apps/web/public/ajuda/manual.html docs/deploy-portainer.md`).

---

## Self-review

- **Cobertura da spec:**
  - §5.1 diagrama Prefeituras → Origem → LiteLLM → Provedores: Tasks 2 e 4.
  - Cache %, erro % e latência: Task 2 (Decisão 3).
  - Gasto por provedor: Task 2 (janela e hoje).
  - 10 s: Tasks 3 e 4.
  - Partículas proporcionais: Tasks 3 e 4.
  - Clique filtra o Consumo: Tasks 3 e 4.
  - §9 SVG puro sem dependência: Global Constraints e Task 4.
  - §6 a web nunca fala com o LiteLLM, isolamento e `tenantId`: Task 2.
  - §7 nada de chave nem texto: Task 2 (asserção sobre o JSON) e Task 5 (item 8).
  - Ruling A5: Decisão 1 (o fluxo não usa tags) e Task 1 (leituras globais limitadas).
- **Tipos:** `FluxoAoVivo`, `OrigemFluxo` e `CaixaFluxo` são definidos uma vez (Tasks 2 e 3) e usados com os mesmos nomes na Task 4. `VisaoGeral` anulável muda na API e na web na mesma task (Task 1).
- **Review Focus:** os cinco itens têm teste nas Tasks 2, 3 e 4.
