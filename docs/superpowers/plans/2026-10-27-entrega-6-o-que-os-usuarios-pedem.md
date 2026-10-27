# Entrega 6 — O que os usuários pedem

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O dono da plataforma vê na Central de IA os **temas mais frequentes** das conversas e as **conversas de alto custo** (com tema e título, nunca o texto). Quem tem `IA_CENTRAL` abre uma conversa de qualquer prefeitura no i7Ai, em modo só leitura, com o motivo registrado na auditoria da prefeitura.

**Architecture:**
- O i7Ai classifica cada conversa num tema de uma **lista fixa** (15 temas), por palavras-chave no título e no nome do agente, sem chamar nenhum modelo. O tema fica numa coluna nova de `conversations`, preenchida na criação e por uma rotina de recálculo para as antigas.
- Ao SGDM saem só o id do tema, o rótulo e contagens:
  - `GET /api/integracoes/sgdm/temas` (novo);
  - `POST /api/integracoes/sgdm/nomes` (Entrega 2), que passa a devolver o tema de cada conversa e o título com dados pessoais mascarados.
- As conversas de alto custo são o agrupamento `conversa` do Consumo (Entrega 2 Task 9: as 200 de maior custo pelo LiteLLM), agora com tema, filtro por tema e o link "ver no i7Ai".
- A abertura entre prefeituras é uma rota nova do i7Ai, `POST /api/central/conversas/:id/abrir`. Ela exige a permissão `IA_CENTRAL`, lida do `/auth/me` do SGDM, e um motivo. Grava `audit_logs` no tenant da conversa **antes** de devolver o conteúdo. A tela do i7Ai abre por `/i7ai/?conversa=<id>`.

**Tech Stack:**
- i7Ai: NestJS + Prisma + `node:test`; React/Vite + `@sgdm/design` + Playwright.
- SGDM: NestJS + Jest (API); Next.js + React Query + Vitest + `recharts` (web).

**Spec:** `docs/superpowers/specs/2026-10-26-central-de-ia-design.md`: §1, §3 (anti-objetivos: dados de outra prefeitura, texto de conversa sem necessidade e sem registro), §5.1, §5.2 (linha da conversa: tema, modelo, custo e "ver no i7Ai" com auditoria), §6 (isolamento, endpoints internos), §7 (LGPD: a Central mostra temas e números; o texto só no i7Ai, com registro), §8 entrega 6.

**Repositórios:**
- i7Ai: `C:/xampp/htdocs/producao/i7ai-IA`, branch `feat/central-ia`.
- SGDM: worktree `C:/xampp/htdocs/producao/prefeitura/SGDM-central-ia`, branch `feat/central-ia`. Nas tasks, os caminhos do SGDM são relativos à raiz do worktree.

**Depende de:**
- Entrega 2:
  - i7Ai: `SgdmModule`, o verificador da chave entre servidores e `sgdm-names.controller.ts`/`sgdm-names.service.ts` (`POST /api/integracoes/sgdm/nomes`).
  - SGDM: `I7aiNomesClient`, `i7ai.apiUrl`, `Agrupamento` com `'conversa'`, `MAX_LINHAS_CONVERSA = 200`, `abreviarId`.
- Entrega 5: `MSG_TAGS_LIMITADAS` e o 400 do Consumo global por conversa acima do limite.
- Entregas 3 e 4: só a Visão geral já tem cartões delas. Não dependa de mais nada.
- **Não** depende de `ai_usage.conversationId` (Entrega 4). O custo das conversas continua vindo do LiteLLM (spec §5.2, "fonte dos números").

**Decisão 12:** nada deste plano vai para produção. Este é o último plano antes do deploy único.

## Decisões do autor (o que a spec deixa em aberto)

1. **O título não é neutro.** `ai-gateway.service.ts:81` grava `title = input.message.trim().slice(0, 120)`, os primeiros 120 caracteres da primeira mensagem. A spec permite mostrar o "título da conversa" (§5.2), e a Entrega 2 já o envia ao SGDM. Esta entrega:
   - faz o **tema** (rótulo de lista fixa) ser a informação principal;
   - mostra o título só na lista de conversas de alto custo, como a §5.2 pede;
   - mascara o título no i7Ai antes de ele sair (Decisão 3);
   - documenta que nomes de pessoas no título não são detectáveis com segurança. Por isso o título aparece só para `IA_CENTRAL`, nunca em CSV de agrupamento que não seja `conversa`.
