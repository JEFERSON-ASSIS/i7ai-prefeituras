# i7Ai · Plataforma de IA para Prefeituras

Frontend React/Vite com o design system oficial `@sgdm/design` e API NestJS. Agentes, conversas, documentos, ferramentas e automações usam PostgreSQL. BullMQ/Redis executam o processamento e as rotinas; S3/MinIO armazena os arquivos.

O preset, os tokens e os componentes do SGDM são usados sem sobrescritas visuais locais. Veja a [validação do design system](docs/VALIDACAO_SGDM.md), com escopo, testes e capturas de desktop e celular.

O [estado do projeto e pendências](docs/STATUS_PROJETO.md) reúne todos os pedidos e as verificações locais de 5 e 6 de outubro de 2026: GitHub público, acesso de JEFERSON-ASSIS, chat, modelos, OmniRouter, SGDM, implantação e limites. A IA local responde com GPT-4o Mini, GPT 5.6 Luna (Low), Claude e Gemini; visão com GPT-4o Mini também foi verificada. Integração ao SGDM e implantação no destino continuam pendentes.

Atualização local em 6 de outubro: [OmniRoute conectado com GPT, Claude e Gemini](docs/OMNIROUTE_LOCAL.md), com Assistente da Prefeitura e agentes de Licitações e Contratos ativos. Respostas reais, streaming, histórico, consumo e visão com GPT foram verificados pela API. As demais capacidades ainda não exercitadas e a integração operacional continuam pendentes.

## Desenvolvimento local

Requisitos: Node.js 24, npm, Git e Docker Compose. A dependência pública `@sgdm/design` está fixada na referência `v0.2.1`.

1. Copie `.env.example` para `.env` e configure as variáveis. Preserve seu `.env` existente.
2. Inicie a infraestrutura: `docker compose up -d`.
3. No MinIO em `http://localhost:9001`, crie o bucket privado `i7ai-documents`. O Compose local usa credenciais de desenvolvimento; o Compose de produção cria bucket e conta da aplicação automaticamente.
4. Instale e inicie a API:

```sh
npm ci --include=optional
cd backend
npm ci --include=optional
npm run prisma:generate
npm run prisma:deploy
npm run prisma:seed
npm run dev
```

5. Em outro terminal, na raiz: `npm run dev`.

O frontend usa `http://localhost:5173`; a API usa `http://localhost:3000/api`. Ajuste `VITE_API_URL`, `PORT` e `CORS_ORIGINS` ao usar outras portas/origens. `/api/health` verifica banco, fila e bucket.

O i7Ai funciona como módulo incorporado no SGDM, sem login próprio. O SGDM fornece sessão, menu e cabeçalho. O seed cria identidades de desenvolvimento para mapear os IDs do JWT do SGDM; ele não habilita um endpoint de login. Alterações de catálogo global e licenças exigem `SUPER_ADMIN`.

Para revisar o visual sem conectar uma prefeitura, abra `http://localhost:5173/preview/sgdm.html` com o servidor de desenvolvimento ativo. Essa prévia simula o host usando os componentes oficiais e dados fictícios; alterações e chamadas de IA estão desabilitadas. Ela não faz parte do build de produção.

O host de desenvolvimento em `preview/local.jsx` apresenta o site completo com o menu SGDM e as 16 áreas usando a API real, sem a faixa superior adicional. No celular, um seletor oficial permite navegar e um botão permite sair. Ele recebe uma sessão fornecida pelo ambiente local, respeita as permissões retornadas pela API e permite alterações. Só funciona no servidor de desenvolvimento em `localhost` ou `127.0.0.1`; o ponto de entrada de produção continua integrado ao SGDM. Durante a revisão local, o servidor específico de acesso usa `http://127.0.0.1:5173/`, com configuração e sessão temporária em `output/preview-server/`, ignorado pelo Git.

Para testar a plataforma real sem depender do SGDM durante o desenvolvimento, execute `npm run local:session` na raiz e abra `http://127.0.0.1:5173/preview/local.html`. A sessão temporária expira em oito horas e deve ser gerada novamente quando necessário. O comando recusa produção, usa um usuário ativo do banco local e grava o JWT somente em `output/preview-server/`, ignorado pelo Git. Se houver mais de um usuário ativo, defina `LOCAL_PREVIEW_USER_EMAIL` no `.env`. A página `preview/sgdm.html` continua sendo apenas a prévia com dados fictícios e chamadas de IA desabilitadas.

## Fluxo funcional

