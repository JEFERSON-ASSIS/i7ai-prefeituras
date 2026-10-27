import { Logger } from '@nestjs/common';
import Ajv from 'ajv';
import type { AgentFunction, AgentToolCall, AgentToolResult } from '../ai/agent-tools.service';
import { LIMIT_MESSAGES } from '../ai/limit-messages';
import { maskPersonalData } from '../sgdm/personal-data';
import type { UserLimits } from '../sgdm/sgdm-limits.service';
import { searchPurchases } from './pncp.client';
import { Fonte, clip } from './research-text';
import { searchWeb } from './serper.client';

export { RESEARCH_INSTRUCTIONS, RESEARCH_PNCP_ONLY_INSTRUCTIONS } from '../ai/instructions';

export const BUILTIN_WEB = 'pesquisar_internet';
export const BUILTIN_PNCP = 'pesquisar_compras_publicas';
export const BUILTIN_WEB_ID = 'builtin:web';
export const BUILTIN_PNCP_ID = 'builtin:pncp';
export const MAX_SEARCHES_PER_ANSWER = 5;
export const SEARCH_LIMIT_ERROR = 'Limite de 5 pesquisas desta resposta atingido. Responda com o que já encontrou.';
export const SOURCE_ERROR = 'A fonte não respondeu agora.';
export const WEB_UNAVAILABLE = 'A pesquisa na internet está indisponível agora.';
const ERROR_CODES = ['SERPER_RECUSOU', 'SERPER_FALHOU', 'PNCP_FALHOU'];
const MAX_SOURCES_APPENDED = 10;

const ajv = new Ajv({ allErrors: false, strict: false, validateFormats: false, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false });

const webSchema = {
  type: 'object',
  properties: { consulta: { type: 'string', minLength: 3, maxLength: 300, description: 'O que pesquisar no Google, em português, sem nomes de pessoas nem documentos pessoais.' } },
  required: ['consulta'], additionalProperties: false,
};
const pncpSchema = {
  type: 'object',
  properties: {
    termo: { type: 'string', minLength: 3, maxLength: 200, description: 'Objeto ou item procurado, por exemplo "arroz tipo 1" ou "merenda escolar".' },
    tipo: { type: 'string', enum: ['edital', 'ata', 'contrato'], description: 'edital (padrão; traz preço estimado e contratado por item), ata (atas de registro de preço) ou contrato.' },
    uf: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'Sigla do estado (2 letras) para limitar a busca, quando pedirem.' },
  },
  required: ['termo'], additionalProperties: false,
};
const validateWeb = ajv.compile(webSchema);
const validatePncp = ajv.compile(pncpSchema);

/** System functions offered to the model when the prefeitura has research on; never bound to an agent. */
export function builtinResearchFunctions(opts: { web: boolean; pncp: boolean }): AgentFunction[] {
  const functions: AgentFunction[] = [];
  if (opts.web) functions.push({ toolId: BUILTIN_WEB_ID, validate: validateWeb, definition: { type: 'function', name: BUILTIN_WEB, strict: false, parameters: webSchema,
    description: 'Pesquisa na internet (Google). Use para informação atual ou de fora da prefeitura: preços, normas, índices, notícias. Devolve títulos, links e trechos.' } });
  if (opts.pncp) functions.push({ toolId: BUILTIN_PNCP_ID, validate: validatePncp, definition: { type: 'function', name: BUILTIN_PNCP, strict: false, parameters: pncpSchema,
    description: 'Pesquisa compras públicas de todo o país no PNCP (editais, atas e contratos) e devolve órgão, município/UF, itens com preço unitário estimado e contratado, data e link.' } });
  return functions;
}

export const isBuiltinResearch = (fn: Pick<AgentFunction, 'toolId'> | undefined): boolean => fn?.toolId === BUILTIN_WEB_ID || fn?.toolId === BUILTIN_PNCP_ID;