2. **Temas por palavras-chave, sem modelo.**
   - Custo zero (§1).
   - Nenhum dado da conversa vai a um provedor só para classificar (§2 decisão 4, §7).
   - Determinístico e testável.
   - Um classificador por modelo fica fora desta entrega.
   - Lista fixa, versão `THEME_VERSION = 1`:

   | id | rótulo | palavras-chave (sem acento, minúsculas) |
   | --- | --- | --- |
   | `licitacoes` | Licitações e contratos | licita, pregao, edital, contrat, aditivo, dispensa, inexigib, termo de referencia, ata de registro, 14.133, fornecedor, leilao |
   | `juridico` | Pareceres e questões jurídicas | parecer, juridic, lei, decreto, procuradori, recurso, mandado, acao judicial, constituc, sentenca |
   | `documentos` | Ofícios e documentos oficiais | oficio, memorando, portaria, despacho, circular, requerimento, notificac, comunicado, minuta, carta |
   | `pessoal` | Pessoal e RH | servidor, ferias, licenca, folha, concurso, nomeac, exonera, aposentad, estagi, ponto, rh, gratifica, progressao |
   | `tributos` | Tributos e arrecadação | iptu, iss, itbi, tribut, imposto, taxa, divida ativa, alvara, arrecada, nota fiscal |
   | `financas` | Orçamento e finanças | orcament, loa, ldo, ppa, empenho, liquidac, pagamento, receita, despesa, prestacao de contas, tce, convenio |
   | `saude` | Saúde | saude, ubs, sus, hospital, vacina, medicament, atencao basica, vigilancia sanitaria, paciente |
   | `educacao` | Educação | escola, educac, aluno, professor, merenda, transporte escolar, creche, matricula, fundeb |
   | `assistencia` | Assistência social | cras, creas, bolsa familia, cadunico, assistencia social, vulnerab, beneficio eventual, idoso |
   | `obras` | Obras e urbanismo | obra, pavimenta, engenhari, projeto basico, medicao, urbanis, loteamento, iluminacao, drenagem, reforma |
   | `meio-ambiente` | Meio ambiente | ambiental, meio ambiente, residuo, lixo, saneamento, arboriza, desmatamento |
   | `atendimento` | Atendimento ao cidadão | ouvidoria, cidadao, reclamac, protocolo, atendimento, e-sic, acesso a informacao, denuncia |
   | `tecnologia` | Tecnologia e sistemas | sistema, planilha, excel, software, computador, internet, site, senha |
   | `texto` | Revisão e resumo de textos | resum, revis, corrig, reescrev, traduz, ortografia, redacao |
   | `outros` | Outros | (nenhuma) |

   - Normalização: NFD sem diacríticos, minúsculas e espaços colapsados.
   - Casamento: palavra-chave de até 4 caracteres casa só a palavra inteira, com `s` final opcional (`\bleis?\b`: casa "leis", não "leitura"). As demais casam o início de palavra (`\bcontrat` casa "contratação"). Palavra-chave com espaço casa a expressão.
   - As palavras-chave são escapadas antes de virar regex (`14.133`, `e-sic`).
   - Pontos: cada acerto no título vale 2, e cada acerto no nome do agente vale 1. Vence a maior soma. O empate fica com a primeira na ordem da tabela. Sem acerto → `outros`.
   - Título `null` → só o nome do agente conta.
3. **Máscara de dados pessoais no título** (`maskPersonalData`, no i7Ai, aplicada a todo título que sai pelos endpoints internos), nesta ordem:
   - e-mail → `[e-mail]`;
   - CNPJ (`\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}`) → `[CNPJ]`;
   - CPF (`\d{3}\.?\d{3}\.?\d{3}-?\d{2}`) → `[CPF]`;
   - telefone, só com DDD entre parênteses ou com hífen (`\(\d{2}\)\s?9?\d{4}-?\d{4}` ou `\b9?\d{4}-\d{4}\b`) → `[telefone]`. Assim um número de processo não vira telefone;
   - qualquer sequência restante de 6 ou mais dígitos → `[número]`.
   - Dentro do i7Ai (tela do chat, abertura auditada) o título não é mascarado.
4. **Frequência de tema = conversas criadas no período** (`conversations.createdAt`, dias UTC de `inicio` a `fim`, como a Central). O período é de no máximo 366 dias, a mesma regra da Entrega 1.
   - Os temas não têm custo: a spec pede os "mais frequentes". O custo fica com as conversas, pelo LiteLLM.
   - Cada tema traz `conversas`, `usuarios` (distintos) e `prefeituras` (distintas).
   - Conversas ainda sem tema calculado (`themeVersion < THEME_VERSION`) contam em `semTema`.
5. **Conversas de alto custo** = `consumo(p, 'conversa')` da Entrega 2: as 200 de maior `gastoUsd` no LiteLLM, com `tema` vindo de `/nomes`.
   - O filtro `tema` age dentro dessas 200. A tela diz "Entre as 200 conversas de maior custo do período."
   - Sem prefeitura e acima do limite de tags da Entrega 5 → o 400 de `MSG_TAGS_LIMITADAS`. O cartão da Visão geral mostra essa frase no lugar da lista.
   - Paginação: `DataTable` com 20 por página, no navegador; a lista já vem limitada a 200.
6. **Abertura entre prefeituras ("ver no i7Ai").**
   - Quem pode: o usuário cujo `GET /auth/me` do SGDM tem `IA_CENTRAL` em `permissoes`. É lido a cada sessão; o cache de identidade de 60 s é o atraso máximo de uma revogação.
   - `IA_CENTRAL` não vira papel do i7Ai: `SgdmIdentity` e `request.user` ganham `centralIa: boolean`. Quem tem só `IA_CENTRAL`, sem `I7AI_*`, entra no i7Ai sem papéis e vê só a abertura de conversa.
   - Motivo obrigatório, de 10 a 300 caracteres. É a necessidade que a §3 pede registrada.
   - Auditoria: `audit_logs` com `tenantId` = **o da conversa** (o administrador da prefeitura vê em Relatórios › Auditoria), `userId` = quem abriu, `event 'conversation.viewed_by_platform'`, `resource 'conversations'`, `resourceId` = id da conversa, `metadata { viewerTenantId, viewerEmail, motivo, origem: 'central-ia', mensagens }` e `ipAddress`.
     - É gravada na mesma transação da leitura e antes da resposta. Se a gravação falhar, nada é devolvido.
     - Cada abertura gera um registro.
   - Só leitura: a rota devolve título, prefeitura, agente, modelo e mensagens (`role`, `content`, `createdAt`, nomes dos anexos). Não há escrita, exportação ou download de anexo por essa via.
   - No máximo as 1.000 mensagens mais recentes, com `truncada: true` acima disso.
   - Ordem das verificações: sem `centralIa` → 403 "Acesso restrito à Central de IA." **antes** de procurar a conversa, para nunca revelar se o id existe. Depois, motivo inválido → 400, e conversa inexistente → 404 "Conversa não encontrada.".
   - `Cache-Control: no-store`.
   - Sem integração com o SGDM (modo local avulso): `centralIa` é sempre `false`, e a rota responde 403.
7. **Link.** Na web do SGDM, `/i7ai/?conversa=<uuid>` (mesmo domínio, spec §8 entrega 0), em nova aba (`target="_blank" rel="noopener noreferrer"`). Aparece só em linha `conversa` cujo id é uuid.
8. **i7Ai fora do ar.**
   - `GET central-ia/temas` responde 200 com `{ indisponivel: true, temas: [], semTema: 0 }`, e o cartão mostra "Temas indisponíveis: o i7Ai não respondeu.".
   - `/nomes` já degrada para nomes abreviados e `tema: null` (Entrega 2).

