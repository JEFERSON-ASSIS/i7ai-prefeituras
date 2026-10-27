#!/usr/bin/env node
// Local smoke: cost of one conversation (fixed 24-message script) before/after the Entrega 4 optimizations.
//   node scripts/smoke-custo-conversa.cjs --agente <id> --mensagens 24 --rotulo antes|depois [--esperar-resumo]
// Development only. Nothing secret is printed: the LiteLLM key and the DB URL come from the environment/.env.
//   Session: SMOKE_TOKEN, or the token written by `npm run local:session` (output/preview-server/session.js).
//   API:     I7AI_API_URL (default http://127.0.0.1:3010/api).
//   LiteLLM: LITELLM_URL (default http://127.0.0.1:4000) with LITELLM_ADMIN_KEY or LITELLM_MASTER_KEY.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[arg.slice(2)] = true;
  else { args[arg.slice(2)] = next; i++; }
}

const API = (process.env.I7AI_API_URL || 'http://127.0.0.1:3010/api').replace(/\/$/, '');
const LITELLM = (process.env.LITELLM_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const LITELLM_KEY = process.env.LITELLM_ADMIN_KEY || process.env.LITELLM_MASTER_KEY || '';

// Fixed question file: the first five carry a value, a date and a law article that the quality check asks for later.
const PERGUNTAS = [
  'Registre estes dados do processo 2025/00481: contrato de R$ 187.450,00, assinado em 14/03/2025, com base no art. 75, inciso II, da Lei 14.133/2021. Responda só "registrado".',
  'O prazo de vigência é de 12 meses, a contar de 01/04/2025, e a garantia contratual é de 5% do valor. Responda só "anotado".',
  'A empresa contratada é a Alfa Serviços Ltda., CNPJ 12.345.678/0001-90, e o fiscal do contrato é o servidor da Secretaria de Obras. Responda só "ok".',
  'Segundo o art. 156 da Lei 14.133/2021, quais são as sanções administrativas? Responda em até duas frases.',
  'Houve um aditivo de R$ 23.100,00 em 30/09/2025, dentro do limite do art. 125. Responda só "ciente".',
  'Explique em duas frases a diferença entre dispensa e inexigibilidade de licitação.',
  'Qual o prazo para impugnar um edital segundo a Lei 14.133/2021? Responda em uma frase.',
  'Liste em uma frase os requisitos de habilitação jurídica.',
  'O pregão eletrônico é obrigatório para quais bens? Responda em uma frase.',
  'O que é o Estudo Técnico Preliminar (ETP)? Responda em uma frase.',
  'Qual o valor limite de dispensa para compras em 2025, em linhas gerais? Responda em uma frase.',
  'O que diz o art. 37, inciso XXI, da Constituição Federal? Responda em uma frase.',
  'Quando cabe a prorrogação de um contrato de serviço contínuo? Responda em uma frase.',
  'O que é o Termo de Referência? Responda em uma frase.',
  'Qual o papel do agente de contratação? Responda em uma frase.',
  'Para que serve a matriz de riscos? Responda em uma frase.',
  'Em que casos o contrato pode ser rescindido unilateralmente? Responda em uma frase.',
  'O que é o Portal Nacional de Contratações Públicas (PNCP)? Responda em uma frase.',
  'Qual o prazo máximo de pagamento a fornecedores, em dias, em linhas gerais? Responda em uma frase.',
  'O que é a ata de registro de preços? Responda em uma frase.',
  'Qual a função do parecer jurídico na fase preparatória? Responda em uma frase.',
  'Cite uma hipótese de nulidade da licitação. Responda em uma frase.',
  'O que é o critério de julgamento por menor preço? Responda em uma frase.',
  'Para encerrar, diga em uma frase o que um fiscal de contrato deve registrar.',
];

function sessionToken() {
  if (process.env.SMOKE_TOKEN) return process.env.SMOKE_TOKEN;
  const file = path.join(root, 'output', 'preview-server', 'session.js');
  if (!fs.existsSync(file)) throw new Error('Sem sessão: rode `npm run local:session` ou defina SMOKE_TOKEN.');
  const match = fs.readFileSync(file, 'utf8').match(/"accessToken":"([^"]+)"/);
  if (!match) throw new Error('A sessão local não tem accessToken.');
  return match[1];
}

