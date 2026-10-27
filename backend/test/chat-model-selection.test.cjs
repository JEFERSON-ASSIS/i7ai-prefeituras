const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { AiGatewayService } = require('../dist/ai/ai-gateway.service');
const http = require('node:http');
const { ForbiddenException } = require('@nestjs/common');
const { quotaFixture } = require('./helpers/quota-fixture.cjs');
const { SgdmAccessService } = require('../dist/sgdm/sgdm-access.service');
const { ChatCatalogController } = require('../dist/ai/chat-catalog.controller');

const keys = ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'AI_GATEWAY_URL', 'OPENAI_API_KEY', 'NODE_ENV', 'SGDM_API_URL', 'SGDM_INTEGRATION_KEY', 'SGDM_ACCESS_CACHE_SECONDS'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
test.beforeEach(() => { keys.forEach(key => delete process.env[key]); process.env.OMNIROUTER_BASE_URL = 'https://fixture.invalid/v1'; process.env.OMNIROUTER_API_KEY = 'synthetic-fixture'; });
test.afterEach(() => keys.forEach(key => { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }));

function fixture(access) {
  const records = { messages: [], usage: [], audit: [], conversations: [], requests: [], preparedFiles: [] };
  const primary = { id: 'default-model', name: 'GPT', slug: 'original-model', inputPrice: null, outputPrice: null, provider: { name: 'OpenAI', slug: 'openai' } };
  const selected = { id: 'selected-model', name: 'Claude', slug: 'account-specific-claude', capabilities: { supportsTools: true, contextWindow: 32000 }, inputPrice: null, outputPrice: null, provider: { name: 'Anthropic', slug: 'anthropic', config: { apiKey: 'never-public' } } };
  const agent = { id: 'agent', tenantId: 'tenant', name: 'Gestão', status: 'ACTIVE', systemPrompt: 'Instruções originais do agente.', temperature: 0.2, maxTokens: 900, advancedReasoning: false, models: [{ isPrimary: true, model: primary }] };
  const prisma = {
    agent: { findFirst: async () => agent }, aiModel: { findUnique: async ({ where }) => where.id === selected.id ? selected : null },
    license: { findFirst: async () => null },
    conversation: { findFirst: async () => null, create: async ({ data }) => { records.conversations.push(data); return { id: 'conversation' }; }, update: async ({ data }) => { records.conversations.push(data); return data; } },
    message: { create: async ({ data }) => { const row = { id: 'message-' + records.messages.length, ...data }; records.messages.push(row); return row; } },
    document: { count: async () => 1 },
    aiUsage: { create: async ({ data }) => { records.usage.push(data); return data; } }, auditLog: { create: async ({ data }) => { records.audit.push(data); return data; } },
  };
  prisma.$transaction = async operation => operation(prisma);
  const quota = quotaFixture(prisma, records);
  const files = [{ id: 'file', name: 'relatório.txt', mimeType: 'text/plain', sizeBytes: '32', status: 'READY' }];
  const knowledge = { prepareChatAttachments: async (...args) => { records.preparedFiles.push(args); return { documents: files, text: '[Arquivo: relatório.txt]\nDespesa de 100 reais.', images: [] }; } };
  const omni = { generate: async input => { records.requests.push(input); return { answer: 'Análise concluída.', inputTokens: 30, outputTokens: 10, measured: true, toolCalls: [] }; } };
  const service = new AiGatewayService(prisma, { searchForAgent: async () => [] }, { load: async () => [] }, quota, knowledge, omni, access);
  return { service, records, prisma, agent, selected, files };
}

test('chat switches the execution model without modifying the agent default, and saves model snapshots', async () => {
  const { service, records, agent } = fixture();
  process.env.AI_GATEWAY_URL = 'https://legacy.invalid';
  const result = await service.chat('agent', 'tenant', { message: 'Olá', modelId: 'selected-model' }, 'user');
  assert.equal(records.requests[0].model.slug, 'account-specific-claude');
  assert.match(records.requests[0].instructions.fixed, /Instruções originais/);
  assert.equal(agent.models[0].model.id, 'default-model');
  assert.equal(records.conversations[0].modelId, 'selected-model');
  assert.equal(result.modelId, 'selected-model'); assert.equal(result.provider, 'anthropic');
  for (const message of records.messages) { assert.equal(message.metadata.modelName, 'Claude'); assert.equal(message.metadata.providerName, 'Anthropic'); }
  assert.ok(!JSON.stringify(result).includes('never-public'));
});

