# LiteLLM como gateway de IA

O LiteLLM Proxy substitui o OmniRoute. Ele recebe as chamadas do backend no contrato OpenAI `/v1/chat/completions` e as repassa para OpenAI, Anthropic (Claude) e, se configurado, Gemini, usando chaves de API comerciais da própria operação.

O backend continua usando as variáveis `OMNIROUTER_*`; só o endereço muda.

```
Navegador → frontend → backend ──(rede Docker interna, HTTP)──→ litellm ──HTTPS──→ OpenAI / Anthropic
                                                                        │
                                                         banco "litellm" (chaves criptografadas)
```

**Produção:** o LiteLLM é o serviço `litellm` da stack Swarm `i7ai-plataforma` ([portainer/i7ai.stack.yml](../portainer/i7ai.stack.yml)), na mesma VPS do SGDM. A stack exige `LITELLM_MASTER_KEY` e `LITELLM_SALT_KEY`; o banco `litellm` fica no Postgres próprio do i7Ai. Roteiro completo em [docs/DEPLOY_VPS.md](./DEPLOY_VPS.md).

## Chaves dos provedores (Central de IA no SGDM)

As chaves da plataforma (OpenAI, Anthropic e Gemini) são cadastradas no SGDM, em **Central de IA › Modelos e acesso › Chaves da plataforma** (permissão `IA_CENTRAL`). A tela de chaves do i7Ai (**Modelos › Chaves dos provedores de IA**) foi removida.

- A chave é enviada uma vez ao LiteLLM, que a guarda criptografada no banco `litellm` com `LITELLM_SALT_KEY`. O i7Ai não grava a chave no próprio banco, em logs ou na auditoria. A auditoria registra só quem salvou ou removeu e o provedor.
- Depois de salva, a tela mostra só o início e o fim mascarados (`sk****88`), exatamente como o LiteLLM devolve.
- Remover uma chave que ainda atende modelos ativos é aceito pelo LiteLLM; por isso a tela avisa quantos modelos ficam sem chave e pede confirmação.
- **Testar** envia uma pergunta de poucos tokens por um modelo daquele provedor publicado no gateway e mostra a resposta ou o erro do provedor.
- Salvar, trocar e remover valem na hora, sem reiniciar. Com `STORE_MODEL_IN_DB=True`, as chaves continuam valendo depois de reiniciar o contêiner.
- **Nunca altere `LITELLM_SALT_KEY`** depois de salvar chaves; elas deixariam de ser lidas.

A API usada é `/credentials` do LiteLLM, marcada como BETA na versão testada (1.106.4). Ao atualizar a imagem, rode `node --test test/provider-credentials.test.cjs` no backend e teste a tela antes de publicar.

A permissão é verificada pelo perfil `SUPER_ADMIN` calculado na autenticação. Se os perfis passarem a vir do token do SGDM, a tela segue essa regra sem mudanças.

`OPENAI_API_KEY` no ambiente do backend continua servindo só para os embeddings, quando `EMBEDDING_API_KEY` estiver vazia. Na VPS a stack não passa `OPENAI_*` ao backend: lá os embeddings dependem só de `EMBEDDING_API_KEY`.

## Precisa de URL pública ou Cloudflare?

Não, quando o LiteLLM roda na mesma VPS e na mesma stack (`i7ai-plataforma`). O backend o acessa por `http://litellm:4000/v1`, o SGDM por `http://litellm:4000` (rede `SGDMNET`), e o serviço não publica nenhuma porta. A stack já define `OMNIROUTER_BASE_URL=http://litellm:4000/v1` e `OMNIROUTER_INTERNAL_HOSTS=litellm` no backend. HTTP nessa rede é aceito só para nomes listados em `OMNIROUTER_INTERNAL_HOSTS` (nomes de serviço Docker, sem ponto). Qualquer outro endereço continua exigindo HTTPS.

Um subdomínio no Cloudflare só é necessário se o LiteLLM ficar em outro servidor. Nesse caso, use HTTPS, `OMNIROUTER_BASE_URL=https://ia.seudominio.com.br/v1` e deixe `OMNIROUTER_INTERNAL_HOSTS` vazio.

## Modelos

Os modelos são ativados na Central de IA do SGDM (**Modelos e acesso**). Ao ativar, o SGDM cria o modelo no LiteLLM com `/model/new`, apontando para a credencial do provedor. Os curingas de [deploy/litellm/config.yaml](../deploy/litellm/config.yaml) continuam no arquivo e roteiam a maioria dos slugs; por isso o `/model/new` só é chamado para modelos ativos que o `/model/info` ainda não lista. Quem remover os curingas depois precisará chamar `/model/new` para todos os modelos ativos. O catálogo do SGDM é copiado para `ai_models` no i7Ai a cada `MODEL_SYNC_SECONDS`. Cada `model_name` deve ser igual ao slug do catálogo e usar um prefixo liberado (`openai/`, `anthropic/`, `gemini/`, `xai/`). Cada modelo aponta para a credencial do provedor (`litellm_credential_name: openai`, `anthropic` ou `gemini`).

Os preços (entrada, saída e entrada em cache, em USD por milhão de tokens) e a janela de contexto vêm do LiteLLM. O i7Ai os lê de `/model/info` 1 minuto depois de iniciar e a cada `MODEL_SYNC_SECONDS` (padrão 300 s), só para os modelos ativos, e grava em **Modelos**, que é só consulta. Ativar um modelo sem preço no LiteLLM é recusado (400). Modelo sem preço no LiteLLM fica sem alteração. Sem `OMNIROUTER_BASE_URL`, a sincronização fica desligada.

Rotas do OmniRoute como `antigravity/...` e `cx/...` não existem no LiteLLM. Troque o modelo dos agentes que as usam.

| Slug | Uso |
| --- | --- |
| `openai/gpt-4o-mini` | Padrão barato: conversa, resumos, planilhas, visão |
| `anthropic/claude-haiku-5-5` | Claude rápido e barato |
| `anthropic/claude-sonnet-5-5` | Documentos longos e análise (licitações, ETP, TR) |

Não há fallback automático entre modelos. O i7Ai registra custo e provedor pelo modelo escolhido, e um fallback mandaria dados para outro provedor com o preço errado.

Na VPS o arquivo entra como *config* do Swarm, que é imutável: no mesmo commit que alterar `deploy/litellm/config.yaml`, troque o sufixo do `name` da config (hoje `i7ai_litellm_config_v2`; a próxima alteração usa `_v3`) em `portainer/i7ai.stack.yml` e faça **Pull and redeploy** da stack `i7ai-plataforma` no Portainer. Sem a troca do nome, o redeploy falha.

## Acesso aos modelos e organização

Regras da Entrega 2, definidas na Central de IA do SGDM:

