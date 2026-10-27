# Central de IA no SGDM — documento de design

Data: 2026-10-26. Estado: aprovado; entrega 0 em produção desde 2026-10-26 (pilha `i7ai-plataforma`, i7Ai em `sgdm.com.br/i7ai/`); decisões 9–12 acrescentadas em 2026-10-26.

Repositórios envolvidos: `i7ai-IA` (este) e `prefeitura/SGDM` (API NestJS + web Next.js). O gateway de IA é o LiteLLM Proxy, já em uso pelo i7Ai (ver `docs/LITELLM.md`).

## 1. Intenção

O dono da plataforma precisa ver e governar todo o uso de IA das prefeituras a partir de uma única tela dentro do SGDM, sem abrir código, túnel SSH ou o painel técnico do LiteLLM. O LiteLLM é o motor; a Central de IA é o volante.

**Medida de sucesso: o custo médio por conversa cai drasticamente**, de forma visível na própria tela (antes e depois de cada otimização), sem piorar a qualidade das respostas e sem expor dados de uma prefeitura a outra.

## 2. Decisões já tomadas (pelo dono da plataforma)

1. A Central de IA fica **dentro do SGDM**, no menu do dono da plataforma. O i7Ai continua sendo o lugar de trabalho (chat, agentes, bases, documentos, automações).
2. **Só quem tem a permissão `IA_CENTRAL`** vê e usa a Central. O administrador da prefeitura não vê consumo, custo nem liberação de modelos.
3. **Chaves:** uma chave da plataforma por provedor (OpenAI, Anthropic, Gemini), cadastrada na Central; a chave própria da prefeitura (`Cadastros › IA` do SGDM, uma por prefeitura) continua opcional e tem prioridade para o provedor dela. O formato atual dessa tabela não muda.
4. **Sem fallback automático entre modelos** e **sem cache semântico** (risco de resposta errada e de dado ir a outro provedor).
5. Saem do i7Ai: Usuários, Departamentos, Licenciamento, Configurações da prefeitura e o cadastro de Modelos (vira consulta). O que o dono libera no SGDM aparece no i7Ai.
6. A IA do próprio SGDM (geração de peças) passa a chamar o LiteLLM, para entrar na mesma visão de custo. **Prefeitura sem chave própria passa a gerar peças com a chave da plataforma**, e esse gasto entra no orçamento dela na Central (hoje o SGDM recusa; isso muda).
7. **Orçamento conta todo o gasto da prefeitura**, com chave própria ou da plataforma (decisão do autor, uma regra só). A Central mostra os dois separados ("na chave da plataforma" e "na chave própria"); para uma prefeitura que paga com a própria chave, o dono define um orçamento maior ou sem limite.
9. **Departamentos do i7Ai = setores do SGDM** (decisão de 2026-10-26). O i7Ai não cadastra departamentos: lê os setores da prefeitura pelo endpoint interno, guarda cada um em `departments` com o id do setor do SGDM (coluna de id externo) e põe o usuário no setor dele no SGDM a cada login. `Department` e `departmentId` continuam existindo (agentes restritos por setor dependem deles).
10. **Configurações da prefeitura vêm do cadastro da prefeitura no SGDM** (decisão de 2026-10-26): nome, fuso e demais campos de `settings` do i7Ai são lidos do SGDM; campo sem equivalente no SGDM recebe um padrão fixo documentado. A tela sai do i7Ai.
11. **Acesso ao i7Ai só por liberação do dono** (decisão de 2026-10-26). As permissões `I7AI_*` não fazem parte do pacote do ADMINISTRADOR (em produção foram retiradas do ADMINISTRADOR em 2026-10-26; o arquivo para desfazer está em `/root/backups/` do cloud232). A migration da entrega 2 torna isso permanente e o seed deixa de concedê-las a perfis de prefeitura.
12. **Um deploy só, com tudo pronto** (decisão de 2026-10-26). As entregas 1 a 6 são feitas e mostradas funcionando no ambiente local, uma a uma, e sobem juntas para produção num único deploy, ensaiado antes na VPS de desenvolvimento (194.163.174.20) com cópia do banco, backup e ensaio das migrations, como na entrega 0. Até lá, a pilha `i7ai-plataforma` em produção fica como está e o i7Ai sem licença.
13. **Tudo roda na mesma VPS do SGDM.** O LiteLLM e o i7Ai são implantados como pilhas ao lado do SGDM; o LiteLLM entra na rede `SGDMNET` sem porta pública, e a API do SGDM e o i7Ai falam com ele pelo nome interno (`http://litellm:4000`, aceito via `OMNIROUTER_INTERNAL_HOSTS`/`SGDM_INTERNAL_HOSTS`). A chave administrativa do LiteLLM fica só no ambiente da API do SGDM e do backend do i7Ai.

