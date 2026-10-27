import { BadGatewayException, BadRequestException, HttpException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { AgentFunction, AgentToolCall, AgentToolsService } from './agent-tools.service';
import { AiQuotaService, QuotaScope, QuotaUsage, usageCost } from './ai-quota.service';
import { gatewayBaseAllowed, isAllowedRoute, routePolicyMessage } from '../catalog/model-route-policy';
import { TenantAiKeyService } from './tenant-ai-key.service';
import { LIMIT_MESSAGES } from './limit-messages';
import type { OtimizacaoEfetiva } from '../sgdm/optimization-defaults';
import { SplitInstructions, joinedInstructions, neutralizeTags } from './instructions';
import { historyWindow } from './history-summary';

export type OmniRouterInput = {
  agent: { id: string; tenantId: string; systemPrompt?: string | null; temperature: unknown; maxTokens: number; advancedReasoning: boolean };
  model: { slug: string; capabilities?: unknown; provider?: { config?: unknown } };
  /** Stable part (agent prompt + rules) and per-message part (document snippets + conversation files). */
  instructions: SplitInstructions;
  /** Conversation summary, sent as a second system message when present. */
  summary?: string;
  message: string;
  history: { role: string; content: string }[];
  /** True when no message was left out of `history` (or a summary covers them); only then is its end marked for caching. */
  historyComplete: boolean;
  images?: { name: string; mimeType: string; dataUrl: string }[];
  functions: AgentFunction[];
  userId?: string;
  origin: 'i7ai-chat' | 'i7ai-automacao' | 'i7ai-resumo';
  conversationId?: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  quotaScope: QuotaScope;
  /** Optimization settings from SGDM (or the defaults), read once per call by the gateway. */
  optimization: OtimizacaoEfetiva;
  /** True when the platform output cap (not the agent or the model) is what bounds max_tokens. */
  outputCapApplied?: boolean;
  /** Estimated prompt tokens the conversation summary saved; the history is resent every round, so each row carries it. */
  historySavedTokens?: number;
};

export type OmniRouterAnswer = {
  answer: string; inputTokens: number; outputTokens: number; measured: boolean;
  /** Sum of the per-round costs recorded in ai_usage (gateway cost when present, otherwise catalog). */
  cost: number;
  toolCalls: { callId: string; name: string }[];
};

type JsonObject = Record<string, unknown>;
type ChatToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown; tool_calls?: ChatToolCall[]; tool_call_id?: string };
type ChatRound = { content: string; calls: ChatToolCall[]; finishReason: string; usage: QuotaUsage };
type UsageReporter = (usage: QuotaUsage) => Promise<void>;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
export const OUTPUT_LIMIT_MESSAGE = 'A resposta passou do limite de tamanho definido pela plataforma para este agente. Peça uma resposta mais curta ou fale com o administrador.';
/** Bounded input estimate per attached image, above what current vision models bill for one image. */
export const IMAGE_TOKEN_ALLOWANCE = 16_384;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function capability(value: unknown, name: string): boolean | undefined {
  const field = object(value)?.[name];
  return typeof field === 'boolean' ? field : undefined;
}
function protocolError(message = 'O OmniRouter retornou uma resposta inválida.'): BadGatewayException {
  return new BadGatewayException(message);
}
function tokenCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw protocolError('O OmniRouter retornou contadores de consumo inválidos.');
  return value;
}
function usageFrom(value: unknown): QuotaUsage {
  if (value === undefined || value === null) return { inputTokens: 0, outputTokens: 0, measured: false };
  const usage = object(value);
  if (!usage) throw protocolError('O OmniRouter retornou contadores de consumo inválidos.');
  const inputTokens = tokenCount(usage.prompt_tokens); const outputTokens = tokenCount(usage.completion_tokens);
  const measured = typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number';
  let totalTokens: number | undefined;
  if (usage.total_tokens !== undefined) {
    if (typeof usage.total_tokens !== 'number') throw protocolError('O OmniRouter retornou contadores de consumo inválidos.');
    totalTokens = tokenCount(usage.total_tokens);
    if (totalTokens < inputTokens + outputTokens) throw protocolError('O OmniRouter retornou contadores de consumo inválidos.');
  }
  const details = usage.prompt_tokens_details;
  if (details !== undefined && details !== null && !object(details)) throw protocolError('O OmniRouter retornou contadores de consumo inválidos.');
  const cachedInputTokens = tokenCount(object(details)?.cached_tokens);
  // LiteLLM reports written cache tokens at the top level (Anthropic) and mirrors them in the details;
  // prompt_tokens already includes both read and written tokens, so they are never added again.
  const written = usage.cache_creation_input_tokens ?? object(details)?.cache_creation_tokens ?? object(details)?.cache_write_tokens;
  const cacheWriteInputTokens = tokenCount(written);
  if (cachedInputTokens + cacheWriteInputTokens > inputTokens) throw protocolError('O OmniRouter retornou contadores de consumo inválidos.');
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    // Some gateways include additional output tokens only in the total. Keep
    // that consumption without inferring missing prompt/completion counters.
    outputTokens: measured && totalTokens !== undefined ? totalTokens - inputTokens : outputTokens,
    measured,
  };
}
function functionCall(value: unknown): ChatToolCall {
  const call = object(value); const fn = object(call?.function);
  if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 200 ||
      typeof fn?.name !== 'string' || !fn.name || fn.name.length > 200 || typeof fn.arguments !== 'string' || fn.arguments.length > 32000) {
    throw protocolError('O OmniRouter retornou uma chamada de ferramenta inválida.');
  }
  return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
}

