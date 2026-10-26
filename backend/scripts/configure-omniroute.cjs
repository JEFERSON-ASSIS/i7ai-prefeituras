const fs = require('node:fs');
const path = require('node:path');
require('reflect-metadata');
const { PrismaClient } = require('@prisma/client');
const { AgentsService } = require('../dist/agents/agents.service');
const { gatewayBaseAllowed, isAllowedRoute, routePolicyMessage } = require('../dist/catalog/model-route-policy');

const envFile = [path.resolve('.env'), path.resolve('../.env')].find(file => fs.existsSync(file));
if (envFile) process.loadEnvFile(envFile);
const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const apply = args.includes('--apply');
const ids = (option('--models') || '').split(',').map(id => id.trim()).filter(Boolean);
const preset = option('--preset') || 'general';
const presets = {
  general: { name: 'Assistente da Prefeitura', description: 'Apoio geral às equipes municipais, com modelos reais do OmniRoute.' },
  licitacoes: { name: 'Assistente de Licitações', description: 'Apoio à organização do processo, análise de documentos e rascunhos de ETP, TR e edital para revisão da equipe.' },
  contratos: { name: 'Assistente de Contratos', description: 'Apoio à gestão e fiscalização: obrigações, vigência, evidências e rascunhos de relatórios e comunicações.' },
};
const agentName = (option('--agent') ?? presets[preset]?.name ?? '').trim();
const generalInstructions = [
  'Você é o assistente geral da prefeitura. Responda em português claro e profissional.',
  'Ajude a organizar informações, resumir documentos e preparar rascunhos para revisão da equipe.',
  'Use as fontes e arquivos autorizados quando disponíveis. Não invente leis, prazos, números, fontes ou atos administrativos.',
  'Quando faltarem dados, indique a lacuna e peça a informação necessária.',
  'Não afirme ter consultado sistemas, publicado documentos, aprovado pedidos ou executado ações sem uma ferramenta autorizada que confirme isso.',
  'Apresente documentos e orientações como rascunhos sujeitos à revisão do responsável municipal.',
].join('\n');
const prisma = new PrismaClient();