test('reopening a conversation restores its model and bounded historical context', async () => {
  const { service, records, prisma } = fixture();
  prisma.conversation.findFirst = async ({ where }) => { assert.equal(where.userId, 'user'); assert.equal(where.tenantId, 'tenant'); return { id: 'conversation', modelId: 'selected-model', messages: [{ role: 'assistant', content: 'Resposta anterior.' }, { role: 'user', content: 'Pergunta anterior.' }] }; };
  await service.chat('agent', 'tenant', { message: 'Continue', conversationId: 'conversation' }, 'user');
  assert.equal(records.requests[0].model.slug, 'account-specific-claude');
  assert.deepEqual(records.requests[0].history.map(item => item.role), ['user', 'assistant']);
  assert.equal(records.conversations[0].modelId, 'selected-model');
});

test('unknown selected models are rejected before provider generation or persistence', async () => {
  const { service, records } = fixture();
  await assert.rejects(service.chat('agent', 'tenant', { message: 'Olá', modelId: 'missing' }, 'user'), /Modelo não encontrado/);
  assert.equal(records.requests.length, 0); assert.equal(records.messages.length, 0);
});

test('owned attachments enter the model context and are linked to the user message only after completion', async () => {
  const { service, records } = fixture();
  await service.chat('agent', 'tenant', { message: 'Analise', modelId: 'selected-model', attachmentIds: ['file'] }, 'user');
  assert.deepEqual(records.preparedFiles[0], ['tenant', 'user', ['file']]);
  assert.match(records.requests[0].instructions.variable, /Despesa de 100 reais/);
  assert.deepEqual(records.messages[0].attachments.create, [{ documentId: 'file' }]);
  assert.equal(records.messages[0].metadata.attachments[0].name, 'relatório.txt');
  assert.equal(records.messages[1].attachments, undefined);
});

test('historical attachments are reauthorized for the current owner on every turn', async () => {
  const { service, prisma, records } = fixture();
  prisma.conversation.findFirst = async () => ({ id: 'conversation', modelId: 'selected-model', messages: [{ role: 'user', content: 'Analise este arquivo', attachments: [{ documentId: 'file' }] }] });
  await service.chat('agent', 'tenant', { message: 'Qual o total?', conversationId: 'conversation' }, 'user');
  assert.deepEqual(records.preparedFiles[0], ['tenant', 'user', ['file']]);
  assert.match(records.requests[0].instructions.variable, /100 reais/);
  assert.equal(records.messages[0].attachments, undefined);
});

test('model context and output limits are enforced before contacting the gateway', async () => {
  const { service, selected, records } = fixture();
  selected.capabilities = { contextWindow: 4096, maxOutputTokens: 100 };
  await service.chat('agent', 'tenant', { message: 'Olá', modelId: 'selected-model' }, 'user');
  assert.equal(records.requests[0].agent.maxTokens, 100);
  await assert.rejects(service.chat('agent', 'tenant', { message: 'x'.repeat(6000), modelId: 'selected-model' }, 'user'), /excedem o contexto/);
  assert.equal(records.requests.length, 1);
});

test('conversation responses expose safe attachment metadata without storage keys or owner IDs', async () => {
  const { service, prisma } = fixture();
  prisma.conversation.findFirst = async () => ({ id: 'conversation', messages: [{ role: 'user', content: 'arquivo', attachments: [{ document: { id: 'file', name: 'relatório.txt', mimeType: 'text/plain', sizeBytes: 32n, status: 'READY', ownerUserId: 'user', tenantId: 'tenant', storageKey: 'private/path' } }] }] });
  const response = await service.getConversation('tenant', 'user', 'conversation');
  assert.equal(response.messages[0].attachments[0].document.sizeBytes, '32');
  assert.ok(!JSON.stringify(response).includes('private/path'));
  assert.ok(!JSON.stringify(response).includes('ownerUserId'));
});

test('reopening long conversations retains the latest turn and attachment in chronological order', async () => {
  const { service, prisma } = fixture();
  const messages = Array.from({ length: 1002 }, (_, index) => ({ id: 'message-' + index, role: index % 2 ? 'assistant' : 'user', content: 'Turno ' + index, createdAt: new Date(index * 1000), attachments: [] }));
  messages[1000].attachments = [{ document: { id: 'recent-file', name: 'recente.txt', mimeType: 'text/plain', sizeBytes: 32n, status: 'READY', ownerUserId: 'user', tenantId: 'tenant' } }];
  prisma.conversation.findFirst = async ({ include }) => {
    const ordered = [...messages].sort((a, b) => include.messages.orderBy.createdAt === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
    return { id: 'conversation', messages: ordered.slice(0, include.messages.take) };
  };
  const response = await service.getConversation('tenant', 'user', 'conversation');
  assert.equal(response.messages.length, 1000);
  assert.equal(response.messages[0].id, 'message-2');
  assert.equal(response.messages.at(-1).id, 'message-1001');
  assert.equal(response.messages.at(-2).attachments[0].document.name, 'recente.txt');
});

test('the first call of a brand-new conversation already carries its id, which is the persisted one', async () => {
  const { service, records } = fixture();
  await service.chat('agent', 'tenant', { message: 'Olá' }, 'user');
  const id = records.requests[0].conversationId;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(records.conversations[0].id, id);
  assert.equal(records.conversations[0].theme, 'outros'); assert.equal(records.conversations[0].themeVersion, 1);
});

test('a failed first generation creates no conversation row', async () => {
  const { service, records } = fixture();
  const generate = service.omni.generate;
  service.omni.generate = async () => { throw new Error('gateway down'); };
  await assert.rejects(service.chat('agent', 'tenant', { message: 'Olá' }, 'user'), /gateway down/);
  assert.equal(records.conversations.length, 0);
  service.omni.generate = generate;
});

const NOT_ALLOWED = 'Este modelo não está liberado para você. Escolha outro no seletor do chat.';
async function sgdm(t, allowed) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(allowed));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.NODE_ENV = 'test';
  process.env.SGDM_API_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
  process.env.SGDM_INTEGRATION_KEY = 'integration-secret';
  return calls;
}
const forbidden = error => error instanceof ForbiddenException && error.message === NOT_ALLOWED;

