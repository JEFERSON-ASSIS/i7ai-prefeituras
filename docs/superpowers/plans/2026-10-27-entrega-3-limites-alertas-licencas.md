# Entrega 3 — Limites, alertas e licenças

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O dono da plataforma define na Central de IA o orçamento mensal e os limites por minuto de cada prefeitura (aplicados no LiteLLM) e de cada usuário (aplicados no i7Ai), recebe alertas na Visão geral e por e-mail, edita as licenças do i7Ai na aba "Licenças i7Ai" e configura a cotação US$→R$. A tela Licenciamento sai do i7Ai.

**Architecture:**
- O SGDM guarda tudo em cinco tabelas novas: `ia_limites`, `ia_limites_usuarios`, `ia_alertas`, `i7ai_licencas` e `ia_configuracao_plataforma`.
- Limites da prefeitura vão para o LiteLLM. Cada prefeitura (o *customer*, `user` da chamada) fica ligada a um *budget* com `max_budget`, `rpm_limit`, `tpm_limit` e `budget_duration: "1mo"`. O LiteLLM recusa sozinho.
- Limites do usuário ficam no i7Ai. Ele lê os limites do SGDM por um endpoint interno novo, com cache curto, e os confere dentro da reserva de cota que já existe (`AiQuotaService.reserve`, sob o `FOR UPDATE` da prefeitura).
- O i7Ai e as peças do SGDM traduzem a recusa do LiteLLM numa mensagem clara.
- Uma rotina no processo da API do SGDM roda a cada 15 min. Ela lê o gasto do mês nos agregados do LiteLLM, grava alertas sem repetir e põe o e-mail na fila de e-mail que o SGDM já tem.
- As licenças do i7Ai passam a ser cadastradas no SGDM. O i7Ai espelha cada uma na tabela `licenses`, no login e a cada 60 s, e as regras de `license-policy.ts` não mudam.

**Tech Stack:**
- i7Ai: NestJS + Prisma + `node:test` no backend; React/Vite + Playwright no frontend.
- SGDM: NestJS + Prisma + Jest na API; Next.js + React Query + Vitest + `recharts` na web.
- LiteLLM 1.106.4 (conferido no container local `i7ai-prefeituras-local-litellm`): `/budget/new`, `/budget/delete`, `/customer/info`, `/customer/new`, `/customer/update`, `/customer/daily/activity/aggregated`, `/tag/daily/activity/aggregated`, `/spend/logs/v2`.

**Spec:** `docs/superpowers/specs/2026-10-26-central-de-ia-design.md` (§2 decisões 2, 7, 12 e 13; §4; §5.1; §5.4; §6; §8 entrega 3; §9)

**Base:** este plano roda depois da Entrega 2 (`docs/superpowers/plans/2026-10-27-entrega-2-modelos-acesso-organizacao.md`). Ele usa o que ela produz:
- no i7Ai: `SgdmModule`, `sgdmIntegrationGet`, `sgdmIntegrationEnabled`, `SgdmUnavailable`, `SgdmNotFound` e o verificador da chave entre servidores do `sgdm-names.controller.ts`;
- no SGDM: `exigirChaveIntegracao`, `LiteLlmAdminClient.enviar`, `CentralIaLiberacoesService.buscarUsuarios`, `I7aiNomesClient` e `i7ai.apiUrl`;
- na web do SGDM: `ABAS_CENTRAL` com três abas.

**Repositórios:**
- i7Ai: `C:/xampp/htdocs/producao/i7ai-IA`, branch `feat/central-ia`.
- SGDM: worktree `C:/xampp/htdocs/producao/prefeitura/SGDM-central-ia`, branch `feat/central-ia`. Nas tasks, os caminhos do SGDM são relativos à raiz do worktree.

**Decisão 12:** nada deste plano vai para produção. O deploy único acontece depois da entrega 6.

## Decisões do autor (o que a spec deixa em aberto)

1. **Orçamento no LiteLLM.**
   - Fica num *budget* por prefeitura, ligado ao *customer* por `budget_id`.
   - `/customer/update` não aceita `rpm_limit`/`tpm_limit` e ignora valores nulos (conferido em `customer_endpoints.py`). Por isso, cada gravação cria um budget novo, `ia-prefeitura-<tenantId>-<epochMs>`, com exatamente os valores atuais, liga o customer a ele e apaga o anterior.
   - "Sem limite" é um budget sem `max_budget`, `rpm_limit` nem `tpm_limit`. Nunca se desliga o `budget_id`.
   - O budget sem limite de uma prefeitura removida fica órfão no LiteLLM depois que a linha some do SGDM. É inofensivo e fica documentado em `docs/LITELLM.md`.
2. **Ordem da gravação de limites da prefeitura.** Primeiro o LiteLLM, depois o banco. Se o LiteLLM falhar → 503 "O gateway de IA não respondeu; os limites não foram salvos." e nada é gravado no SGDM, como na ativação de modelos da Entrega 2.
3. **"Ação ao atingir" = campo `bloquear`.**
   - `bloquear = true` (padrão): o budget leva `max_budget = orçamento`, e o LiteLLM recusa a partir de 100%.
   - `bloquear = false`: o budget não tem `max_budget` e só há alertas.
   - O aviso sai a `avisoPercentual`% (padrão 80, faixa 1–99). Não se usa o `soft_budget` do LiteLLM: o e-mail é do SGDM.
4. **Competência = mês civil em UTC.**
   - O LiteLLM 1.106.4 zera o gasto dos budgets `1mo` no dia 1º às 00:00 no fuso `litellm_settings.timezone`, que não está definido e por isso é UTC.
   - A Central já agrupa por dia UTC (Entrega 1). O orçamento do i7Ai por usuário usa o mesmo mês.
5. **Gasto anterior ao primeiro orçamento.**
   - Ao ligar uma prefeitura ao primeiro budget, o LiteLLM compara o gasto acumulado do customer (desde a criação) até a primeira virada de mês.
   - Aceito: em produção o i7Ai está sem licença e não há histórico relevante (decisão 12). Fica documentado em `docs/LITELLM.md`.
6. **Limites por usuário ficam no i7Ai, não em orçamento por tag.**
   - A reserva de cota do i7Ai hoje é só por prefeitura: `AiTokenReservation` não tem usuário. Ela ganha a coluna `userId`.
   - Chamadas por minuto = reservas do usuário nos últimos 60 s.
   - Tokens por minuto = tokens medidos mais reservados pendentes do usuário nos últimos 60 s. Recusa quando o já usado atinge o limite; o tamanho da chamada nova não entra, para uma chamada com imagem nunca ficar bloqueada para sempre.
   - Orçamento mensal = soma de `ai_usage.cost` do usuário no mês UTC.
   - Consequência: o orçamento por usuário cobre só o i7Ai. As peças do SGDM entram no orçamento da prefeitura.
7. **SGDM fora do ar ao ler limites de usuário:** o i7Ai usa o último valor por até 600 s. Sem nenhum valor, segue sem limite de usuário e registra `logger.warn`. Bloquear todo o chat por uma falha curta do SGDM seria pior; o teto da prefeitura continua no LiteLLM.
8. **Regra "acima de N× a média".**
   - N é um campo da prefeitura (`multiploMedia`, vazio = desligada, faixa 1,5–100) e vale para todos os usuários dela.
   - Média = gasto do mês dos usuários com gasto > 0 ÷ quantidade deles.
   - Só dispara com pelo menos 5 usuários com gasto e quando o usuário gastou pelo menos US$ 1,00. Uma prefeitura com um só usuário nunca dispara.
9. **Fontes do gasto do mês na rotina:**
   - `/customer/daily/activity/aggregated`, uma chamada para todas as prefeituras;
   - `/tag/daily/activity/aggregated` para as tags `usuario:`. O usuário é ligado à prefeitura por `usuario.tenantId` no banco do SGDM; não se pagina o log de cada prefeitura.
10. **Gasto "na chave da plataforma" × "na chave própria"** (decisão 7):
    - aparece só no detalhe de uma prefeitura, pela tag `chave:` lida dos logs dela (o caminho `tenantId` da Entrega 1);
    - a lista mostra só o total contra o orçamento;
    - chamadas anteriores à tag `chave:` aparecem como "sem marcação".
11. **Rotina de alertas.**
    - A cada 15 min (`IA_ALERTAS_INTERVALO_MS`, padrão 900000; `0` desliga), com a primeira rodada 2 min depois de subir a API. Desligada sem `LITELLM_URL`/`LITELLM_ADMIN_KEY`.
    - Padrão `setInterval` + `unref` + `rodando` de `resumo-prazos.service.ts`.
    - Deduplicação pela coluna única `chave = <tipo>:<tenantId>:<usuarioId|->:<AAAA-MM>[:<orçamento>]`. O sufixo do orçamento só existe nos alertas de orçamento.
    - Um alerta resolvido não volta no mesmo mês, a não ser que o orçamento mude.
    - Duas instâncias da API: o `INSERT` que perde no `chave` não envia e-mail. A marcação `email_enfileirado_em` é feita por `updateMany` condicional antes de enfileirar.
    - Nada de Redis para isso. A fila de e-mail continua no Redis do SGDM, como hoje, e nunca leva resposta de IA (§6).
12. **E-mail dos alertas.**
    - Usa `FilaEmailService.enfileirar` com `tipo: 'aviso'` e um evento novo, `EVENTO_EMAIL.IA_ALERTA`.
    - Destinatários: usuários ativos com um perfil ativo que tem `IA_CENTRAL`.
    - Vale a preferência `notificacaoEmail` de cada um, como em todo aviso do SGDM.
13. **Cotação US$→R$** é um campo único de `ia_configuracao_plataforma`, editado na aba Limites e alertas e lido por `GET central-ia/configuracao`.
    - Substitui `NEXT_PUBLIC_COTACAO_USD`, que nunca chegava ao build de produção.
    - Sem cotação, os valores em R$ aparecem como "—".
14. **Licenças no SGDM.**
    - Uma por prefeitura, nunca apagada: para revogar, `situacao = 'SUSPENSA'`.
    - `fim` é inclusivo. O i7Ai recebe `endDate` = dia seguinte a `fim`, às 03:00 UTC (meia-noite de Brasília).
    - O campo `features` do i7Ai não é sincronizado.