## 3. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- Ver gasto por prefeitura, usuário, agente, modelo, origem e conversa; por dia; exportar.
- Saber quem consome acima do padrão e agir ali mesmo.
- Liberar provedores e modelos por prefeitura e por usuário, a partir do catálogo do LiteLLM com preços.
- Orçamento mensal e limites por prefeitura e usuário, com aviso e bloqueio.
- Ligar as otimizações seguras e ver a economia real de cada uma.
- Um "fluxo ao vivo" que mostre, de forma visual, o que está acontecendo.

**Não objetivos (desta entrega)**
- Faturamento/cobrança das prefeituras (a Central dá os números; cobrar é outro processo).
- Trocar o motor de IA do SGDM (só muda o endereço para o LiteLLM).
- Migrar o SGDM para o pacote `@sgdm/design` (a Central usa os estilos atuais do SGDM).

**Anti-objetivos (seria falha mesmo funcionando)**
- Uma prefeitura ver dados de outra.
- Texto de conversas de servidores exposto sem necessidade e sem registro.
- Custo registrado com o preço de outro modelo.
- Uma chave de provedor gravada no banco do i7Ai, em log ou em auditoria.
- Cair o custo e piorar as respostas (resumo com perda de informação jurídica).

## 4. Onde fica e quem acessa

Menu do SGDM, seção **Inteligência Artificial**:
- `i7Ai ↗` (já existe; qualquer permissão `I7AI_*`).
- **Central de IA** (permissão `IA_CENTRAL`): Visão geral · Consumo e custo · Modelos e acesso · Limites e alertas · Otimização · Licenças i7Ai.

Permissão `IA_CENTRAL`:
- Nova, módulo `ia`, criada por migration idempotente (padrão de `docs/modulos/padrao-modulo.md`) e no seed.
- Reservada à plataforma: entra em `PERMISSOES_SO_PLATAFORMA` (API e web), como `IA_CONFIGURAR`. Nunca entra no pacote do ADMINISTRADOR.
- DONO_PLATAFORMA recebe na migration. Outras pessoas: perfil no tenant da plataforma com essa permissão (ex.: "GESTOR_IA").
- A API recusa sem a permissão; o menu esconde o item (`navigation.ts` com `permissions: ['IA_CENTRAL']`).
- Rótulo, guia e entrada no manual (`public/ajuda/manual.html`), como as demais permissões.

Visual: componentes e classes atuais do SGDM (`PageHeader`, `.card`, `.stat-card`, `DataTable`, `Tabs`, `EmptyState`, `Skeleton`, `Toast`), `recharts` com os padrões do painel, ícones `lucide-react`. Nenhuma biblioteca nova.

## 5. As telas

### 5.1 Visão geral
- Período: hoje / 7 dias / 30 dias / mês.
- Cartões: gasto no período (US$ e R$ pela cotação configurada), **custo médio por conversa** (com variação vs. período anterior), chamadas e erros, economia com cache, prefeituras e usuários ativos, alertas abertos.
- **Fluxo ao vivo:** diagrama Prefeituras → Origem (i7Ai chat, i7Ai automações, SGDM peças) → LiteLLM (cache %, erro %, latência) → Provedores (gasto por provedor). Atualiza a cada 10 s; partículas animadas proporcionais ao volume. Clicar numa caixa filtra a tela de Consumo.
- Lista de alertas abertos e lista de sugestões de economia (ver 5.5), cada uma com ação.

### 5.2 Consumo e custo
- Agrupar por: prefeitura (padrão), usuário, agente, modelo, origem, provedor. Cada linha abre o nível seguinte até a conversa.
- Colunas: chamadas, tokens de entrada, tokens de saída, tokens lidos do cache, custo, custo por conversa.
- Gráfico de gasto por dia; dias com alerta destacados.
- Linha da conversa: tema (título da conversa, não o texto), modelo, custo, link "ver no i7Ai" (abre a conversa no i7Ai; a abertura por quem tem `IA_CENTRAL` fica na auditoria do i7Ai).
- Exportar CSV do agrupamento atual.
- **Fonte dos números:** o LiteLLM, que calcula custo por chamada com a tabela de preços dele e registra tokens em cache. Cada chamada chega ao LiteLLM com `user` = prefeitura e metadados (usuário, agente, conversa, origem). Os relatórios do i7Ai continuam para o uso interno da prefeitura.