async function main() {
  if (args.some(value => value !== '--apply' && !/^--(?:models|agent|tenant|user|preset)=/.test(value))) throw new Error('Argumento desconhecido. Use --models=IDs e coloque nomes com espaços entre aspas.');
  if (!Object.hasOwn(presets, preset)) throw new Error('Use --preset=general, licitacoes ou contratos.');
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Informe IDs diferentes com --models=id1,id2. O primeiro será o padrão do novo agente.');
  if (!agentName || agentName.length > 160) throw new Error('Informe um nome de agente de até 160 caracteres.');
  const systemPrompt = preset === 'general' ? generalInstructions : fs.readFileSync(path.join(__dirname, '../presets', preset + '.pt-BR.txt'), 'utf8').trim();
  if (!systemPrompt || systemPrompt.length > 50000) throw new Error('O preset deve conter instruções de até 50 mil caracteres.');
  const base = new URL(process.env.OMNIROUTER_BASE_URL || '');
  if (!gatewayBaseAllowed(base)) throw new Error('Configure uma base HTTPS válida no ambiente privado.');
  const key = process.env.OMNIROUTER_API_KEY?.trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('Configure a credencial somente no ambiente privado do backend.');
  const response = await fetch(base.href.replace(/\/+$/, '') + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('Falha ao consultar o catálogo: HTTP ' + response.status);
  const payload = await response.json();
  if (!Array.isArray(payload.data)) throw new Error('O gateway não retornou um catálogo válido.');
  const models = ids.map(id => {
    const model = payload.data.find(item => item.id === id);
    if (!model || (model.type && !['chat', 'text', 'llm'].includes(model.type))) throw new Error('Modelo de chat não encontrado: ' + id);
    if (!isAllowedRoute(id)) throw new Error(routePolicyMessage(id));
    // Multi-family connections (antigravity/, kiro/) are attributed by model family.
    const provider = { openai: 'openai', anthropic: 'anthropic', gemini: 'google', xai: 'xai' }[id.split('/')[0].toLowerCase()]
      || (/claude|sonnet|opus|haiku/i.test(id) ? 'anthropic' : /gemini/i.test(id) ? 'google' : /grok/i.test(id) ? 'xai' : /gpt|\/o\d/i.test(id) ? 'openai' : undefined);
    if (!provider) throw new Error('Provedor não mapeado para a rota: ' + id);
    const capabilities = {};
    for (const [remote, local] of [['vision', 'supportsVision'], ['tool_calling', 'supportsTools'], ['reasoning', 'supportsReasoning'], ['temperature', 'supportsTemperature']]) {
      if (typeof model.capabilities?.[remote] === 'boolean') capabilities[local] = model.capabilities[remote];
    }
    const window = model.context_length || model.max_input_tokens;
    if (Number.isSafeInteger(window) && window >= 4096 && window <= 2000000) capabilities.contextWindow = window;
    if (Number.isSafeInteger(model.max_output_tokens) && model.max_output_tokens >= 1 && model.max_output_tokens <= 200000) capabilities.maxOutputTokens = model.max_output_tokens;
    return { id, name: (model.name || id).replace(/^[a-z0-9-]+\//i, ''), provider, capabilities };
  });
  const tenantId = option('--tenant');
  const tenants = await prisma.tenant.findMany({ where: tenantId ? { id: tenantId } : {}, select: { id: true, name: true } });
  if (tenants.length !== 1) throw new Error('Escolha a prefeitura explicitamente com --tenant=UUID.');
  const tenant = tenants[0];
  const actorId = option('--user');
  const users = await prisma.user.findMany({ where: { tenantId: tenant.id, status: 'ACTIVE', ...(actorId ? { id: actorId } : {}) }, select: { id: true } });
  if (users.length !== 1) throw new Error('Escolha o responsável ativo com --user=UUID.');
  const userId = users[0].id;
  const existingAgents = await prisma.agent.findMany({ where: { tenantId: tenant.id, name: agentName }, select: { id: true, status: true } });
  if (existingAgents.length > 1) throw new Error('Há mais de um agente com esse nome. Escolha um nome único.');
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'review', tenant: tenant.name, agentName, preset, agentExists: Boolean(existingAgents.length), models }));
  if (!apply) return;
  const saved = await prisma.$transaction(async tx => {
    const result = [];
    for (const model of models) {
      const provider = await tx.aiProvider.findUnique({ where: { slug: model.provider } });
      if (!provider) throw new Error('Cadastre o provedor antes de continuar: ' + model.provider);
      const where = { providerId_slug: { providerId: provider.id, slug: model.id } };
      const existing = await tx.aiModel.findUnique({ where });
      if (existing) { result.push(existing); continue; }
      const row = await tx.aiModel.create({ data: { providerId: provider.id, slug: model.id, name: model.name, capabilities: model.capabilities, inputPrice: null, outputPrice: null } });
      await tx.auditLog.create({ data: { tenantId: tenant.id, userId, event: 'model.created', resource: 'models', resourceId: row.id, metadata: { providerId: provider.id, slug: row.slug, source: 'omniroute-admin-configuration' } } });
      result.push(row);
    }
    return result;
  });
  const agents = new AgentsService(prisma);
  // Re-running configuration preserves prompts, status, bindings and model choices.
  const agent = existingAgents[0] || await agents.create(tenant.id, { name: agentName, description: presets[preset].description, systemPrompt, status: 'ACTIVE', modelId: saved[0].id, maxTokens: preset === 'general' ? 2048 : 4096, advancedReasoning: false }, userId);
  console.log(JSON.stringify({ configuredModels: saved.map(model => ({ id: model.id, slug: model.slug })), agent: { id: agent.id, name: agentName, status: agent.status } }));
}

main().catch(error => { console.error(error instanceof Error && !error.message.includes(process.env.OMNIROUTER_API_KEY || 'never-match') ? error.message : 'Falha ao configurar o gateway.'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