15. **Espelho no i7Ai.**
    - `SgdmLicenseService` grava a licença do SGDM na linha mais recente de `licenses` da prefeitura, ou cria uma.
    - O SGDM responder "sem licença" não apaga a linha local: fica um `logger.warn` "Licença local sem cadastro no SGDM; importe na Central de IA.". Assim a importação é possível.
    - SGDM fora do ar: a linha atual continua valendo e o login nunca falha por isso.
16. **Migração das licenças existentes do i7Ai.**
    - Não é feita por migration, porque os bancos são diferentes.
    - O botão "Importar licenças do i7Ai" da aba lê `GET /api/integracoes/sgdm/licencas` e cria no SGDM só as que faltam. Produção não tem nenhuma; no ambiente local é um clique.
17. **O recurso `licensing` sai do i7Ai:** de `RESOURCES` e do caso especial do CONSTRUTOR em `role-catalog.ts`. Linhas antigas em `permissions` ficam órfãs e são inofensivas.
18. **Status HTTP das recusas por limite:**
    - O i7Ai responde 429 nas quatro mensagens de limite.
    - As peças do SGDM usam o tipo de erro novo `LIMITE`, também 429.
    - O LiteLLM 1.106.4 devolve 422 para orçamento excedido (`budget_exceeded_status_code = 422`) e 429 para limite por minuto (`Rate limit exceeded for end_user: …`). A reserva do i7Ai já marca 422 e 429 como `REJECTED`.

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
- Só os componentes visuais atuais do SGDM: `PageHeader`, `.card`, `.stat-card`, `DataTable`, `Tabs`, `EmptyState`, `Skeleton`, `Toast`, `recharts`, `lucide-react`.

**Chaves e isolamento:**
- Nenhuma chave de provedor e nenhuma chave administrativa do LiteLLM em banco do i7Ai, em log, em auditoria, em resposta de API ou no navegador.
- Toda consulta de limite, alerta e licença filtra por prefeitura. Um `usuarioId` de outra prefeitura → 404 "Usuário não encontrado nesta prefeitura.".

**Auditoria e acesso:**
- Rotas `/central-ia/*` com `@RequirePermissions('IA_CENTRAL')` na classe.
- Endpoints internos:
  - SGDM `/integracoes/i7ai/*`: `exigirChaveIntegracao`.
  - i7Ai `/api/integracoes/sgdm/*`: o verificador de chave da Entrega 2.
  - Sem chave configurada → 404; com chave errada → 401.
- Toda escrita da Central registra em `auditoria` (`AuditoriaService.registrar`), sem chaves:
  - `entidade`: `ia_limite` | `ia_limite_usuario` | `ia_alerta` | `i7ai_licenca` | `ia_configuracao`.
  - `acao`: `CRIAR` | `EDITAR` | `EXCLUIR` | `RESOLVER` | `IMPORTAR`.
  - `tenantId` = o da prefeitura afetada; na cotação, o de quem age.
  - `BigInt` vai como string em `dadosAnteriores`/`dadosNovos`.

**Migrations:**
- SGDM: uma só, `20261214100000_ia_limites_alertas_licencas`, depois de `20261213100000_ia_modelos_liberacoes`.
  - SQL idempotente (`IF NOT EXISTS`), conforme `docs/modulos/padrao-modulo.md`.
  - Aplicada no banco local com `psql` e depois `npx prisma migrate resolve --applied`.
- i7Ai: `20261028000300_ai_token_reservations_user`, depois de `20261028000200_departments_external_id`.
  - Gere com `npx prisma migrate dev --create-only`, revise e aplique.

**Mensagens exatas das recusas por limite** (i7Ai, `backend/src/ai/limit-messages.ts`; SGDM, `apps/api/src/modules/ia/limite-gateway.ts`):
- `tenantMonth`: "A prefeitura atingiu o limite de IA deste mês. Fale com o administrador da plataforma."
- `tenantMinute`: "A prefeitura atingiu o limite de uso de IA por minuto. Aguarde um instante e tente novamente."
- `userMonth`: "Você atingiu o seu limite de IA deste mês. Fale com o administrador da plataforma."
- `userMinute`: "Você atingiu o seu limite de uso de IA por minuto. Aguarde um instante e tente novamente."

## Review Focus

1. **Orçamento estourado no meio de uma conversa ou de uma peça.**
   - O LiteLLM responde 422 `ExceededBudget: End User=… over budget`.
   - Esperado: o chat (com e sem streaming) e a geração de peça mostram `tenantMonth`, com status 429. Não deve aparecer "O gateway de IA recusou o modelo…", nem 502 genérico, nem o texto cru do LiteLLM.
   - A reserva fica `REJECTED`. (Task 3: teste do `httpError` nos dois caminhos; Task 2: teste do provider de peças.)
2. **Duas rodadas da rotina ao mesmo tempo, ou o dono resolve um alerta e a prefeitura continua acima.**
   - Esperado: uma linha por `chave` no mês, um e-mail por destinatário e nenhum alerta reaberto no mesmo mês. (Task 5.)
3. **SGDM fora do ar no login ou na sincronização periódica de licenças.**
   - Esperado: o i7Ai mantém a licença espelhada, o login conclui e nada fica ilimitado em produção.
   - SGDM respondendo `{ licenca: null }` → a linha local fica e há um aviso no log. (Task 6.)
4. **Limite removido, ou `bloquear` desligado.**
   - Esperado: o customer passa para um budget sem `max_budget` e a próxima chamada passa.
   - LiteLLM fora do ar ao salvar → 503 e o SGDM não grava. O budget novo criado antes da falha no customer é apagado. (Task 2.)
5. **Cotação `0`, negativa, texto ou acima de 50.**
   - Esperado: 400 "Informe uma cotação entre 0,5 e 50.".
   - Cotação ausente → R$ "—" nos cartões, nunca `NaN` nem "R$ 0,00". (Tasks 1 e 8.)

---

### Task 1 (SGDM API): tabelas novas e cotação US$→R$

**Files:**
- Modify: `apps/api/prisma/schema.prisma`. Modelos novos e relações inversas em `Tenant`/`Usuario`:
  - `IaLimite` (`ia_limites`), limites da prefeitura:
    - `id` uuid, `tenantId` @unique (FK `Tenant`, Cascade)
    - `orcamentoMensalUsd` Decimal(12,2)?, `avisoPercentual` Int @default(80), `bloquear` Boolean @default(true)
    - `chamadasPorMinuto` Int?, `tokensPorMinuto` Int?, `multiploMedia` Decimal(5,1)?
    - `litellmBudgetId` VarChar(120)?
    - `atualizadoPorId` String?, `atualizadoEm` @updatedAt
  - `IaLimiteUsuario` (`ia_limites_usuarios`):
    - `id`, `tenantId`, `usuarioId` (FK `Usuario`, Cascade)
    - `orcamentoMensalUsd` Decimal(12,2)?, `avisoPercentual` Int @default(80), `bloquear` Boolean @default(true)
    - `chamadasPorMinuto` Int?, `tokensPorMinuto` Int?
    - `atualizadoPorId?`, `atualizadoEm`
    - `@@unique([tenantId, usuarioId])`, `@@index([tenantId])`
  - `IaAlerta` (`ia_alertas`):
    - `id`, `chave` VarChar(200) @unique, `tipo` VarChar(40)
    - `tenantId` (FK Cascade), `usuarioId` String? (FK SetNull)
    - `competencia` VarChar(7), `valorUsd` Decimal(12,4), `referenciaUsd` Decimal(12,4)?, `mensagem` VarChar(300)
    - `situacao` VarChar(10) @default("ABERTO")
    - `criadoEm`, `resolvidoEm?`, `resolvidoPorId?`, `emailEnfileiradoEm?`
    - `@@index([situacao, criadoEm])`, `@@index([tenantId, criadoEm])`
  - `I7aiLicenca` (`i7ai_licencas`):
    - `id`, `tenantId` @unique (FK Cascade)
    - `situacao` VarChar(10) (`ATIVA` | `SUSPENSA`), `inicio` @db.Date, `fim` @db.Date?
    - `maxUsuarios`, `maxAgentes`, `maxAutomacoes`, `maxBases` Int
    - `maxArmazenamentoBytes` BigInt, `maxTokensMes` BigInt
    - `atualizadoPorId?`, `criadoEm`, `atualizadoEm`
  - `IaConfiguracaoPlataforma` (`ia_configuracao_plataforma`):
    - `id` Int @id @default(1), com `CHECK (id = 1)` no SQL
    - `cotacaoUsdBrl` Decimal(10,4)?
    - `atualizadoPorId?`, `atualizadoEm?`
- Create: `apps/api/prisma/migrations/20261214100000_ia_limites_alertas_licencas/migration.sql`
  - `CREATE TABLE IF NOT EXISTS` das cinco tabelas, FKs e índices `IF NOT EXISTS`.
  - `CHECK` de `avisoPercentual BETWEEN 1 AND 99` e de `situacao` nas duas tabelas que a têm.
  - Nenhuma permissão nova.
- Create: `apps/api/src/modules/central-ia/configuracao.service.ts`, `CentralIaConfiguracaoService`:
  - `obter(): Promise<{ cotacaoUsdBrl: number | null; atualizadoEm: string | null }>`: sem linha → `{ null, null }`.
  - `salvar(user, cotacaoUsdBrl: number | null, ip?, userAgent?)`: upsert do id 1; auditoria `EDITAR`, `entidade 'ia_configuracao'`, `entidadeId '1'`.
- Create: `apps/api/src/modules/central-ia/configuracao.controller.ts` (`IA_CENTRAL`):
  - `GET central-ia/configuracao`
  - `PUT central-ia/configuracao` com body `{ cotacaoUsdBrl: number | null }`
  - DTO em `dto/configuracao.dto.ts`: `@IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.5) @Max(50)`, com a mensagem "Informe uma cotação entre 0,5 e 50.".
- Modify: `central-ia.module.ts` (controller e provider).
- Test: `apps/api/src/modules/central-ia/__tests__/configuracao.spec.ts`, `__tests__/migration-ia-limites.spec.ts`.

