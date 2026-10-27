import { BadGatewayException, BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException, Optional, ServiceUnavailableException, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { Response as ModelResponse, ResponseCreateParamsNonStreaming, ResponseInputItem } from 'openai/resources/responses/responses';
import { PrismaService } from '../prisma/prisma.service';
import { RagService, RagSource } from '../knowledge/rag.service';
import { ChatDto } from './dto/chat.dto';
import { requireActiveLicense } from '../catalog/license-policy';
import { AiQuotaService, QuotaScope, QuotaUsage, calculateUsageCost } from './ai-quota.service';
import { AgentFunction, AgentToolCall, AgentToolsService } from './agent-tools.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { OmniRouterService } from './omnirouter.service';
import { publicModelCapabilities } from '../catalog/model-capabilities';
import { SgdmAccessService } from '../sgdm/sgdm-access.service';
import { SgdmOptimizationService } from '../sgdm/sgdm-optimization.service';
import { OPTIMIZATION_DEFAULTS, OtimizacaoEfetiva } from '../sgdm/optimization-defaults';
import { CHAT_EXPORT_INSTRUCTIONS, SplitInstructions, fixedInstructions, joinedInstructions, variableInstructions } from './instructions';
import { EXPORT_MIME, ExportFormat, exportFileName, exportTitle, parseAnswer, renderExport } from './chat-export';

export { CHAT_EXPORT_INSTRUCTIONS };

type HistoryItem = { role: string; content: string };
type AttachmentContext = { documents: { id: string; name: string; mimeType: string; sizeBytes: string; status: string }[]; text: string; images: { name: string; mimeType: string; dataUrl: string }[] };
type ChatRunOptions = { signal?: AbortSignal; onDelta?: (text: string) => void };
export type ChatStreamEvent = 'delta' | 'complete';
export type AgentExecutionInput = { message: string; userId?: string; automationId?: string; conversationId?: string; signal?: AbortSignal; modelId?: string; attachmentContext?: AttachmentContext; historyComplete?: boolean };
export type AgentAnswer = { answer: string; sources: RagSource[]; agentId: string; provider: string; model: string; toolCalls?: { callId: string; name: string }[]; usage: { inputTokens: number; outputTokens: number; cost: number; costConfigured: boolean; latencyMs: number; measured: boolean } };
type PreparedAnswer = { quotaScope: QuotaScope; result: AgentAnswer; modelId: string; modelName: string; providerName: string; userId?: string; automationId?: string; tenantId: string };
type ProviderAnswer = { answer: string; inputTokens: number; outputTokens: number; measured: boolean; cost?: number; toolCalls: { callId: string; name: string }[] };
const HISTORY_MESSAGES = 40;
const agentInclude = { models: { include: { model: { include: { provider: true } } } } } satisfies Prisma.AgentInclude;
type LoadedAgent = Prisma.AgentGetPayload<{ include: typeof agentInclude }>;
type LoadedModel = LoadedAgent['models'][number]['model'];
const conversationModel = { select: { id: true, name: true, slug: true, provider: { select: { id: true, name: true, slug: true } } } };
const attachmentDocument = { select: { id: true, name: true, mimeType: true, sizeBytes: true, status: true, ownerUserId: true, tenantId: true } };

function numericTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(2_147_483_647, Math.trunc(value)) : 0;
}
export { calculateUsageCost };

@Injectable()
export class AiGatewayService {
  constructor(private readonly prisma: PrismaService, private readonly rag: RagService, private readonly agentTools: AgentToolsService, private readonly quota: AiQuotaService, @Optional() private readonly knowledge?: KnowledgeService, @Optional() private readonly omni?: OmniRouterService, private readonly access?: SgdmAccessService, @Optional() private readonly optimization?: SgdmOptimizationService) {}