## Global Constraints

**Testes (máquina de 16 GB, nunca a suíte inteira):**
- API do SGDM: `cd apps/api && npx jest --runInBand <caminhos da task>`.
- Web do SGDM: `cd apps/web && npx vitest run <arquivos da task>` (só `**/__tests__/**/*.test.ts`, ambiente `node`).
- Backend do i7Ai:
  - durante a task: `cd backend && npm run build && node --test test/<arquivo>.cjs`;
  - `npm run build && npm test` uma vez no fim de cada task (os testes carregam `../dist`).
- Frontend do i7Ai: `npx playwright test <arquivos da task>`.

**Commits:**
- Um por repositório, com `git add <caminhos explícitos>`.
- No i7Ai, nunca `output/verification/**`.
- No SGDM, nunca arquivos fora da task.

**Texto e visual:**
- Textos para o usuário em português; comentários de código em inglês.
- Nenhuma biblioteca nova.
- SGDM: só `PageHeader`, `.card`, `.stat-card`, `DataTable`, `Tabs`, `EmptyState`, `Skeleton`, `Toast`, `recharts` e `lucide-react`.
- i7Ai: os componentes de `@sgdm/design` que o app já usa.
- **Nenhuma aba nova:** a spec §4 fixa as seis abas. Os temas entram como cartão na Visão geral; as conversas, no Consumo.

**Chaves e dados:**
- Nenhuma chave de provedor ou chave administrativa do LiteLLM em banco do i7Ai, log, auditoria, resposta ou navegador.
- **O texto das conversas nunca sai do i7Ai.** Os endpoints internos devolvem ids, temas, contagens e títulos mascarados. O conteúdo só é devolvido pela rota auditada da Decisão 6, ao navegador de quem abriu, dentro do i7Ai.
- Logs do i7Ai com contagens; nunca título, motivo ou conteúdo.

**Acesso e isolamento:**
- Rotas `/central-ia/*` com `@RequirePermissions('IA_CENTRAL')` na classe.
- Endpoints internos do i7Ai: o verificador da Entrega 2 (sem chave configurada → 404; chave errada → 401; `timingSafeEqual` sobre sha256).
- `tenantId` opcional filtra tudo. Sem ele, a visão é de todas as prefeituras, só para `IA_CENTRAL`.

**Migrations (o executor confere a ordem antes de criar: `ls` da pasta e renomear se outra entrega já tiver usado nome posterior):**
- i7Ai: `20261031000100_conversation_theme`, depois de `20261030000300_optimization_events` (Entrega 4). Gere com `npx prisma migrate dev --create-only`, revise e aplique.
- SGDM: nenhuma.

## Review Focus

1. **Alguém sem `IA_CENTRAL` (administrador de prefeitura com `I7AI_ADMINISTRAR`) chama `POST /api/central/conversas/<id>/abrir` com o id de outra prefeitura, existente ou não.**
   - Esperado: 403 igual nos dois casos, nenhum `audit_logs` e nenhum conteúdo.
   - Teste: Task 3.
2. **Conversa apagada entre a listagem no SGDM e o clique em "ver no i7Ai".**
   - Esperado: 404 "Conversa não encontrada.", nenhum registro de auditoria, e a tela do i7Ai mostra a mensagem com "Fechar".
   - Teste: Tasks 3 e 4.
3. **Título com CPF, telefone ou e-mail ("Recurso do CPF 123.456.789-00, tel (65) 99999-1234").**
   - Esperado: o título que chega ao SGDM sai mascarado (`[CPF]`, `[telefone]`), o tema sai `juridico` e o banco do i7Ai mantém o título original.
   - Teste: Tasks 1 e 2.
4. **Conversa sem título, ou com agente de nome genérico ("Assistente").**
   - Esperado: tema pelo nome do agente quando houver acerto; senão `outros`. Nunca `null` depois do recálculo e nunca erro.
   - Teste: Task 1.
5. **i7Ai fora do ar ou sem `I7AI_API_URL` ao abrir a Visão geral.**
   - Esperado: o cartão de temas diz "Temas indisponíveis…", e o resto da Visão geral e do Consumo funciona, com títulos abreviados e tema "—".
   - Teste: Task 5.

---

### Task 1 (i7Ai backend): tema de cada conversa

Paralelizável com Task 3.

**Files:**
- Create: `backend/src/sgdm/themes.ts` (puro):
  - `THEME_VERSION = 1`
  - `THEMES: readonly { id: ThemeId; label: string; keywords: readonly string[] }[]`: a tabela da Decisão 2, na ordem dela.
  - `type ThemeId = 'licitacoes' | 'juridico' | 'documentos' | 'pessoal' | 'tributos' | 'financas' | 'saude' | 'educacao' | 'assistencia' | 'obras' | 'meio-ambiente' | 'atendimento' | 'tecnologia' | 'texto' | 'outros'`
  - `normalizeText(s: string): string`
  - `classifyTheme(title: string | null, agentName: string): ThemeId`
  - `themeLabel(id: string): string`; id desconhecido → `'Outros'`.
- Create: `backend/src/sgdm/personal-data.ts`: `maskPersonalData(text: string): string` (Decisão 3).
- Modify: `backend/prisma/schema.prisma`, `Conversation` +=:
  - `theme String? @db.VarChar(30)`
  - `themeVersion Int @default(0)`
  - `@@index([createdAt])`
  - `@@index([tenantId, createdAt])`
  - `@@index([themeVersion])`