**Interfaces:**
- Produces:
  - os modelos Prisma acima, usados pelas Tasks 2, 4 e 5;
  - `GET central-ia/configuracao` → `{ cotacaoUsdBrl: number | null; atualizadoEm: string | null }`, usado pela Task 8.

- [ ] **Step 1: Testes**
  - Migration: o SQL contém as cinco tabelas, `"chave"` com índice único e `CHECK ("id" = 1)`.
  - Service: `obter()` sem linha → `{ cotacaoUsdBrl: null, atualizadoEm: null }`. `salvar(user, 5.4321)` → upsert com `id: 1`, e a auditoria recebe `entidade: 'ia_configuracao'`, `acao: 'EDITAR'` e `dadosNovos: { cotacaoUsdBrl: 5.4321 }`.
  - Controller:
    - sem `IA_CENTRAL` → 403;
    - `{ cotacaoUsdBrl: 0 }`, `-1`, `'abc'` e `51` → 400 com "Informe uma cotação entre 0,5 e 50.";
    - `null` → 200.
- [ ] **Step 2: Rodar e ver falhar** — `npx jest --runInBand src/modules/central-ia/__tests__/configuracao.spec.ts src/modules/central-ia/__tests__/migration-ia-limites.spec.ts` → FAIL.
- [ ] **Step 3: Implementar.** `npx prisma generate`; aplicar a migration no banco local (`psql`, depois `migrate resolve --applied 20261214100000_ia_limites_alertas_licencas`).
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS.
- [ ] **Step 5: Commit** — `git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20261214100000_ia_limites_alertas_licencas apps/api/src/modules/central-ia && git commit -m "feat(ia): tabelas de limites, alertas e licenças e cotação do dólar na Central de IA"`

---

### Task 2 (SGDM API): limites por prefeitura e usuário, aplicados no LiteLLM, e recusa traduzida nas peças

**Files:**
- Create: `apps/api/src/modules/central-ia/limites.regras.ts` (funções puras):
  - `budgetDoLimite(l: { orcamentoMensalUsd: number | null; bloquear: boolean; chamadasPorMinuto: number | null; tokensPorMinuto: number | null } | null, tenantId: string, agoraMs: number): Record<string, unknown>`
    - Devolve `{ budget_id: 'ia-prefeitura-' + tenantId + '-' + agoraMs, budget_duration: '1mo' }`.
    - Acrescenta `max_budget` só quando `bloquear` e há orçamento, e `rpm_limit`/`tpm_limit` só quando preenchidos. Nunca chaves com `null`.
  - `percentualDoOrcamento(gastoUsd: number, orcamentoUsd: number | null): number | null`, com uma casa decimal; sem orçamento → `null`.
- Create: `apps/api/src/modules/central-ia/limites.service.ts`, `CentralIaLimitesService`:
  - Construtor: `(client: LiteLlmAdminClient, prisma, auditoria, central: CentralIaService)`.
  - `aplicarNoGateway(tenantId, limite | null, budgetAnterior: string | null): Promise<string>`, nesta ordem:
    1. `enviar('POST','/budget/new', budgetDoLimite(...))`.
    2. `enviar('POST','/customer/update', { user_id: tenantId, budget_id }, true)`. O LiteLLM devolve 404 "does not exist in db" para customer inexistente; nesse caso, `null` → `enviar('POST','/customer/new', { user_id: tenantId, budget_id })`. (`get()` mapeia todo não-2xx para 502 e não serve aqui.)
    3. `enviar('POST','/budget/delete', { id: budgetAnterior }, true)`. Uma falha aqui só gera `logger.warn`.
    - Falha no passo 2 → tenta `/budget/delete` do novo e lança `ServiceUnavailableException('O gateway de IA não respondeu; os limites não foram salvos.')`.
    - Devolve o `budget_id` novo.
  - `listar(): Promise<{ tenantId; nome; limite: LimitePrefeitura | null; gastoMesUsd: number | null; percentual: number | null; excecoes: number }[]>`
    - Todas as prefeituras ativas, por `nome`.
    - O gasto do mês vem de `central.gastoDoMes(competenciaUtc(agora))`. Com o LiteLLM fora → `gastoMesUsd: null`, e a lista sai mesmo assim.
  - `detalhe(tenantId)` → `{ limite, usuarios: { usuarioId; nome; email; ...LimiteUsuario }[], gastoMes: { totalUsd; plataformaUsd; propriaUsd; semMarcaUsd } | null }`.
    - O gasto por chave vem de `central.gastoPorChave(tenantId, inicio, fim)`.
    - Tenant inexistente → 404.
    - `gastoPorChave` falhando (LiteLLM fora, ou o 400 "Chamadas demais no período…" do limite de 100 páginas de log da Entrega 1) → `gastoMes: null`, e o detalhe abre mesmo assim com "—".
  - `salvar(user, tenantId, dto: LimitePrefeituraDto)`: `aplicarNoGateway`, depois upsert com `litellmBudgetId`; auditoria `CRIAR`/`EDITAR` com antes e depois.
  - `remover(user, tenantId)`: `aplicarNoGateway(tenantId, null, atual.litellmBudgetId)`, depois apaga a linha; auditoria `EXCLUIR`.
  - `salvarUsuario(user, tenantId, usuarioId, dto: LimiteUsuarioDto)` e `removerUsuario(user, tenantId, usuarioId)`:
    - Usuário de outra prefeitura → 404.
    - Não tocam no LiteLLM.
    - Auditoria com `entidade 'ia_limite_usuario'`.
  - `paraI7ai(tenantId, usuarioId?): Promise<{ usuario: LimiteUsuarioI7ai | null }>`.
- Modify: `apps/api/src/modules/central-ia/central-ia.service.ts`. Métodos públicos novos:
  - `gastoDoMes(c: { inicio: string; fim: string }): Promise<{ prefeituras: Map<string, number>; usuarios: Map<string, number> }>`
    - `prefeituras` vem de `somarBreakdown(resultados(clientes), 'entities')`.
    - `usuarios` vem de `agruparTags(entidades, 'usuario:')` do agregado global de tags.
  - `gastoPorChave(tenantId, inicio, fim): Promise<{ totalUsd; plataformaUsd; propriaUsd; semMarcaUsd }>`
    - Lê `agruparTags` com prefixo `chave:` sobre `tags({ inicio, fim, tenantId })`. O total vem de `clientes`.
    - `semMarcaUsd = max(0, total − plataforma − própria)`, arredondado com `arredondar`.
- Create: `apps/api/src/modules/central-ia/competencia.ts`: `competenciaUtc(agora: Date): { competencia: string; inicio: string; fim: string }`. Exemplo: `2026-10-27T15:00Z` → `{ '2026-10', '2026-10-01', '2026-10-27' }`.
- Create: `apps/api/src/modules/central-ia/limites.controller.ts` (`IA_CENTRAL`):
  - `GET central-ia/limites`
  - `GET central-ia/limites/:tenantId`
  - `PUT central-ia/limites/:tenantId`
  - `DELETE central-ia/limites/:tenantId`
  - `PUT central-ia/limites/:tenantId/usuarios/:usuarioId`
  - `DELETE central-ia/limites/:tenantId/usuarios/:usuarioId`
  - A busca de usuários reaproveita `GET central-ia/acesso/:tenantId/usuarios` (Entrega 2).
- Create: `apps/api/src/modules/central-ia/dto/limites.dto.ts`:
  - `LimitePrefeituraDto`:
    - `orcamentoMensalUsd`: number | null, 0,01–1.000.000, duas casas. Mensagem: "Informe um orçamento entre US$ 0,01 e US$ 1.000.000,00.".
    - `avisoPercentual`: int, 1–99.
    - `bloquear`: boolean.
    - `chamadasPorMinuto`: int | null, 1–100.000.
    - `tokensPorMinuto`: int | null, 1–100.000.000.
    - `multiploMedia`: number | null, 1,5–100.
  - `LimiteUsuarioDto`: os mesmos campos, sem `multiploMedia`.
  - Ids com `@IsId()`.
- Create: `apps/api/src/modules/central-ia/i7ai-limites.controller.ts`, `@ApiExcludeController() @Controller('integracoes/i7ai')`, `@Public()`, com `exigirChaveIntegracao` em cada rota:
  - `GET limites/:tenantId?usuarioId=` → `{ usuario: LimiteUsuarioI7ai | null }`.
  - UUID inválido → 404. Usuário de outra prefeitura → 404. Sem `usuarioId` → `{ usuario: null }`.
- Create: `apps/api/src/modules/ia/limite-gateway.ts`:
  - `MENSAGENS_LIMITE` (as quatro mensagens das Global Constraints; o SGDM usa as duas `tenant*`).
  - `limiteDoGateway(corpo: string): string | null`
    - `/ExceededBudget|over budget|Budget has been exceeded/i` → `tenantMonth`.
    - `/Rate limit exceeded for end_user/i` → `tenantMinute`.
    - Senão → `null`.
- Modify: `apps/api/src/modules/ia/providers/ia-provider.interface.ts`: `IaProviderError.tipo` += `'LIMITE'`.
- Modify: `apps/api/src/modules/ia/providers/litellm.provider.ts:77-91`
  - Com `!resposta.ok`, lê o corpo uma vez.
  - Se `limiteDoGateway(corpo)` → lança `IaProviderError('LIMITE', mensagem)` antes dos ramos 401/403 e de `classificarStatus`.
- Modify: `apps/api/src/modules/ia/ia-provider.registry.ts`: `traduzirErroIa` faz `IaProviderError` do tipo `LIMITE` → `HttpException(mensagem, 429)`. Os demais tipos continuam 502.
- Modify: `central-ia.module.ts`.
- Test (`apps/api/src/modules/central-ia/__tests__/`): `limites.regras.spec.ts`, `limites.service.spec.ts`, `limites.controller.spec.ts`, `i7ai-limites.controller.spec.ts`, `competencia.spec.ts`; e `apps/api/src/modules/ia/__tests__/litellm.provider.spec.ts`.

**Interfaces:**
- Consumes:
  - `LiteLlmAdminClient.get`/`enviar` (Entrega 2, Task 2);
  - `exigirChaveIntegracao` (Entrega 2, Task 5);
  - modelos da Task 1.