  async chat(agentId: string, tenantId: string, input: ChatDto, userId: string, options: ChatRunOptions = {}) {
    options.signal?.throwIfAborted();
    let history: HistoryItem[] = [];
    let modelId = input.modelId;
    let historyAttachmentIds: string[] = [];
    let historyCut = false;
    if (input.conversationId) {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: input.conversationId, tenantId, userId, agentId },
        include: { messages: { orderBy: { createdAt: 'desc' }, take: HISTORY_MESSAGES + 1, include: { attachments: { include: { document: attachmentDocument } } } } },
      });
      if (!conversation) throw new NotFoundException('Conversa não encontrada para este usuário e agente.');
      modelId ??= conversation.modelId ?? undefined;
      // One extra row only tells whether older messages were left out (the prompt-cache prefix then shifts every turn).
      const recent = conversation.messages.slice(0, HISTORY_MESSAGES);
      historyCut = conversation.messages.length > HISTORY_MESSAGES;
      history = [...recent].reverse().map(({ role, content }) => ({ role, content }));
      historyAttachmentIds = recent.flatMap(item => (item.attachments || []).map(link => link.documentId));
    }
    const attachmentIds = input.attachmentIds || [];
    if (attachmentIds.length > 5 || new Set(attachmentIds).size !== attachmentIds.length) throw new BadRequestException('Envie até cinco anexos diferentes.');
    let attachmentContext: AttachmentContext | undefined;
    if (attachmentIds.length || historyAttachmentIds.length) {
      if (!this.knowledge) throw new ServiceUnavailableException('O serviço de anexos está indisponível.');
      // Keep the most recent files in context. Every file is reauthorized before use.
      const relevantIds = [...new Set([...attachmentIds, ...historyAttachmentIds])].slice(0, 5);
      attachmentContext = await this.knowledge.prepareChatAttachments(tenantId, userId, relevantIds);
    }
    options.signal?.throwIfAborted();
    // A new conversation gets its id up front so even its first (usually costliest) call carries the conversa tag.
    const newConversationId = input.conversationId ? undefined : randomUUID();
    const prepared = await this.generate(agentId, tenantId, { message: input.message, userId, conversationId: input.conversationId ?? newConversationId, modelId, attachmentContext, signal: options.signal, historyComplete: !historyCut }, history, options.onDelta);
    try {
    options.signal?.throwIfAborted();
    const { conversationId, messages } = await this.prisma.$transaction(async (tx) => {
      options.signal?.throwIfAborted();
      let id = input.conversationId;
      if (id) {
        const owned = await tx.conversation.findFirst({ where: { id, tenantId, userId, agentId } });
        if (!owned) throw new NotFoundException('Conversa não encontrada.');
        await tx.conversation.update({ where: { id }, data: { updatedAt: new Date(), modelId: prepared.modelId } });
      } else {
        const conversation = await tx.conversation.create({ data: { id: newConversationId, tenantId, userId, agentId, modelId: prepared.modelId, title: input.message.trim().slice(0, 120) } });
        id = conversation.id;
      }
      const attachments = (attachmentContext?.documents || []).filter(document => attachmentIds.includes(document.id));
      if (attachmentIds.length) {
        // Recheck inside the persistence transaction so deletion/ownership changes cannot race linking.
        const count = await tx.document.count({ where: { id: { in: attachmentIds }, tenantId, ownerUserId: userId, chatOnly: true, status: 'READY' } });
        if (count !== attachmentIds.length) throw new BadRequestException('Um anexo ficou indisponível. Envie-o novamente.');
      }
      const modelMetadata = { modelId: prepared.modelId, modelName: prepared.modelName, model: prepared.result.model, provider: prepared.result.provider, providerName: prepared.providerName };
      const userMessage = await tx.message.create({ data: { conversationId: id, role: 'user', content: input.message.trim(), createdAt: new Date(), metadata: { ...modelMetadata, attachments } as Prisma.InputJsonValue,
        ...(attachments.length ? { attachments: { create: attachments.map(document => ({ documentId: document.id })) } } : {}),
      } });
      const assistantMessage = await tx.message.create({ data: {
        conversationId: id, role: 'assistant', content: prepared.result.answer, createdAt: new Date(userMessage.createdAt.getTime() + 1),
        inputTokens: prepared.result.usage.inputTokens, outputTokens: prepared.result.usage.outputTokens, latencyMs: prepared.result.usage.latencyMs,
        metadata: { ...modelMetadata, sources: prepared.result.sources, toolCalls: prepared.result.toolCalls || [], usageMeasured: prepared.result.usage.measured, costConfigured: prepared.result.usage.costConfigured } as Prisma.InputJsonValue,
      } });
      await this.recordUsage(tx, prepared, id);
      options.signal?.throwIfAborted();
      return { conversationId: id, messages: [userMessage, assistantMessage] };
    });
    return { ...prepared.result, modelId: prepared.modelId, modelName: prepared.modelName, conversationId, messages };
    } catch (error) { await this.quota.finish(prepared.quotaScope, 'FAILED'); throw error; }
  }

  async chatStream(agentId: string, tenantId: string, input: ChatDto, userId: string, emit: (event: ChatStreamEvent, payload: unknown) => void, signal?: AbortSignal) {
    const result = await this.chat(agentId, tenantId, input, userId, { signal, onDelta: (text) => emit('delta', { text }) });
    signal?.throwIfAborted();
    emit('complete', result);
    return result;
  }

  async executeAgent(agentId: string, tenantId: string, input: AgentExecutionInput): Promise<AgentAnswer> {
    const prepared = await this.generate(agentId, tenantId, input);
    try {
      await this.prisma.$transaction((tx) => this.recordUsage(tx, prepared));
      return prepared.result;
    } catch (error) { await this.quota.finish(prepared.quotaScope, 'FAILED'); throw error; }
  }

  listConversations(tenantId: string, userId: string, agentId?: string) {
    return this.prisma.conversation.findMany({
      where: { tenantId, userId, ...(agentId ? { agentId } : {}) },
      select: { id: true, agentId: true, modelId: true, model: conversationModel, title: true, createdAt: true, updatedAt: true, agent: { select: { id: true, name: true } }, _count: { select: { messages: true } } },
      orderBy: { updatedAt: 'desc' }, take: 100,
    });
  }

  async getConversation(tenantId: string, userId: string, id: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, tenantId, userId }, include: { agent: { select: { id: true, name: true } }, model: conversationModel, messages: { orderBy: { createdAt: 'desc' }, take: 1000, include: { attachments: { include: { document: attachmentDocument } } } } },
    });
    if (!conversation) throw new NotFoundException('Conversa não encontrada.');
    return { ...conversation, messages: [...conversation.messages].reverse().map(item => ({ ...item, attachments: (item.attachments || []).filter(link => link.document.ownerUserId === userId && link.document.tenantId === tenantId).map(link => ({ document: { id: link.document.id, name: link.document.name, mimeType: link.document.mimeType, sizeBytes: link.document.sizeBytes.toString(), status: link.document.status } })) })) };
  }

  async exportMessage(tenantId: string, userId: string, conversationId: string, messageId: string, format: ExportFormat) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, role: 'assistant', conversation: { tenantId, userId } },
      select: { content: true, conversation: { select: { title: true, tenant: { select: { name: true } } } } },
    });
    if (!message) throw new NotFoundException('Resposta não encontrada.');
    const blocks = parseAnswer(message.content);
    if (!blocks.length) throw new BadRequestException('A resposta não tem conteúdo para exportar.');
    if (format === 'xlsx' && !blocks.some(block => block.type === 'table')) throw new BadRequestException('A resposta não contém tabelas para exportar em Excel.');
    const generatedAt = new Date();
    const title = exportTitle(blocks, message.conversation.title);
    const content = await renderExport(format, { title, organization: message.conversation.tenant.name, generatedAt, blocks });
    return new StreamableFile(content, { type: EXPORT_MIME[format], disposition: "attachment; filename*=UTF-8''" + encodeURIComponent(exportFileName(title, format, generatedAt)), length: content.length });
  }

  private async generate(agentId: string, tenantId: string, input: AgentExecutionInput, history: HistoryItem[] = [], onDelta?: (text: string) => void): Promise<PreparedAnswer> {
    input.signal?.throwIfAborted();
    const message = input.message?.trim();
    const maxCharacters = input.automationId ? 200000 : 16000;
    if (!message || message.length > maxCharacters) throw new BadRequestException('Informe uma mensagem de até ' + maxCharacters + ' caracteres.');
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, tenantId }, include: agentInclude });
    if (!agent) throw new NotFoundException('Agente não encontrado.');
    if (agent.status === 'ARCHIVED') throw new BadRequestException('Este agente está arquivado.');
    if (agent.status !== 'ACTIVE') throw new BadRequestException('Ative o agente nas configurações para executar.');
    const binding = agent.models.find((item) => item.isPrimary);
    const model: LoadedModel | null = input.modelId ? await this.prisma.aiModel.findUnique({ where: { id: input.modelId }, include: { provider: true } }) : binding?.model || null;
    if (!model) throw new BadRequestException(input.modelId ? 'Modelo não encontrado no catálogo.' : 'Selecione um modelo principal nas configurações do agente.');
    // Released models come from SGDM (chat, stream and automations alike); automations use the prefeitura's list.
    if (model.active === false) throw new ForbiddenException('Este modelo não está liberado para você. Escolha outro no seletor do chat.');
    await this.access?.assertAllowed(agent.tenantId, input.userId, model.slug);
    const omniConfigured = Boolean(process.env.OMNIROUTER_BASE_URL || process.env.OMNIROUTER_API_KEY);
    if (!omniConfigured && !process.env.AI_GATEWAY_URL && model.provider.slug.toLowerCase() !== 'openai') throw new ServiceUnavailableException('Configure o OmniRouter no servidor para usar este provedor.');
    if (!omniConfigured && !process.env.AI_GATEWAY_URL && !process.env.OPENAI_API_KEY) throw new ServiceUnavailableException('O provedor de IA não está configurado. Defina as credenciais do OmniRouter no servidor.');
    if (input.attachmentContext?.images.length && !omniConfigured) throw new BadRequestException('A análise de imagens exige OmniRouter e um modelo com visão habilitada.');
    if (input.automationId && !await this.prisma.automation.findFirst({ where: { id: input.automationId, tenantId, agentId }, select: { id: true } })) throw new NotFoundException('Automação não encontrada para este agente.');
    await this.checkTokenQuota(tenantId);
    const started = Date.now();
    const functions = await this.agentTools.load(tenantId, agentId, input.signal);
    const sources = await this.rag.searchForAgent(tenantId, agentId, message, 6);
    const context = sources.map((source, index) => '[Fonte ' + (index + 1) + '] ' + source.documentName + ' (trecho ' + (source.chunkIndex + 1) + ')\n' + source.content).join('\n\n');
    const capabilities = publicModelCapabilities(model.capabilities);
    // Read once per call; never throws (SGDM down and nothing cached → defaults).
    const optimization = this.optimization ? await this.optimization.effective(tenantId, agentId) : structuredClone(OPTIMIZATION_DEFAULTS);
    // Only the OmniRouter path moves the sources to the last user message; the other paths keep today's single string.
    const cacheOn = omniConfigured && optimization.cachePrompt.ligado;
    const instructions: SplitInstructions = { fixed: fixedInstructions(agent, Boolean(input.automationId), cacheOn), variable: variableInstructions(context, input.attachmentContext?.text) };
    const joined = joinedInstructions(instructions);
    // The platform's per-agent output cap only lowers agent.maxTokens, never raises it.
    const outputCap = optimization.limiteSaida.ligado && Number.isSafeInteger(optimization.limiteSaida.tokens) && optimization.limiteSaida.tokens! >= 1 ? optimization.limiteSaida.tokens! : Infinity;
    const ownLimit = Math.min(agent.maxTokens, typeof capabilities.maxOutputTokens === 'number' ? capabilities.maxOutputTokens : Infinity);
    const maxOutput = Math.min(ownLimit, outputCap);
    // True only when the platform cap is what bounds the answer (strictly below the agent's and the model's limits).
    const outputCapApplied = outputCap < ownLimit;
    const configuredWindow = typeof capabilities.contextWindow === 'number' ? capabilities.contextWindow : undefined;
    let historyBudget = 48000;
    if (configuredWindow) {
      // UTF-8 bytes provide a conservative text budget; actual usage still comes from the gateway.
      historyBudget = Math.min(historyBudget, configuredWindow - maxOutput - 2048 - Buffer.byteLength(joined + message, 'utf8'));
      if (historyBudget < 0) throw new BadRequestException('A mensagem e os anexos excedem o contexto configurado para este modelo. Reduza os arquivos ou escolha um modelo com contexto maior.');
    }
    const bounded = this.boundedHistory(history, historyBudget);
    // A cut history changes the cached prefix on every turn, so its last message is not marked for caching.
    const historyComplete = input.historyComplete !== false && bounded.length === history.length;
    history = bounded;
    const executionAgent = { ...agent, maxTokens: maxOutput };
    const provider = model.provider.slug.toLowerCase();
    const settings = { temperature: Number(agent.temperature), maxTokens: maxOutput, advancedReasoning: agent.advancedReasoning };
    const quotaScope = this.quota.scope({ tenantId, agentId, modelId: model.id, userId: input.userId, automationId: input.automationId, inputPrice: Number(model.inputPrice) || 0, outputPrice: Number(model.outputPrice) || 0, cachedInputPrice: Number(model.cachedInputPrice ?? model.inputPrice) || 0, cacheWriteInputPrice: Number(model.cacheWriteInputPrice ?? model.inputPrice) || 0, conversationId: input.conversationId, kind: 'resposta' });
    try {
    const generated = omniConfigured
      ? await this.runOmniRouter(executionAgent, model, instructions, message, history, historyComplete, functions, input, quotaScope, optimization, outputCapApplied, onDelta)
      : process.env.AI_GATEWAY_URL
        ? await this.externalGateway(executionAgent, model.slug, provider, joined, message, history, sources, settings, functions, input, quotaScope)
        : await this.openAi(executionAgent, tenantId, model, joined, message, history, functions, input, quotaScope, onDelta);
    input.signal?.throwIfAborted();
    const { answer, inputTokens, outputTokens, measured } = generated;
    // Same number recorded in ai_usage when the OmniRouter ran; other paths have no cache or gateway data.
    const cost = generated.cost ?? calculateUsageCost(inputTokens, outputTokens, model.inputPrice, model.outputPrice);
    const costConfigured = measured && model.inputPrice != null && model.outputPrice != null;
    return { quotaScope, tenantId, userId: input.userId, automationId: input.automationId, modelId: model.id, modelName: model.name || model.slug, providerName: model.provider.name, result: { answer, sources, agentId, provider: omniConfigured ? provider : process.env.AI_GATEWAY_URL ? 'gateway' : provider, model: model.slug, ...(generated.toolCalls.length ? { toolCalls: generated.toolCalls } : {}), usage: { inputTokens, outputTokens, cost, costConfigured, latencyMs: Date.now() - started, measured } } };
    } catch (error) { await this.quota.finish(quotaScope, 'FAILED'); throw error; }
  }

  private async runOmniRouter(agent: LoadedAgent, model: LoadedModel, instructions: SplitInstructions, message: string, history: HistoryItem[], historyComplete: boolean, functions: AgentFunction[], input: AgentExecutionInput, quotaScope: QuotaScope, optimization: OtimizacaoEfetiva, outputCapApplied: boolean, onDelta?: (text: string) => void): Promise<ProviderAnswer> {
    if (!this.omni) throw new ServiceUnavailableException('O adaptador OmniRouter está indisponível.');
    return this.omni.generate({ agent, model, instructions, message, history, historyComplete, images: input.attachmentContext?.images, functions, userId: input.userId, origin: input.automationId ? 'i7ai-automacao' : 'i7ai-chat', conversationId: input.conversationId, signal: input.signal, onDelta, quotaScope, optimization, outputCapApplied });
  }

  private async openAi(agent: LoadedAgent, tenantId: string, selectedModel: LoadedModel, instructions: string, message: string, history: HistoryItem[], functions: AgentFunction[], input: AgentExecutionInput, quotaScope: QuotaScope, onDelta?: (text: string) => void): Promise<ProviderAnswer> {
    const model = selectedModel.slug;
    const providerConfig = selectedModel.provider.config;
    const providerSettings = providerConfig && typeof providerConfig === 'object' && !Array.isArray(providerConfig) ? providerConfig as Record<string, unknown> : {};
    const modelSettings = selectedModel.capabilities && typeof selectedModel.capabilities === 'object' && !Array.isArray(selectedModel.capabilities) ? selectedModel.capabilities as Record<string, unknown> : {};
    const config = { ...providerSettings, ...modelSettings };
    const supportsReasoning = typeof config.supportsReasoning === 'boolean' ? config.supportsReasoning : /^(o[1-9]([.-]|$)|gpt-[56])/.test(model);
    const supportsTemperature = typeof config.supportsTemperature === 'boolean' ? config.supportsTemperature : !supportsReasoning;
    if (agent.advancedReasoning && !supportsReasoning) throw new BadRequestException('O modelo selecionado não oferece raciocínio avançado. Desative a opção ou selecione um modelo compatível.');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined, timeout: 60000, maxRetries: 0 });
    const transcript: ResponseInputItem[] = [...this.boundedHistory(history), { role: 'user', content: message }];
    const request: ResponseCreateParamsNonStreaming = {
      model, instructions, store: false, max_output_tokens: agent.maxTokens, input: transcript,
      ...(supportsTemperature ? { temperature: Number(agent.temperature) } : {}),
      ...(supportsReasoning ? { reasoning: { effort: agent.advancedReasoning ? 'medium' : 'low' } } : {}),
      ...(functions.length ? { tools: functions.map((item) => item.definition), parallel_tool_calls: false } : {}),
    };
    let inputTokens = 0; let outputTokens = 0; let measured = true;
    const usedCalls: { callId: string; name: string }[] = [];
    try {
      for (let round = 0; round < 8; round++) {
        input.signal?.throwIfAborted();
        const response = await this.quota.runRound(quotaScope, request, agent.maxTokens, async record => {
          const response = onDelta ? await this.openAiStreamRound(client, request, input.signal, onDelta, record) : await client.responses.create(request, { signal: input.signal });
          await record(this.providerUsage(response));
          return response;
        });
        input.signal?.throwIfAborted();
        if (response.status !== 'completed') throw new BadGatewayException('O provedor encerrou uma resposta incompleta. Verifique o limite de tokens e tente novamente.');
        inputTokens += numericTokens(response.usage?.input_tokens); outputTokens += numericTokens(response.usage?.output_tokens); measured = measured && this.providerUsage(response).measured;
        const calls = response.output.filter((item) => item.type === 'function_call').map((item) => ({ callId: item.call_id, name: item.name, arguments: item.arguments }));
        if (!calls.length) {
          const answer = this.responseText(response);
          if (!answer) throw new BadGatewayException('O provedor retornou uma resposta sem texto. Verifique o modelo e o limite de tokens.');
          return { answer, inputTokens, outputTokens, measured, toolCalls: usedCalls };
        }
        if (round === 7 || usedCalls.length + calls.length > 8) throw new BadGatewayException('O agente atingiu o limite de oito chamadas/rodadas de ferramentas sem concluir a resposta.');
        // Preserve all reasoning, message and function-call items when replaying state.
        transcript.push(...response.output as ResponseInputItem[]);
        for (const call of calls) {
          if (usedCalls.some((item) => item.callId === call.callId)) throw new BadGatewayException('O provedor repetiu um identificador de chamada de ferramenta.');
          const result = await this.agentTools.execute(tenantId, agent.id, call, functions, input.userId, input.signal);
          usedCalls.push({ callId: call.callId, name: call.name });
          transcript.push({ type: 'function_call_output', call_id: result.callId, output: result.output });
        }
      }
    } catch (error) {
      if (input.signal?.aborted) { input.signal.throwIfAborted(); }
      if (error instanceof HttpException) throw error;
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      if (status === 401 || status === 403) throw new ServiceUnavailableException('A credencial do provedor de IA é inválida ou não tem acesso ao modelo.');
      if (status === 429) throw new ServiceUnavailableException('O provedor de IA atingiu o limite de uso. Tente novamente mais tarde.');
      if (status === 400 || status === 404) throw new BadGatewayException('O provedor recusou o modelo, as ferramentas ou seus parâmetros. Verifique as configurações do agente.');
      throw new ServiceUnavailableException('Não foi possível obter uma resposta do provedor de IA. Verifique a conexão e tente novamente.');
    }
    throw new BadGatewayException('O agente não concluiu a resposta dentro do limite de rodadas.');
  }

  private async openAiStreamRound(client: OpenAI, request: ResponseCreateParamsNonStreaming, signal: AbortSignal | undefined, onDelta: (text: string) => void, record: (usage: QuotaUsage) => Promise<void>): Promise<ModelResponse> {
    const stream = await client.responses.create({ ...request, stream: true }, { signal });
    let completed: ModelResponse | undefined;
    for await (const event of stream) {
      signal?.throwIfAborted();
      if (event.type === 'response.output_text.delta') onDelta(event.delta);
      else if (event.type === 'response.refusal.delta') onDelta(event.delta);
      else if (event.type === 'response.completed') { await record(this.providerUsage(event.response)); completed = event.response; }
      else if (event.type === 'response.failed' || event.type === 'response.incomplete') { await record(this.providerUsage(event.response)); throw new BadGatewayException('O provedor interrompeu a geração da resposta. Tente novamente.'); }
      else if (event.type === 'error') throw new BadGatewayException('O provedor interrompeu a geração da resposta. Tente novamente.');
    }
    signal?.throwIfAborted();
    if (!completed) throw new BadGatewayException('O stream de IA terminou sem confirmação de conclusão. Nenhuma resposta parcial foi salva.');
    return completed;
  }

  private providerUsage(response: ModelResponse): QuotaUsage {
    const input = response.usage?.input_tokens; const output = response.usage?.output_tokens;
    return { inputTokens: numericTokens(input), outputTokens: numericTokens(output), measured: typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 && typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 };
  }

  private responseText(response: ModelResponse) {
    return (response.output_text || response.output.flatMap((item) => item.type === 'message' ? item.content.flatMap((part) => part.type === 'output_text' ? [part.text] : part.type === 'refusal' ? [part.refusal] : []) : []).join('')).trim();
  }

  private boundedHistory(history: HistoryItem[], maxBytes = 48000) {
    let size = 0;
    return [...history].reverse().filter((item) => {
      size += Buffer.byteLength(item.content, 'utf8');
      return size <= maxBytes && ['user', 'assistant'].includes(item.role);
    }).reverse().map((item) => ({ role: item.role as 'user' | 'assistant', content: item.content }));
  }

  private async externalGateway(agent: LoadedAgent, model: string, provider: string, instructions: string, message: string, history: HistoryItem[], sources: RagSource[], settings: Record<string, unknown>, functions: AgentFunction[], input: AgentExecutionInput, quotaScope: QuotaScope): Promise<ProviderAnswer> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.AI_GATEWAY_API_KEY) headers.Authorization = 'Bearer ' + process.env.AI_GATEWAY_API_KEY;
    const results: { callId: string; name: string; output: string }[] = [];
    let inputTokens = 0; let outputTokens = 0; let measured = true;
    for (let round = 0; round < 8; round++) {
      input.signal?.throwIfAborted();
      const request = {
        agent: { id: agent.id, name: agent.name, systemPrompt: instructions, ...settings }, model, provider, message,
        history: this.boundedHistory(history), context: sources,
        ...(functions.length ? { tools: functions.map(item => item.definition), toolExecution: 'client', toolResults: results } : {}),
      };
      const payload = await this.quota.runRound(quotaScope, request, agent.maxTokens, async record => {
        let response: Response;
        try {
          response = await fetch(process.env.AI_GATEWAY_URL!.replace(/\/$/, '') + '/chat', {
            method: 'POST', headers, signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000), body: JSON.stringify(request),
          });
        } catch { input.signal?.throwIfAborted(); throw new ServiceUnavailableException('O gateway de IA está indisponível ou excedeu o tempo limite.'); }
        if (!response.ok) throw Object.assign(new BadGatewayException('O gateway de IA recusou a solicitação (HTTP ' + response.status + ').'), { providerStatus: response.status });
        let payload: Record<string, unknown>;
        try { payload = await response.json() as Record<string, unknown>; }
        catch { throw new BadGatewayException('O gateway de IA retornou conteúdo inválido.'); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BadGatewayException('O gateway de IA deve retornar um objeto JSON válido.');
        const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {};
        const inputCount = usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens;
        const outputCount = usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens;
        const counters = { inputTokens: numericTokens(inputCount), outputTokens: numericTokens(outputCount), measured: typeof inputCount === 'number' && Number.isSafeInteger(inputCount) && inputCount >= 0 && typeof outputCount === 'number' && Number.isSafeInteger(outputCount) && outputCount >= 0 };
        await record(counters);
        inputTokens += counters.inputTokens; outputTokens += counters.outputTokens; measured = measured && counters.measured;
        return payload;
      });
      if (payload.toolCalls !== undefined && !Array.isArray(payload.toolCalls)) throw new BadGatewayException('O gateway deve retornar toolCalls como uma lista de chamadas.');
      const rawCalls = payload.toolCalls as unknown[] | undefined;
      if (!rawCalls?.length) {
        if (typeof payload.answer !== 'string' || !payload.answer.trim()) throw new BadGatewayException('O gateway deve retornar uma resposta no campo answer.');
        return { answer: payload.answer.trim(), inputTokens, outputTokens, measured, toolCalls: results.map(({ callId, name }) => ({ callId, name })) };
      }
      if (round === 7 || results.length + rawCalls.length > 8) throw new BadGatewayException('O gateway atingiu o limite de oito chamadas/rodadas de ferramentas.');
      for (const raw of rawCalls) {
        if (!raw || typeof raw !== 'object') throw new BadGatewayException('O gateway retornou uma chamada de ferramenta inválida.');
        const value = raw as Record<string, unknown>;
        if (typeof value.name !== 'string' || typeof value.callId !== 'string') throw new BadGatewayException('A chamada do gateway precisa conter name, callId e arguments.');
        const argumentsJson = typeof value.arguments === 'string' ? value.arguments : JSON.stringify(value.arguments);
        if (typeof argumentsJson !== 'string') throw new BadGatewayException('A chamada do gateway precisa conter argumentos JSON.');
        const call: AgentToolCall = { callId: value.callId, name: value.name, arguments: argumentsJson };
        if (results.some((item) => item.callId === call.callId)) throw new BadGatewayException('O gateway repetiu um identificador de chamada de ferramenta.');
        const result = await this.agentTools.execute(agent.tenantId, agent.id, call, functions, input.userId, input.signal);
        results.push(result);
      }
    }
    throw new BadGatewayException('O gateway não concluiu a resposta dentro do limite de rodadas.');
  }

  private async checkTokenQuota(tenantId: string) {
    const license = await requireActiveLicense(this.prisma, tenantId);
    if (!license) return;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodStart = license.startDate > monthStart ? license.startDate : monthStart;
    const usage = await this.prisma.aiUsage.aggregate({ where: { tenantId, createdAt: { gte: periodStart } }, _sum: { inputTokens: true, outputTokens: true } });
    if (BigInt((usage._sum.inputTokens || 0) + (usage._sum.outputTokens || 0)) >= license.maxTokens) throw new BadRequestException('O limite de tokens da licença foi atingido.');
  }

  private async recordUsage(tx: Prisma.TransactionClient, prepared: PreparedAnswer, conversationId?: string) {
    const { result, tenantId, userId, automationId } = prepared;
    await this.quota.finish(prepared.quotaScope, 'COMPLETED', tx);
    await tx.auditLog.create({ data: {
      tenantId, userId, event: automationId ? 'agent.automation_executed' : 'agent.chat_completed', resource: 'agent', resourceId: result.agentId,
      metadata: { ...(conversationId ? { conversationId } : {}), ...(automationId ? { automationId } : {}), model: result.model, provider: result.provider, sourceIds: result.sources.map((source) => source.documentId), ...result.usage },
    } });
  }
}