async function http(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const agente = args.agente;
  const total = Math.min(Number(args.mensagens) || PERGUNTAS.length, PERGUNTAS.length);
  const rotulo = String(args.rotulo || '');
  if (typeof agente !== 'string' || !['antes', 'depois'].includes(rotulo)) {
    console.error('Uso: node scripts/smoke-custo-conversa.cjs --agente <id> --mensagens 24 --rotulo antes|depois [--esperar-resumo]');
    process.exit(2);
  }
  if (!LITELLM_KEY) throw new Error('Defina LITELLM_ADMIN_KEY ou LITELLM_MASTER_KEY no ambiente.');
  const token = sessionToken();
  const inicio = new Date(Date.now() - (args.conversa ? 24 * 3600_000 : 60_000));

  // --conversa <id>: only measure a conversation that already ran (e.g. after the LiteLLM log flush).
  let conversationId = typeof args.conversa === 'string' ? args.conversa : undefined;
  const medirApenas = Boolean(conversationId);
  for (let i = 0; i < (medirApenas ? 0 : total); i++) {
    const r = await http(`${API}/agents/${agente}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: PERGUNTAS[i], ...(conversationId ? { conversationId } : {}) }),
    });
    if (r.status >= 300) throw new Error(`Mensagem ${i + 1} falhou (${r.status}): ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200)}`);
    conversationId ??= r.body.conversationId || r.body.conversation?.id;
    if (!conversationId) throw new Error('A resposta do chat não trouxe conversationId.');
  }

  // Direct database reads (ai_usage, audit_logs); the connection string stays in the environment.
  const { PrismaClient } = require(path.join(root, 'backend', 'node_modules', '@prisma', 'client'));
  const prisma = new PrismaClient();
  try {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { tenantId: true } });
    if (!conversation) throw new Error('Conversa não encontrada no banco.');

    // The summary job runs after the answer: wait for it (2 s steps, 60 s at most) when it is expected.
    const esperar = args['esperar-resumo'] === true || (rotulo === 'depois' && args['esperar-resumo'] !== 'nao');
    let resumo = null;
    if (esperar) {
      for (let t = 0; t < 30 && !resumo; t++) {
        resumo = await prisma.auditLog.findFirst({ where: { tenantId: conversation.tenantId, resourceId: conversationId, event: 'conversation.summary_created' }, select: { id: true } });
        if (!resumo) await sleep(2000);
      }
    }
    const rejeitados = await prisma.auditLog.count({ where: { tenantId: conversation.tenantId, resourceId: conversationId, event: 'conversation.summary_rejected' } });

    // LiteLLM side: every call tagged conversa:<id> (answers and summary calls), paged.
    const tag = `conversa:${conversationId}`;
    const fmt = date => date.toISOString().slice(0, 19).replace('T', ' ');
    const esperadas = await prisma.aiUsage.count({ where: { conversationId, cacheHit: false } });
    let chamadas = 0, entrada = 0, cache = 0, saida = 0, custo = 0;
    // LiteLLM writes spend logs in batches: poll (up to 60 s) until every non-cached call of the conversation shows up.
    for (let tentativa = 0; tentativa < 31; tentativa++) {
      chamadas = entrada = cache = saida = custo = 0;
      for (let pagina = 1; ; pagina++) {
        const query = new URLSearchParams({ end_user: conversation.tenantId, start_date: fmt(inicio), end_date: fmt(new Date(Date.now() + 60_000)), page: String(pagina), page_size: '100' });
        const r = await http(`${LITELLM}/spend/logs/v2?${query}`, { headers: { authorization: `Bearer ${LITELLM_KEY}` } });
        if (r.status !== 200) throw new Error(`/spend/logs/v2 respondeu ${r.status}.`);
        for (const row of r.body.data || []) {
          if (!(row.request_tags || []).includes(tag)) continue;
          chamadas++;
          entrada += row.prompt_tokens || 0;
          saida += row.completion_tokens || 0;
          const details = row.metadata?.usage_object?.prompt_tokens_details || {};
          cache += details.cached_tokens || 0;
          custo += Number(row.spend) || 0;
        }
        if (pagina >= (r.body.total_pages || 1) || !(r.body.data || []).length) break;
      }
      if (chamadas >= esperadas) break;
      await sleep(2000);
    }

    // Reconciliation with the i7Ai's own numbers.
    const usage = await prisma.aiUsage.findMany({ where: { conversationId }, select: { cost: true, inputTokens: true, cachedInputTokens: true, outputTokens: true, cacheHit: true, kind: true } });
    const aiCost = usage.reduce((sum, row) => sum + Number(row.cost), 0);
    const aiCache = usage.reduce((sum, row) => sum + row.cachedInputTokens, 0);

    console.log('rotulo; conversa; chamadas; tokens entrada; tokens cache; tokens saída; custo US$');
    console.log([rotulo, conversationId, chamadas, entrada, cache, saida, custo.toFixed(6)].join('; '));
    console.log(`conferência ai_usage: chamadas ${usage.length} (resumo ${usage.filter(row => row.kind === 'resumo').length}); tokens cache ${aiCache}; custo US$ ${aiCost.toFixed(6)}; diferença ${(aiCost - custo).toFixed(6)}`);
    console.log(`resumo: ${resumo ? 'criado' : esperar ? 'não apareceu em 60 s' : 'não esperado'}; conversation.summary_rejected: ${rejeitados}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