- **Fechado por padrão.** Prefeitura sem liberação não recebe nenhum modelo no i7Ai. Um 404 do SGDM no endpoint de acesso vale como "nada liberado".
- **Liberação por prefeitura.** Lista de provedores e de modelos. Lista de modelos vazia na regra = todos os modelos ativos dos provedores liberados.
- **Exceção por usuário.** A lista da exceção substitui a da prefeitura (não soma).
- **Desativar um modelo** o remove das regras. Se a liberação da prefeitura ficar vazia, ela é apagada (volta ao fechado).
- **Peças do SGDM.** Continuam com o `modelo` de Cadastros › IA (ou o padrão do adapter) e ignoram as liberações. Com o LiteLLM ligado, o dono ainda precisa ligar a IA por prefeitura em Cadastros › IA.
- **Permissões `I7AI_*`.** Só o dono da plataforma as tem; o ADMINISTRADOR de prefeitura deixou de recebê-las (migration `20261212100000`) e só o dono atribui perfis com códigos reservados.
- **Organização.** Os departamentos do i7Ai são os setores da prefeitura no SGDM (cada usuário em um departamento: CHEFE > ordem > nome), e nome, fuso e retenção vêm do `/settings` do SGDM. As telas Usuários, Departamentos e Configurações saíram do i7Ai.
- **Consumo** agrupado por agente e por conversa, com nomes: a API do SGDM consulta o i7Ai (`I7AI_API_URL`) para traduzir os ids das tags.
- **SGDM fora do ar.** O i7Ai usa o último acesso em cache por até 10 minutos (60 s de validade + janela de 600 s). Isso vale só para o acesso aos modelos; a validação da sessão depende do SGDM e é refeita a cada `SGDM_SESSION_CACHE_SECONDS` (60 s), então sem o SGDM os logins e as requisições novas falham após esse prazo.
- **Execução de automação.** A execução manual usa o acesso do usuário que a disparou; as execuções agendadas usam a regra da prefeitura (sem exceção de usuário). No login, com o cache de organização frio, a espera pelo SGDM pode chegar a 8 s (endurecimento previsto).

### Variáveis

| Variável | Onde | Padrão | Uso |
| --- | --- | --- | --- |
| `SGDM_ACCESS_CACHE_SECONDS` | backend do i7Ai | 60 | validade do cache das liberações |
| `SGDM_ORG_CACHE_SECONDS` | backend do i7Ai | 300 | validade do cache de setores e configurações |
| `MODEL_SYNC_SECONDS` | backend do i7Ai | 300 | sincronização do catálogo e dos preços |
| `I7AI_API_URL` | API do SGDM (`sgdm-app`) | vazio | `http://i7ai-backend:3000/api`; sem ela o Consumo mostra ids em vez de nomes |

Migrations novas: i7Ai `20261028000100_ai_models_active` e `20261028000200_departments_external_id`; SGDM `20261212100000_i7ai_fora_do_administrador` e `20261213100000_ia_modelos_liberacoes`.

## Limites e orçamento

Regras da Entrega 3, definidas na Central de IA do SGDM (**Limites e alertas**) e aplicadas pelo LiteLLM e pelo i7Ai.

- **Orçamento por prefeitura.** O SGDM cria um budget no LiteLLM com id `ia-prefeitura-<id>-<ms>`, duração `1mo`, ligado ao customer (`user` = uuid da prefeitura). Ele reinicia no dia 1º do mês UTC. O gasto das duas chaves (da plataforma e própria da prefeitura) entra no mesmo orçamento, porque o customer recebe todo o gasto; a Central mostra a divisão.
- **Competência = mês UTC.** O mês da Central, dos alertas e do orçamento é o mês calendário em UTC, não o do fuso da prefeitura.
- **Gasto anterior ao primeiro orçamento.** O primeiro budget conta o gasto anterior do mês (o customer acumula o gasto desde que foi criado): o orçamento nasce já abatido, e isso vale até o mês virar. Depois da virada o gasto recomeça do zero.
- **Aviso e bloqueio.** O aviso (percentual do orçamento) gera um alerta e nunca recusa chamadas. Com "bloquear ao atingir 100%", o gateway recusa as chamadas seguintes; sem a opção, o orçamento é só registrado.
- **Chamadas por minuto da prefeitura.** Limite de requisições por minuto aplicado no customer (`end_user`), com limite de tokens por minuto quando preenchido. "Chamadas por minuto" conta toda rodada ao gateway (rodadas de ferramentas e resumos também), então valores muito baixos cortam agentes que usam ferramentas.
- **Budget órfão.** Cada gravação cria um budget novo e apaga o anterior. Quando a prefeitura perde o limite, o customer fica ligado a um budget sem teto; se a prefeitura é removida do SGDM, esse budget sem limite fica órfão no LiteLLM. É inofensivo (não limita nada). Se o banco falhar depois do LiteLLM, o SGDM religa o customer ao budget anterior; se isso também falhar, registra um erro com a prefeitura e o budget novo para correção manual.
- **Limites por usuário no i7Ai.** Chamadas e tokens por minuto e por mês de cada usuário, definidos na Central e lidos pelo backend em `GET /integracoes/i7ai/limites/:tenantId` (cache `SGDM_LIMITS_CACHE_SECONDS`). O bloqueio vale só para o i7Ai e o bloco do usuário no i7Ai conta apenas o uso do i7Ai; as peças do SGDM entram no orçamento da prefeitura. Já os alertas de usuário contam também as peças do SGDM, pela tag `usuario:` do gasto no LiteLLM.
- **Regra de recusa por orçamento (só End User).** Só vira recusa de orçamento da prefeitura a mensagem do gateway que começa com `ExceededBudget: End User=` (e `Rate limit exceeded for end_user` para o minuto). Budgets de chave ou de equipe não são traduzidos. A regra é a mesma nos dois repositórios (`backend/src/ai/omnirouter.service.ts` no i7Ai e `apps/api/src/modules/ia/limite-gateway.ts` no SGDM).

Mensagens de recusa (idênticas no chat, nas automações e na geração de peças):

| Situação | Mensagem |
| --- | --- |
| Orçamento do mês da prefeitura | A prefeitura atingiu o limite de IA deste mês. Fale com o administrador da plataforma. |
| Minuto da prefeitura | A prefeitura atingiu o limite de uso de IA por minuto. Aguarde um instante e tente novamente. |
| Mês do usuário | Você atingiu o seu limite de IA deste mês. Fale com o administrador da plataforma. |
| Minuto do usuário | Você atingiu o seu limite de uso de IA por minuto. Aguarde um instante e tente novamente. |

**Alertas.** A API do SGDM avalia os limites a cada `IA_ALERTAS_INTERVALO_MS` e grava alertas na Central (Visão geral e aba Limites e alertas): orçamento da prefeitura perto do limite e atingido, orçamento de usuário perto do limite e atingido, e uso de usuário acima de N× a média (cinco tipos; não há alerta de limite por minuto). Um alerta resolvido não volta na rodada seguinte. O e-mail é operacional: sai para todo usuário ativo com a permissão `IA_CENTRAL` (dono da plataforma), sem depender da preferência "Avisos por e-mail" de cada um, e é o único aviso ativo no modo "só avisa" (sem bloqueio). Sem nenhum destinatário o alerta fica sem e-mail até haver um (a tela avisa "Nenhum destinatário recebe os alertas por e-mail."); a contagem de alertas abertos aparece até 100. A **cotação do dólar** (US$ para R$) também se configura nessa tela e substitui a antiga `NEXT_PUBLIC_COTACAO_USD`, que não existe mais.