test('modelId forçado de um modelo ativo não liberado é recusado com 403, sem chamada ao gateway', async t => {
  const calls = await sgdm(t, { modelos: ['original-model'], padrao: 'original-model' });
  const { service, records, selected } = fixture(new SgdmAccessService());
  selected.active = true;
  await assert.rejects(service.chat('agent', 'tenant', { message: 'Olá', modelId: 'selected-model' }, 'user'), forbidden);
  assert.equal(records.requests.length, 0); assert.equal(records.messages.length, 0);
  assert.deepEqual(calls, ['/api/v1/integracoes/i7ai/acesso/tenant?usuarioId=user']);
});

test('modelo principal do agente não liberado é recusado com 403', async t => {
  await sgdm(t, { modelos: ['account-specific-claude'], padrao: null });
  const { service, records } = fixture(new SgdmAccessService());
  await assert.rejects(service.chat('agent', 'tenant', { message: 'Olá' }, 'user'), forbidden);
  assert.equal(records.requests.length, 0);
  // The allowed one still runs.
  await service.chat('agent', 'tenant', { message: 'Olá', modelId: 'selected-model' }, 'user');
  assert.equal(records.requests.length, 1);
});

test('automação (sem userId) consulta acesso da prefeitura, sem usuarioId', async t => {
  const calls = await sgdm(t, { modelos: ['original-model'], padrao: 'original-model' });
  const { service, records } = fixture(new SgdmAccessService());
  await service.executeAgent('agent', 'tenant', { message: 'Rodar' });
  assert.deepEqual(calls, ['/api/v1/integracoes/i7ai/acesso/tenant']);
  assert.equal(records.requests.length, 1);
});

test('modelo inativo é recusado com a mesma mensagem, mesmo sem integração', async () => {
  const { service, records, selected } = fixture(new SgdmAccessService());
  selected.active = false;
  await assert.rejects(service.chat('agent', 'tenant', { message: 'Olá', modelId: 'selected-model' }, 'user'), forbidden);
  assert.equal(records.requests.length, 0);
});

test('/chat/catalog mostra só os modelos liberados e o defaultModelId do padrão', async t => {
  const calls = await sgdm(t, { modelos: ['anthropic/claude-sonnet-5', 'openai/gpt-5.5'], padrao: 'anthropic/claude-sonnet-5' });
  const models = [{ id: '1', slug: 'openai/gpt-5.5' }, { id: '2', slug: 'anthropic/claude-sonnet-5' }, { id: '3', slug: 'openai/o4-mini' }];
  const catalog = { activeModels: async () => models };
  const agents = { list: async () => [{ id: 'agent', status: 'ACTIVE' }, { id: 'draft', status: 'DRAFT' }] };
  const controller = new ChatCatalogController(agents, catalog, new SgdmAccessService());
  const result = await controller.list({ user: { tenantId: 'tenant', sub: 'user', roles: ['SUPER_ADMIN'] } });
  assert.deepEqual(result.models.map(model => model.id), ['1', '2']);
  assert.equal(result.defaultModelId, '2');
  assert.deepEqual(result.agents.map(agent => agent.id), ['agent']);
  assert.deepEqual(calls, ['/api/v1/integracoes/i7ai/acesso/tenant?usuarioId=user']);
  // Without integration every active model is offered and there is no default.
  delete process.env.SGDM_API_URL;
  const local = await new ChatCatalogController(agents, catalog, new SgdmAccessService()).list({ user: { tenantId: 'tenant', sub: 'user', roles: [] } });
  assert.equal(local.models.length, 3); assert.equal(local.defaultModelId, null);
});