1. Cadastre departamentos e confira os modelos disponíveis.
2. Crie uma base e envie documentos. Aguarde **Processado**; erros de extração aparecem na tabela.
3. Configure um agente com instruções, modelo principal, bases e ferramentas. Ative-o antes de conversar ou executar: a interface e a API exigem agente `ACTIVE`, inclusive em streaming e automações.
4. Abra o agente no chat. Conversas e fontes são persistidas por usuário e prefeitura. O streaming confirma o salvamento ao concluir; respostas parciais interrompidas não entram no histórico.
5. Crie uma automação com etapas de agente ou ferramenta HTTP. Execute manualmente ou cadastre cron com fuso horário. Acompanhe estado, resultado, erro e duração em Execuções.
6. Consulte consumo e auditoria em Relatórios; limites, alertas e licenças ficam na Central de IA do SGDM (veja [docs/LITELLM.md](docs/LITELLM.md)).

O servidor verifica limites de usuários, agentes, bases, automações e armazenamento. Cada rodada de IA reserva saldo sob bloqueio da prefeitura no PostgreSQL antes da chamada, considerando consumo e reservas simultâneas. Contadores do provedor são registrados mesmo em respostas incompletas ou falhas. Interrupções sem contadores mantêm uma reserva pendente; o sistema não apresenta estimativas como consumo medido. O gateway deve respeitar `maxTokens`.

## IA e documentos

O chat permite escolher agente e modelo separadamente, reabrir o histórico e enviar anexos privados. A integração central OmniRouter usa `OMNIROUTER_BASE_URL` e `OMNIROUTER_API_KEY` somente no backend. Os modelos são cadastrados no catálogo existente com os identificadores da conta do gateway. O gateway recomendado é o LiteLLM na mesma VPS, com chaves próprias da OpenAI e da Anthropic; veja [LiteLLM como gateway de IA](docs/LITELLM.md). Consulte a [implementação e configuração do chat](docs/CHAT_OMNIROUTER.md), incluindo migration aditiva, formatos suportados e capacidades por modelo.

Em ambientes anteriores sem OmniRouter, `OPENAI_API_KEY` mantém a Responses API com o modelo selecionado. Raciocínio avançado exige modelo compatível. Preços são cadastrados pelo administrador da plataforma, em USD por milhão de tokens; preços ausentes aparecem como não configurados.

O contrato legado `AI_GATEWAY_URL` também permanece disponível quando OmniRouter não estiver configurado. O backend envia `POST <gateway>/chat` com agente, modelo, provedor, mensagem, histórico e contexto. A resposta deve conter `answer` e, para consumo medido, `usage.inputTokens`/`usage.outputTokens`. Esse contrato JSON entrega a resposta completa; os adaptadores OmniRouter e OpenAI oferecem streaming incremental. Veja o [contrato do gateway e ferramentas](docs/GATEWAY.md).

Há extração real de PDF, DOCX, XLSX, TXT, MD, CSV, JSON, XML e HTML, com limite padrão de 50 MB e processamento em fila. Páginas de PDF sem texto passam por OCR local em português; o modelo acompanha as dependências e os documentos não são enviados a um serviço externo de OCR. PDFs mistos preservam as páginas com texto. Cada arquivo admite até 20 páginas que precisem de OCR, com limite de imagem e tempo; digitalizações ilegíveis geram erro de processamento. Com `EMBEDDING_API_KEY` ou `OPENAI_API_KEY`, o pipeline gera embeddings de 1.536 dimensões e pesquisa semântica nas bases ativas vinculadas ao agente. Sem esse provedor, a pesquisa usa termos literais. A indexação pode gerar cobrança do provedor configurado.

## Ferramentas e MCP

HTTP, REST, webhook e n8n executam requisições reais. Cada ferramenta declara os domínios permitidos. O servidor valida DNS/IP e bloqueia destinos privados e redirecionamentos em produção. Credenciais usam `env:TOOL_SECRET_NOME`, definido no ambiente do backend; valores de segredos não aparecem no cadastro nem nas respostas.

MCP usa Streamable HTTP com inicialização, descoberta e chamada. Somente ferramentas ativas vinculadas ao agente podem executar. Argumentos MCP são validados por JSON Schema draft-07; cada chamada revalida a autorização. Há um limite de oito chamadas/rodadas por resposta. MCP stdio/SSE legado não faz parte desta versão.

`INTERNAL_DATABASE` consulta documentos processados e bases vinculadas ao agente, departamentos ou agentes da mesma prefeitura, com campos permitidos e sem SQL livre ou credenciais. `EXTERNAL_SEARCH` consulta uma API de pesquisa autorizada, recebe `results` ou `web.results`, limita os resultados e sanitiza as respostas. Ambos usam argumentos `{query, limit?}` e revalidam o vínculo antes de executar. Veja [operação e configuração](docs/FINALIZACAO.md).

## Retenção

Sem prazo explícito em Configurações, a limpeza fica desativada. Um prazo salvo ativa a rotina diária: conversas vencidas são removidas com suas mensagens; entradas, saídas e erros de execuções encerradas são limpos, mantendo status e horários. Cadastros, documentos, auditoria, consumo e reservas são preservados. O campo pode ser limpo para desativar a rotina. A primeira verificação ocorre um minuto após iniciar a API; cada prefeitura usa seu próprio prazo e lotes de até 500 registros por tipo.