- Create: `backend/prisma/migrations/20261031000100_conversation_theme/migration.sql`.
- Modify: `backend/src/ai/ai-gateway.service.ts:81`: a criação da conversa grava `theme: classifyTheme(title, agent.name)` e `themeVersion: THEME_VERSION`. O agente já está carregado nesse ponto; se não estiver, use `select: { name: true }` na mesma transação.
- Create: `backend/src/sgdm/theme-backfill.service.ts`, `ThemeBackfillService` (`OnApplicationBootstrap`/`OnModuleDestroy`, padrão de `backend/src/retention`):
  - primeira rodada 1 min depois de subir, depois a cada 10 min (`THEME_BACKFILL_INTERVAL_MS`, padrão 600000; `0` desliga);
  - cada rodada faz até 20 lotes de 500 conversas com `themeVersion < THEME_VERSION`, lendo só `id`, `title` e `agent.name`;
  - `updateMany` por tema e lote;
  - `logger.log` só com contagens.
- Modify: `backend/src/sgdm/sgdm.module.ts` (provider).
- Test: create `backend/test/themes.test.cjs`, `backend/test/theme-backfill.test.cjs`; `backend/test/chat-*.test.cjs` que criam conversa (asserção do tema).

**Interfaces:**
- Produces: `classifyTheme`, `themeLabel`, `THEMES`, `THEME_VERSION`, `ThemeId`, `maskPersonalData` e as colunas `conversations.theme` e `themeVersion`, usados pela Task 2.

- [ ] **Step 1: Testes**
  - `classifyTheme('Preciso de um parecer sobre a lei de licitações 14.133', 'Assistente')`: o título tem `parecer`, `lei` (jurídico, 4 pontos) e `licita`, `14.133` (licitações, 4 pontos). O empate fica com a ordem da tabela → `'licitacoes'`.
  - `classifyTheme('Recurso do CPF 123.456.789-00, tel (65) 99999-1234', 'Assistente')` → `'juridico'`.
  - `classifyTheme('Leitura do relatório', 'Assistente')` → `'outros'` (`lei` não casa "leitura").
  - `classifyTheme(null, 'Assistente de Saúde')` → `'saude'`.
  - `classifyTheme(null, 'Assistente')` → `'outros'`.
  - `classifyTheme('CONTRATAÇÃO EMERGENCIAL', 'x')` → `'licitacoes'` (acento e caixa).
  - `classifyTheme('Leis municipais', 'Assistente')` → `'juridico'`; `classifyTheme('Obras da praça', 'x')` → `'obras'` (plural de palavra curta).
  - `classifyTheme('Processo 14x133', 'x')` → `'outros'`: o ponto de `14.133` é literal.
  - `themeLabel('nao-existe') === 'Outros'`.
  - `maskPersonalData('Recurso do CPF 123.456.789-00, tel (65) 99999-1234, joao@x.gov.br, CNPJ 12.345.678/0001-90, processo 2026001234')` → `'Recurso do CPF [CPF], tel [telefone], [e-mail], CNPJ [CNPJ], processo [número]'`.
  - `maskPersonalData('Lei 14.133 de 2021')` não muda: 5 dígitos ou menos por sequência.
  - Backfill (Prisma em memória):
    - 1.200 conversas com `themeVersion 0` → depois de uma rodada, todas com `themeVersion 1` e tema;
    - com 10.001 → a primeira rodada faz 10.000 e a segunda o resto;
    - o log não contém nenhum título.
  - Chat: a conversa criada tem `theme` e `themeVersion 1`.
- [ ] **Step 2: Rodar e ver falhar** — `cd backend && npm run build && node --test test/themes.test.cjs test/theme-backfill.test.cjs` → FAIL.
- [ ] **Step 3: Implementar.** Migration com `npx prisma migrate dev --create-only --name conversation_theme`; renomear a pasta, revisar, aplicar e rodar `npm run prisma:generate`.
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS; `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git add backend/prisma backend/src/sgdm backend/src/ai/ai-gateway.service.ts backend/test && git commit -m "feat(ia): tema de cada conversa por lista fixa, sem modelo, e máscara de dados pessoais"`

---

### Task 2 (i7Ai backend): temas e títulos mascarados para a Central

Depende da Task 1. Paralelizável com Task 3.

**Files:**
- Create: `backend/src/sgdm/sgdm-themes.controller.ts` + `sgdm-themes.service.ts`, no `SgdmModule`, com o verificador de chave da Entrega 2:
  - `GET /api/integracoes/sgdm/temas?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&tenantId=<uuid opcional>`.
  - Validação: datas válidas, `fim >= inicio`, até 366 dias, `tenantId` uuid. Fora disso → 400.
  - Consulta: `this.prisma.$queryRaw` com `Prisma.sql` (padrão de `insights.controller.ts`; o `groupBy` do Prisma não tem `count(DISTINCT …)`) sobre `conversations` com `createdAt >= inicio 00:00Z` e `< fim + 1 dia 00:00Z`. Ela devolve `count(*)`, `count(DISTINCT "userId")` e `count(DISTINCT "tenantId")` por `theme`, e um `count` das linhas com `themeVersion < THEME_VERSION`.
- Modify: `backend/src/sgdm/sgdm-names.service.ts` (Entrega 2):
  - os títulos de `conversas` saem com `maskPersonalData`;
  - a resposta ganha `temas: Record<string, { id: ThemeId; rotulo: string }>` para cada conversa encontrada, com o tema já calculado. Uma conversa com `themeVersion` antiga é classificada na hora, sem gravar.
- Test: create `backend/test/sgdm-themes.test.cjs`; `backend/test/sgdm-names.test.cjs` (Entrega 2).

**Interfaces:**
- Consumes: Task 1; o verificador de chave e `SgdmModule` (Entrega 2).
- Produces (contratos HTTP; nomes exatos):
  ```ts
  // GET /api/integracoes/sgdm/temas
  interface TemasI7ai {
    periodo: { inicio: string; fim: string };
    temas: { tema: ThemeId; rotulo: string; conversas: number; usuarios: number; prefeituras: number }[]; // conversas > 0, desc by conversas, then THEMES order
    semTema: number;
  }
  // POST /api/integracoes/sgdm/nomes — Entrega 2 response, extended
  interface NomesI7ai {
    agentes: Record<string, string>;
    conversas: Record<string, string | null>;          // masked titles
    temas: Record<string, { id: ThemeId; rotulo: string }>;
  }
  ```