### 5.3 Modelos e acesso
- **Catálogo:** modelos que o LiteLLM conhece (tabela de preços dele: preço de entrada, saída, cache, contexto, visão, ferramentas), filtrado por provedor e busca. O dono marca os que entram na plataforma ("ativo") e um "padrão". Modelos ativos viram entradas do LiteLLM (`/model/new`) com `litellm_credential_name` do provedor; o catálogo do i7Ai (`ai_models`) é sincronizado a partir daí (slug, capacidades, preços), deixando de ser cadastro manual.
- **Liberações:** por prefeitura: provedores e modelos permitidos e o padrão; dentro da prefeitura, exceções por usuário. Guardado no SGDM.
- O i7Ai pergunta ao SGDM (endpoint interno, mesmo mecanismo do `/auth/me`) o que o usuário pode usar: o seletor do chat mostra só isso e o servidor recusa o resto, mesmo forçado.
- Mostra também qual chave atende cada prefeitura/provedor (própria ou da plataforma) e o resultado do último teste.

### 5.4 Limites e alertas
- Por prefeitura: orçamento mensal (US$), ação ao atingir (avisar a X% e bloquear a 100%), chamadas por minuto, tokens por minuto.
- Por usuário: opcional, mesmos campos; e regra "acima de N× a média da prefeitura" gera alerta.
- Aplicação (decisão do autor): no LiteLLM, o campo `user` da chamada é o *customer/end user*, e só existe um por chamada. Ele é usado para a **prefeitura**: orçamento mensal, chamadas e tokens por minuto por prefeitura ficam no LiteLLM (`/customer`, `/budget`). O **usuário** vai como tag (`metadata.tags = ["usuario:<id>", "agente:<id>", "origem:<x>"]`): o LiteLLM agrupa gasto por tag (`/tag/daily/activity`) e aceita orçamento por tag; limites por minuto por usuário são aplicados pelo i7Ai, que já tem reserva de cota por usuário. O i7Ai traduz a recusa em mensagem clara no chat ("A prefeitura atingiu o limite de IA deste mês").
- Alertas aparecem na Visão geral e vão por e-mail (SMTP do SGDM) para quem tem `IA_CENTRAL`.
- As licenças do i7Ai (usuários, agentes, automações, bases, armazenamento, tokens) passam a ser editadas aqui ("Licenças i7Ai") e sincronizadas com a tabela `licenses` do i7Ai pelo endpoint interno; a tela Licenciamento do i7Ai some.

### 5.5 Otimização
Cada item mostra: ligado/desligado, onde se aplica (todos / por prefeitura / por agente), **economia real nos últimos 30 dias** medida pelo LiteLLM ou pelo i7Ai, e estimativa quando desligado.

1. **Modelo padrão barato** e aviso quando um agente usa modelo caro para tarefas curtas.
2. **Cache de prompt do provedor:** i7Ai separa a parte fixa das instruções (prompt do agente + regras) da parte variável (trechos dos documentos) e manda a marcação `cache_control` para a Claude; OpenAI é automático. O custo registrado passa a usar o preço de token em cache.
3. **Histórico resumido:** conversas acima de N mensagens têm as mais antigas resumidas por um modelo barato; o resumo entra no lugar delas. Parâmetro N por prefeitura. Resumo guardado por conversa e revisável.
4. **Respostas repetidas (cache exato) no LiteLLM** com Redis: ligado por padrão só para automações; validade configurável.
5. **Limite de tokens de saída** por agente, visível com o custo estimado.
6. **Imagens em resolução baixa** por padrão, com opção "alta" por agente.
7. **Sugestões automáticas** a partir do consumo real (ex.: "62% das chamadas da Maria são resumos curtos no GPT-5.5"), com botão Aplicar que executa a mudança (trocar padrão, ativar cache, definir limite) e registra na auditoria.

Fora do escopo por decisão: cache semântico, fallback automático entre modelos, compressão de prompt.

## 6. Como funciona por baixo (contratos)