### Licenças do i7Ai

As licenças das prefeituras são editadas no SGDM, em **Central de IA › Licenças i7Ai** (editar limites e vigência, suspender e importar as licenças que já existiam no i7Ai). O i7Ai não tem mais a tela Licenciamento (`#/licensing` abre o Dashboard) e espelha a licença do SGDM a cada `SGDM_LICENSE_SYNC_SECONDS` e no login.

- **Licenças nunca são apagadas.** Para revogar, marque **Suspensa**.
- **Fim inclusivo.** O dia final vale inteiro: o `fim` informado vira `endDate` no dia seguinte às 03:00 UTC.
- **Importar cria só o que falta.** A importação copia as licenças do i7Ai para prefeituras que ainda não têm licença no SGDM; nunca sobrescreve uma existente.
- **Limite de usuários.** Excedido o `maxUsuarios`, o usuário novo não entra no i7Ai e vê "Limite de usuários da licença atingido".
- **SGDM fora do ar.** A licença espelhada continua valendo, o login conclui e o chat segue com o último limite de usuário em cache.

### Variáveis (Entrega 3)

| Variável | Onde | Padrão | Uso |
| --- | --- | --- | --- |
| `SGDM_LIMITS_CACHE_SECONDS` | backend do i7Ai | 60 | validade do cache dos limites por usuário |
| `SGDM_LICENSE_SYNC_SECONDS` | backend do i7Ai | 60 | intervalo do espelhamento das licenças do SGDM |
| `SGDM_FAILURE_CACHE_SECONDS` | backend do i7Ai | 15 | quanto tempo uma leitura falha do SGDM é lembrada antes de tentar de novo |
| `IA_ALERTAS_INTERVALO_MS` | API do SGDM (`sgdm-app`) | 900000 (15 min) | intervalo da avaliação dos alertas; `0` desliga |

Migrations novas: SGDM `20261214100000_ia_limites_alertas_licencas` e i7Ai `20261028000300_ai_token_reservations_user`. Aviso de implantação: a do i7Ai cria índices com `CREATE INDEX` simples em `ai_usage` e `ai_token_reservations`, que bloqueiam escritas enquanto constroem; aplique em janela tranquila. Os dados de demonstração da fumaça local (cotação, limite da prefeitura Demo) existem só na máquina local.

## Local (Windows)

Esta máquina usa `docker-compose.local.yml` (Postgres 5435, Redis 6381, MinIO 9004, LiteLLM 4000).

1. No `.env` da raiz: `OMNIROUTER_BASE_URL="http://localhost:4000/v1"` e `OMNIROUTER_API_KEY` igual a `LITELLM_MASTER_KEY`.
2. `docker compose -p i7ai-prefeituras-local -f docker-compose.local.yml up -d`
3. Inicie a API e o frontend e abra `http://127.0.0.1:5173/preview/local.html` (depois de `npm run local:session`).
4. Sem `SGDM_API_URL`/`SGDM_INTEGRATION_KEY` (modo avulso), todos os modelos do banco local ficam disponíveis no chat; com a integração, o catálogo e as liberações vêm da Central de IA do SGDM.

## VPS (produção)

O passo a passo está em [docs/DEPLOY_VPS.md](./DEPLOY_VPS.md): stack Swarm `i7ai-plataforma` criada pelo Portainer (método Repository, `portainer/i7ai.stack.yml`), variáveis de [portainer/stack.env.example](../portainer/stack.env.example), ligação com o SGDM e a fumaça. Em resumo, para o LiteLLM:

- `LITELLM_MASTER_KEY`: `echo sk-$(openssl rand -hex 32)`; o mesmo valor vai em `LITELLM_ADMIN_KEY` da stack `sgdm-app`. O backend recebe a chave como `OMNIROUTER_API_KEY` pela própria stack.
- `LITELLM_SALT_KEY`: `openssl rand -hex 32`; guarde uma cópia segura e nunca troque.
- A imagem do LiteLLM está fixada por digest em `portainer/i7ai.stack.yml`. Para atualizar, escolha uma versão em https://github.com/BerriAI/litellm/releases e fixe o novo digest; não use `latest`.
- Chaves dos provedores: as da plataforma, na **Central de IA** do SGDM; a de cada prefeitura, no SGDM em **Cadastros › Inteligência Artificial**.
- Modelos: ativados na **Central de IA** do SGDM (que também define o padrão e as liberações por prefeitura e usuário). O i7Ai copia o catálogo do SGDM a cada `MODEL_SYNC_SECONDS` e os preços (USD por milhão de tokens) e o contexto do LiteLLM; **Modelos** no i7Ai é só consulta. Sem preço no LiteLLM, o custo aparece como não configurado.
- Ensaio dos limites: depois de salvar um limite de prefeitura na Central, consulte `GET /budget/info` do LiteLLM (com a chave mestra) e confirme que `budget_reset_at` é o dia 1º do próximo mês às 00:00Z.
- Faça uma conversa real com cada modelo, com e sem streaming, e um envio de imagem com GPT-4o Mini.

## Ordem do deploy da Central de IA

O deploy conjunto com o SGDM segue a mesma ordem descrita em `docs/deploy-portainer.md` do SGDM (seção 11). Resumo do lado do i7Ai:

1. Merge dos dois repositórios em `main`.
2. Variáveis: `REDIS_CACHE_PASSWORD`; `I7AI_INTEGRACAO_CHAVE` (SGDM) igual a `SGDM_INTEGRATION_KEY` (i7Ai), com 32 caracteres ou mais; `LITELLM_ADMIN_KEY` (SGDM) igual a `LITELLM_MASTER_KEY` (i7Ai). Chaves diferentes dão 401 entre as stacks (chat fechado, limites e modelos sem sincronizar).
3. Antes: `SELECT tenant_id FROM perfis WHERE nome = 'DONO_PLATAFORMA'` no banco do SGDM deve devolver uma única linha, da prefeitura da plataforma.
4. Deploy do **SGDM primeiro**, com `LITELLM_URL` vazio em `sgdm-app`. O contrário (i7Ai novo com SGDM antigo) deixa o chat fechado.
5. O dono ativa modelos e liberações em `/central-ia/modelos`.
6. Deploy do i7Ai com a config do LiteLLM `i7ai_litellm_config_v2`. Os índices de `ai_usage` e `conversations` não são concorrentes: use horário de baixo movimento.
7. Confirme que a stack i7Ai e o LiteLLM estão saudáveis; só então preencha `LITELLM_URL` em `sgdm-app` e refaça o deploy.
8. Gere uma peça com a chave própria de uma prefeitura e outra com a da plataforma.

Notas de versão: `retentionDays` volta ao padrão e os departamentos legados ficam inativos. SMTP precisa estar configurado no SGDM para os e-mails de alerta. Rode o ensaio `e4t4-live.cjs` (ou equivalente) com uma chave real da Anthropic antes de confiar na economia do cache de prompt.

## Central de IA no SGDM