- [ ] **Step 1: Testes**
  - Temas:
    - sem chave configurada → 404; chave errada → 401;
    - período de 367 dias → 400; `fim < inicio` → 400; `tenantId` inválido → 400;
    - 3 conversas `licitacoes` (2 usuários, 1 prefeitura) e 1 `saude` no período, mais 1 fora dele → `temas` `[{ tema:'licitacoes', rotulo:'Licitações e contratos', conversas:3, usuarios:2, prefeituras:1 }, { tema:'saude', … conversas:1 }]`;
    - com `tenantId` de outra prefeitura → `temas: []`;
    - 1 conversa com `themeVersion 0` → `semTema: 1`;
    - `JSON.stringify(resposta)` sem `title`, `content` ou `messages`.
  - Nomes:
    - conversa com título `'CPF 123.456.789-00'` → `conversas[id] === 'CPF [CPF]'`;
    - `temas[id]` com `{ id, rotulo }`;
    - conversa com `themeVersion 0` → tema calculado, e o banco não muda.
- [ ] **Step 2: Rodar e ver falhar** — `npm run build && node --test test/sgdm-themes.test.cjs test/sgdm-names.test.cjs` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS; `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git add backend/src/sgdm backend/test && git commit -m "feat(ia): temas das conversas e títulos mascarados para a Central de IA"`

---

### Task 3 (i7Ai backend): abertura auditada de conversa pela Central

Paralelizável com Tasks 1, 2 e 5.

**Files:**
- Modify: `backend/src/auth/sgdm-identity.service.ts`
  - `SgdmIdentity` += `centralIa: boolean` (`permissoes.includes('IA_CENTRAL')`).
  - `resolve()` só lança o 403 de hoje quando `!roles.length && !centralIa`.
  - O espelho (`sync`) não muda: um usuário só com `IA_CENTRAL` fica sem papéis do i7Ai.
- Modify: `backend/src/auth/jwt-auth.guard.ts`
  - `AuthenticatedRequest.user` += `centralIa: boolean`, vindo da identidade do SGDM.
  - No modo local sem SGDM, `false`.
- Create: `backend/src/central/central.module.ts`, `central-conversations.controller.ts`, `central-conversations.service.ts`, `dto/open-conversation.dto.ts`. Importar `CentralModule` em `app.module.ts`.
  - `@Controller('central/conversas')`, `@UseGuards(JwtAuthGuard)`, sem `@RequirePermission`. A verificação é `centralIa`, feita primeiro no handler.
  - `@Post(':id/abrir')` com `ParseUUIDPipe` e `OpenConversationDto { @IsString() @Transform(trim) @Length(10, 300, { message: 'Informe o motivo da abertura (10 a 300 caracteres).' }) motivo }`.
  - `@Header('Cache-Control', 'no-store')`.
  - Service `open(viewer: AuthenticatedRequest['user'], id: string, motivo: string, ip?: string): Promise<CentralConversationView>`:
    - em `$transaction`, lê a conversa de qualquer prefeitura (sem filtro de tenant) com `tenant.name`, `agent.name`, `model.slug` e as últimas 1.001 mensagens (`orderBy createdAt desc`), com anexos (`document.name`);
    - grava o `auditLog` da Decisão 6, com `metadata.mensagens` = mensagens devolvidas;
    - devolve em ordem cronológica.
  - Nenhuma escrita além do audit: `updatedAt` da conversa não muda.
- Test: create `backend/test/central-conversations.test.cjs`; `backend/test/sgdm-identity.test.cjs` (flag e entrada só com `IA_CENTRAL`).

**Interfaces:**
- Produces (contrato HTTP, usado pela Task 4):
  ```ts
  // POST /api/central/conversas/:id/abrir  body { motivo: string }
  interface CentralConversationView {
    id: string; titulo: string | null; prefeitura: string; agente: string; modelo: string | null;
    criadaEm: string; truncada: boolean;
    mensagens: { id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; createdAt: string; anexos: string[] }[];
  }
  ```
  - `GET /api/auth/me` passa a incluir `centralIa: boolean`.

- [ ] **Step 1: Testes**
  - Identidade:
    - `/auth/me` do SGDM com `permissoes ['IA_CENTRAL']` → `resolve` não lança, `roles []` e `centralIa true`;
    - `permissoes []` → o 403 de hoje;
    - `['I7AI_USAR']` → `centralIa false`.
  - Abertura:
    - viewer `centralIa false`, com um id existente de outra prefeitura e com um id inexistente → os dois 403 com "Acesso restrito à Central de IA.", e `auditLog.create` não chamado;
    - viewer `centralIa true`, motivo `'curto'` → 400 com a mensagem do DTO;
    - id inexistente → 404 "Conversa não encontrada." e sem audit;
    - sucesso com uma conversa da prefeitura B aberta por um viewer da plataforma A → resposta com as mensagens em ordem cronológica;
    - nesse sucesso, `auditLog.create` com `tenantId B`, `userId` do viewer, `event 'conversation.viewed_by_platform'`, `metadata.motivo` e `metadata.viewerTenantId A`;
    - com o `auditLog.create` falhando → erro, sem conteúdo devolvido;
    - 1.005 mensagens → 1.000, `truncada true`;
    - `conversation.update` nunca chamado;
    - o log não contém o motivo nem o conteúdo.
- [ ] **Step 2: Rodar e ver falhar** — `npm run build && node --test test/central-conversations.test.cjs test/sgdm-identity.test.cjs` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS; `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git add backend/src/auth backend/src/central backend/src/app.module.ts backend/test && git commit -m "feat(ia): abertura de conversa pela Central de IA, só leitura e com auditoria na prefeitura"`

---

### Task 4 (i7Ai frontend): tela de conversa aberta pela Central

Depende da Task 3 (contrato). Paralelizável com Tasks 5 e 6.

