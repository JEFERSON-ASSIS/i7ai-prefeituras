# Chat, modelos e anexos privados

O [status do projeto](STATUS_PROJETO.md) reúne entregas, verificações e pendências operacionais. Este documento detalha o contrato e os limites do chat.

A [configuração local de 6 de outubro](OMNIROUTE_LOCAL.md) registra a conexão real ao OmniRoute, quatro modelos de GPT/Claude/Gemini, três agentes ativos, texto e visão com GPT verificados pela API, além dos resultados históricos e limites restantes.

## Análise da estrutura existente

O projeto permanece como módulo React/Vite incorporado ao SGDM, usando o pacote oficial `@sgdm/design`. O SGDM fornece sessão e navegação. O backend NestJS valida o JWT, consulta usuário/prefeitura ativos e aplica as permissões existentes. Não há autenticação nova.

`Agent`, `AiProvider`, `AiModel`, `Conversation` e `Message` já representam agentes, catálogo global e histórico. `AiGatewayService` já centralizava prompt do agente, histórico, bases vinculadas, ferramentas, streaming, quotas e consumo. Documentos já eram armazenados em S3/MinIO e processados pela fila BullMQ/Redis. Essas estruturas foram ampliadas; não existe um catálogo ou armazenamento paralelo.

## Experiência do chat

O chat oferece agente e modelo independentes, histórico geral do usuário, campo de múltiplas linhas e botão `+`. Enter envia; Shift+Enter acrescenta uma linha. A mudança de modelo vale para o próximo turno e não modifica o modelo padrão do agente. Cada resposta conserva o nome e o identificador do modelo/provedor usados.

Uma mensagem textual é obrigatória, inclusive quando há anexos. Selecionar arquivos sem escrever uma mensagem não inicia uma chamada à IA.

O histórico pertence à combinação usuário/prefeitura. A lateral lista até 100 conversas recentes. Ao reabrir uma conversa, o chat restaura agente e último modelo e exibe até 1000 mensagens recentes em ordem cronológica. Não há paginação para acessar conversas ou mensagens anteriores a esses limites pela interface; os registros anteriores continuam no banco, sujeitos à política existente de retenção. O backend recebe o prompt original do agente, histórico recente, fontes das bases vinculadas, anexos autorizados e a mensagem atual. Somente respostas concluídas e persistidas são confirmadas ao navegador; interromper a geração não salva texto parcial.

O catálogo é administrado no SGDM, em **Central de IA › Modelos e acesso**: o dono da plataforma ativa os modelos, escolhe o padrão e libera por prefeitura e por usuário. O i7Ai copia o catálogo (a cada `MODEL_SYNC_SECONDS`) e os preços e a janela de contexto vêm do LiteLLM; **Modelos** no i7Ai é só consulta. O seletor do chat mostra apenas os modelos liberados para o usuário, e um `modelId` fora da liberação recebe 403 (*"Este modelo não está liberado para você. Escolha outro no seletor do chat."*). O acesso é fechado por padrão: prefeitura sem liberação não recebe modelo. Nenhum modelo é escolhido por uma lista hardcoded no chat.

## Ativação do OmniRouter

Existem serviços distintos com esse nome. Não foi presumido um endpoint nem foram inventados IDs de modelos. Informe a URL oficial da conta e configure exclusivamente o ambiente do backend:

```dotenv
OMNIROUTER_BASE_URL=https://endereco-oficial-do-seu-gateway/v1
OMNIROUTER_API_KEY=credencial-fornecida-pelo-servico
```

O adaptador chama `POST <base>/chat/completions` usando Bearer, `messages`, `model`, `max_tokens` e, no streaming, `stream_options.include_usage`. A base deve incluir o prefixo exigido pelo serviço. HTTPS é obrigatório em produção. HTTP somente em localhost no desenvolvimento. A chave não é enviada ao frontend nem retornada pelo catálogo. Os exemplos de ambiente permanecem vazios e os arquivos `.env` reais são ignorados pelo Git.

Consulte o catálogo de modelos habilitados na sua conta (`GET <base>/models`, quando documentado pelo serviço) e ative os IDs exatos na Central de IA do SGDM (**Modelos e acesso**), com nomes como GPT, Claude e Gemini. Preços ausentes permanecem não configurados. Não reutilize o identificador de outro gateway sem verificar.