A Central de IA é a visão do consumo e do custo de IA de todas as prefeituras, dentro do SGDM (`/central-ia` e `/central-ia/consumo`). Só quem tem a permissão `IA_CENTRAL` vê. Ela é reservada à prefeitura da plataforma: o perfil `DONO_PLATAFORMA` já vem com ela, e um perfil da prefeitura da plataforma (por exemplo `GESTOR_IA`) pode recebê-la; perfis das demais prefeituras não podem. Qualquer outro usuário recebe 403 na API.

**De onde vêm os números.** O SGDM consulta o LiteLLM com `LITELLM_URL` e `LITELLM_ADMIN_KEY` (as duas precisam estar preenchidas; uma só desliga). O consumo e o custo saem do gasto que o próprio LiteLLM registra (`/spend/...`); a divisão por usuário, origem e conversa de uma prefeitura sai de `/spend/logs/v2`. O i7Ai grava o mesmo em `ai_usage` (tokens, tokens em cache e `costSource`: `gateway` quando vem do `x-litellm-response-cost`, `catalog` quando é calculado com os preços sincronizados do `/model/info`, de 6 em 6 horas).

**Tags em cada chamada.** Toda chamada ao gateway leva `user` = uuid da prefeitura e `metadata.tags`:

| Tag | Valor |
| --- | --- |
| `usuario:` | usuário que originou a chamada |
| `origem:` | `i7ai-chat`, `i7ai-automacao`, `i7ai-resumo` (resumo do histórico), `sgdm-pecas` (geração de peças no SGDM) ou `sgdm-teste` (teste de chave no SGDM) |
| `conversa:` | conversa do chat (a primeira mensagem de uma conversa nova já leva a tag) |
| `agente:` | uuid do agente do i7Ai que respondeu (só chamadas do i7Ai; as peças do SGDM não têm agente) |
| `chave:` | `propria` quando a chamada levou a chave da própria prefeitura (`api_key` por requisição), `plataforma` quando usou a chave da plataforma |

Todas as tags levam só ids e valores fixos, nunca nomes de pessoas nem chaves. O teste de chave em **Cadastros › IA** do SGDM sai com `origem:sgdm-teste` e não conta como peça.

Ficam fora dessas tags por prefeitura: o teste das credenciais de provedor feito pelo i7Ai (passa pelo gateway sem `user` nem `metadata.tags`, então entra no gasto total sem prefeitura) e os embeddings da base de conhecimento (cliente próprio com `EMBEDDING_*`, sem `user` nem tags; só aparecem no gateway se `EMBEDDING_BASE_URL` apontar para ele).

As peças do SGDM passam pelo LiteLLM só se `LITELLM_URL` e `LITELLM_ADMIN_KEY` estiverem definidas, usando a chave da própria prefeitura (`api_key` por requisição) ou, sem ela, a da plataforma.

**Custo por conversa** = gasto das chamadas com tag `conversa:` ÷ número de conversas. Nas linhas do detalhamento, conversas e custo por conversa aparecem como "—" (nulo) quando não dá para calcular: quando não há uma prefeitura filtrada ao agrupar por prefeitura, usuário ou origem, e sempre ao agrupar por modelo ou provedor.

**Retenção.** Usuário, origem e conversas por prefeitura dependem dos logs do LiteLLM; se ele apagar logs antigos (retenção configurada), esses números somem do período. Os totais de gasto não dependem disso.

### Fluxo ao vivo

Na **Visão geral** da Central, o cartão **Fluxo ao vivo** desenha as chamadas dos últimos 5 minutos: prefeituras → origem (`i7Ai · chat e resumos`, `i7Ai · automações`, `SGDM · peças`, outras) → LiteLLM → provedores. A web nunca fala com o LiteLLM: ela consulta `GET /central-ia/fluxo` na API do SGDM (só `IA_CENTRAL`; sem a permissão, 403), e a API é quem lê o gateway.

**Fonte.** Cada atualização faz no máximo uma leitura da janela em `/spend/logs/v2` (`start_date` = agora − 300 s, `page_size` 1000, `page` 1, `exclude_internal_health_checks`, mais `end_user` quando há uma prefeitura selecionada). Nunca pagina: com mais de 1.000 chamadas na janela, os números vêm das 1.000 mais recentes e a tela avisa "Volume alto: números das 1.000 chamadas mais recentes." A resposta fica em cache de 5 s por prefeitura (uma só consulta em voo por chave; falha não fica em cache), então várias abas e vários usuários custam ao LiteLLM no máximo uma leitura a cada 5 s **por instância da API**. A tela atualiza a cada 10 s e passa a 30 s depois de duas falhas seguidas; com a aba oculta não consulta. O gasto de hoje por provedor sai de `/customer/daily/activity/aggregated` do dia UTC, com cache de 60 s. O fluxo não usa tags e não lê `/tag/daily/activity*`.

**O que cada número quer dizer** (sobre as linhas da janela; sem chamadas, "—"):

| Número | Cálculo |
| --- | --- |
| erro % | chamadas com `status = failure` ÷ todas as chamadas × 100 |
| cache % | tokens de entrada lidos do cache de prompt do provedor ÷ tokens de entrada (`prompt_tokens`), só nas chamadas com sucesso, × 100. Tokens lidos do cache = `prompt_tokens_details.cached_tokens` (ou `cache_read_input_tokens`, ou 0), limitado ao `prompt_tokens` da linha |
| latência (p50, p95) | percentil por posição (*nearest rank*) de `request_duration_ms` nas chamadas com sucesso que **não** vieram do cache exato; uma resposta do cache exato levaria a mediana para perto de zero |
| respostas repetidas | chamadas com `cache_hit = True` (cache exato do LiteLLM); aparece no detalhe da caixa LiteLLM |
| gasto na janela (provedor) | soma de `spend` das linhas da janela |

O resumo do histórico (`origem:i7ai-resumo`) conta na caixa de chat, porque é custo causado por uma conversa; na aba **Consumo e custo** ele continua em linha própria.

**Atraso do LiteLLM.** O LiteLLM grava o log de gasto alguns segundos depois da resposta. Local, uma chamada de 220 ms apareceu em `/spend/logs/v2` depois de cerca de 3,7 s, e em lotes maiores em até 16 s. Com cache de 5 s e atualização de 10 s, uma chamada aparece no fluxo em até uns 20 s; não é falha.

**LiteLLM fora do ar.** A API devolve 503 ("O gateway de IA não respondeu.") ou 502; a tela mantém o último retrato esmaecido, **pausa as partículas** e marca a caixa LiteLLM em vermelho com "Sem resposta desde HH:MM:SS" (hora do navegador). Ao voltar, a marca some na próxima atualização bem-sucedida. Com movimento reduzido no sistema (`prefers-reduced-motion`), não há partículas; a espessura das ligações e os números continuam.

**Leituras por tag limitadas.** O resto da Visão geral (e o agrupamento por origem do Consumo) lê `/tag/daily/activity` em páginas de 1.000 linhas, no máximo `MAX_PAGINAS_TAGS` (100) páginas, e filtra cada página antes de descartá-la (a memória não cresce com o período). A origem global usa `/tag/daily/activity/aggregated` só com as tags conhecidas, nunca sem `tags`. Passou do limite: o consumo responde 400 com "Período com conversas demais para contar; escolha um período menor ou filtre uma prefeitura.", a Visão geral mostra "—" nos usuários ativos, conversas e custo por conversa com essa mesma dica, e a avaliação de alertas pula só os alertas por usuário (os da prefeitura continuam).