- Produces:
  - `type LimitePrefeitura = { orcamentoMensalUsd: number | null; avisoPercentual: number; bloquear: boolean; chamadasPorMinuto: number | null; tokensPorMinuto: number | null; multiploMedia: number | null }`.
  - `type LimiteUsuario = Omit<LimitePrefeitura, 'multiploMedia'>`.
  - **Contrato interno (congelado aqui; o i7Ai o consome na Task 3):** `GET /integracoes/i7ai/limites/:tenantId?usuarioId=` → `{ usuario: LimiteUsuarioI7ai | null }`.
    - `LimiteUsuarioI7ai = { orcamentoMensalUsd: number | null; bloquear: boolean; chamadasPorMinuto: number | null; tokensPorMinuto: number | null }`.
  - `CentralIaService.gastoDoMes` e `competenciaUtc`, usados pela Task 5.
  - `CentralIaLimitesService.listar`, `detalhe`, usados pela Task 8.

- [ ] **Step 1: Testes**
  - Regras:
    - `budgetDoLimite({ orcamentoMensalUsd: 100, bloquear: true, chamadasPorMinuto: 60, tokensPorMinuto: null }, 't1', 5)` → `{ budget_id: 'ia-prefeitura-t1-5', budget_duration: '1mo', max_budget: 100, rpm_limit: 60 }`, sem `tpm_limit`;
    - `bloquear: false` → sem `max_budget`;
    - `null` → só `budget_id` e `budget_duration`;
    - `percentualDoOrcamento(85, 100) === 85` e `percentualDoOrcamento(1, null) === null`.
  - `competenciaUtc(new Date('2026-11-01T02:00:00Z')).competencia === '2026-11'`.
  - Service, com o client falso:
    - Salvar numa prefeitura cujo customer não existe chama, em ordem, `/budget/new`, `/customer/update` (404 → `null`) e `/customer/new` com `{ user_id, budget_id }`. Grava `litellmBudgetId`.
    - Salvar de novo chama `/customer/update`, depois `/budget/delete` com o id anterior.
    - `/customer/update` falhando → `ServiceUnavailableException` com a mensagem exata, `/budget/delete` do novo e nenhum `upsert`.
    - `remover` liga um budget sem `max_budget` e apaga a linha.
    - `salvarUsuario` com usuário de outro tenant → `NotFoundException` (`esperarSoDoTenant`).
    - Auditoria em toda escrita, com `entidade 'ia_limite'` ou `'ia_limite_usuario'`.
  - `gastoPorChave`, com logs de `chave:plataforma` 3,00, `chave:propria` 1,50 e total 5,00 → `{ totalUsd: 5, plataformaUsd: 3, propriaUsd: 1.5, semMarcaUsd: 0.5 }`.
  - Controllers:
    - sem `IA_CENTRAL` → 403 nas seis rotas;
    - `avisoPercentual: 100` → 400;
    - interno: sem chave → 404, chave errada → 401, usuário de outro tenant → 404.
  - Provider de peças:
    - resposta 422 com `{"error":{"message":"ExceededBudget: End User=t1 over budget. Spend=10.2, Budget=10.0"}}` → `traduzirErroIa` lança 429 com `tenantMonth`;
    - 429 com "Rate limit exceeded for end_user: t1. Limit type: requests" → 429 com `tenantMinute`;
    - 429 sem essa marca → continua a mensagem `COTA` de hoje.
