# Contratos dos gateways de IA

Atualizado em 5 de outubro de 2026. Consulte [STATUS_PROJETO.md](STATUS_PROJETO.md) para o estado operacional e [CHAT_OMNIROUTER.md](CHAT_OMNIROUTER.md) para configuração, capacidades e anexos do chat.

## Escolha do adaptador

O OmniRouter é o gateway central da experiência solicitada. Usa `OMNIROUTER_BASE_URL` e `OMNIROUTER_API_KEY` exclusivamente no backend e o contrato compatível com Chat Completions: `POST <base>/chat/completions`, com `messages`, identificador do modelo, ferramentas e conteúdo multimodal quando permitido pelo catálogo.

O adaptador OmniRouter tem precedência quando qualquer uma dessas duas variáveis está preenchida; ambas precisam estar configuradas para funcionar. Configuração incompleta ou falha do OmniRouter produz erro explícito, sem troca automática para outro provedor.

Sem configuração OmniRouter, `AI_GATEWAY_URL` mantém o contrato legado descrito abaixo. Sem ambos os gateways, a integração OpenAI direta continua usando `OPENAI_API_KEY` e a Responses API. O contrato legado `/chat` não deve ser usado como se fosse o endpoint do OmniRouter. Nenhuma dessas credenciais é retornada ao navegador.

## Contrato legado `AI_GATEWAY_URL`

O backend chama `POST ${AI_GATEWAY_URL}/chat` com `Content-Type: application/json` e, se configurado, `Authorization: Bearer ${AI_GATEWAY_API_KEY}`. O gateway é uma configuração administrativa do servidor.

## Solicitação

```json
{
  "agent": {
    "id": "uuid-do-agente",
    "name": "Agente",
    "systemPrompt": "Instruções e fontes recuperadas",
    "temperature": 0.2,
    "maxTokens": 1000,
    "advancedReasoning": false
  },
  "model": "identificador-do-modelo",
  "provider": "openai",
  "message": "Pergunta",
  "history": [{"role":"user","content":"Mensagem anterior"}],
  "context": []
}
```

O histórico contém somente mensagens do usuário autenticado, da conversa/agente/prefeitura selecionados, limitado a 40 mensagens e 48 mil caracteres. `context` contém os trechos encontrados nas bases ativas vinculadas ao agente.

## Resposta final

```json
{
  "answer": "Resposta com referência [Fonte 1] quando aplicável.",
  "usage": {"inputTokens":120,"outputTokens":24}
}
```

O texto precisa ser não vazio. Os tokens devem ser números não negativos; sem eles o consumo é marcado como não medido. Esse formato JSON legado não fornece deltas: o endpoint da plataforma `/chat/stream` emite `complete` após persistir a resposta. Os adaptadores OmniRouter e OpenAI direta oferecem deltas reais quando o provedor confirma o protocolo de streaming.

## Chamadas de ferramentas

Quando o agente possui funções autorizadas, a solicitação também contém:

```json
{
  "tools": [{
    "type":"function",
    "name":"alias-recebido-do-backend",
    "description":"Descrição da função",
    "parameters":{"type":"object","properties":{}},
    "strict":false
  }],
  "toolExecution":"client",
  "toolResults":[]
}
```

O gateway pode retornar chamadas em vez da resposta final:

```json
{
  "toolCalls":[{"callId":"call-1","name":"alias-recebido-do-backend","arguments":{"consulta":"termo"}}],
  "usage":{"inputTokens":40,"outputTokens":10}
}
```

`arguments` aceita objeto ou string JSON. O backend valida o alias, argumentos, autorização atual e destino, executa a função e chama o gateway novamente com `toolResults:[{"callId":"call-1","name":"alias-recebido-do-backend","output":"resultado JSON sanitizado"}]`. O gateway deve considerar esses resultados e concluir com `answer`. IDs repetidos e funções não autorizadas são recusados; o máximo é oito chamadas/rodadas. Os tokens das rodadas são somados. O gateway não deve executar essas mesmas ferramentas por conta própria.