Variáveis: nenhuma nova.

### O que os usuários pedem

A Visão geral tem o cartão **O que os usuários pedem** (temas mais frequentes e conversas de alto custo), e o **Consumo e custo › Por conversa** tem as colunas **Tema** e **i7Ai** e o filtro **Tema**. A Central mostra temas e números; o texto das conversas só no i7Ai, com registro.

**Temas por lista fixa.** O tema de cada conversa é calculado no i7Ai, sem chamar modelo nenhum (nenhum dado de conversa sai só para ser classificado), por palavras-chave do **título** (peso 2) e do **nome do agente** (peso 1), sem acentos nem maiúsculas. Vence a maior pontuação; empate, quem teve mais palavras; ainda empate, a ordem da tabela; nenhuma palavra: `outros`. Os temas são: `licitacoes` (Licitações e contratos), `juridico` (Pareceres e questões jurídicas), `documentos` (Ofícios e documentos oficiais), `pessoal` (Pessoal e RH), `tributos` (Tributos e arrecadação), `financas` (Orçamento e finanças), `saude` (Saúde), `educacao` (Educação), `assistencia` (Assistência social), `obras` (Obras e urbanismo), `meio-ambiente` (Meio ambiente), `atendimento` (Atendimento ao cidadão), `tecnologia` (Tecnologia e sistemas), `texto` (Revisão e resumo de textos) e `outros`. A tabela e as regras estão em `backend/src/sgdm/themes.ts`.

- A conversa nova já nasce com `theme` e `themeVersion` (colunas de `conversations`).
- **Versão e recálculo.** `THEME_VERSION` (hoje 2) sobe sempre que a tabela ou as regras mudam. Só vale o tema de linhas com `themeVersion` igual ou maior que a versão atual. **Depois de subir a versão, tudo conta como `semTema` até o recálculo rodar**: o cartão e o filtro ficam vazios ou incompletos nesse intervalo. O recálculo (`ThemeBackfillService`) roda 60 s depois de o backend subir e depois a cada `THEME_BACKFILL_INTERVAL_MS` (padrão 10 min; `0` desliga), em rodadas de até 20 lotes de 500 conversas, **das mais recentes para as mais antigas**, e é idempotente (linha atualizada sai do filtro; uma linha já classificada por versão mais nova nunca é sobrescrita). O log traz só contagens, nunca títulos. Medido no banco local: 62 conversas recalculadas em 1 lote, 83 ms.
- **Migration `20261031000100_conversation_theme`.** Soma as colunas `theme` e `themeVersion` e cria três índices em `conversations` (`createdAt`; `tenantId, createdAt`; `themeVersion`) com `CREATE INDEX` comum, que **trava as escritas na tabela enquanto o índice é construído**. Aplique-a em horário calmo, sobretudo com milhões de conversas.

**Máscara de títulos e o limite dela.** O título que sai do i7Ai para a Central (`POST /api/integracoes/sgdm/nomes`) passa por `maskPersonalData`, nesta ordem: e-mail → `[e-mail]`, CNPJ → `[CNPJ]`, CPF (com ou sem pontos e traço) → `[CPF]`, telefone com DDD → `[telefone]` e qualquer sequência de 6 ou mais dígitos, mesmo com espaços, pontos ou hífens → `[número]` (um número de processo não é tomado por telefone). O título no banco do i7Ai não muda. **Nomes de pessoas não são detectados** e não são mascarados: "Férias do servidor João" sai como está. Por isso o título só vai para quem tem `IA_CENTRAL`, e o texto das mensagens nunca sai por esses endpoints.

**Endpoints internos.** Chamados só entre servidores, com a chave de integração (`SGDM_INTEGRATION_KEY`, igual a `I7AI_INTEGRACAO_CHAVE` no SGDM). Nenhum devolve texto de mensagem.

| Endpoint | Devolve |
| --- | --- |
| `GET /api/integracoes/sgdm/temas?inicio=AAAA-MM-DD&fim=AAAA-MM-DD[&tenantId=]` | por tema: id, rótulo, conversas, usuários e prefeituras; mais `semTema`. Período de até 366 dias, por data de criação da conversa |
| `POST /api/integracoes/sgdm/nomes` (ids de agentes e de conversas no corpo) | nome de cada agente e, para cada conversa, o título mascarado e o `tema` (id e rótulo). Conversa com `themeVersion` antigo é classificada na hora, sem gravar; por isso a coluna Tema do Consumo já mostra o tema mesmo antes do recálculo, enquanto o cartão de temas ainda conta essas conversas como `semTema` |
| `POST /api/central/conversas/:id/abrir` | única rota que devolve texto, e não é de integração: usa a sessão do usuário (veja abaixo) |

O SGDM mostra "Temas indisponíveis" (no cartão e na coluna Tema) quando o i7Ai não responde; o resto da Central continua. No Consumo, o filtro por tema olha só as 200 conversas de maior custo do período.

**Abertura de uma conversa (auditada).** O link **ver no i7Ai** abre `/i7ai/?conversa=<id>` em nova aba, que pede o **motivo** antes de mostrar qualquer coisa.

1. `POST /api/central/conversas/:id/abrir` com `{ "motivo": "..." }` (10 a 300 caracteres). Só quem tem `centralIa` na sessão (permissão `IA_CENTRAL` do SGDM) abre; os demais recebem **403 antes de qualquer leitura ou validação do corpo**, então a resposta não revela se a conversa existe, e nada é gravado. Id sem conversa: 404.
2. Em **uma transação**, o i7Ai lê a conversa (as 1.000 mensagens mais recentes; `truncada: true` se havia mais), grava na auditoria **da prefeitura dona da conversa** o evento `conversation.viewed_by_platform` (recurso `conversations`, com `motivo`, `viewerEmail`, `viewerTenantId`, `origem: central-ia` e o número de mensagens) e só então responde. Se a auditoria falhar, nada é devolvido.
3. A visualização é só de leitura e em texto puro, com `Cache-Control: no-store`. O log do servidor traz só o id e a contagem de mensagens, nunca o motivo, o título nem o conteúdo.
4. O administrador da prefeitura vê o evento em **i7Ai › Relatórios › Auditoria**, com o nome de quem abriu e o motivo.

O dono da plataforma precisa ter entrado no i7Ai ao menos uma vez para existir no espelho de usuários. Um usuário que tem `IA_CENTRAL` mas **nenhum papel i7Ai** não ocupa vaga de licença (senão o dono ficaria bloqueado em prefeituras com a licença cheia); a vaga só é conferida se ele ganhar um papel i7Ai.

## Otimização