- [ ] **Step 2: Rodar e ver falhar** — `npx jest --runInBand src/modules/central-ia/__tests__/limites src/modules/central-ia/__tests__/i7ai-limites.controller.spec.ts src/modules/central-ia/__tests__/competencia.spec.ts src/modules/ia/__tests__/litellm.provider.spec.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS; `npx jest --runInBand src/modules/central-ia src/modules/ia/__tests__/litellm.provider.spec.ts` → PASS.
- [ ] **Step 5: Conferir no LiteLLM local**
  - Salvar `{ orcamentoMensalUsd: 0.01, bloquear: true }` para a prefeitura de teste.
  - `curl` em `/customer/info?end_user_id=<id>` mostra `litellm_budget_table.max_budget = 0.01` e `budget_duration = '1mo'`.
  - Uma geração de peça depois de gastar mais de US$ 0,01 → 429 com `tenantMonth`.
  - Remover o limite → a peça seguinte gera.
- [ ] **Step 6: Commit** — `git commit -m "feat(ia): limites de IA por prefeitura no LiteLLM e por usuário na Central"`

---

### Task 3 (i7Ai backend): recusas do LiteLLM traduzidas e limites por usuário

Paralelizável com Task 4 e Task 5 (repositório diferente; o contrato foi fixado na Task 2).

**Files:**
- Create: `backend/src/ai/limit-messages.ts`: `export const LIMIT_MESSAGES = { tenantMonth, tenantMinute, userMonth, userMinute } as const`, com os textos das Global Constraints.
- Modify: `backend/src/ai/omnirouter.service.ts:285-298` (`httpError`)
  - Antes de `missingKey`:
    - `/ExceededBudget|over budget|Budget has been exceeded/i` → `HttpException(LIMIT_MESSAGES.tenantMonth, 429)`;
    - `/Rate limit exceeded for end_user/i` → `HttpException(LIMIT_MESSAGES.tenantMinute, 429)`.
  - As duas levam `providerStatus: status`. Vale para stream e não stream (L240 é o único ponto de chamada).
- Create: `backend/src/sgdm/sgdm-limits.service.ts`, `SgdmLimitsService`, exportado por `SgdmModule`:
  - `forUser(tenantId: string, userId: string): Promise<UserLimits | null>`.
    - `UserLimits = { monthlyBudgetUsd: number | null; block: boolean; callsPerMinute: number | null; tokensPerMinute: number | null }`.
    - `null`: integração desligada, `usuario: null`, ou falha sem valor em cache. Na falha, `logger.warn` sem a chave (decisão 7).
  - Lê `GET /integracoes/i7ai/limites/:tenantId?usuarioId=` por `sgdmIntegrationGet`.
  - Cache por `tenantId:userId`, TTL `SGDM_LIMITS_CACHE_SECONDS` (padrão 60). Em erro, serve o valor vencido por até 600 s. `MAX_CACHE = 5000`, FIFO, como `SgdmAccessService`.
- Modify: `backend/prisma/schema.prisma`: `AiTokenReservation.userId String? @db.Uuid` + `@@index([tenantId, userId, createdAt])`.
  - Migration `20261028000300_ai_token_reservations_user`.
  - Se `AiUsage` não tiver índice com `userId`, a mesma migration cria `@@index([tenantId, userId, createdAt])` em `ai_usage`.
- Modify: `backend/src/ai/ai-quota.service.ts`
  - Construtor: `(prisma, @Optional() limits?: SgdmLimitsService)`.
  - `runRound()`: antes de `reserve`, `const userLimits = scope.userId && this.limits ? await this.limits.forUser(scope.tenantId, scope.userId) : null`.
  - `reserve(scope, budget, userLimits: UserLimits | null = null)`: dentro da transação, depois do bloco da licença e antes do `create`, com `now` e `minuteAgo = now − 60 s`:
    - `monthlyBudgetUsd` e `block` → soma de `aiUsage.cost` (`tenantId`, `userId`, `createdAt ≥ início do mês UTC`) ≥ orçamento → `HttpException(LIMIT_MESSAGES.userMonth, 429)`.
    - `callsPerMinute` → `aiTokenReservation.count({ tenantId, userId, createdAt ≥ minuteAgo })` ≥ limite → `HttpException(LIMIT_MESSAGES.userMinute, 429)`.
    - `tokensPerMinute` → (input + output de `aiUsage` do usuário desde `minuteAgo`) + (`reservedTokens` das reservas `RESERVED`/`UNCERTAIN` do usuário desde `minuteAgo`) ≥ limite → a mesma `userMinute`. O orçamento da chamada nova não entra (decisão 6).
    - O `create` grava `userId: scope.userId`.
- Modify: `backend/src/ai/ai-gateway.module.ts`: `SgdmModule` já importado (Entrega 2). Confirmar que `SgdmLimitsService` é injetável em `AiQuotaService`.
- Test:
  - `backend/test/omnirouter.test.cjs` (recusas);
  - `backend/test/quota.test.cjs` (limites por usuário);
  - create `backend/test/sgdm-limits.test.cjs`.

**Interfaces:**
- Consumes: o contrato `GET /integracoes/i7ai/limites/:tenantId?usuarioId=` (Task 2); `sgdmIntegrationGet` (Entrega 2, Task 6).
- Produces: `LIMIT_MESSAGES`; `SgdmLimitsService.forUser`; a coluna `ai_token_reservations.userId`.

- [ ] **Step 1: Testes**
  - `omnirouter.test.cjs`, com o servidor falso do arquivo:
    - 422 `{"error":{"message":"litellm.BudgetExceededError: ExceededBudget: End User=tenant-a over budget. Spend=1.2, Budget=1.0"}}`, com e sem `onDelta` → rejeita com `status 429` e `message === LIMIT_MESSAGES.tenantMonth`;
    - 429 "Rate limit exceeded for end_user: tenant-a. Limit type: tokens." → `tenantMinute`;
    - 429 sem essa marca → continua "O provedor de IA atingiu o limite de uso…";
    - a reserva da chamada recusada fica `REJECTED`.
  - `quota.test.cjs`, com o Prisma em memória e um `SgdmLimitsService` falso:
    - custo do mês do usuário 10,00 com orçamento 10 e `block: true` → 429 `userMonth`, sem `create`;
    - com `block: false` → reserva criada;
    - 3 reservas do usuário nos últimos 60 s com `callsPerMinute: 3` → 429 `userMinute`; uma reserva de 61 s atrás não conta;
    - `tokensPerMinute: 1000` com 900 tokens usados e reserva nova de 128000 (imagem) → passa;
    - com 1000 usados → 429;
    - automação (sem `userId`) → `forUser` não é chamado;
    - a reserva criada tem `userId`.
  - `sgdm-limits.test.cjs`:
    - devolve os limites e repete do cache dentro do TTL;
    - stale servido com o SGDM em 500;
    - nunca lido com o SGDM fora → `null` e `warn`;
    - integração desligada → `null` sem `fetch`.
- [ ] **Step 2: Rodar e ver falhar** — `npm run build && node --test test/omnirouter.test.cjs test/quota.test.cjs test/sgdm-limits.test.cjs` → FAIL.
- [ ] **Step 3: Implementar** e rodar `npm run prisma:generate`.
- [ ] **Step 4: Rodar e ver passar** — `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git add backend/prisma backend/src/ai backend/src/sgdm backend/test && git commit -m "feat(ia): recusas por limite com mensagem clara e limites de IA por usuário"`

---

### Task 4 (SGDM API): licenças do i7Ai na Central e endpoint interno

**Files:**
- Create: `apps/api/src/modules/central-ia/licencas.regras.ts` (funções puras):
  - `paraI7ai(l: I7aiLicenca | null): LicencaI7ai | null`
    - `ATIVA → 'ACTIVE'`, `SUSPENSA → 'SUSPENDED'`.
    - `startDate = inicio + 'T03:00:00.000Z'`; `endDate = fim ? (fim + 1 dia) + 'T03:00:00.000Z' : null` (decisão 14).
    - Os `BigInt` vão como string.
  - `deLegada(l: LicencaLegadaI7ai): DadosLicenca`: `ACTIVE → ATIVA`; `SUSPENDED` e `EXPIRED` → `SUSPENSA`; datas pelo dia em UTC.
  - `validarLicenca(dto): string | null`: `fim < inicio` → "O fim da licença deve ser igual ou posterior ao início.".
- Create: `apps/api/src/modules/central-ia/i7ai-licencas.client.ts`, `I7aiLicencasClient`
  - Mesma base, chave e timeout de 8 s do `I7aiNomesClient` (Entrega 2, Task 9).
  - `uso(tenantIds: string[]): Promise<Record<string, UsoLicencaI7ai>>`
    - `POST ${i7ai.apiUrl}/integracoes/sgdm/licencas/uso` com `{ tenantIds }`, em lotes de 200.
    - Falha ou sem configuração → `{}` e `logger.warn`.
  - `legadas(): Promise<LicencaLegadaI7ai[]>`
    - `GET ${i7ai.apiUrl}/integracoes/sgdm/licencas`.
    - Falha → `ServiceUnavailableException('O i7Ai não respondeu; tente importar de novo.')`.
- Create: `apps/api/src/modules/central-ia/licencas.service.ts`, `CentralIaLicencasService`:
  - `listar(): Promise<{ tenantId; nome; licenca: LicencaCentral | null; uso: UsoLicencaI7ai | null }[]>`: prefeituras ativas por `nome`, com o uso vindo do client.
  - `salvar(user, tenantId, dto: LicencaDto)`: upsert e auditoria `CRIAR`/`EDITAR` com `entidade 'i7ai_licenca'`. Tenant inexistente → 404.
  - `importar(user): Promise<{ importadas: number; ignoradas: number }>`:
    - Cria só para `tenantId` que existe no SGDM e não tem `i7ai_licencas`. As demais contam como ignoradas.
    - Auditoria `IMPORTAR` por licença criada.
  - `paraIntegracao(tenantId): Promise<{ licenca: LicencaI7ai | null }>`.
- Create: `apps/api/src/modules/central-ia/licencas.controller.ts` (`IA_CENTRAL`):
  - `GET central-ia/licencas`
  - `PUT central-ia/licencas/:tenantId`
  - `POST central-ia/licencas/importar`
  - Sem `DELETE` (decisão 14).
- Create: `apps/api/src/modules/central-ia/dto/licencas.dto.ts`, `LicencaDto`:
  - `situacao` ∈ {`ATIVA`, `SUSPENSA`}; `inicio` e `fim?` em ISO de data (`AAAA-MM-DD`).
  - `maxUsuarios`, `maxAgentes`, `maxAutomacoes`, `maxBases`: int, 0–1.000.000.
  - `maxArmazenamentoBytes` e `maxTokensMes`: string de dígitos, até 15 caracteres.
- Modify: `apps/api/src/modules/central-ia/i7ai-limites.controller.ts` (Task 2): `GET integracoes/i7ai/licenca/:tenantId` → `{ licenca: LicencaI7ai | null }`. UUID inválido → 404.
- Modify: `central-ia.module.ts`.
- Test: `__tests__/licencas.regras.spec.ts`, `__tests__/licencas.service.spec.ts`, `__tests__/licencas.controller.spec.ts`, `__tests__/i7ai-licencas.client.spec.ts`; `__tests__/i7ai-limites.controller.spec.ts` (rota nova).

**Interfaces:**
- Consumes: modelos da Task 1; `exigirChaveIntegracao`; `i7ai.apiUrl` e `i7ai.chaveIntegracao` (Entrega 2).
- Produces. **Contratos congelados aqui** (a Task 6 implementa o lado do i7Ai):
  - SGDM → i7Ai: `GET /integracoes/i7ai/licenca/:tenantId` → `{ licenca: LicencaI7ai | null }`.
    - `LicencaI7ai = { status: 'ACTIVE' | 'SUSPENDED'; startDate: string; endDate: string | null; maxUsers: number; maxAgents: number; maxAutomations: number; maxKnowledgeBases: number; maxStorageBytes: string; maxTokens: string }`.
  - i7Ai → SGDM: `POST /api/integracoes/sgdm/licencas/uso`, body `{ tenantIds: string[] }` (uuids, 1–200) → `{ uso: Record<string, UsoLicencaI7ai> }`.
    - `UsoLicencaI7ai = { users: number; agents: number; automations: number; knowledgeBases: number; storageBytes: string; tokensThisMonth: string; reservedTokens: string }`.
  - i7Ai → SGDM: `GET /api/integracoes/sgdm/licencas` → `{ licencas: LicencaLegadaI7ai[] }`.
    - `LicencaLegadaI7ai = { tenantId: string; status: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED'; startDate: string; endDate: string | null; maxUsers; maxAgents; maxAutomations; maxKnowledgeBases: number; maxStorageBytes: string; maxTokens: string }`. Só a linha mais recente de cada prefeitura.
  - `CentralIaLicencasService.listar`, usado pela Task 9.

- [ ] **Step 1: Testes**
  - Regras:
    - `paraI7ai({ situacao: 'ATIVA', inicio: 2026-01-01, fim: 2026-12-31, maxArmazenamentoBytes: 10737418240n, … })` → `startDate '2026-01-01T03:00:00.000Z'`, `endDate '2027-01-01T03:00:00.000Z'`, `maxStorageBytes '10737418240'`;
    - `fim` nulo → `endDate null`;
    - `deLegada({ status: 'EXPIRED', … }).situacao === 'SUSPENSA'`.
  - Service:
    - `importar` com três legadas (uma de tenant inexistente, uma de tenant que já tem licença, uma nova) → `{ importadas: 1, ignoradas: 2 }`, com uma auditoria `IMPORTAR`;
    - `listar` com o client lançando → linhas com `uso: null` e status 200;
    - `salvar` com `fim` antes de `inicio` → 400 com a mensagem exata.
  - Client: sem `apiUrl` → `uso` devolve `{}` sem `fetch`; 450 ids → três lotes.
  - Controllers:
    - sem `IA_CENTRAL` → 403 nas três rotas;
    - interno: sem chave → 404, chave errada → 401, tenant sem licença → `{ licenca: null }`.
- [ ] **Step 2: Rodar e ver falhar** — `npx jest --runInBand src/modules/central-ia/__tests__/licencas src/modules/central-ia/__tests__/i7ai-licencas.client.spec.ts src/modules/central-ia/__tests__/i7ai-limites.controller.spec.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): licenças do i7Ai cadastradas na Central de IA"`

---

### Task 5 (SGDM API): alertas, rotina de 15 min e e-mail

**Files:**
- Create: `apps/api/src/modules/central-ia/alertas.regras.ts` (funções puras):
  - `type TipoAlerta = 'ORCAMENTO_AVISO' | 'ORCAMENTO_ATINGIDO' | 'USUARIO_ORCAMENTO_AVISO' | 'USUARIO_ORCAMENTO_ATINGIDO' | 'USUARIO_ACIMA_DA_MEDIA'`
  - `MIN_USUARIOS_MEDIA = 5`, `MIN_GASTO_ACIMA_MEDIA_USD = 1`
  - `chaveDoAlerta(tipo, tenantId, usuarioId: string | null, competencia, orcamentoUsd: number | null): string`
    - Devolve `` `${tipo}:${tenantId}:${usuarioId ?? '-'}:${competencia}` ``.
    - Nos tipos `ORCAMENTO_*` e `USUARIO_ORCAMENTO_*`, acrescenta `` `:${orcamentoUsd}` ``. Assim, um orçamento aumentado no mês volta a gerar alerta ao ser atingido de novo.
    - `USUARIO_ACIMA_DA_MEDIA` não leva o sufixo.
  - `avaliarAlertas(e: EntradaAlertas): NovoAlerta[]`
    - `EntradaAlertas = { competencia; gastoPrefeituras: Map<string, number>; gastoUsuarios: Map<string, { tenantId: string; gastoUsd: number }>; limites: (LimitePrefeitura & { tenantId })[]; limitesUsuarios: (LimiteUsuario & { tenantId; usuarioId })[]; nomesPrefeituras: Map<string,string>; nomesUsuarios: Map<string,string> }`.
    - `NovoAlerta = { chave; tipo; tenantId; usuarioId: string | null; competencia; valorUsd: number; referenciaUsd: number | null; mensagem: string }`.
    - Regras:
      - gasto ≥ 100% do orçamento → `*_ATINGIDO`;
      - gasto ≥ `avisoPercentual` → `*_AVISO`. Os dois podem coexistir; o aviso já criado não some.
      - acima da média: decisão 8. `referenciaUsd` = média.
    - Mensagens exatas (valores com `formatarUsdBr`, por exemplo "US$ 85,00"):
      - `ORCAMENTO_AVISO`: "`<Prefeitura>`: 85% do orçamento de IA do mês (US$ 85,00 de US$ 100,00)."
      - `ORCAMENTO_ATINGIDO`: "`<Prefeitura>` atingiu o orçamento de IA do mês (US$ 100,40 de US$ 100,00)." Com `bloquear`, acrescenta " As chamadas estão bloqueadas até a virada do mês ou até o orçamento subir."
      - `USUARIO_ORCAMENTO_AVISO` / `_ATINGIDO`: "`<Usuário>` (`<Prefeitura>`): 90% do limite mensal (US$ 18,00 de US$ 20,00)." / "`<Usuário>` (`<Prefeitura>`) atingiu o limite mensal (US$ 20,10 de US$ 20,00)."
      - `USUARIO_ACIMA_DA_MEDIA`: "`<Usuário>` (`<Prefeitura>`) gastou US$ 42,00 no mês, 4,2× a média da prefeitura (US$ 10,00)."
    - Truncadas em 300.
- Create: `apps/api/src/modules/central-ia/alertas.service.ts`, `CentralIaAlertasService`:
  - Construtor: `(prisma, central: CentralIaService, fila: FilaEmailService, auditoria)`.
  - `avaliar(agora = new Date()): Promise<{ criados: number; emails: number }>`, nesta ordem:
    1. `competenciaUtc(agora)` e `central.gastoDoMes`.
    2. Usuários com gasto → `tenantId` por `prisma.usuario.findMany({ where: { id: { in } }, select: { id, tenantId, nome } })`. Ids que não são uuid ou não existem ficam de fora.
    3. Limites e nomes.
    4. `avaliarAlertas`.
    5. `ia_alertas.create` um a um. `P2002` em `chave` = já existia; ignora.
    6. E-mail dos criados: `updateMany({ where: { id, emailEnfileiradoEm: null }, data: { emailEnfileiradoEm: agora } })`. Só com `count === 1`, enfileira para cada destinatário.
       - `{ tipo: 'aviso', tenantId: dest.tenantId, usuarioId: dest.id, evento: EVENTO_EMAIL.IA_ALERTA, titulo: 'Central de IA: alerta de consumo', detalhe: alerta.mensagem, caminho: '/central-ia' }`.
    - Destinatários: `usuario.findMany({ where: { ativo: true, perfis: { some: { perfil: { ativo: true, permissoes: { some: { permissao: { codigo: 'IA_CENTRAL' } } } } } } }, select: { id, tenantId } })`.
  - `listar(f: { situacao?: 'ABERTO' | 'RESOLVIDO'; tenantId?: string; inicio?: string; fim?: string }): Promise<AlertaCentral[]>`, `take 100`, `criadoEm desc`, com o nome da prefeitura e do usuário.
  - `resolver(user, id)`:
    - Já resolvido → devolve como está. Inexistente → 404.
    - Grava `situacao 'RESOLVIDO'`, `resolvidoEm` e `resolvidoPorId`.
    - Auditoria `RESOLVER`, `entidade 'ia_alerta'`, com o `tenantId` do alerta.
- Create: `apps/api/src/modules/central-ia/alertas-rotina.service.ts`, `CentralIaAlertasRotina` (`OnApplicationBootstrap`, `OnModuleDestroy`):
  - Intervalo `centralIa.intervaloAlertasMs`. `0`, ou `litellmConfig` nulo → não agenda.
  - Primeira rodada com `setTimeout` de 120000 ms; depois `setInterval`, os dois com `unref`.
  - A flag `rodando` evita duas rodadas no mesmo processo. Erro → `logger.warn` com a mensagem e a rodada seguinte segue.
- Modify: `apps/api/src/config/configuration.ts`: `centralIa: { intervaloAlertasMs: inteiro(process.env.IA_ALERTAS_INTERVALO_MS, 900000) }`, no padrão dos outros inteiros do arquivo.
- Modify: `apps/api/src/modules/notificacoes/email/aviso-email.regras.ts`: `EVENTO_EMAIL.IA_ALERTA = 'IA_ALERTA'`. Ele entra em `lerJob` pela lista de `EVENTO_EMAIL`. Não aparece na tela de preferências por evento, se houver uma: é aviso da plataforma.
- Create: `apps/api/src/modules/central-ia/alertas.controller.ts` (`IA_CENTRAL`):
  - `GET central-ia/alertas?situacao=&tenantId=&inicio=&fim=`
  - `POST central-ia/alertas/:id/resolver`
- Modify: `central-ia.module.ts`: importa `NotificacoesModule` e registra o controller e os dois providers. Antes, confirmar que `NotificacoesModule` exporta `FilaEmailService`; se não exportar, acrescentar ao `exports`.
- Test: `__tests__/alertas.regras.spec.ts`, `__tests__/alertas.service.spec.ts`, `__tests__/alertas-rotina.spec.ts`, `__tests__/alertas.controller.spec.ts`.

**Interfaces:**
- Consumes: `CentralIaService.gastoDoMes`, `competenciaUtc` (Task 2); modelos da Task 1; `FilaEmailService.enfileirar`.
- Produces: `GET central-ia/alertas` → `AlertaCentral[]`, usado pela Task 8.
  - `AlertaCentral = { id; tipo: TipoAlerta; tenantId; prefeitura: string; usuarioId: string | null; usuario: string | null; competencia; valorUsd: number; referenciaUsd: number | null; mensagem; situacao: 'ABERTO' | 'RESOLVIDO'; criadoEm: string; resolvidoEm: string | null }`.

- [ ] **Step 1: Testes**
  - Regras, com orçamento 100 e aviso 80:
    - gasto 79,99 → nenhum;
    - 80 → `ORCAMENTO_AVISO` com a mensagem exata "Prefeitura de Teste: 80% do orçamento de IA do mês (US$ 80,00 de US$ 100,00).";
    - 100,40 com `bloquear` → `ORCAMENTO_AVISO` + `ORCAMENTO_ATINGIDO`, este com a frase de bloqueio;
    - `bloquear: false` → sem a frase;
    - prefeitura sem orçamento → nenhum.
  - Média:
    - 5 usuários com gastos [1, 1, 1, 1, 42] e N = 3 → só o de 42, média 9,20;
    - 4 usuários → nenhum;
    - usuário com 0,90 acima de N× → nenhum (mínimo US$ 1).
  - `chaveDoAlerta`:
    - `('ORCAMENTO_AVISO','t1',null,'2026-10',100) === 'ORCAMENTO_AVISO:t1:-:2026-10:100'`;
    - `('USUARIO_ACIMA_DA_MEDIA','t1','u1','2026-10',null) === 'USUARIO_ACIMA_DA_MEDIA:t1:u1:2026-10'`.
  - Service:
    - `create` lançando `P2002` → não conta como criado e não enfileira;
    - `updateMany` com `count 0` → não enfileira;
    - dois destinatários → dois `enfileirar` com `evento 'IA_ALERTA'`;
    - um usuário cujo `tenantId` no banco difere do da tag não entra em outra prefeitura;
    - `resolver` → auditoria `RESOLVER`;
    - `listar({ tenantId })` passa `tenantId` no `where`.
  - Rotina:
    - `intervaloAlertasMs = 0` → nenhum timer;
    - duas chamadas simultâneas de `rodada()` → `avaliar` uma vez;
    - `avaliar` lançando → `warn` e nada propaga.
  - Controller: sem `IA_CENTRAL` → 403 nas duas rotas.
- [ ] **Step 2: Rodar e ver falhar** — `npx jest --runInBand src/modules/central-ia/__tests__/alertas` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**
  - Mesmo comando → PASS.
  - `npx jest --runInBand src/modules/notificacoes/__tests__ src/modules/central-ia` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): alertas de consumo de IA com rotina e e-mail para a Central"`