Capacidades por modelo: visão e ferramentas precisam ser explicitamente habilitadas quando suportadas pelo serviço e modelo. Temperatura só é enviada quando declarada compatível. Janela de contexto e limite de resposta podem ser cadastrados em tokens; o servidor limita o histórico por um orçamento conservador de bytes UTF-8 e rejeita solicitações cujo conteúdo fixo excede o contexto configurado, incluindo definições/resultados de ferramentas em cada rodada. Imagens exigem janela de contexto cadastrada e reservam temporariamente essa janela completa na quota, evitando contar bytes base64 como tokens. O consumo exibido continua vindo dos contadores do provedor. O modo de intensidade de raciocínio avançado não é enviado enquanto seu contrato não for validado no serviço escolhido; o backend informa essa incompatibilidade.

Quando configurado, OmniRouter tem precedência para todas as famílias de modelos. Os adaptadores anteriores foram preservados para ambientes existentes. `AI_GATEWAY_URL` continua sendo um contrato próprio `/chat` e não deve receber uma URL OmniRouter OpenAI-compatible. Embeddings mantêm sua configuração separada.

Consumo: quando `prompt_tokens` e `completion_tokens` estão completos e o gateway informa `total_tokens`, o adaptador preserva esse total e registra como saída `total_tokens - prompt_tokens`. Isso inclui consumo adicional informado somente no total, sem somar detalhes de cache/raciocínio novamente. A ausência de um contador mantém o consumo sem confirmação; totais contraditórios ou inválidos são recusados com reserva conservadora. Os tokens adicionais não recebem uma classificação de raciocínio inferida.

## Anexos

Documentos: PDF, TXT, CSV, XLSX, DOCX, MD, JSON, XML e HTML, com os extratores existentes. PDF digitalizado mantém OCR local em português. Imagens: PNG, JPG/JPEG e WEBP estático, enviadas como conteúdo multimodal apenas com OmniRouter, visão habilitada e janela de contexto cadastrada no modelo. WEBP animado, XLS, ZIP, áudio e vídeo retornam erro de formato não suportado; não são apresentados como processamento disponível. Visão com GPT-4o Mini foi validada no i7Ai com a conta real. A análise com os demais modelos ainda não foi exercitada; Claude/Gemini esbarram na janela reservada maior que a licença local, conforme [resultados](OMNIROUTE_LOCAL.md).

São aceitos até cinco anexos por turno, até 20 MB por documento e 10 MB por imagem. `CHAT_ATTACHMENT_MAX_BYTES` pode reduzir o limite de documentos. Imagens têm limite de 8192 pixels por lado e 16 milhões de pixels. O backend valida extensão, MIME, conteúdo, nome, tamanho, estrutura Office e decodificação de imagens. Arquivos não são executados nem publicados como URLs públicas.

Anexos são `Document` privados, com proprietário e `chatOnly=true`, associados a mensagens por `MessageAttachment`. Reutilizam bucket, cliente S3, fila e quotas de armazenamento. Não aparecem na área compartilhada Documentos, em bases de conhecimento, consultas internas ou RAG. Cada consulta, download, exclusão e uso na IA verifica prefeitura e proprietário. Conteúdo privado não gera embeddings. O navegador aguarda o processamento antes de enviar a mensagem.

Até cinco arquivos únicos são reautorizados nos próximos turnos: os anexos atuais têm prioridade, seguidos dos anexos das últimas 40 mensagens, dos mais recentes aos mais antigos. A validação de imagens no navegador acompanha esse mesmo conjunto. O texto extraído tem limite total de 48 mil caracteres, com aviso explícito de truncamento no contexto enviado ao modelo. Um arquivo associado a uma mensagem não pode ser apagado isoladamente pela seleção de anexos. Arquivos privados sem mensagens, com mais de 24 horas, são limpos do S3 e do banco; essa rotina também remove órfãos após a retenção das conversas, liberando a quota.

## Migration e APIs

A migration `20261005000100_chat_models_attachments` é aditiva: modelo opcional na conversa, capacidades opcionais no catálogo, escopo/proprietário no documento e vínculos arquivo–mensagem. Conversas antigas e documentos compartilhados conservam seus dados. Aplique em cada destino com `cd backend` e `npm run prisma:deploy`; não use reset de banco.