As otimizações da Entrega 4 reduzem o custo por conversa do i7Ai. São configuradas no SGDM, em **Central de IA › Otimização** (tabela `ia_otimizacoes`, escopo agente > prefeitura > todos > padrão), e o i7Ai só lê (`GET /integracoes/i7ai/otimizacoes/:tenantId`, cache `SGDM_OPTIMIZATION_CACHE_SECONDS`). Sem resposta do SGDM e sem cache, o i7Ai usa os padrões abaixo e nunca bloqueia o chat. As peças do SGDM (`origem:sgdm-pecas`) não recebem nenhuma delas.

| Item | Ligado | Parâmetros | Escopos |
| --- | --- | --- | --- |
| Modelo caro (aviso) | sim | `fatorPreco: 4`, `saidaCurta: 500` | todos |
| Cache de prompt | sim | — | todos, prefeitura, agente |
| Resumo do histórico | **não** | `mensagens: 20` (10 a 40); `modelos` por provedor (OpenAI `openai/gpt-4o-mini`, Anthropic `anthropic/claude-haiku-5-5`, Gemini nenhum), só em "todos" | todos, prefeitura, agente |
| Cache exato | sim, só automações | `ttlSegundos: 3600` (60 a 86400), `chat: false` | todos, prefeitura, agente |
| Limite de saída | não | `tokens: null` (256 a 32000) | agente |
| Imagens em baixa | sim | — (desligado = "alta") | todos, prefeitura, agente |
| Sugestões | sim | `minimoUsd: 1` | todos |

**No deploy.** Cache de prompt e imagens em baixa já vêm ligados por padrão. Na primeira chamada depois do deploy, a disposição do prompt muda para todos os agentes (parte fixa no sistema, trechos e arquivos na última mensagem do usuário; ver abaixo), e as imagens passam a ir em `detail: 'low'`. Em baixa resolução, texto miúdo de editais e documentos escaneados (fotografados ou digitalizados como imagem) pode ficar ilegível para o modelo: para prefeituras ou agentes que leem esse tipo de arquivo, desligue "Imagens em baixa" naquele escopo.

### Cache de prompt: parte fixa e parte variável

- **Ligado.** A mensagem de sistema leva só a parte fixa (prompt do agente, regras de exportação e regra das fontes). Os trechos de documentos e os arquivos vão no começo da última mensagem do usuário, dentro de `<fontes_e_arquivos>`; o histórico também fica em cache. Essas tags são neutralizadas se aparecerem dentro do conteúdo.
- **`cache_control`.** Só para modelos `anthropic/`, em no máximo 2 pontos: o fim da parte fixa e a última mensagem do histórico. O segundo ponto só vale quando o histórico não foi cortado (nem pelo resumo). OpenAI e Gemini cacheiam sozinhos, sem marcação.
- **Desligado.** A disposição é exatamente a anterior à Entrega 4.
- **Custo.** `inputTokens` inclui os tokens lidos e os escritos em cache. Os lidos são cobrados por `cachedInputPrice`, os escritos por `cacheWriteInputPrice` (do `cache_creation_input_token_cost` do LiteLLM; sem ele, pelo preço de entrada).
- **Mínimo do provedor.** O Claude só cacheia prefixos acima do mínimo do modelo (o Haiku exige mais de 2.048 tokens); abaixo disso os tokens em cache ficam em 0.

### Resumo do histórico

- **Gatilho.** Mais de N mensagens (padrão 20; de 10 a 40). As N/2 mais recentes vão sempre literais, e o resumo é refeito em lotes de N/2. O teto de 40 garante que as até N − 1 mensagens ainda não resumidas caibam na janela de 40 mensagens do histórico. Roda num job BullMQ (`conversation.summary`) depois da resposta, fora do caminho do usuário. As mensagens nunca são apagadas.
- **Só quando economiza.** Na fumaça da Task 11 (mensagens curtas, ~60 tokens) o resumo ficou maior que as mensagens que substituía e o custo subiu 10%. Por isso:
  - o lote só é resumido quando as mensagens dele somam pelo menos 6.000 caracteres (`SUMMARY_MIN_SOURCE_CHARS`, ~1.500 tokens); abaixo disso o job não chama o modelo e espera mais mensagens (o lote seguinte é maior);
  - o limite de saída do resumo é 40% dos tokens estimados do texto que ele substitui (resumo anterior + lote), com piso de 256 e teto de 1.500 tokens (ou o do modelo, se menor);
  - se o resumo pronto tiver 70% ou mais dos caracteres do texto substituído, é descartado: auditoria `conversation.summary_skipped` só com contagens (`messages`, `summaryChars`, `replacedChars`). Não conta como rejeição (não soma para as 3 seguidas), mas espera mais N/2 mensagens como uma rejeição, para não pagar um resumo descartado a cada resposta.
- **Mesmo provedor.** O modelo é o barato do provedor da conversa (parâmetro `modelos`), se ativo e liberado para a prefeitura; senão o próprio modelo da conversa. Nunca outro provedor.
- **Conferência de itens.** Todo número, data, valor, lei, artigo, processo, CPF/CNPJ e percentual da fonte tem de aparecer literalmente no resumo (inclusive "artigo 75", "arts. 74 e 75", prazos, quantidades e datas por extenso). Valores e quantidades guardam o multiplicador ("R$ 1,5 milhão" não é "R$ 1,5" nem "R$ 1,5 mil"; mil, milhão/milhões, bilhão/bilhões). Há uma nova tentativa; se ainda faltar, o resumo é rejeitado e a conversa segue com as mensagens completas. Resposta cortada pelo limite de saída do resumo (o proporcional acima) e falhas repetíveis também contam como rejeição.
- **Limite de custo.** Depois de uma rejeição o job só tenta de novo após mais N/2 mensagens; com 3 rejeições seguidas a conversa para de ser resumida até o usuário desligar e ligar de novo. Cada job faz no máximo 2 chamadas e limita a fonte. Recusas por limite ou orçamento (limites do SGDM, orçamento/limite por minuto da prefeitura no LiteLLM, saldo ou licença inativa) não são rejeição: o job só pula e tenta na próxima resposta.
- **Fora do resumo.** Trechos de RAG e anexos nunca entram.
- **Reversão pelo usuário.** O chat mostra "Ver resumo" e "Usar mensagens completas"; "Permitir resumo" volta (`POST /conversations/:id/summary/disable|enable`). O aviso "foram resumidas" só aparece quando `GET /conversations/:id` devolve `summaryActive: true` (mesma condição do envio: OmniRouter configurado, resumo ligado na Central, não desligado pelo usuário e resumo existente). A Central vê só contagens (criados, rejeitados, desligados pelo usuário), nunca texto; os eventos de auditoria são `conversation.summary_created|rejected|skipped|disabled` (o painel conta criados, rejeitados e desligados).
- **Custo do resumo** fica separado pela origem `i7ai-resumo`.

### Cache exato

O LiteLLM guarda respostas inteiras num Redis só de cache, o `i7ai-redis-cache`. Ele tem senha própria (`REDIS_CACHE_PASSWORD`), `maxmemory 200mb`, `allkeys-lru` e não grava em disco. Fica separado do `i7ai-redis` das filas BullMQ, que precisa de `noeviction` (um despejo ali soltaria a trava de um job e a automação seria cobrada duas vezes). Nunca é o Redis do SGDM. No LiteLLM, `REDIS_HOST`, `REDIS_PORT` e `REDIS_PASSWORD` apontam para o `i7ai-redis-cache` (a stack alimenta `REDIS_PASSWORD` com `REDIS_CACHE_PASSWORD`). O plano original previa o `i7ai-redis` com `maxmemory` e `volatile-ttl`; isso foi abandonado na revisão da Task 5.