@Injectable()
export class OmniRouterService {
  constructor(private readonly agentTools: AgentToolsService, private readonly quota: AiQuotaService, @Optional() private readonly tenantKeys?: TenantAiKeyService) {}

  async generate(input: OmniRouterInput): Promise<OmniRouterAnswer> {
    input.signal?.throwIfAborted();
    const endpoint = this.endpoint();
    const apiKey = process.env.OMNIROUTER_API_KEY?.trim();
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new ServiceUnavailableException('Configure OMNIROUTER_API_KEY no servidor para usar o OmniRouter.');
    if (!input.model.slug?.trim()) throw new BadRequestException('Selecione um modelo válido no catálogo.');
    if (!isAllowedRoute(input.model.slug)) throw new BadRequestException(routePolicyMessage(input.model.slug));
    if (input.agent.advancedReasoning) {
      // Model reasoning capability alone does not specify a gateway parameter
      // for changing reasoning intensity. Do not silently ignore this setting.
      throw new BadRequestException('O modo de raciocínio avançado ainda não possui um contrato validado no OmniRouter. Desative essa opção no agente.');
    }
    if (input.images?.length && capability(input.model.capabilities, 'supportsVision') !== true) {
      throw new BadRequestException('O modelo selecionado não tem processamento de imagens habilitado no catálogo.');
    }
    const configuredWindow = object(input.model.capabilities)?.contextWindow;
    const contextWindow = typeof configuredWindow === 'number' && Number.isSafeInteger(configuredWindow) && configuredWindow >= 4096 && configuredWindow <= 2_000_000 ? configuredWindow : undefined;
    const hasImages = Boolean(input.images?.length);
    if (hasImages && !contextWindow) {
      throw new BadRequestException('Configure uma janela de contexto válida em Modelos antes de analisar imagens com este modelo.');
    }
    if (input.functions.length && capability(input.model.capabilities, 'supportsTools') !== true) {
      throw new BadRequestException('O modelo selecionado não tem chamadas de ferramentas habilitadas no catálogo.');
    }
    if (!Number.isSafeInteger(input.agent.maxTokens) || input.agent.maxTokens < 1) throw new BadRequestException('O limite de resposta do agente é inválido.');
    const supportsTemperature = capability(input.model.capabilities, 'supportsTemperature') ?? capability(input.model.provider?.config, 'supportsTemperature') ?? false;
    const temperature = Number(input.agent.temperature);
    if (supportsTemperature && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new BadRequestException('A temperatura do agente deve estar entre 0 e 2.');
    // The prefeitura's own key from SGDM, sent only on the wire (never in the quota or logs).
    const providerKey = await this.tenantKeys?.forModel(input.agent.tenantId, input.model.slug);
    const messages = this.messagesFor(input);
    const usedCalls: { callId: string; name: string }[] = [];
    let inputTokens = 0; let outputTokens = 0; let measured = true; let cost = 0;
    for (let round = 0; round < 8; round++) {
      input.signal?.throwIfAborted();
      const request = {
        model: input.model.slug, messages, max_tokens: input.agent.maxTokens,
        ...(supportsTemperature ? { temperature } : {}),
        ...(input.functions.length ? { tools: input.functions.map(({ definition }) => ({
          type: 'function', function: { name: definition.name, description: definition.description, parameters: definition.parameters, strict: definition.strict },
        })), parallel_tool_calls: false } : {}),
        stream: Boolean(input.onDelta), ...(input.onDelta ? { stream_options: { include_usage: true } } : {}),
      };
      // Schemas and tool results grow the transcript across rounds. Count every
      // textual field before each paid call; image bytes are not text tokens.
      if (contextWindow && this.textInputUpperBound(request) + input.agent.maxTokens > contextWindow) {
        throw new BadRequestException('A mensagem, os anexos, o histórico e as ferramentas excedem o contexto configurado para este modelo. Reduza o conteúdo ou escolha um modelo com contexto maior.');
      }
      // Vision accounting is model-specific and base64 bytes are not tokens. Reserve
      // the text bound plus a fixed allowance per image, capped by the catalog window:
      // reserving the whole window would refuse every image chat on 1M-context models.
      const inputUpperBound = hasImages
        ? Math.min(contextWindow! - input.agent.maxTokens, this.textInputUpperBound(request) + input.images!.length * IMAGE_TOKEN_ALLOWANCE)
        : undefined;
      const generated = await this.quota.runRound(input.quotaScope, request, input.agent.maxTokens, record => this.round(endpoint, apiKey, request, input, record, providerKey), inputUpperBound);
      input.signal?.throwIfAborted();
      inputTokens += generated.usage.inputTokens; outputTokens += generated.usage.outputTokens; measured = measured && generated.usage.measured;
      cost = Number((cost + usageCost(input.quotaScope, generated.usage).cost).toFixed(6));
      if (inputTokens > 2_147_483_647 || outputTokens > 2_147_483_647) throw protocolError('O consumo acumulado do OmniRouter excedeu o limite permitido.');
      this.validateFinish(generated, input);
      if (!generated.calls.length) {
        const answer = generated.content.trim();
        if (!answer) throw protocolError('O OmniRouter retornou uma resposta sem texto.');
        return { answer, inputTokens, outputTokens, measured, cost, toolCalls: usedCalls };
      }
      if (round === 7 || usedCalls.length + generated.calls.length > 8) throw protocolError('O agente atingiu o limite de oito chamadas/rodadas de ferramentas sem concluir a resposta.');
      const roundIds = new Set<string>();
      for (const call of generated.calls) {
        if (roundIds.has(call.id) || usedCalls.some(item => item.callId === call.id)) throw protocolError('O OmniRouter repetiu um identificador de chamada de ferramenta.');
        roundIds.add(call.id);
        if (!input.functions.some(item => item.definition.name === call.function.name)) throw protocolError('O OmniRouter solicitou uma ferramenta que não está vinculada a este agente.');
      }
      messages.push({ role: 'assistant', content: generated.content || null, tool_calls: generated.calls });
      for (const call of generated.calls) {
        input.signal?.throwIfAborted();
        const localCall: AgentToolCall = { callId: call.id, name: call.function.name, arguments: call.function.arguments };
        const result = await this.agentTools.execute(input.agent.tenantId, input.agent.id, localCall, input.functions, input.userId, input.signal);
        input.signal?.throwIfAborted();
        usedCalls.push({ callId: call.id, name: call.function.name });
        messages.push({ role: 'tool', tool_call_id: result.callId, content: result.output });
      }
    }
    throw protocolError('O OmniRouter não concluiu a resposta dentro do limite de rodadas.');
  }

  private endpoint(): string {
    const configured = process.env.OMNIROUTER_BASE_URL?.trim();
    if (!configured) throw new ServiceUnavailableException('Configure OMNIROUTER_BASE_URL no servidor com a URL oficial da sua conta OmniRouter.');
    let base: URL;
    try { base = new URL(configured); } catch { throw new ServiceUnavailableException('OMNIROUTER_BASE_URL deve ser uma URL válida.'); }
    if (!gatewayBaseAllowed(base)) {
      throw new ServiceUnavailableException('OMNIROUTER_BASE_URL deve usar HTTPS, sem credenciais ou parâmetros na URL. HTTP é permitido somente para localhost no desenvolvimento ou serviços internos em OMNIROUTER_INTERNAL_HOSTS.');
    }
    return configured.replace(/\/+$/, '') + '/chat/completions';
  }

  private history(history: OmniRouterInput['history']): ChatMessage[] {
    return historyWindow(history).map(item => ({ role: item.role as 'user' | 'assistant', content: item.content }));
  }

  private textInputUpperBound(request: { messages: ChatMessage[] }): number {
    const messages = request.messages.map(message => ({ ...message, content: Array.isArray(message.content)
      ? message.content.map(part => object(part)?.type === 'image_url' ? { type: 'image_url', image_url: { detail: object(object(part)?.image_url)?.detail } } : part)
      : message.content,
    }));
    return Buffer.byteLength(JSON.stringify({ ...request, messages }), 'utf8') + 2048;
  }

  private messagesFor(input: OmniRouterInput): ChatMessage[] {
    const history = this.history(input.history);
    // Off: exactly the layout before prompt caching (one system string with the sources inline).
    if (!input.optimization.cachePrompt.ligado) {
      return [{ role: 'system', content: joinedInstructions({ ...input.instructions, variable: neutralizeTags(input.instructions.variable, ['fontes_e_arquivos']) }) },
        ...(input.summary ? [{ role: 'system' as const, content: input.summary }] : []), ...history, { role: 'user', content: this.userContent(input) }];
    }
    // On: the fixed part stays alone at the top so the prefix repeats; Anthropic needs explicit markers
    // (at most 2), the other providers cache prefixes on their own.
    const anthropic = input.model.slug.startsWith('anthropic/');
    const marker = anthropic ? { cache_control: { type: 'ephemeral' } } : {};
    const messages: ChatMessage[] = [{ role: 'system', content: [{ type: 'text', text: input.instructions.fixed, ...marker }] }];
    if (input.summary) messages.push({ role: 'system', content: input.summary });
    // A cut history shifts every turn, so writing it to the cache (1.25x) would cost more than it saves.
    const markHistory = anthropic && input.historyComplete === true && history.length > 0 && history.length === input.history.length;
    messages.push(...history.map((item, index) => markHistory && index === history.length - 1
      ? { role: item.role, content: [{ type: 'text', text: item.content as string, ...marker }] }
      : item));
    messages.push({ role: 'user', content: [
      { type: 'text', text: '<fontes_e_arquivos>\n' + neutralizeTags(input.instructions.variable, ['fontes_e_arquivos']) +'\n</fontes_e_arquivos>' },
      { type: 'text', text: input.message },
      ...this.imageParts(input),
    ] });
    return messages;
  }

  private userContent(input: OmniRouterInput): unknown {
    if (!input.images?.length) return input.message;
    return [{ type: 'text', text: input.message }, ...this.imageParts(input)];
  }

  private imageParts(input: OmniRouterInput): unknown[] {
    return (input.images || []).map(image => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) || !image.dataUrl.startsWith('data:' + image.mimeType + ';base64,') ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1))) {
        throw new BadRequestException('O anexo de imagem deve possuir conteúdo PNG, JPEG ou WEBP válido.');
      }
      // "Baixa" = detail low; "alta" = auto (the provider decides, as before this setting existed).
      return { type: 'image_url', image_url: { url: image.dataUrl, detail: input.optimization.imagensBaixa.ligado ? 'low' : 'auto' } };
    });
  }

  // Ids only, never person names: the gateway groups spend by these tags.
  private tags(input: OmniRouterInput, providerKey?: string): string[] {
    return [
      ...(input.userId ? ['usuario:' + input.userId] : []),
      'origem:' + input.origin,
      ...(input.conversationId ? ['conversa:' + input.conversationId] : []),
      ...(input.agent.id ? ['agente:' + input.agent.id] : []),
      // Key source only, never the key itself.
      providerKey ? 'chave:propria' : 'chave:plataforma',
    ];
  }

  private async round(endpoint: string, apiKey: string, request: unknown, input: OmniRouterInput, report: UsageReporter, providerKey?: string): Promise<ChatRound> {
    // Every round resends the user's images, so each ai_usage row carries the request's image count and detail.
    const images = input.images?.length ?? 0; const low = input.optimization.imagensBaixa.ligado;
    const saved = Number.isSafeInteger(input.historySavedTokens) && input.historySavedTokens! > 0 ? input.historySavedTokens! : 0;
    const record: UsageReporter = usage => report({ ...usage, lowDetailImages: low ? images : 0, highDetailImages: low ? 0 : images, ...(saved ? { historySavedTokens: saved } : {}) });
    const timeout = AbortSignal.timeout(60000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: input.onDelta ? 'text/event-stream' : 'application/json', Authorization: 'Bearer ' + apiKey },
        // `user` = prefeitura: the gateway groups spend by it (Relatórios › Custos de IA).
        body: JSON.stringify({ ...(request as object), user: input.agent.tenantId, metadata: { tags: this.tags(input, providerKey) }, ...(providerKey ? { api_key: providerKey } : {}) }), signal, redirect: 'error',
      });
      input.signal?.throwIfAborted();
      if (!response.ok) throw this.httpError(response.status, await this.gatewayReason(response));
      if (input.onDelta) {
        if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
          await response.body?.cancel();
          throw protocolError('O OmniRouter não retornou um stream SSE válido.');
        }
        return await this.stream(response, input.onDelta, signal, record);
      }
      const content = await this.readBody(response, signal);
      let payload: JsonObject | undefined;
      try { payload = object(JSON.parse(content)); } catch { throw protocolError('O OmniRouter retornou conteúdo JSON inválido.'); }
      if (!payload || payload.error) throw protocolError();
      const usage = usageFrom(payload.usage);
      // LiteLLM's official cost; streaming responses never carry it.
      const rawCost = response.headers.get('x-litellm-response-cost')?.trim();
      const gatewayCost = rawCost && /^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(rawCost) ? Number(rawCost) : undefined;
      if (gatewayCost !== undefined && Number.isFinite(gatewayCost) && usage.measured) usage.gatewayCost = gatewayCost;
      // Peek at the finish reason before recording, so a response cut by the token cap is marked truncated;
      // the full choice validation still happens below, after the paid usage is safely recorded.
      const peeked = Array.isArray(payload.choices) ? object(payload.choices[0])?.finish_reason : undefined;
      usage.truncated = peeked === 'length';
      await record(usage);
      const choices = payload.choices;
      if (!Array.isArray(choices) || choices.length !== 1) throw protocolError();
      const choice = object(choices[0]); const message = object(choice?.message);
      if (!choice || !message || message.role !== 'assistant' || typeof choice.finish_reason !== 'string') throw protocolError();
      const calls = message.tool_calls === undefined || message.tool_calls === null ? [] : Array.isArray(message.tool_calls) ? message.tool_calls.map(functionCall) : undefined;
      if (!calls || calls.length > 8) throw protocolError('O OmniRouter retornou uma lista de ferramentas inválida.');
      const text = message.content ?? message.refusal ?? '';
      if (typeof text !== 'string') throw protocolError();
      return { content: text, calls, finishReason: choice.finish_reason, usage };
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(timeout.aborted ? 'O OmniRouter excedeu o tempo limite. Tente novamente.' : 'Não foi possível obter uma resposta do OmniRouter. Verifique a conexão e tente novamente.');
    }
  }

  /** First line of the gateway error, used only to classify the failure. */
  private async gatewayReason(response: Response): Promise<string> {
    try {
      const text = (await response.text()).slice(0, 4000);
      const message = (JSON.parse(text) as { error?: { message?: unknown } })?.error?.message;
      return typeof message === 'string' ? message.split(String.fromCharCode(10))[0].replace(/^(?:litellm\.\w+:\s*)+/, '').replace(/\s+/g, ' ').trim().slice(0, 240) : '';
    } catch {
      return '';
    }
  }

  private httpError(status: number, reason = ''): HttpException {
    // LiteLLM refusing the prefeitura's own limits (customer budget): a clear 429 instead of a gateway error.
    // Only the end user (prefeitura) budget is shown as the prefeitura's limit; key/team/tag budgets stay a generic gateway error.
    if (/ExceededBudget:\s*End User=/i.test(reason)) return Object.assign(new HttpException(LIMIT_MESSAGES.tenantMonth, 429), { providerStatus: status });
    if (/Rate limit exceeded for end_user/i.test(reason)) return Object.assign(new HttpException(LIMIT_MESSAGES.tenantMinute, 429), { providerStatus: status });
    const missingKey = /api_key client option must be set|api key|x-api-key|authentication/i.test(reason);
    const unknownModel = /invalid model name|model.*not found|does not exist/i.test(reason);
    const message = missingKey ? 'A chave do provedor de IA não está cadastrada ou foi recusada. Cadastre a chave da prefeitura no SGDM (Cadastros › IA) ou a chave da plataforma em Central de IA › Modelos e acesso › Chaves da plataforma, no SGDM.'
      : unknownModel ? 'O modelo escolhido não está disponível no gateway de IA. Escolha outro modelo ou peça ao SUPER_ADMIN para revisar o catálogo.'
      : status === 401 || status === 403 ? 'A credencial do gateway de IA é inválida ou não tem acesso ao modelo.'
      : status === 402 ? 'O saldo da conta do provedor de IA é insuficiente.'
      : status === 429 ? 'O provedor de IA atingiu o limite de uso. Tente novamente mais tarde.'
      : status === 400 || status === 404 || status === 422 ? 'O gateway de IA recusou o modelo, os anexos, as ferramentas ou seus parâmetros. Verifique o catálogo e as configurações do agente.'
      : 'O gateway de IA está indisponível. Tente novamente mais tarde.';
    // The reason only selects a message: provider text may echo the request and is never shown.
    const error = [400, 404, 422].includes(status) || missingKey || unknownModel ? new BadGatewayException(message) : new ServiceUnavailableException(message);
    return Object.assign(error, { providerStatus: status });
  }

  private validateFinish(round: ChatRound, input: OmniRouterInput): void {
    if (round.finishReason === 'length') {
      // With the platform's output cap on, the user is told the cap (not the agent setting) cut the answer.
      const cap = input.optimization.limiteSaida;
      const capBound = Boolean(input.outputCapApplied) && cap.ligado && cap.tokens === input.agent.maxTokens;
      // `truncated` lets callers (the history summary) tell a cut answer from a failure.
      throw Object.assign(protocolError(capBound ? OUTPUT_LIMIT_MESSAGE : 'O OmniRouter encerrou uma resposta incompleta por limite de tokens. Aumente o limite de resposta do agente.'), { truncated: true });
    }
    if (round.finishReason === 'content_filter') throw protocolError('O OmniRouter interrompeu a resposta por restrições do modelo.');
    if (!['stop', 'tool_calls'].includes(round.finishReason) || (round.finishReason === 'tool_calls') !== Boolean(round.calls.length)) {
      throw protocolError('O OmniRouter encerrou a resposta sem uma confirmação de conclusão válida.');
    }
  }

  private async readBody(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) throw protocolError();
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
    let body = ''; let bytes = 0; let finished = false;
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) { body += decoder.decode(); finished = true; break; }
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw protocolError('A resposta do OmniRouter excedeu o tamanho permitido.');
        body += decoder.decode(next.value, { stream: true });
      }
      return body;
    } finally {
      if (!finished) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async stream(response: Response, onDelta: (text: string) => void, signal: AbortSignal, record: UsageReporter): Promise<ChatRound> {
    if (!response.body) throw protocolError('O stream do OmniRouter está vazio.');
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = ''; let content = ''; let bytes = 0; let done = false; let ended = false; let finishReason: string | undefined;
    let usage: QuotaUsage = { inputTokens: 0, outputTokens: 0, measured: false };
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const processFrame = async (frame: string) => {
      const lines = frame.split(/\r\n|\r|\n/);
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (event === 'error') throw protocolError('O OmniRouter interrompeu a geração da resposta. Tente novamente.');
      if (!data) return;
      if (done) throw protocolError('O OmniRouter enviou dados após encerrar o stream.');
      if (data === '[DONE]') {
        if (!finishReason) throw protocolError('O stream do OmniRouter terminou sem confirmação de conclusão. Nenhuma resposta parcial foi salva.');
        done = true;
        return;
      }
      let payload: JsonObject | undefined;
      try { payload = object(JSON.parse(data)); } catch { throw protocolError('O OmniRouter retornou um frame SSE inválido.'); }
      if (!payload || payload.error) throw protocolError('O OmniRouter interrompeu a geração da resposta. Tente novamente.');
      if (payload.usage !== undefined && payload.usage !== null) {
        const counters = usageFrom(payload.usage);
        if (counters.inputTokens < usage.inputTokens || counters.outputTokens < usage.outputTokens) throw protocolError('O OmniRouter retornou contadores de consumo inconsistentes.');
        usage = counters;
        await record({ ...usage, measured: false });
      }
      if (!Array.isArray(payload.choices) || payload.choices.length > 1) throw protocolError('O OmniRouter retornou um frame SSE inválido.');
      if (!payload.choices.length) {
        if (payload.usage === undefined || payload.usage === null) throw protocolError('O OmniRouter retornou um frame SSE vazio.');
        return;
      }
      const choice = object(payload.choices[0]); const delta = object(choice?.delta);
      if (!choice || choice.index !== 0 || !delta || (delta.role !== undefined && delta.role !== 'assistant')) throw protocolError('O OmniRouter retornou um frame SSE inválido.');
      if (finishReason) {
        // LiteLLM sends the usage frame after the finish with an empty delta; only real content is refused.
        const empty = (value: unknown) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
        if (empty(delta.content) && empty(delta.refusal) && empty(delta.tool_calls) && (choice.finish_reason === undefined || choice.finish_reason === null)) return;
        throw protocolError('O gateway de IA enviou conteúdo após concluir a resposta.');
      }
      if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') throw protocolError();
      if (delta.refusal !== undefined && delta.refusal !== null && typeof delta.refusal !== 'string') throw protocolError();
      const text = (delta.content ?? delta.refusal ?? '') as string;
      if (text) { content += text; onDelta(text); signal.throwIfAborted(); }
      if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
        if (!Array.isArray(delta.tool_calls)) throw protocolError('O OmniRouter retornou uma chamada de ferramenta inválida.');
        for (const raw of delta.tool_calls) {
          const call = object(raw); const index = call?.index;
          if (!call || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 7 || (call.type !== undefined && call.type !== 'function')) throw protocolError('O OmniRouter retornou uma chamada de ferramenta inválida.');
          const previous = calls.get(index) || { id: '', name: '', arguments: '' }; const fn = object(call.function);
          if (call.id !== undefined) {
            if (typeof call.id !== 'string' || (previous.id && previous.id !== call.id)) throw protocolError('O OmniRouter retornou uma chamada de ferramenta inválida.');
            previous.id = call.id;
          }
          if (call.function !== undefined && !fn) throw protocolError('O OmniRouter retornou uma chamada de ferramenta inválida.');
          if (fn?.name !== undefined) {
            if (typeof fn.name !== 'string') throw protocolError('O OmniRouter retornou uma chamada de ferramenta inválida.');
            previous.name += fn.name;
          }
          if (fn?.arguments !== undefined) {
            if (typeof fn.arguments !== 'string') throw protocolError('O OmniRouter retornou uma chamada de ferramenta inválida.');
            previous.arguments += fn.arguments;
          }
          if (previous.id.length > 200 || previous.name.length > 200 || previous.arguments.length > 32000) throw protocolError('A chamada de ferramenta do OmniRouter excedeu o tamanho permitido.');
          calls.set(index, previous);
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) throw protocolError();
        finishReason = choice.finish_reason;
      }
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
        if (!next.done) bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw protocolError('O stream do OmniRouter excedeu o tamanho permitido.');
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) throw protocolError('O OmniRouter retornou um frame SSE acima do limite permitido.');
          await processFrame(frame);
        }
        if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) throw protocolError('O OmniRouter retornou um frame SSE acima do limite permitido.');
        if (next.done) { ended = true; break; }
        if (done) break;
      }
      signal.throwIfAborted();
      if (!done || !finishReason || buffer.trim()) throw protocolError('O stream do OmniRouter terminou sem confirmação de conclusão. Nenhuma resposta parcial foi salva.');
      usage.truncated = finishReason === 'length';
      await record(usage);
      const parsedCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => functionCall({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
      return { content, calls: parsedCalls, finishReason, usage };
    } finally {
      if (!ended) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