- `GET /api/chat/catalog`: agentes ativos da prefeitura e catálogo de modelos, protegido por `agents:execute`.
- `POST /api/chat/attachments`: multipart com `file`.
- `GET /api/chat/attachments/capabilities`: formatos/limites do servidor.
- `GET /api/chat/attachments/:id`: estado e metadados seguros.
- `GET /api/chat/attachments/:id/download`: download autorizado.
- `DELETE /api/chat/attachments/:id`: remove arquivo ainda sem vínculo.
- `POST /api/agents/:id/chat[/stream]`: `{message, conversationId?, modelId?, attachmentIds?}`.
- `/api/conversations`: histórico existente ampliado com modelo/anexos seguros.

As rotas de anexos usam `agents:execute`; usuários de chat não precisam receber permissão de administrar documentos compartilhados. Metadados públicos não contêm `storageKey`, chave de provedor ou proprietário de arquivo.

As permissões existentes são definidas por perfil, recurso e prefeitura. Não há ACL individual por agente nem restrição automática pelo departamento do usuário.

Desde a correção local de 6 de outubro de 2026, o catálogo, a interface e `AiGatewayService.generate` exigem agentes `ACTIVE`. Chamadas diretas ao chat, streaming e `executeAgent` recusam rascunhos e agentes arquivados antes de consultar bases/ferramentas, reservar tokens, chamar o provedor ou persistir respostas. Rascunhos retornam a orientação para ativar o agente nas configurações. Consulte o [status do projeto](STATUS_PROJETO.md#p06--alinhamento-da-regra-de-agentes-ativos).

## Verificação

Testes de backend cobrem seleção/restauração de modelo, snapshots, autorização de arquivos, validação de conteúdo, S3/quotas, limpeza, contexto, SSE real, cancelamento, erros e ferramentas. Testes no navegador cobrem catálogo, mudança de modelo, histórico, composição de mensagem, anexos e interrupção em desktop/celular. O harness integrado usa PostgreSQL, Redis e MinIO locais, schema e filas exclusivos e gateway simulado; inclui isolamento entre usuários/prefeituras e anexo passando por upload, processamento, mensagem e histórico.

```sh
npm run build
npm run audit:design
npm test
npm run test:visual
cd backend
npm run prisma:generate
npm run build
npm test
npm run test:integration
```

Os testes não consomem créditos de IA. A chamada real e as capacidades multimodais continuam dependendo da confirmação do serviço, dos modelos habilitados e da credencial configurada no servidor.

### Resultados locais em 5 de outubro de 2026

- Builds frontend/backend, quatro testes do consumidor SSE e auditoria SGDM aprovados: 18 arquivos e 241 usos de componentes oficiais.
- Suite completa do backend: 166 testes aprovados. Após reforçar a validação de arquivos Office, os 28 testes de anexos/extratores passaram, incluindo o novo caso de XLSX com tamanhos adulterados. Os oito testes finais de seleção/histórico passaram, incluindo uma conversa com mais de 1000 mensagens que conserva o turno e anexo mais recentes ao reabrir.
- Suite completa de interface: 39 testes aprovados. Verificação final do chat: 15 testes aprovados, incluindo dois novos cenários de imagens que saíram do contexto. São 41 cenários distintos de interface verificados.
- Integração com PostgreSQL, Redis e MinIO locais aprovada, com cinco chamadas ao gateway simulado, processamento de anexo e isolamento entre usuários/prefeituras. O schema, as filas e os arquivos sintéticos foram removidos ao concluir.
- Banco de desenvolvimento `localhost:5432/i7ai`, schema `public`: migrations pendentes aplicadas com `prisma migrate deploy`, total de seis aplicadas e nenhuma pendente. Backup custom do PostgreSQL validado e preservado em `output/backup` (ignorado pelo Git). A comparação de 30 tabelas confirmou IDs e hashes de todas as colunas anteriores preservados; documentos antigos continuam compartilhados. A única adição de dados foi o cadastro de Anthropic e Google. Nenhum seed ou provisionamento foi executado nessa atualização.
- 115 capturas na [galeria SGDM](../output/verification/sgdm/index.html). O [relatório Playwright](../output/verification/sgdm/playwright-report/index.html) corresponde à última execução focada de 15 testes.

As credenciais e a API real OmniRouter não estavam configuradas; essa validação não afirma acesso aos modelos reais da conta.

A implementação no commit `701412c` também teve [CI aprovado no GitHub](https://github.com/cristhyna-lucena/i7ai-prefeituras/actions/runs/37360216695). Esse resultado não substitui a validação com a conta OmniRouter e o SGDM reais.