---

### Task 6 (i7Ai backend): licença vinda do SGDM e Licenciamento fora da API

Paralelizável com Task 5 (repositório diferente; os contratos foram fixados na Task 4).

**Files:**
- Create: `backend/src/sgdm/sgdm-license.service.ts`, `SgdmLicenseService` (`OnModuleInit`, `OnModuleDestroy`), exportado por `SgdmModule`:
  - `fetch(tenantId: string): Promise<LicenseSnapshot | null | undefined>`
    - `undefined` = integração desligada ou SGDM com falha (`logger.warn`). Nesse caso nada muda.
    - `null` = SGDM sem licença.
    - `LicenseSnapshot` = `LicencaI7ai` (Task 4), com `maxStorageBytes` e `maxTokens` já como `bigint`.
    - Lê `GET /integracoes/i7ai/licenca/:tenantId` por `sgdmIntegrationGet`.
  - `apply(tx: Prisma.TransactionClient, tenantId: string, snapshot: LicenseSnapshot | null): Promise<void>`
    - Com snapshot: atualiza a linha mais recente (`orderBy createdAt desc`) ou cria uma. Mexe só nos campos do snapshot; `features` fica.
    - `null` com linha local → `logger.warn('Licença local sem cadastro no SGDM; importe na Central de IA.')`, uma vez por prefeitura e processo, e nada muda (decisão 15).
  - `syncAll(): Promise<{ synced: number }>`: para cada `tenant` com `status 'ACTIVE'`, `fetch`; se não for `undefined`, `apply` numa transação com `SELECT … FOR UPDATE` do tenant (a mesma trava de `license-policy.ts`).
  - Agenda: só com `sgdmIntegrationEnabled()`. Primeira rodada 30 s depois de subir; depois a cada `SGDM_LICENSE_SYNC_SECONDS` (padrão 60); timers com `unref`, como `ModelPricingSyncService`.
  - `usage(tenantIds: string[]): Promise<Record<string, UsageI7ai>>`
    - O corpo de contagem de `CatalogService.licensing()` movido para cá, por prefeitura: usuários não suspensos, agentes e automações não arquivados, bases, bytes de documentos, tokens do mês UTC e reservas pendentes.
    - Números grandes como string.
  - `legacy(): Promise<LicencaLegadaI7ai[]>`: a linha mais recente de cada prefeitura.
- Create: `backend/src/sgdm/sgdm-licenses.controller.ts`, registrado em `SgdmModule`, com o verificador da chave da Entrega 2. Se o verificador ainda estiver dentro de `sgdm-names.controller.ts`, extraia-o para `backend/src/sgdm/integration-key.ts` como `assertIntegrationKey(authorization?: string): void` e use-o nos dois.
  - `GET /api/integracoes/sgdm/licencas` → `{ licencas: await legacy() }`.
  - `POST /api/integracoes/sgdm/licencas/uso`, body `{ tenantIds }`: só uuids, 1–200, senão 400 → `{ uso }`.