## Eventos para o frontend

`POST /api/agents/:id/chat` e `POST /api/agents/:id/chat/stream` recebem o mesmo DTO autenticado por JWT:

```json
{
  "message": "Analise este relatório.",
  "conversationId": "uuid-da-conversa-existente-opcional",
  "modelId": "uuid-do-modelo-do-catalogo-opcional",
  "attachmentIds": ["uuid-do-anexo-privado-processado"]
}
```

`message` é obrigatório e aceita até 16 mil caracteres. `conversationId`, `modelId` e `attachmentIds` são opcionais; os IDs devem ser UUIDs válidos. São permitidos até cinco anexos diferentes, previamente enviados a `/api/chat/attachments`, pertencentes ao usuário/prefeitura e com estado `READY`. O arquivo e sua chave de armazenamento não são recebidos nesse DTO. Sem `modelId`, uma conversa existente reutiliza seu modelo salvo; o padrão legado é o modelo principal do agente. A escolha do modelo não altera a configuração do agente.

O endpoint `/chat/stream` responde SSE:

```text
event: progress
data: {"etapa":"pesquisa_compras"}

event: delta
data: {"text":"trecho incremental"}

event: complete
data: {"answer":"resposta","conversationId":"uuid","modelId":"uuid","modelName":"Nome amigável","messages":[],"sources":[],"usage":{}}

event: error
data: {"message":"Motivo da falha"}
```

`complete` representa a confirmação de conversa, mensagens, consumo e auditoria persistidos. O payload real contém as duas mensagens novas e seus IDs. Desconectar cancela a geração; texto parcial não é salvo. Comentários heartbeat são enviados a cada 15 segundos. `progress` é informativo e traz só a etapa (`pesquisa_internet`, `pesquisa_compras`, `ferramenta` ou `documentos`), nunca argumentos ou termos pesquisados; clientes que não o conhecem o ignoram.

## Reserva de consumo

Cada rodada reserva tokens antes da requisição, sob bloqueio da prefeitura no PostgreSQL. Para texto, o cálculo usa os bytes UTF-8 do pedido, uma margem de enquadramento e o limite de saída. Com imagens no OmniRouter, a reserva usa a janela de contexto validada do modelo, sem tratar bytes base64 como tokens de texto. O contrato legado deve respeitar `agent.maxTokens`; os adaptadores aplicam o limite de saída do agente e as capacidades configuradas do modelo. Os contadores reais de cada rodada, incluindo ferramentas, continuam sendo registrados.

O consumo é persistido antes da conversa. Uma falha posterior não apaga os tokens informados. Respostas incompletas/fracassadas registram os contadores disponíveis; falta de confirmação mantém uma reserva pendente. Contadores ausentes não são substituídos por valores inventados. Recusas HTTP explícitas 400/401/402/403/404/422/429 liberam a reserva da rodada recusada sem criar consumo para ela. O HTTP 402 do OmniRouter é tratado como recusa por saldo insuficiente; eventual consumo medido em rodadas anteriores permanece registrado. Licenciamento informa o saldo reservado separadamente.

## Rotas liberadas para dados da prefeitura

O OmniRoute também expõe assinaturas pessoais, contas de ferramentas e serviços gratuitos de terceiros (`antigravity/`, `cx/`, `codex/`, `kiro/`, `auto/`, `no-think/` e outros). Esses termos de consumidor não cobrem dados municipais. Com `OMNIROUTER_BASE_URL` configurado, o i7Ai aceita somente modelos cujo identificador começa por um prefixo de `OMNIROUTER_ALLOWED_PREFIXES` (padrão `openai,anthropic,gemini,xai`), que devem corresponder a chaves de API dos provedores com termos comerciais.

A regra vale no cadastro e na edição de modelos, no catálogo do chat (modelos fora da lista não são oferecidos) e no momento da chamada, antes de reservar cota ou acessar a rede. Identificadores sem prefixo, como as combinações do gateway, são recusados. Modelos antigos fora da regra continuam visíveis aos administradores para correção.