export type ResearchCallRow = {
  tenantId: string; userId?: string; agentId: string; conversationId?: string;
  source: 'web' | 'pncp'; status: 'ok' | 'erro' | 'limite'; costUsd: number;
};
export type ResearchContext = {
  tenantId: string; userId?: string; agentId: string; conversationId?: string;
  serperKey: string | null; costPerSearchUsd: number; signal?: AbortSignal;
};
export type ResearchDeps = {
  /** Stores one research_calls row. A failure is logged (count only) and never breaks the answer. */
  record: (row: ResearchCallRow) => Promise<void>;
  /** The user's existing per-minute call limit; false = refused. Absent = no limit (e.g. automations). */
  withinUserLimit?: () => Promise<boolean>;
  web?: typeof searchWeb;
  pncp?: typeof searchPurchases;
};

/**
 * Runs the built-in research functions of one answer: caps them at 5, applies the user's per-minute limit, masks
 * the web query, records every call and collects the links returned. Never throws into the chat (except when the
 * user's own signal aborts). Never logs the query or the Serper key.
 */
export class ResearchSession {
  private readonly logger = new Logger(ResearchSession.name);
  private readonly collected = new Map<string, Fonte>();
  private searches = 0;
  /** Serper refused the key: no more web calls in this answer. */
  private webRefused = false;

  constructor(private readonly ctx: ResearchContext, private readonly deps: ResearchDeps) {}

  get sources(): Fonte[] { return [...this.collected.values()]; }

  async execute(call: AgentToolCall): Promise<AgentToolResult> {
    const reply = (value: unknown): AgentToolResult => ({ callId: call.callId, name: call.name, output: clip(JSON.stringify(value)) });
    const source: 'web' | 'pncp' | undefined = call.name === BUILTIN_WEB ? 'web' : call.name === BUILTIN_PNCP ? 'pncp' : undefined;
    if (!source || (source === 'web' && !this.ctx.serperKey)) return reply({ erro: 'Esta pesquisa não está disponível.' });
    let args: any;
    try { args = JSON.parse(call.arguments); } catch { return reply({ erro: 'Argumentos inválidos para a pesquisa.' }); }
    const validate = source === 'web' ? validateWeb : validatePncp;
    if (!args || typeof args !== 'object' || Array.isArray(args) || !validate(args as object)) return reply({ erro: 'Argumentos inválidos para a pesquisa.' });

    if (this.searches >= MAX_SEARCHES_PER_ANSWER) {
      await this.store(source, 'limite', 0);
      return reply({ erro: SEARCH_LIMIT_ERROR });
    }
    if (this.deps.withinUserLimit && !await this.deps.withinUserLimit()) {
      await this.store(source, 'limite', 0);
      return reply({ erro: LIMIT_MESSAGES.userMinute });
    }
    if (source === 'web' && this.webRefused) {
      await this.store('web', 'erro', 0);
      return reply({ erro: WEB_UNAVAILABLE });
    }
    this.searches++;
    this.ctx.signal?.throwIfAborted();
    try {
      if (source === 'web') {
        const found = await (this.deps.web ?? searchWeb)(maskPersonalData(String(args.consulta).trim()), this.ctx.serperKey!, this.ctx.signal);
        this.ctx.signal?.throwIfAborted();
        for (const item of found.resultados) this.collect(item.titulo, item.link);
        await this.store('web', 'ok', this.ctx.costPerSearchUsd);
        return reply(found);
      }
      const found = await (this.deps.pncp ?? searchPurchases)({ termo: maskPersonalData(String(args.termo).trim()), ...(args.tipo ? { tipo: args.tipo } : {}), ...(args.uf ? { uf: String(args.uf).toUpperCase() } : {}) }, this.ctx.signal);
      this.ctx.signal?.throwIfAborted();
      for (const compra of found.compras) {
        const place = compra.municipio && compra.uf ? compra.municipio + '/' + compra.uf : compra.uf;
        this.collect([compra.orgao, place, compra.objeto].filter(Boolean).join(' — ').slice(0, 160), compra.link);
      }
      await this.store('pncp', 'ok', 0);
      return reply(found);
    } catch (error) {
      // The user's disconnect still cancels the whole answer; any other failure is the source's.
      if (this.ctx.signal?.aborted) this.ctx.signal.throwIfAborted();
      // Only the client's fixed error code; never the key or the query.
      const code = error instanceof Error && ERROR_CODES.includes(error.message) ? error.message : 'FALHA_DESCONHECIDA';
      if (code === 'SERPER_RECUSOU') this.webRefused = true;
      this.logger.warn('Uma pesquisa (' + source + ') não respondeu: ' + code + '.');
      await this.store(source, 'erro', 0);
      return reply({ erro: SOURCE_ERROR });
    }
  }