- **Marcação de cada chamada:** o i7Ai (e o SGDM) enviam ao LiteLLM `user` = id da prefeitura e `metadata.tags` = `["usuario:<id>", "agente:<id>", "conversa:<id>", "origem:<i7ai-chat|i7ai-automacao|sgdm-pecas>"]`. É isso que permite agrupar e orçar. Definido já na entrega 1 para não perder histórico.
- **Custo oficial (decisão do autor):** o número do LiteLLM. Em respostas sem streaming o i7Ai grava o custo devolvido no cabeçalho `x-litellm-response-cost`; em streaming (sem cabeçalho) calcula com a mesma tabela de preços do LiteLLM, sincronizada para `ai_models` (entrada, saída e entrada em cache, via `/model/info`), e com a mesma fórmula, incluindo tokens em cache. `ai_usage` registra `costSource` (`gateway`/`catalog`) e `cachedInputTokens`. Assim prefeitura (relatório do i7Ai) e dono (Central) veem o mesmo valor; os preços em Modelos deixam de ser cadastro manual.
- **Leitura de consumo:** a API do SGDM consulta o LiteLLM (`/customer/daily/activity/aggregated`, `/spend/logs`, `/user/daily/activity/aggregated`) com a chave administrativa do LiteLLM, que fica só no ambiente do SGDM. A web do SGDM nunca fala com o LiteLLM direto.
- **Catálogo e preços:** `litellm.model_cost` exposto pelo LiteLLM (`/model_group/info`, `/model/info`) ou tabela de preços embutida; ativação por `/model/new`, `/model/update`, `/model/delete`.
- **Chaves da plataforma:** `/credentials` do LiteLLM (já implementado no i7Ai; move para a Central). A chave própria da prefeitura continua no SGDM e vai na chamada (`api_key`), como hoje.
- **Liberações, limites e licenças:** guardados no banco do SGDM (tabelas novas `ia_liberacoes`, `ia_limites`, `i7ai_licencas` ou equivalente). Limites também aplicados no LiteLLM (`/customer`, `/budget`, `/end_user`). O i7Ai lê liberações e licenças pelo endpoint interno já existente (`/integracoes/i7ai/...`), com cache curto, como faz com a chave de IA.
- **Auditoria:** toda escrita na Central registra em `auditoria` do SGDM, sem chaves.
- **Isolamento:** toda consulta filtra por prefeitura; a Central só existe no tenant da plataforma; `?tenantId=` segue a regra atual do SGDM.
- **Prefeitura selecionada (decisão do autor):** a Central aparece para quem tem `IA_CENTRAL` **mesmo sem prefeitura selecionada** no SGDM (terceira exceção em `getSecoesVisiveis`), porque a Visão geral e o Consumo mostram todas as prefeituras. As rotas da Central aceitam `tenantId` opcional como filtro e exigem `IA_CENTRAL`; sem ele, 403 como hoje. Com uma prefeitura selecionada no SGDM, a Central abre já filtrada nela.
- **Redis do cache exato (decisão do autor):** o Redis próprio do i7Ai/LiteLLM, com senha, nunca o Redis compartilhado do SGDM (que guarda tokens de sessão e redefinição de senha). Respostas de IA não entram no Redis do SGDM.

## 7. Restrições

- Máquina de desenvolvimento com 16 GB: testes com poucos workers (`--runInBand`), um serviço por vez.
- O LiteLLM está em 1.106.4; `/credentials` é BETA. Fixar versão por digest e revalidar nas atualizações.
- A API do SGDM tem erros de compilação no módulo da saúde em andamento (campo `profissionalId` sem `prisma generate`). Não tocar; não bloqueia.
- Nada de chave de provedor em banco do i7Ai, log, auditoria ou resposta de API.
- LGPD: a Central mostra temas e números; o texto das conversas só no i7Ai, com registro.

## 8. Entregas, em ordem