- Modify: `backend/src/auth/sgdm-identity.service.ts` (`sync()`, L103–121)
  - Antes da transação: `const license = this.licenses ? await this.licenses.fetch(identity.tenantId) : undefined`.
  - Dentro, logo depois do `tenant.upsert`: `if (license !== undefined) await this.licenses!.apply(tx, identity.tenantId, license)`. Assim um usuário novo já é contado contra a licença do SGDM (JIT).
  - Injeção com `@Optional()`, como `tenantKeys`.
- Modify: `backend/src/catalog/catalog.controller.ts:37-40`, `catalog.service.ts:212-242`, `catalog.dto.ts:64-75`
  - Remove `GET/PATCH /licensing`, `licensing()`, `updateLicense()`, `LicenseDto`, e `largeInteger` se ficar sem uso.
- Modify: `backend/src/auth/role-catalog.ts:3,9`: tira `'licensing'` de `RESOURCES` e do caso do CONSTRUTOR (decisão 17).
- Test:
  - Create `backend/test/sgdm-license.test.cjs`.
  - Modify:
    - `backend/test/sgdm-identity.test.cjs` (licença do SGDM aplicada no login);
    - `backend/test/audit-crud.test.cjs:133-134` (remover os casos `license.created`/`license.updated` e afirmar que `CatalogController.prototype.updateLicense` não existe);
    - `backend/test/provision.test.cjs:94,124` (nenhuma permissão com `resource 'licensing'`).

**Interfaces:**
- Consumes: os três contratos da Task 4; `sgdmIntegrationGet`, `sgdmIntegrationEnabled` e o verificador de chave (Entrega 2).
- Produces: os endpoints `GET /api/integracoes/sgdm/licencas` e `POST /api/integracoes/sgdm/licencas/uso`, consumidos por `I7aiLicencasClient` (Task 4).

- [ ] **Step 1: Testes**
  - `sgdm-license.test.cjs`, com o SGDM falso e o Prisma em memória:
    - snapshot `ACTIVE` com `maxUsers 5` → cria a linha com `maxStorageBytes` `bigint`;
    - segunda chamada com `maxUsers 8` → atualiza a mesma linha e mantém `features`;
    - duas linhas locais → só a mais recente muda;
    - `{ licenca: null }` com linha local → linha intacta e um `warn`;
    - SGDM 500 → `fetch` devolve `undefined` e nada muda;
    - `usage` de duas prefeituras → contagens separadas;
    - `/licencas/uso` com 201 ids → 400;
    - sem chave configurada → 404; chave errada → 401.
  - `sgdm-identity.test.cjs`:
    - prefeitura nova, com o SGDM devolvendo `maxUsers: 1` e um usuário já existente → o login de um segundo usuário recusa com "Limite de usuários da licença atingido";
    - SGDM fora no login → o login conclui com a licença local.
- [ ] **Step 2: Rodar e ver falhar** — `npm run build && node --test test/sgdm-license.test.cjs test/sgdm-identity.test.cjs test/audit-crud.test.cjs test/provision.test.cjs` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git add backend/src/sgdm backend/src/auth backend/src/catalog backend/test && git commit -m "feat(licenca): licenças do i7Ai vêm do SGDM e o Licenciamento sai da API"`

---

### Task 7 (i7Ai frontend): a tela Licenciamento sai

Paralelizável com Task 8 e Task 9 (repositório diferente).

**Files:**
- Modify: `src/app-shell.jsx`
  - `moduleNavigationGroups` (L17–25): sai o grupo "Organização", que depois da Entrega 2 só tinha `licensing`.
  - `titles` perde `licensing`.
  - O branch `active === 'licensing'` (L96) e o `import { LicensePage }` (L6) saem. Um `active` desconhecido continua caindo em dashboard.
  - `ShieldCheck` continua importado (usado na L82).
- Delete: `src/features/LicensePage.jsx`.
- Modify (Playwright):
  - `test/visual/fixtures.js:32`: remover `'/licensing'`.
  - `test/visual/sgdm.spec.js`: tirar `licensing` do mapa da L6 e de `editors` na L29; remover o caso de reservas (L84–85); novo caso: `?module=licensing` cai no Dashboard.
  - `test/visual/host-preview.spec.js:6`: tirar `licensing`.

- [ ] **Step 1: Atualizar os specs Playwright** (casos acima).
- [ ] **Step 2: Rodar e ver falhar** — `npx playwright test test/visual/sgdm.spec.js test/visual/host-preview.spec.js` → FAIL no caso novo.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**
  - Mesmo comando → PASS.
  - `npm run build` sem erros.
  - `grep -rn "licensing\|LicensePage" src` → nada.
- [ ] **Step 5: Commit** — `git add src test/visual && git commit -m "feat(ui): a tela Licenciamento sai do i7Ai"`. Nunca `output/verification`.

---

### Task 8 (SGDM web): aba Limites e alertas, alertas na Visão geral e cotação configurável

**Files (`apps/web/`):**
- Modify: `lib/central-ia.ts`
  - `ABAS_CENTRAL` += `{ id: 'limites', rotulo: 'Limites e alertas', href: '/central-ia/limites' }`, depois de `modelos`.
  - Remove `cotacaoUsd()`.
  - `formatarBrl(n: number, cotacao: number | null): string`: `null` → `SEM_VALOR`.
  - `rotuloAlerta(tipo: TipoAlerta): string`:
    - `ORCAMENTO_AVISO` → 'Orçamento perto do limite';
    - `ORCAMENTO_ATINGIDO` → 'Orçamento atingido';
    - `USUARIO_ORCAMENTO_AVISO` → 'Usuário perto do limite';
    - `USUARIO_ORCAMENTO_ATINGIDO` → 'Usuário atingiu o limite';
    - `USUARIO_ACIMA_DA_MEDIA` → 'Usuário acima da média'.
  - `diasComAlerta(alertas: { criadoEm: string }[]): string[]`: datas UTC `AAAA-MM-DD` únicas, ordenadas.
- Modify: `lib/constants.ts`: `PAGE_TITLES['/central-ia/limites'] = 'Limites e alertas'`.
- Create: `lib/central-ia-limites.ts`
  - `formatarPercentual(n: number | null): string`: `85 → '85%'`, `85.5 → '85,5%'`, `null → '—'`.
  - `validarLimite(form): string | null`: mesmas faixas e mensagens da API (Task 2).
  - `limiteVazio(): LimitePrefeitura` (aviso 80, `bloquear true`, o resto `null`).
- Create: `lib/central-ia-limites-api.ts`: `buscarConfiguracao`, `salvarConfiguracao`, `buscarLimites`, `buscarLimite`, `salvarLimite`, `removerLimite`, `salvarLimiteUsuario`, `removerLimiteUsuario`, `buscarAlertas`, `resolverAlerta`, sobre as rotas das Tasks 1, 2 e 5.
- Create: `components/central-ia/ListaAlertas.tsx`
  - Props `{ alertas: AlertaCentral[]; onResolver?: (id: string) => void }`.
  - Lista em `.card` com rótulo, mensagem, data e o botão "Resolver" só em `ABERTO`. Sem alertas → `EmptyState` "Nenhum alerta aberto.".
- Modify: `components/central-ia/CartoesResumo.tsx`
  - Recebe `cotacao: number | null` por prop, vinda de `useQuery(['central-ia','configuracao'])` na página.
  - Novo `.stat-card` "Alertas abertos" com a contagem.
- Modify: `app/(dashboard)/central-ia/page.tsx` (Visão geral)
  - Carrega `buscarAlertas({ situacao: 'ABERTO', tenantId })` e mostra `ListaAlertas` abaixo dos gráficos.
  - "Resolver" chama `resolverAlerta` e invalida a query.
- Modify: `components/central-ia/GraficoDiario.tsx` + `app/(dashboard)/central-ia/consumo/page.tsx`
  - Prop `diasComAlerta?: string[]`: `ReferenceLine` vertical (`recharts`, já usado) em cada dia, com `stroke` da cor de alerta do painel.
  - A tela Consumo busca os alertas do período (`inicio`, `fim`, `tenantId`).
- Create: `app/(dashboard)/central-ia/limites/page.tsx` (`AbasCentral`):
  - Card "Cotação do dólar": campo numérico (0,5–50), "Salvar", "Atualizado em …".
  - `DataTable` de prefeituras: nome, orçamento, gasto no mês, % (`formatarPercentual`), por minuto, exceções. A linha abre o detalhe.
  - Seção "Alertas" com `Tabs` "Abertos" · "Resolvidos" e `ListaAlertas`.
- Create: `app/(dashboard)/central-ia/limites/[tenantId]/page.tsx`:
  - Três `.stat-card`: "Gasto no mês", "Na chave da plataforma", "Na chave própria" (+ "Sem marcação" quando > 0), em US$ e R$.
  - Formulário da prefeitura:
    - orçamento (US$);
    - "Avisar a" (%);
    - "Bloquear ao atingir 100%" (checkbox);
    - chamadas por minuto, tokens por minuto;
    - "Alertar usuário acima de N× a média".
    - Botões "Salvar" e "Remover limites".
    - Erro 503 → `Toast` com a mensagem da API.
  - Seção "Limites por usuário":
    - Busca de usuário (mínimo 2 letras, rota de acesso da Entrega 2), com os mesmos campos menos N.
    - Lista das exceções com "Remover".
    - Nota fixa: "Limites por usuário valem para o i7Ai; as peças do SGDM entram no orçamento da prefeitura."
- Sem `IA_CENTRAL` → `router.replace('/dashboard')`, como as demais. Estados com `Skeleton`, `EmptyState` com "Tentar novamente" e `Toast`.
- Test: create `lib/__tests__/central-ia-limites.test.ts`; `lib/__tests__/central-ia.test.ts`.

**Interfaces:**
- Consumes: as rotas e os tipos das Tasks 1, 2 e 5 (`LimitePrefeitura`, `LimiteUsuario`, `AlertaCentral`, `TipoAlerta`).

- [ ] **Step 1: Testes**
  - `formatarBrl(10, null) === '—'`; `formatarBrl(10, 5.5) === 'R$ 55,00'`.
  - `formatarPercentual(85.5) === '85,5%'`.
  - `rotuloAlerta('USUARIO_ACIMA_DA_MEDIA') === 'Usuário acima da média'`.
  - `diasComAlerta([{ criadoEm: '2026-10-05T23:59:00Z' }, { criadoEm: '2026-10-05T01:00:00Z' }, { criadoEm: '2026-10-02T10:00:00Z' }])` → `['2026-10-02', '2026-10-05']`.
  - `validarLimite({ ...limiteVazio(), avisoPercentual: 100 })` → mensagem.
  - `ABAS_CENTRAL.map(a => a.id)` → `['visao-geral','consumo','modelos','limites']`.
  - `abaAtivaCentral('/central-ia/limites/abc') === 'limites'`.
  - `cotacaoUsd` não é mais exportado.
- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run lib/__tests__/central-ia-limites.test.ts lib/__tests__/central-ia.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar**
  - vitest PASS.
  - `npx tsc --noEmit -p .` sem erros novos.
  - `grep -rn "NEXT_PUBLIC_COTACAO_USD" apps/web` → nada.
  - Em `http://localhost:3000/central-ia/limites`, como `owner@sgdm.app`:
    - salvar a cotação 5,40 → a Visão geral mostra R$;
    - salvar um orçamento para a prefeitura de teste;
    - o detalhe mostra o gasto separado por chave.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): aba Limites e alertas, alertas na Visão geral e cotação configurável"`