## Integração com SGDM

Antes de montar o frontend, injete:

```js
window.__SGDM_CONTEXT__ = {
  accessToken: 'jwt-assinado-pelo-sgdm',
  tenantName: 'Prefeitura',
  organizationName: 'SGDM',
  modulePage: 'dashboard',
  navigationManagedByHost: true
};
window.dispatchEvent(new Event('sgdm:context-updated'));
```

O JWT deve usar HS256 e conter `sub` e `tenantId` como UUIDs de usuário e prefeitura cadastrados no i7Ai. A assinatura usa `SGDM_JWT_SECRET` (ou `JWT_SECRET` quando não houver segredo separado); issuer/audience podem ser exigidos por configuração. Usuário, prefeitura e permissões ativos são consultados no banco. Nomes e perfis enviados pelo navegador não concedem acesso.

O host altera `modulePage` e dispara `sgdm:context-updated` para trocar a tela; o mesmo evento atualiza uma sessão renovada. O módulo não altera o hash nem a URL do SGDM. A navegação interna emite `i7ai:navigate` com `detail.page`, para o host sincronizar seu menu. A ausência ou expiração de sessão emite `i7ai:session-required` com `detail.reason` (`missing`, `expired` ou `refresh`); o SGDM conduz a autenticação ou renovação.

Não existe `POST /api/auth/login` nem formulário de credenciais no módulo. Tokens legados com issuer `i7ai-local` são recusados. O endpoint protegido `GET /api/auth/me` valida a sessão fornecida pelo SGDM. O menu e o cabeçalho pertencem ao host; `navigationManagedByHost: false` habilita apenas um seletor oficial de áreas para revisão isolada.

## Verificação

```sh
npm run build
node --test test/event-stream.test.mjs
cd backend
npm run build
npm test
npm run test:integration
```

Os testes unitários usam serviços simulados e fixtures de formatos/protocolos. O teste integrado requer PostgreSQL/pgvector, Redis e MinIO; cria schema e filas exclusivos, inicia API/gateway simulados próprios e limpa seus dados. Não usa credenciais de IA pagas. As portas 3001/3002 devem estar livres. Veja [resultados e pendências](docs/FINALIZACAO.md).

## Produção

Dockerfiles, Nginx e `docker-compose.production.yml` estão preparados. O repositório já está público no GitHub, com workflow de CI executado em pushes e pull requests. A [verificação do commit de implementação do chat](https://github.com/cristhyna-lucena/i7ai-prefeituras/actions/runs/37360216695) passou nos jobs frontend/backend. A implantação no destino permanece pendente.

Copie `deploy/.env.production.example` para `deploy/.env.production`. Preencha segredos, endereços e imagens MinIO aprovadas, fixadas em tag/digest. URLs de banco/Redis devem apontar para os serviços `postgres`/`redis`, com caracteres especiais das credenciais codificados.

```sh
docker compose --env-file deploy/.env.production -f docker-compose.production.yml config --quiet
docker compose --env-file deploy/.env.production -f docker-compose.production.yml up -d --build
```

A API aguarda migrations e provisionamento do bucket. Banco, Redis, MinIO e API não publicam portas. O frontend atende em `127.0.0.1:8080`, para um proxy TLS do servidor. Builds Linux foram aprovados localmente, com OCR offline e frontend Nginx sem root; a implantação no destino ainda não foi realizada. Configure domínio, HTTPS, backups com restauração verificada e monitoramento antes do acesso externo. A vinculação ao SGDM real permanece para a etapa final combinada.

### Primeira prefeitura e administrador

O seed demonstrativo recusa produção. Use `backend/scripts/provision.cjs`, fornecendo as variáveis de `deploy/.env.provision.example` pelo ambiente administrativo/gerenciador de segredos, com `DATABASE_URL` do destino:

```sh
cd backend
npm run provision
```

O script exige nome/slug da prefeitura e nome/e-mail do administrador, sem senha local. Preserva identidades, perfis, licenças e hashes legados existentes. `PROVISION_PLATFORM_ADMIN=true` concede `SUPER_ADMIN` somente a usuário novo. `PROVISION_CREATE_LICENSE=true` exige todos os limites. O resultado retorna IDs; a vinculação desses IDs ao SGDM fica para a etapa final de integração.

`PROVISION_MODEL_SLUG` cria opcionalmente um modelo OpenAI sem preços inventados. Execute no ambiente administrativo com acesso ao banco/container. Não publique arquivos com senhas. `TOOL_SECRET_*` precisa ser fornecido explicitamente ao container backend ou por um override de secrets.

## Referência visual

A imagem de apresentação fica em [i7ai-projeto.png](i7ai-projeto.png). O frontend implementa o tema SGDM e os fluxos descritos acima.