  private collect(titulo: string, link: string) {
    if (typeof link !== 'string' || !/^https?:\/\//i.test(link.trim())) return;
    const key = link.trim();
    if (!this.collected.has(key)) this.collected.set(key, { titulo: String(titulo || '').trim(), link: key });
  }

  private async store(source: 'web' | 'pncp', status: 'ok' | 'erro' | 'limite', costUsd: number) {
    const { tenantId, userId, agentId, conversationId } = this.ctx;
    try { await this.deps.record({ tenantId, userId, agentId, conversationId, source, status, costUsd: status === 'ok' ? costUsd : 0 }); }
    catch { this.logger.warn('Falha ao registrar 1 pesquisa.'); }
  }
}

const markdownTitle = (text: string) => text.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const markdownLink = (link: string) => link.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');

/** Adds a "Fontes" section with the collected links (up to 10, no repeats) when the answer cites none of them. */
export function appendSourcesIfMissing(answer: string, sources: Fonte[]): string {
  const unique = [...new Map(sources.filter(item => item?.link).map(item => [item.link, item] as const)).values()];
  if (!unique.length) return answer;
  if (unique.some(item => answer.includes(item.link) || answer.includes(markdownLink(item.link)))) return answer;
  const lines = unique.slice(0, MAX_SOURCES_APPENDED).map(item => '- [' + (markdownTitle(item.titulo) || markdownTitle(item.link)) + '](' + markdownLink(item.link) + ')');
  return answer + '\n\n**Fontes**\n' + lines.join('\n');
}

type CountDelegate = { count: (args: any) => Promise<number> };

/**
 * The user's per-minute call limit from SGDM (the same `callsPerMinute` the quota enforces on model rounds),
 * counting the model rounds (token reservations) and the research calls of the last minute.
 */
export function userMinuteCheck(
  prisma: { aiTokenReservation: CountDelegate; researchCall: CountDelegate },
  limits: { forUser: (tenantId: string, userId: string) => Promise<UserLimits | null> } | undefined,
  tenantId: string,
  userId: string | undefined,
): (() => Promise<boolean>) | undefined {
  if (!userId || !limits) return undefined;
  return async () => {
    const userLimits = await limits.forUser(tenantId, userId);
    if (!userLimits || userLimits.callsPerMinute === null) return true;
    const where = { tenantId, userId, createdAt: { gte: new Date(Date.now() - 60_000) } };
    const [rounds, searches] = await Promise.all([
      prisma.aiTokenReservation.count({ where }),
      prisma.researchCall.count({ where: { ...where, status: { not: 'limite' } } }),
    ]);
    return rounds + searches < userLimits.callsPerMinute;
  };
}

/** research_calls writer. */
export function researchRecorder(prisma: { researchCall: { create: (args: any) => Promise<unknown> } }): (row: ResearchCallRow) => Promise<void> {
  return async row => {
    await prisma.researchCall.create({ data: {
      tenantId: row.tenantId, userId: row.userId ?? null, agentId: row.agentId || null, conversationId: row.conversationId ?? null,
      source: row.source, status: row.status, costUsd: row.costUsd,
    } });
  };
}