**Files:**
- Create: `src/features/CentralConversationPage.jsx`, `CentralConversationPage({ token, conversationId, onClose })`:
  - Antes de abrir, um `Card` com o aviso "Você vai abrir uma conversa de outra prefeitura. A abertura fica registrada na auditoria dela.", o campo "Motivo da abertura" (`textarea`, de 10 a 300 caracteres, com contador) e o botão "Abrir conversa". O botão fica desabilitado fora da faixa.
  - Depois, uma faixa fixa "Visualização pela Central de IA (somente leitura). Esta abertura foi registrada na auditoria da prefeitura.", o cabeçalho (prefeitura, agente, modelo e data) e as mensagens em lista, em texto com `white-space: pre-wrap`, sem markdown e sem campo de envio. Os anexos aparecem só pelo nome.
  - Com `truncada`: "Mostrando as 1.000 mensagens mais recentes.".
  - Erros: 403 → "Seu perfil não tem a permissão Central de IA."; 404 → "Conversa não encontrada."; os demais → a mensagem da API com "Tentar novamente". Todos com o botão "Fechar".
- Modify: `src/app-shell.jsx` (`App()`)
  - Lê uma vez, no estado inicial, `new URLSearchParams(window.location.search).get('conversa')`, só se for uuid.
  - Com o id, e depois da sessão (`/auth/me`) confirmada, renderiza `CentralConversationPage` no lugar do conteúdo, mesmo sem papéis.
  - `onClose` remove o parâmetro (`history.replaceState`) e volta ao estado normal.
  - Sem o id e com `user.roles.length === 0`: `EmptyState` com "Seu acesso ao i7Ai serve só para abrir conversas pela Central de IA.".
- Test: create `test/visual/central-conversation.spec.js`, que intercepta `/api/auth/me` e `/api/central/conversas/*/abrir` com `page.route`, no padrão de `test/visual/chat.spec.js`.

**Interfaces:**
- Consumes: `POST /api/central/conversas/:id/abrir` e `/auth/me.centralIa` (Task 3).

- [ ] **Step 1: Testes** (Playwright)
  - `/?conversa=<uuid>` → aparece o campo de motivo. "Abrir conversa" fica desabilitado com 9 caracteres e habilitado com 10.
  - Ao abrir: o corpo do POST tem `motivo`, aparece a faixa "somente leitura", as mensagens aparecem e não existe `textarea` de envio.
  - O mock responde 404 → "Conversa não encontrada." com o botão "Fechar"; ao clicar, a URL fica sem `conversa`.
  - `/?conversa=nao-uuid` → o app normal.
  - Usuário sem papéis e sem `conversa` → a mensagem de acesso restrito.
- [ ] **Step 2: Rodar e ver falhar** — `npx playwright test test/visual/central-conversation.spec.js` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — o comando do Step 2 e `npx playwright test test/visual/chat.spec.js` → PASS.
- [ ] **Step 5: Commit** — `git add src/features/CentralConversationPage.jsx src/app-shell.jsx test/visual/central-conversation.spec.js && git commit -m "feat(ia): conversa aberta pela Central de IA em modo só leitura"`

---

### Task 5 (SGDM API): temas e tema das conversas na Central

Paralelizável com Tasks 3 e 4 (o contrato da Task 2 está fixado acima).

**Files:**
- Create: `apps/api/src/modules/central-ia/i7ai-temas.client.ts`
  - `I7aiTemasClient.temas(p: Periodo): Promise<TemasI7ai | null>`.
  - Faz `GET ${i7ai.apiUrl}/integracoes/sgdm/temas?…` com `Bearer i7ai.chaveIntegracao`, timeout 8 s.
  - Falha, resposta fora do formato ou falta de configuração → `null` e `logger.warn` só com o status. Mesmo padrão do `I7aiNomesClient`.
- Create: `apps/api/src/modules/central-ia/temas.controller.ts`
  - `@Controller('central-ia')`, `@RequirePermissions('IA_CENTRAL')`.
  - `@Get('temas')` com `PeriodoDto` → `TemasCentral = TemasI7ai & { indisponivel: boolean }`. Com `null` → `{ periodo, temas: [], semTema: 0, indisponivel: true }`.
- Modify: `apps/api/src/modules/central-ia/i7ai-nomes.client.ts`: o tipo de retorno ganha `temas: Record<string, { id: string; rotulo: string }>`; resposta sem `temas` → `{}`.
- Modify: `apps/api/src/modules/central-ia/central-ia.regras.ts`
  - `LinhaConsumo` += `tema?: { id: string; rotulo: string } | null`, só nas linhas `conversa`.
  - `csvDe` acrescenta a coluna "Tema" quando as linhas têm `tema`.
- Modify: `apps/api/src/modules/central-ia/dto/periodo.dto.ts`: `ConsumoQueryDto` += `@IsOptional() @Matches(/^[a-z-]{2,30}$/) tema?: string`.
- Modify: `apps/api/src/modules/central-ia/central-ia.service.ts` e `central-ia.controller.ts`
  - `consumo(p, agrupar, tema?)`: `tema` com `agrupar !== 'conversa'` → `BadRequestException('O filtro de tema vale só para o agrupamento por conversa.')`.
  - Linhas `conversa`: `tema = nomes.temas[id] ?? null`. Com `tema`, ficam só as linhas desse tema, aplicado depois do corte de 200.
  - `consumo.csv` aceita o mesmo filtro.
- Modify: `apps/api/src/modules/central-ia/central-ia.module.ts`.
- Test: create `__tests__/i7ai-temas.client.spec.ts` e `__tests__/temas.controller.spec.ts`; `__tests__/central-ia.service.spec.ts`, `__tests__/central-ia.regras.spec.ts`, `__tests__/periodo.dto.spec.ts`.