---

### Task 9 (SGDM web): aba Licenças i7Ai

**Files (`apps/web/`):**
- Modify: `lib/central-ia.ts`: `ABAS_CENTRAL` += `{ id: 'licencas', rotulo: 'Licenças i7Ai', href: '/central-ia/licencas' }`, sempre a última. A Entrega 4 insere `otimizacao` antes dela.
- Modify: `lib/constants.ts`: `PAGE_TITLES['/central-ia/licencas'] = 'Licenças i7Ai'`.
- Create: `lib/central-ia-licencas.ts`
  - `bytesParaGb(bytes: string): number`: uma casa decimal, `'10737418240' → 10`.
  - `gbParaBytes(gb: number): string`: `10 → '10737418240'`, `0.5 → '536870912'`.
  - `usoDeLimite(usado: number | string | null, maximo: number | string): string`: `(3, 10) → '3 / 10'`, `(null, 10) → '— / 10'`, com números grandes em pt-BR (`'1.000.000'`).
  - `rotuloSituacaoLicenca(l: { situacao; fim: string | null } | null, hoje: string): string`:
    - `null` → 'Sem licença';
    - `SUSPENSA` → 'Suspensa';
    - `fim < hoje` → 'Expirada';
    - senão → 'Ativa'.
- Create: `lib/central-ia-licencas-api.ts`: `buscarLicencas`, `salvarLicenca`, `importarLicencas`.
- Create: `app/(dashboard)/central-ia/licencas/page.tsx` (`AbasCentral`):
  - `DataTable`: prefeitura, situação, vigência, usuários, agentes, automações, bases, armazenamento (GB) e tokens do mês. Uso vem com `usoDeLimite`; uso indisponível → "—".
  - Botão "Importar licenças do i7Ai": confirma, mostra "N importadas, M ignoradas" em `Toast` e recarrega.
  - A linha abre o detalhe.
- Create: `app/(dashboard)/central-ia/licencas/[tenantId]/page.tsx`
  - Formulário: situação (Ativa/Suspensa), início, fim (opcional), os quatro limites inteiros, armazenamento em GB e tokens por mês.
  - "Salvar". O erro da API vai para `Toast`.
  - Nota fixa: "O i7Ai aplica a licença em até 1 minuto. Para revogar, suspenda: licenças não são apagadas."
- Test: create `lib/__tests__/central-ia-licencas.test.ts`; `lib/__tests__/central-ia.test.ts`.

**Interfaces:**
- Consumes: as rotas da Task 4 (`LicencaCentral`, `UsoLicencaI7ai`).

- [ ] **Step 1: Testes**
  - Os exemplos de `bytesParaGb`, `gbParaBytes`, `usoDeLimite` e `rotuloSituacaoLicenca` acima.
  - `ABAS_CENTRAL.at(-1).id === 'licencas'` e cinco abas no total.
  - Atualizar a asserção de quatro abas da Task 8 em `central-ia.test.ts` para `['visao-geral','consumo','modelos','limites','licencas']`.
- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run lib/__tests__/central-ia-licencas.test.ts lib/__tests__/central-ia.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar**
  - vitest PASS; `npx tsc --noEmit -p .` sem erros novos.
  - Em `/central-ia/licencas`, como `owner@sgdm.app`:
    - importar as licenças locais do i7Ai;
    - editar `maxUsuarios` da prefeitura de teste;
    - ver o uso vindo do i7Ai.
- [ ] **Step 5: Commit** — `git commit -m "feat(ia): aba Licenças i7Ai na Central de IA"`

---

### Task 10: documentação e fumaça local

**Files:**
- Modify: `i7ai-IA/docs/LITELLM.md`
  - Nova seção "Limites e orçamento":
    - budget por prefeitura (`ia-prefeitura-<id>-<ms>`, `1mo`, reinício no dia 1º UTC);
    - gasto anterior ao primeiro orçamento (decisão 5);
    - mensagens de recusa;
    - limites por usuário no i7Ai.
  - Variáveis novas: `SGDM_LIMITS_CACHE_SECONDS` e `SGDM_LICENSE_SYNC_SECONDS` no backend do i7Ai; `IA_ALERTAS_INTERVALO_MS` na API do SGDM.
  - A seção de licenças passa a apontar para a Central de IA › Licenças i7Ai.
- Modify: `i7ai-IA/portainer/i7ai.stack.yml` e `portainer/stack.env.example`: só variáveis com padrão e comentários. Sem deploy (decisão 12).
- Modify (SGDM): `apps/web/public/ajuda/manual.html`
  - Subseções `#central-ia-limites` (orçamento, aviso, bloqueio, por minuto, por usuário, N× a média, alertas e e-mail, cotação) e `#central-ia-licencas` (editar, suspender, importar), dentro da seção `#central-ia` da Entrega 2.
  - Remover qualquer menção a `NEXT_PUBLIC_COTACAO_USD` dos documentos do SGDM.
- O resultado da fumaça vai na descrição do commit de documentação, sem arquivo novo.

- [ ] **Step 1: Fumaça local** (SGDM local + i7Ai pelo proxy `scripts/local-sgdm-proxy.cjs` + LiteLLM local, com `IA_ALERTAS_INTERVALO_MS=60000` só nesta sessão):
  1. Como `owner@sgdm.app`, salvar a cotação 5,40. A Visão geral mostra R$.
  2. Prefeitura de teste:
     - orçamento US$ 0,02, aviso 50%, bloquear;
     - conversar no i7Ai até passar de US$ 0,01;
     - em até 1 min, um alerta "Orçamento perto do limite" na Visão geral e o e-mail no log da API (SMTP local desligado: só assunto e tamanho).
  3. Passar de US$ 0,02:
     - o chat do i7Ai mostra "A prefeitura atingiu o limite de IA deste mês. Fale com o administrador da plataforma.";
     - a geração de peça mostra a mesma mensagem;
     - aparece o alerta "Orçamento atingido".
  4. Remover os limites → o chat volta a responder.
  5. Chamadas por minuto da prefeitura = 2 → a terceira mensagem no mesmo minuto mostra a mensagem por minuto.
  6. Limite de usuário com 1 chamada por minuto → a segunda mostra "Você atingiu o seu limite de uso de IA por minuto…". Outro usuário da mesma prefeitura conversa normalmente.
  7. Resolver um alerta → ele não volta na rodada seguinte.
  8. Licenças:
     - importar a licença local;
     - mudar `maxUsuarios` para o número atual de usuários;
     - em até 1 min, um usuário novo da prefeitura não entra no i7Ai e vê "Limite de usuários da licença atingido".
  9. O menu do i7Ai não tem Licenciamento; `#/licensing` cai no Dashboard.
  10. `grep -ri "sk-"` nos logs das duas APIs e em `auditoria`/`audit_logs` → nada.
  11. Derrubar a API do SGDM: o login no i7Ai conclui com a licença espelhada e o chat segue com o último limite de usuário em cache.
- [ ] **Step 2: Commit em cada repositório** — `git commit -m "docs(ia): Central de IA — limites, alertas e licenças"`.

---

## Self-review

- **Cobertura da spec:**
  - §5.4: orçamento, aviso e bloqueio, limites por minuto da prefeitura (T2) e do usuário (T3); regra N× (T5); alertas na Visão geral e por e-mail (T5, T8); licenças editadas na Central (T4, T9) e sincronizadas (T6); a tela Licenciamento some (T6, T7).
  - §5.1: o cartão "alertas abertos" e a lista de alertas (T8). A lista de sugestões fica para a entrega 4.
  - §5.2: os dias com alerta destacados no gráfico (T8).
  - Decisão 7: o orçamento conta as duas chaves, porque o customer recebe todo o gasto, e a Central mostra a divisão (T2, T8).
  - §6: limites no LiteLLM e no SGDM, endpoints internos com cache curto e auditoria sem chaves.
  - §9: a cotação como configuração da plataforma (T1, T8) e a tradução da recusa (T2, T3).
- **Tipos:**
  - `LimitePrefeitura`/`LimiteUsuario`/`LimiteUsuarioI7ai` (T2) → `UserLimits` (T3), com mapeamento explícito no `SgdmLimitsService`.
  - `LicencaI7ai`/`UsoLicencaI7ai`/`LicencaLegadaI7ai` (T4) → T6 e T9.
  - `AlertaCentral`/`TipoAlerta` (T5) → T8.
  - `competenciaUtc` e `gastoDoMes` (T2) → T5.
- **Paralelismo:**
  - T3 ∥ T4/T5 (contrato de limites congelado na T2).
  - T6 ∥ T5 (contratos de licença congelados na T4).
  - T7 ∥ T8/T9.
  - As tasks do SGDM rodam em ordem: T1 → T2 → T4 → T5 → T8 → T9.