- **Quando vale.** O modo é `default_off` (`deploy/litellm/config.yaml`), então nada é cacheado sem pedido. O backend pede `cache: { 'use-cache': true, ttl, namespace: 'i7ai:<prefeitura>' }` só em chamadas sem stream e sem ferramentas: em automações, e no chat quando a Central liga `chat`. Agente com ferramentas nunca usa o cache exato (uma chamada de ferramenta, ou uma resposta montada sobre o resultado dela, repetida do cache pularia dados novos). A estimativa do cache exato ainda conta repetições de pedidos com ferramentas (o `ai_usage` não marca se havia ferramentas), então pode superestimar para esses agentes. O namespace por prefeitura foi testado no LiteLLM 1.106.4: o mesmo pedido de outra prefeitura não acerta o cache.
- **Acerto.** O LiteLLM envia `x-litellm-cache-key` só quando a resposta vem do cache. O `x-litellm-response-cost` repete o custo original, por isso o i7Ai grava `cacheHit = true` e custo 0 sem usar esse cabeçalho. Os tokens ficam na linha para medir a economia, mas saem do saldo da licença, dos tokens por minuto do usuário e dos totais do painel (contados à parte em `cacheHits`).
- **Gasto do LiteLLM.** Num acerto, `LiteLLM_SpendLogs` grava `spend = 0` e `cache_hit = True` (conferido no 1.106.4). Os números da Central, que vêm do `/spend/...`, não somam o custo de um acerto.
- **Redis fora do ar.** Com `socket_connect_timeout: 1` e `socket_timeout: 1`, a chamada segue sem cache. No teste local, as primeiras chamadas tiveram uns 2 s a mais e as seguintes, nenhum atraso. O LiteLLM também guarda uma cópia curta na própria memória: com o Redis parado, a primeira chamada de uma entrada nova responde normalmente (e é cobrada) e uma repetição imediata ainda pode vir dessa cópia (`cacheHit`), então um acerto não prova que o Redis está de pé.
- **Contadores do LiteLLM no mesmo Redis.** Com `REDIS_HOST` definido, o LiteLLM também guarda no `i7ai-redis-cache` os contadores que ele compartilha entre réplicas (limites por minuto e gasto em memória). Esse Redis despeja chaves (`allkeys-lru`) e não grava em disco: com a memória cheia ou depois de um reinício, um contador pode zerar e um limite por minuto deixar passar mais chamadas por alguns instantes. O orçamento mensal da prefeitura continua no banco do LiteLLM (`LiteLLM_EndUserTable`) e os limites do SGDM são conferidos pelo i7Ai no próprio banco, então nenhum dos dois depende desse Redis.

### Limite de saída e imagens

- **Limite de saída.** Só por agente, como teto sobre `agent.maxTokens`. Resposta cortada pelo teto vira erro claro e `ai_usage.truncated`, contado na Central como guarda de qualidade (`truncated` marca qualquer corte por tamanho, não só o do teto da plataforma). A sugestão só aparece com o p95 real abaixo de metade do limite atual.
- **Imagens.** "Baixa" = `detail: 'low'`; "alta" = `auto` (o de antes). A economia só existe para `openai/`; Claude e Gemini não reduzem por esse parâmetro. Em baixa, texto pequeno de documentos escaneados pode se perder (ver "No deploy").

### Como cada economia é medida

Tudo vem de `ai_usage` do i7Ai, que guarda os mesmos números do LiteLLM (`GET /api/integracoes/sgdm/otimizacao/economia`, período de até 92 dias; só ids, contagens, tokens e US$, nunca texto de conversa). Preços em US$ por milhão de tokens, os atuais de `ai_models`. **Real** vem de linhas medidas; **estimativa** é uma projeção para quem está com o item desligado. Quando não dá para medir, a API devolve `null` e a tela mostra "—", nunca 0.

| Item | Real | Estimativa |
| --- | --- | --- |
| Cache de prompt | `Σ lidos × (entrada − entrada em cache) − Σ escritos × (escrita − entrada)`; inclui o cache automático da OpenAI | por agente com o item desligado e prefixo de pelo menos 1.024 tokens, só com as chamadas `anthropic/` (OpenAI e Gemini cacheiam sozinhos com o item ligado ou não, e isso já está no real): `acertos × prefixo × (entrada − cache) − erros × prefixo × (escrita − entrada)`; acerto = chamada a menos de 5 min da anterior do mesmo agente |
| Cache exato | soma do custo (preços do modelo) das linhas com `cacheHit` | custo das linhas sem acerto cujo `requestHash` repete o de uma anterior da mesma prefeitura dentro do TTL |
| Resumo | `Σ historySavedTokens × entrada − Σ custo` das linhas `kind 'resumo'` | com o item desligado: para cada resposta em posição maior que N, tokens das mensagens anteriores às N/2 mais recentes (dentro da janela do histórico: 40 mensagens e 48.000 caracteres) × 0,75 × entrada; 0,75 é a compressão suposta |
| Imagens em baixa | só `openai/`: `Σ imagens baixas × 680 × entrada` | `Σ imagens altas × 680 × entrada`; 680 = 765 − 85, uma imagem de 1024 px em `auto` contra `low` (aproximação) |
| Troca de modelo | linhas do agente depois do evento com o modelo novo, até a troca seguinte ou o "Desfazer" × (preços do antigo − preços do novo), sem resultado negativo por linha | calculada no SGDM (modelo caro): tokens do agente × (preços atuais − preços do padrão) |
| Limite de saída | — (`null`: não mensurável) | — |

O **antes/depois** de cada item é o custo por conversa (gasto das chamadas com tag `conversa:` ÷ conversas) nos 30 dias antes de `ligadoEm` contra até 30 dias a partir de `ligadoEm`. Só existe para a linha "todos" do item (o `ligadoEm` de uma exceção por prefeitura ou agente não entra); sem ela ligada, "—". O cabeçalho da aba compara o custo por conversa do período com o anterior. As sugestões (no máximo 20, cada uma com pelo menos US$ `minimoUsd` em 30 dias) são calculadas na hora; "Aplicar" recalcula antes de executar e só então audita (`ia_sugestao`, `APLICAR`), e a troca de modelo de um agente tem "Desfazer", também depois de recarregar a página: o i7Ai devolve `agentes[].ultimaTroca` (de, para, em) enquanto o agente ainda está no modelo da troca e ela não foi desfeita (o desfazer grava o evento `TROCA_MODELO_DESFEITA`, que nunca é oferecido para desfazer). Se o modelo anterior não estiver mais ativo ou liberado para a prefeitura, o desfazer é recusado com "O modelo anterior não está mais liberado para esta prefeitura; escolha outro modelo no agente.". A troca também é recusada quando o agente recebeu imagens nos últimos 30 dias (`ai_usage` com imagens) e o modelo novo não tem `supportsVision: true`, além das checagens de ferramentas e raciocínio. O aviso "modelo caro" de cada agente compara com o padrão da prefeitura dele (`padraoPrefeitura` do painel), não com o da plataforma.