**Interfaces:**
- Consumes: `TemasI7ai`/`NomesI7ai` (Task 2), `I7aiNomesClient` e `MAX_LINHAS_CONVERSA` (Entrega 2), `MSG_TAGS_LIMITADAS` (Entrega 5).
- Produces: `GET central-ia/temas` → `TemasCentral`; `GET central-ia/consumo?agrupar=conversa&tema=` com `LinhaConsumo.tema`. Usados pela Task 6.

- [ ] **Step 1: Testes**
  - Client:
    - sem `apiUrl` → `null`, sem `fetch`;
    - 500 → `null`, e o `logger.warn` não contém a chave;
    - corpo válido → igual ao recebido.
  - Controller:
    - sem `IA_CENTRAL` → 403 (metadados);
    - client `null` → 200 com `indisponivel: true`.
  - Service:
    - `consumo(p, 'usuario', 'saude')` → 400 com a mensagem acima;
    - `consumo(p, 'conversa')` com `/nomes` devolvendo `temas: { c1: { id:'saude', rotulo:'Saúde' } }` → a linha `c1` com esse `tema` e as demais com `null`;
    - `consumo(p, 'conversa', 'saude')` → só `c1`;
    - `/nomes` falhando → todas com `tema: null` e status 200.
  - Regras: o CSV de conversas tem o cabeçalho "Tema" e o rótulo; o CSV de prefeituras não tem.
  - DTO: `tema: 'Saúde!'` → erro de validação.
- [ ] **Step 2: Rodar e ver falhar** — `cd apps/api && npx jest --runInBand src/modules/central-ia/__tests__/i7ai-temas.client.spec.ts src/modules/central-ia/__tests__/temas.controller.spec.ts src/modules/central-ia/__tests__/central-ia.service.spec.ts src/modules/central-ia/__tests__/central-ia.regras.spec.ts src/modules/central-ia/__tests__/periodo.dto.spec.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** — mesmo comando → PASS; `npx jest --runInBand src/modules/central-ia` → PASS.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/central-ia && git commit -m "feat(ia): temas das conversas e filtro por tema na Central de IA"`

---

### Task 6 (SGDM web): "O que os usuários pedem" na Visão geral e conversas no Consumo

Depende da Task 5.

**Files:**
- Modify: `apps/web/lib/central-ia.ts`
  - `linkConversaI7ai(id: string): string | null` → `/i7ai/?conversa=<id>` para uuid; senão `null`.
  - `participacao(conversas: number, total: number): string` → `'42%'`, sem casas; com `total` 0, `'—'`.
  - `urlConsumoTema(tema: string): string` → `/central-ia/consumo?agrupar=conversa&tema=<tema>`, mantendo `periodo` quando informado.
- Modify: `apps/web/lib/central-ia-api.ts`
  - Tipos `TemasCentral` e `LinhaConsumo.tema`.
  - `buscarTemas(token, p): Promise<TemasCentral>`.
  - `buscarConsumo(token, p, agrupar, tema?)`.
  - `urlCsv` com `tema`.
- Create: `apps/web/components/central-ia/OQueUsuariosPedem.tsx`: `.card` "O que os usuários pedem" com duas colunas:
  - **Temas mais frequentes**:
    - `recharts` `BarChart` horizontal, no padrão de `GraficoDiario`, com conversas por tema e o rótulo e a participação na barra;
    - abaixo, uma lista com usuários e prefeituras de cada tema;
    - cada tema é um link para `urlConsumoTema`;
    - `semTema > 0` → "N conversas ainda sem tema (cálculo em andamento).";
    - `indisponivel` → "Temas indisponíveis: o i7Ai não respondeu.".
  - **Conversas de alto custo**: as 5 primeiras de `buscarConsumo(…, 'conversa')`, com tema, título (`nome`), custo e "ver no i7Ai" (ícone `ExternalLink`, nova aba, `aria-label="Ver a conversa no i7Ai (abre em nova aba; a abertura fica registrada)"`), mais o link "Ver todas" para `agrupar=conversa`. Um 400 com `MSG_TAGS_LIMITADAS` → a frase no lugar da lista.
  - Estados: `Skeleton` e `EmptyState` "Nenhuma conversa no período.".
- Modify: `apps/web/app/(dashboard)/central-ia/page.tsx`: o cartão vai depois do Fluxo ao vivo (Entrega 5), com as duas `useQuery` no período e na prefeitura atuais.
- Modify: `apps/web/components/central-ia/TabelaConsumo.tsx`: com `agrupar === 'conversa'`, entram as colunas "Tema" (rótulo ou "—") e "i7Ai" (o link, só com `linkConversaI7ai` não nulo), e a nota "Entre as 200 conversas de maior custo do período.".
- Modify: `apps/web/app/(dashboard)/central-ia/consumo/page.tsx`
  - Com `agrupar === 'conversa'`, um `select` "Tema" com "Todos" e os temas do período vindos de `buscarTemas` (os que têm conversas), ligado a `filtros.tema`. A web não repete a lista de temas.
  - Um `tema` da URL fora dessa lista continua no select com o próprio id, para o filtro não sumir.
  - Ao mudar o agrupamento, `tema: ''`.
  - A consulta e o CSV passam `tema`.
- Test: `apps/web/lib/__tests__/central-ia.test.ts`; create `apps/web/lib/__tests__/o-que-usuarios-pedem-markup.test.ts` (`renderToStaticMarkup`).

**Interfaces:**
- Consumes: `GET central-ia/temas` e `consumo?agrupar=conversa&tema=` (Task 5); o cartão do fluxo (Entrega 5) só como posição.

- [ ] **Step 1: Testes**
  - `linkConversaI7ai('0dd57084-e9c3-4c5c-8ccf-62fd7f89969a') === '/i7ai/?conversa=0dd57084-e9c3-4c5c-8ccf-62fd7f89969a'`; `linkConversaI7ai('abc') === null`.
  - `participacao(21, 50) === '42%'`; `participacao(0, 0) === '—'`.
  - `urlConsumoTema('saude')` contém `agrupar=conversa&tema=saude`.
  - Markup:
    - com `indisponivel` → "Temas indisponíveis";
    - com uma conversa → um `<a href="/i7ai/?conversa=…" target="_blank" rel="noopener noreferrer">`;
    - `semTema 3` → "3 conversas ainda sem tema".