0. **Implantação na VPS (antes de tudo, sem quebrar o SGDM).** Plano: `docs/superpowers/plans/2026-10-26-entrega-0-vps.md`. O SGDM roda em Docker Swarm via Portainer, com Traefik (certificados automáticos), site em `sgdm.com.br`, API em `api.sgdm.com.br`, e Postgres/Redis/MinIO compartilhados na rede externa `SGDMNET` (sem portas públicas; a VPS anterior foi comprometida, o roteiro `portainer/DEPLOY-VPS-NOVA.md` é rígido). Forma da entrega:
   - Pilha Swarm própria `i7ai` (`portainer/i7ai.stack.yml` neste repositório) com `postgres` (pgvector, bancos `i7ai` e `litellm`), `redis`, `minio`, `backend`, `litellm` e `frontend`. Infra própria porque o i7Ai exige a extensão `vector` e para não tocar nas pilhas de infraestrutura do SGDM. `backend`, `litellm` e `frontend` entram também na `SGDMNET`, sem porta publicada.
   - Traefik: `Host(sgdm.com.br) && PathPrefix(/i7ai)` → `frontend` (nginx), com prioridade acima do roteador `sgdm_web`. O nginx do i7Ai passa a servir sob `/i7ai` e repassa `/i7ai/api` ao backend (hoje serve na raiz; ajustar `nginx.conf`).
   - SGDM API → LiteLLM por `http://litellm:4000` (variáveis `LITELLM_URL`, `LITELLM_ADMIN_KEY` na pilha `sgdm-app`); i7Ai → SGDM por `http://sgdm-api:3001/api/v1` (`SGDM_API_URL`, `SGDM_INTERNAL_HOSTS=sgdm-api`, `SGDM_INTEGRATION_KEY`); `OMNIROUTER_BASE_URL=http://litellm:4000/v1`, `OMNIROUTER_INTERNAL_HOSTS=litellm`.
   - Publicação como no SGDM: workflows `docker-publish` e `deploy-vps` no repositório do i7Ai gerando `ghcr.io/jeferson-assis/i7ai-backend` e `i7ai-frontend` (repositório público `JEFERSON-ASSIS/i7ai-prefeituras`; a VPS baixa sem token, como faz com o SGDM); migrations do i7Ai executadas no entrypoint do backend (`RUN_MIGRATIONS`, como a API do SGDM); serviços de uma execução só (`bucket-init`) com `restart_policy: none`.
   - Mudanças no SGDM em produção, todas reversíveis: três variáveis na pilha `sgdm-app`, migrations `I7AI_*`/`IA_CENTRAL` (rodam sozinhas no deploy) e a nova imagem.
   - Checklist com rollback (remover a pilha `i7ai` e as variáveis devolve o SGDM ao estado anterior); teste de fumaça do SGDM antes e depois (`portainer/DEPLOY-VPS-NOVA.md` §4); `ss -tulpn` sem portas novas em `0.0.0.0`.
   - VPS: 11 GB de RAM, 6,2 GB disponíveis em 2026-10-26. A pilha soma ~1,5 GB (LiteLLM ~800 MB); cada serviço recebe `deploy.resources.limits.memory` (LiteLLM 1,2 GB, backend 768 MB, postgres 512 MB, demais 256 MB) para um pico nunca afetar o SGDM.
   - Nada da VPS é removido: `omniroute` fica como reserva do dono (não é usado pelo i7Ai), `phpmyadmin` e `i7ai-cloud` atendem outros projetos. A memória disponível (6,2 GB) basta sem remoções.
1. **Marcação e consumo:** `user` + `metadata.tags` em toda chamada (i7Ai e SGDM via LiteLLM); permissão `IA_CENTRAL`; telas Visão geral (sem fluxo ao vivo ainda) e Consumo e custo agrupando por prefeitura, usuário, modelo, origem e provedor. O agrupamento por agente e a linha por conversa com link para o i7Ai ficam para a entrega 2 (dependem do catálogo sincronizado e das liberações). Plano: `docs/superpowers/plans/2026-10-26-entrega-1-consumo-e-custo.md`.
2. **Modelos, acesso e organização:** catálogo, ativação, liberações por prefeitura/usuário; i7Ai obedece; cadastro de Modelos do i7Ai vira consulta; chaves da plataforma movidas para a Central; setores do SGDM como departamentos (decisão 9); configurações da prefeitura vindas do SGDM (decisão 10); telas Usuários, Departamentos e Configurações saem do i7Ai; `I7AI_*` fora do pacote do ADMINISTRADOR (decisão 11).
3. **Limites, alertas e licenças:** orçamento, limites, e-mail; Licenças i7Ai no SGDM; a tela Licenciamento sai do i7Ai.
4. **Otimização:** cache de prompt com preço de cache, histórico resumido, cache exato, limites de saída, imagens em baixa, sugestões com Aplicar.
5. **Fluxo ao vivo.**
6. **O que os usuários pedem:** temas mais frequentes e conversas de alto custo.

Cada entrega tem testes (backend dos dois sistemas e web do SGDM), smoke contra o ambiente local (proxy `scripts/local-sgdm-proxy.cjs`) e atualização de `docs/LITELLM.md` e do manual do SGDM.

## 9. O que fica para quem constrói

- Nome e estrutura exatos das tabelas novas no SGDM; se liberação por usuário é lista de permitidos ou de exceções (a tela mostra "exceções").
- Como o SGDM exibe a cotação US$→R$ (campo em configurações da plataforma; atualização manual é aceitável).
- Frequência de atualização do fluxo ao vivo e biblioteca de animação (SVG puro é aceitável; sem dependência nova).
- Como o i7Ai converte a resposta de "orçamento excedido" do LiteLLM na mensagem de chat.
- Tamanho N padrão do histórico resumido e modelo barato usado no resumo (sugestão: 20 mensagens, GPT-4o Mini).