### Variáveis

| Variável | Onde | Padrão | Uso |
| --- | --- | --- | --- |
| `SGDM_OPTIMIZATION_CACHE_SECONDS` | backend do i7Ai | 60 | validade do cache das otimizações por prefeitura (um valor vencido ainda é servido por até 600 s enquanto o SGDM não responde); a stack repassa ao backend (`${SGDM_OPTIMIZATION_CACHE_SECONDS:-60}`) |
| `SGDM_OPTIMIZATION_FAILURE_CACHE_SECONDS` | backend do i7Ai | 15 | quanto tempo uma leitura falha é lembrada antes de tentar de novo |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | LiteLLM | `i7ai-redis-cache`, 6379, valor de `REDIS_CACHE_PASSWORD` | Redis do cache exato |
| `REDIS_CACHE_PASSWORD` | stack do i7Ai | sem padrão | senha do `i7ai-redis-cache`; diferente de `REDIS_PASSWORD` |

Migrations novas: i7Ai `20261030000100_otimizacao_consumo`, `20261030000200_conversation_summary`, `20261030000210_conversation_summary_rejections` e `20261030000300_optimization_events`; SGDM `20261215100000_ia_otimizacoes`. Aviso de implantação: a primeira cria índice com `CREATE INDEX` simples em `ai_usage`, que bloqueia escritas enquanto constrói; confira o número de linhas e aplique em janela tranquila. Serviço novo na stack: `i7ai-redis-cache`.

Antes de ligar o cache de prompt em produção, rode o teste ao vivo com Claude (3 mensagens; a 2ª e a 3ª devem trazer tokens em cache) e meça o custo por conversa com o script abaixo.

### Medir o custo por conversa

`node scripts/smoke-custo-conversa.cjs --agente <id> --mensagens 24 --rotulo antes|depois` abre uma conversa nova, envia as mensagens fixas do script (com leis, datas e valores), espera o resumo quando ele está ligado e imprime `rotulo; conversa; chamadas; tokens entrada; tokens cache; tokens saída; custo US$`. O custo é a soma das chamadas com a tag `conversa:<id>` em `/spend/logs/v2` do LiteLLM, conferida com `ai_usage`. A chave do LiteLLM (`LITELLM_MASTER_KEY` ou `LITELLM_ADMIN_KEY`) e a sessão local (`npm run local:session`) vêm do ambiente e do `.env`, e nunca são impressas. Só para desenvolvimento.

## Pesquisa na internet

Os agentes podem pesquisar na internet e em compras públicas durante a resposta. Vale só no caminho OmniRouter/LiteLLM e só para modelos com `supportsTools`.

**Como ligar.** O padrão é **desligado**. O dono da plataforma (permissão `IA_CENTRAL`) liga em **Central de IA › Otimização › Pesquisa na internet**, para todas as prefeituras ou para uma. O SGDM guarda o interruptor, a chave do Serper e o custo por pesquisa; o i7Ai lê tudo em `GET /integracoes/i7ai/pesquisa` do SGDM (mesma chave de integração das outras leituras; cache curto; SGDM antigo sem o campo conta como desligado).

**Fontes.**
- **Compras públicas (PNCP)**, sem chave: `pesquisar_compras_publicas` busca em `pncp.gov.br/api/search/` (edital, ata ou contrato; UF opcional), detalha até 5 compras por chamada (itens e resultados) e devolve preços, órgão, data e o link `https://pncp.gov.br/app/editais/...` (atas e contratos têm link próprio). Custo 0.
- **Internet (Serper)**: `pesquisar_internet` faz `POST https://google.serper.dev/search` com o cabeçalho `X-API-KEY`. Precisa da chave cadastrada em **Central de IA › Modelos e acesso › Pesquisa na internet (Serper)**. Sem chave, só a função de compras é oferecida.
- A única saída de rede é para `google.serper.dev` e `pncp.gov.br`; 10 s por chamada; resposta lida até 1 MB.

**Limites.** Até **5 pesquisas por resposta** (internet e compras somadas). A 6ª recebe "limite de pesquisas desta resposta atingido" e o modelo conclui com o que tem; o teto de 8 rodadas do OmniRouter não muda. Cada resultado é cortado em 12.000 caracteres antes de ir ao modelo. O limite por minuto do usuário conta as pesquisas junto com as reservas de tokens; a verificação por rodada de modelo ainda conta só as reservas.

**Custo.** Cada pesquisa na internet soma ao consumo o valor configurado pelo dono (padrão **US$ 0,001**, aceita vírgula). PNCP custa 0 e também é registrado. Tabela `research_calls` do i7Ai (migration `20261101000100_research_calls`): prefeitura, conversa, fonte, status, custo e data, sem o texto pesquisado. A Central mostra o total por prefeitura em **Visão geral** (cartão "Pesquisas na internet") e em **Consumo e custo** (tabela "Pesquisas por prefeitura"), por `GET /integracoes/sgdm/pesquisas` do i7Ai.

**Privacidade.** O termo enviado ao Serper e ao PNCP passa por `maskPersonalData` (CPF, telefone etc. saem mascarados). A chave do Serper é cifrada no SGDM, nunca volta à tela (só o final mascarado) e não entra em log nem em auditoria; o log do i7Ai guarda só contagens, a fonte e um código de erro (`SERPER_RECUSOU`, `SERPER_FALHOU`, `PNCP_FALHOU`). Se o Serper recusar a chave, a sessão para de chamá-lo naquela resposta. Os resultados chegam ao modelo marcados como dados, não instruções.

**Falhas e fontes.** Fonte fora do ar ou lenta: a ferramenta devolve "A fonte não respondeu agora." e a resposta sai com o resto; o chat não quebra. Se a resposta final não citar nenhum link coletado, o servidor acrescenta "Fontes" (até 10 links), também no streaming.

**Mensagens do modelo.** Pesquisa desligada: o prompt manda dizer com clareza que a pesquisa não está liberada para a prefeitura e não inventar números nem links. Pesquisa ligada com modelo sem `supportsTools`: o prompt manda dizer que o modelo escolhido não pesquisa e sugerir outro modelo.

**Automações perdem o cache exato.** Com a pesquisa ligada, as funções entram na requisição e o cache exato (que só vale sem ferramentas) deixa de valer nas automações da prefeitura. A tela de Otimização avisa disso.

**Word e Excel antigos (.doc/.xls).** O chat e a base de conhecimento passam a ler `.doc` e `.xls` (dependência `xlsx` 0.20.3 vinda de `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`; o `docker build` precisa de acesso a `cdn.sheetjs.com`). A leitura roda num `worker_thread` com 15 s de tempo limite (o worker é encerrado) e limites: 50 planilhas, 200.000 linhas, 2.000.000 de células e 4.000.000 de caracteres; planilha acima disso é recusada com mensagem clara.

**Migrations.** i7Ai `20261101000100_research_calls`; SGDM `20261216100000_ia_pesquisa_internet`.
