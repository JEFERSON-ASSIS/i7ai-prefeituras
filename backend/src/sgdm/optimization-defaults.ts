/** Effective optimization settings for one agent, as resolved by SGDM (contract `OtimizacaoEfetiva`). */
export interface OtimizacaoEfetiva {
  modeloCaro: { ligado: boolean; fatorPreco: number; saidaCurta: number };
  cachePrompt: { ligado: boolean };
  resumoHistorico: { ligado: boolean; mensagens: number; modelos: { openai: string | null; anthropic: string | null; gemini: string | null } };
  cacheExato: { ligado: boolean; ttlSegundos: number; chat: boolean };
  limiteSaida: { ligado: boolean; tokens: number | null };
  imagensBaixa: { ligado: boolean };
  sugestoes: { ligado: boolean; minimoUsd: number };
}

/** SGDM's `GET /integracoes/i7ai/otimizacoes/:tenantId` body; `agentes` only lists agents with an agent-scope row. */
export interface OtimizacaoI7ai { padrao: OtimizacaoEfetiva; agentes: Record<string, OtimizacaoEfetiva> }

/**
 * Defaults when SGDM has no row (or cannot be reached and nothing is cached). Must stay identical to SGDM's
 * PADROES_OTIMIZACAO: both repositories pin the same literal in their tests.
 */
export const OPTIMIZATION_DEFAULTS: OtimizacaoEfetiva = Object.freeze({
  modeloCaro: Object.freeze({ ligado: true, fatorPreco: 4, saidaCurta: 500 }),
  cachePrompt: Object.freeze({ ligado: true }),
  resumoHistorico: Object.freeze({ ligado: false, mensagens: 20, modelos: Object.freeze({ openai: 'openai/gpt-4o-mini', anthropic: 'anthropic/claude-haiku-5-5', gemini: null }) }),
  cacheExato: Object.freeze({ ligado: true, ttlSegundos: 3600, chat: false }),
  limiteSaida: Object.freeze({ ligado: false, tokens: null }),
  imagensBaixa: Object.freeze({ ligado: true }),
  sugestoes: Object.freeze({ ligado: true, minimoUsd: 1 }),
}) as OtimizacaoEfetiva;
