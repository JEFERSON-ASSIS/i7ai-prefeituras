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

Na VPS o arquivo entra como *config* do Swarm, que é imutável: no mesmo commit que alterar `deploy/litellm/config.yaml`, troque o sufixo de `name: i7ai_litellm_config_v1` (v1 → v2) em `portainer/i7ai.stack.yml` e faça **Pull and redeploy** da stack `i7ai-plataforma` no Portainer. Sem a troca do nome, o redeploy falha.

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
- **Chamadas por minuto da prefeitura.** Limite de requisições por minuto aplicado no customer (`end_user`), com limite de tokens por minuto quando preenchido.
- **Limites por usuário no i7Ai.** Chamadas e tokens por minuto e por mês de cada usuário, definidos na Central e lidos pelo backend em `GET /integracoes/i7ai/limites/:tenantId` (cache `SGDM_LIMITS_CACHE_SECONDS`). Valem só para o i7Ai; as peças do SGDM entram no orçamento da prefeitura.
- **Regra de recusa por orçamento (só End User).** Só vira recusa de orçamento da prefeitura a mensagem do gateway que começa com `ExceededBudget: End User=` (e `Rate limit exceeded for end_user` para o minuto). Budgets de chave ou de equipe não são traduzidos. A regra é a mesma nos dois repositórios (`backend/src/ai/omnirouter.service.ts` no i7Ai e `apps/api/src/modules/ia/limite-gateway.ts` no SGDM).

Mensagens de recusa (idênticas no chat, nas automações e na geração de peças):

| Situação | Mensagem |
| --- | --- |
| Orçamento do mês da prefeitura | A prefeitura atingiu o limite de IA deste mês. Fale com o administrador da plataforma. |
| Minuto da prefeitura | A prefeitura atingiu o limite de uso de IA por minuto. Aguarde um instante e tente novamente. |
| Mês do usuário | Você atingiu o seu limite de IA deste mês. Fale com o administrador da plataforma. |
| Minuto do usuário | Você atingiu o seu limite de uso de IA por minuto. Aguarde um instante e tente novamente. |

**Alertas.** A API do SGDM avalia os limites a cada `IA_ALERTAS_INTERVALO_MS` e grava alertas na Central (Visão geral e aba Limites e alertas): orçamento perto do limite, orçamento atingido, limite por minuto e uso de usuário acima de N× a média. Um alerta resolvido não volta na rodada seguinte. O e-mail sai só para quem tem a permissão `IA_CENTRAL` (dono da plataforma); a contagem de alertas abertos aparece até 100. A **cotação do dólar** (US$ para R$) também se configura nessa tela e substitui a antiga `NEXT_PUBLIC_COTACAO_USD`, que não existe mais.

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
- Faça uma conversa real com cada modelo, com e sem streaming, e um envio de imagem com GPT-4o Mini.

## Central de IA no SGDM

A Central de IA é a visão do consumo e do custo de IA de todas as prefeituras, dentro do SGDM (`/central-ia` e `/central-ia/consumo`). Só quem tem a permissão `IA_CENTRAL` vê. Ela é reservada à prefeitura da plataforma: o perfil `DONO_PLATAFORMA` já vem com ela, e um perfil da prefeitura da plataforma (por exemplo `GESTOR_IA`) pode recebê-la; perfis das demais prefeituras não podem. Qualquer outro usuário recebe 403 na API.

**De onde vêm os números.** O SGDM consulta o LiteLLM com `LITELLM_URL` e `LITELLM_ADMIN_KEY` (as duas precisam estar preenchidas; uma só desliga). O consumo e o custo saem do gasto que o próprio LiteLLM registra (`/spend/...`); a divisão por usuário, origem e conversa de uma prefeitura sai de `/spend/logs/v2`. O i7Ai grava o mesmo em `ai_usage` (tokens, tokens em cache e `costSource`: `gateway` quando vem do `x-litellm-response-cost`, `catalog` quando é calculado com os preços sincronizados do `/model/info`, de 6 em 6 horas).

**Tags em cada chamada.** Toda chamada ao gateway leva `user` = uuid da prefeitura e `metadata.tags`:

| Tag | Valor |
| --- | --- |
| `usuario:` | usuário que originou a chamada |
| `origem:` | `i7ai-chat`, `i7ai-automacao`, `sgdm-pecas` (geração de peças no SGDM) ou `sgdm-teste` (teste de chave no SGDM) |
| `conversa:` | conversa do chat (a primeira mensagem de uma conversa nova já leva a tag) |
| `agente:` | uuid do agente do i7Ai que respondeu (só chamadas do i7Ai; as peças do SGDM não têm agente) |
| `chave:` | `propria` quando a chamada levou a chave da própria prefeitura (`api_key` por requisição), `plataforma` quando usou a chave da plataforma |

Todas as tags levam só ids e valores fixos, nunca nomes de pessoas nem chaves. O teste de chave em **Cadastros › IA** do SGDM sai com `origem:sgdm-teste` e não conta como peça.

Ficam fora dessas tags por prefeitura: o teste das credenciais de provedor feito pelo i7Ai (passa pelo gateway sem `user` nem `metadata.tags`, então entra no gasto total sem prefeitura) e os embeddings da base de conhecimento (cliente próprio com `EMBEDDING_*`, sem `user` nem tags; só aparecem no gateway se `EMBEDDING_BASE_URL` apontar para ele).

As peças do SGDM passam pelo LiteLLM só se `LITELLM_URL` e `LITELLM_ADMIN_KEY` estiverem definidas, usando a chave da própria prefeitura (`api_key` por requisição) ou, sem ela, a da plataforma.

**Custo por conversa** = gasto das chamadas com tag `conversa:` ÷ número de conversas. Nas linhas do detalhamento, conversas e custo por conversa aparecem como "—" (nulo) quando não dá para calcular: quando não há uma prefeitura filtrada ao agrupar por prefeitura, usuário ou origem, e sempre ao agrupar por modelo ou provedor.

**Retenção.** Usuário, origem e conversas por prefeitura dependem dos logs do LiteLLM; se ele apagar logs antigos (retenção configurada), esses números somem do período. Os totais de gasto não dependem disso.

## Cache exato de respostas

O LiteLLM guarda respostas inteiras num Redis só de cache, o `i7ai-redis-cache`. Ele tem senha própria (`REDIS_CACHE_PASSWORD`), 200 MB, `allkeys-lru` e não grava em disco. Fica separado do `i7ai-redis` das filas BullMQ, que precisa de `noeviction`. Nunca é o Redis do SGDM.

- **Quando vale.** O modo é `default_off` (`deploy/litellm/config.yaml`), então nada é cacheado sem pedido. O backend pede `cache: { 'use-cache': true, ttl, namespace: 'i7ai:<prefeitura>' }` só em chamadas sem stream: em automações, e no chat quando a Central liga `chat`. O namespace por prefeitura foi testado no LiteLLM 1.106.4: o mesmo pedido de outra prefeitura não acerta o cache.
- **Acerto.** O LiteLLM envia `x-litellm-cache-key` só quando a resposta vem do cache. O `x-litellm-response-cost` repete o custo original, por isso o i7Ai grava `cacheHit = true` e custo 0 sem usar esse cabeçalho. Os tokens ficam na linha para medir a economia, mas saem do saldo da licença, dos tokens por minuto do usuário e dos totais do painel (contados à parte em `cacheHits`).
- **Gasto do LiteLLM.** Num acerto, `LiteLLM_SpendLogs` grava `spend = 0` e `cache_hit = True` (conferido no 1.106.4). Os números da Central, que vêm do `/spend/...`, não somam o custo de um acerto.
- **Redis fora do ar.** Com `socket_connect_timeout: 1` e `socket_timeout: 1`, a chamada segue sem cache. No teste local, as primeiras chamadas tiveram uns 2 s a mais e as seguintes, nenhum atraso.

## Próximas etapas de redução de custo

1. Ler tokens em cache no consumo e cadastrar preço de entrada em cache.
2. Dividir o prompt de sistema em parte fixa e trechos dos documentos, com `cache_control` para o Claude.
3. Resumir o histórico antigo com um modelo barato.
4. Imagens com `detail: 'low'` quando não for preciso ler detalhes.
5. Chaves virtuais do LiteLLM por prefeitura (o teto de gasto por prefeitura já existe: veja Limites e orçamento).