- [ ] **Step 2: Rodar e ver falhar** — `cd apps/web && npx vitest run lib/__tests__/central-ia.test.ts lib/__tests__/o-que-usuarios-pedem-markup.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar**
  - vitest PASS; `npx tsc --noEmit -p .` sem erros novos.
  - Abrir `http://localhost:3000/central-ia` como `owner@sgdm.app` pelo proxy local: o cartão mostra temas e conversas reais.
  - Clicar num tema: o Consumo abre agrupado por conversa e filtrado. "ver no i7Ai" abre a nova aba.
  - Largura de 390 px sem rolagem horizontal.
- [ ] **Step 5: Commit** — `git add apps/web/lib/central-ia.ts apps/web/lib/central-ia-api.ts apps/web/components/central-ia/OQueUsuariosPedem.tsx apps/web/components/central-ia/TabelaConsumo.tsx "apps/web/app/(dashboard)/central-ia/page.tsx" "apps/web/app/(dashboard)/central-ia/consumo/page.tsx" apps/web/lib/__tests__/central-ia.test.ts apps/web/lib/__tests__/o-que-usuarios-pedem-markup.test.ts && git commit -m "feat(ia): o que os usuários pedem na Central de IA e conversas com link para o i7Ai"`

---

### Task 7: documentação e fumaça local

**Files:**
- Modify (i7Ai): `docs/LITELLM.md`, seção "Central de IA no SGDM", subseção "O que os usuários pedem":
  - temas por lista fixa (tabela, versão e recálculo);
  - a máscara de títulos e o limite dela (nomes de pessoas);
  - a rota de abertura, quem pode, o motivo e o registro;
  - nenhum texto sai do i7Ai pelos endpoints internos.
- Modify (i7Ai): `docs/` da integração com o SGDM, se existir um arquivo de endpoints internos (procure por `integracoes/sgdm/nomes`): acrescentar `GET /integracoes/sgdm/temas` e `POST /central/conversas/:id/abrir`.
- Modify (SGDM): `apps/web/public/ajuda/manual.html`, subseção `#central-ia-pedidos` em `#central-ia`:
  - temas e o que "sem tema" quer dizer;
  - conversas de alto custo e o filtro por tema;
  - "ver no i7Ai": o motivo obrigatório e o registro na auditoria da prefeitura, que o administrador dela vê;
  - a frase de LGPD: "A Central mostra temas e números; o texto das conversas só no i7Ai, com registro."

- [ ] **Step 1: Fumaça local** (proxy `scripts/local-sgdm-proxy.cjs`; marcar cada item e colar o resultado na descrição do commit de documentação)
  1. No chat do i7Ai da prefeitura de teste, três conversas: "Minuta de edital de pregão para merenda", "Férias do servidor João, CPF 123.456.789-00" e "oi". Depois de um minuto, a Visão geral mostra `licitacoes`, `pessoal` e `outros` (ou o tema do nome do agente).
  2. Consumo › Conversa: o título da segunda aparece com `[CPF]`. No banco do i7Ai, o título continua original.
  3. Filtro "Pessoal e RH": só a segunda conversa.
  4. O dono (`owner@sgdm.app`) entra no i7Ai uma vez antes, para o usuário existir no espelho. Depois, "ver no i7Ai" → motivo com 9 caracteres bloqueado; com 10 ou mais, a conversa abre em só leitura.
  5. Como administrador da prefeitura de teste, em i7Ai › Relatórios › Auditoria: o evento `conversation.viewed_by_platform` com o nome do dono.
  6. Como administrador da prefeitura (sem `IA_CENTRAL`): `POST /i7ai/api/central/conversas/<id>/abrir` → 403, e nenhum registro novo em `audit_logs`.
  7. Parar o backend do i7Ai: a Visão geral mostra "Temas indisponíveis" e o resto da Central funciona.
  8. `grep` no log do i7Ai pelo motivo e pelo CPF da fumaça → nada. O mesmo nas respostas de `/central-ia/temas` e `/central-ia/consumo` → nenhum `content` e nenhum CPF.
  9. Registrar no ledger o tempo do recálculo de temas no banco local (conversas e duração).
- [ ] **Step 2: Commit em cada repositório** — `git commit -m "docs(ia): Central de IA — o que os usuários pedem e abertura auditada de conversas"` (i7Ai: `git add docs/LITELLM.md` e o arquivo de endpoints, se houver; SGDM: `git add apps/web/public/ajuda/manual.html`).

---

## Self-review

- **Cobertura da spec:**
  - §8 item 6, temas mais frequentes: Tasks 1, 2, 5 e 6.
  - Conversas de alto custo: Tasks 5 e 6, sobre a Entrega 2.
  - §5.2, linha da conversa com tema, modelo, custo e "ver no i7Ai": Task 6 (tema e link) e Task 3 (abertura com auditoria). O modelo da conversa aparece na abertura; a coluna de modelo no Consumo continua como na Entrega 2.
  - §3 anti-objetivos:
    - outra prefeitura só com `IA_CENTRAL`: Task 3, 403 antes da busca;
    - texto só com necessidade e registro: Task 3, motivo e auditoria antes do conteúdo.
  - §7 LGPD: Decisões 1–3 e Tasks 1 e 2 (máscara, nenhum texto nos endpoints internos).
  - §4, nenhuma aba nova: Global Constraints.
- **Tipos:**
  - `ThemeId`, `TemasI7ai`, `NomesI7ai.temas` e `CentralConversationView` são definidos uma vez (Tasks 1–3) e usados com os mesmos nomes nas Tasks 4–6.
  - `LinhaConsumo.tema` é igual na API e na web.
  - `centralIa` é o nome no backend e no `/auth/me`.
- **Review Focus:** os cinco itens têm teste nas Tasks 1, 2, 3, 4 e 5.
