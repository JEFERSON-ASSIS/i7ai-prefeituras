const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PrismaClient, Prisma } = require('@prisma/client');
const { JwtService } = require('@nestjs/jwt');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const backendRoot = path.resolve(__dirname, '..');
const envPath = [path.join(backendRoot, '.env'), path.resolve(backendRoot, '../.env')].find(value => fs.existsSync(value));
if (envPath) process.loadEnvFile(envPath);

const schemaName = 'integration_' + Date.now() + '_' + randomBytes(6).toString('hex');
const queuePrefix = schemaName;
const jwtSecret = randomBytes(48).toString('hex');
const apiPort = 3001, gatewayPort = 3002;
const base = 'http://127.0.0.1:' + apiPort + '/api';
const gatewayUrl = 'http://127.0.0.1:' + gatewayPort;
const namespacePattern = /^integration_[0-9]{13}_[a-f0-9]{12}$/;
const tenants = [], gatewayCalls = [], ownedProcesses = new Set(), sensitiveValues = new Set([jwtSecret]);
const processDiagnostics = new WeakMap();
let prisma, childEnv, apiProcess, scanBytes, apiExited = false, gatewayStarted = false, schemaCreated = false, migrated = false, temporaryRoot, phase = 'preparação';
let lastHealth = 'nenhuma resposta recebida';

function validateNamespace() {
  assert.match(schemaName, namespacePattern, 'Namespace de integração inválido');
  assert.equal(queuePrefix, schemaName, 'A fila deve usar somente o namespace deste harness');
  assert.ok(!['public', 'pg_catalog', 'information_schema'].includes(schemaName));
}
function quoteIdentifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/, 'Identificador SQL inválido');
  return '"' + value + '"';
}
function localEndpoint(value, protocols, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(label + ' não está configurado para o teste local'); }
  assert.ok(protocols.includes(url.protocol), label + ': protocolo inválido');
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname.replace(/^\[|\]$/g, '')), label + ' deve apontar para uma dependência local');
  return url;
}
function configure() {
  validateNamespace();
  // Prepare the CPU/native-font fixture before opening HTTP connections. A
  // synchronous first canvas load must not stall the harness's socket lifecycle.
  scanBytes = require('../test/helpers/scanned-pdf.cjs').scannedPdfFixture();
  const database = localEndpoint(process.env.DATABASE_URL, ['postgres:', 'postgresql:'], 'PostgreSQL');
  database.searchParams.set('schema', schemaName);
  database.searchParams.set('connection_limit', '3');
  localEndpoint(process.env.REDIS_URL || 'redis://localhost:6379', ['redis:', 'rediss:'], 'Redis');
  localEndpoint(process.env.S3_ENDPOINT || 'http://localhost:9000', ['http:', 'https:'], 'Armazenamento S3');
  childEnv = { ...process.env, DATABASE_URL: database.toString(), NODE_ENV: 'test', PORT: String(apiPort),
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379', S3_ENDPOINT: process.env.S3_ENDPOINT || 'http://localhost:9000', S3_BUCKET: process.env.S3_BUCKET || 'i7ai-documents',
    AI_GATEWAY_URL: gatewayUrl, AI_GATEWAY_API_KEY: '', OMNIROUTER_BASE_URL: '', OMNIROUTER_API_KEY: '', OPENAI_API_KEY: '', EMBEDDING_API_KEY: '',
    OPENAI_BASE_URL: gatewayUrl, EMBEDDING_BASE_URL: gatewayUrl,
    SGDM_JWT_SECRET: jwtSecret, SGDM_JWT_ISSUER: 'fixture-sgdm', SGDM_JWT_AUDIENCE: 'i7ai-fixture', JWT_SECRET: '',
    QUEUE_PREFIX: queuePrefix, PGOPTIONS: '',
    TOOLS_ALLOW_PRIVATE_NETWORK: 'true',
  };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('TOOL_SECRET_')) childEnv[key] = '';
    if (/SECRET|PASSWORD|TOKEN|API_KEY|DATABASE_URL|REDIS_URL|S3_ACCESS_KEY|S3_SECRET_KEY/.test(key) && childEnv[key]) sensitiveValues.add(childEnv[key]);
  }
  for (const value of Object.values(process.env)) if (typeof value === 'string' && value.length >= 8 && /(?:postgres|redis):\/\//i.test(value)) sensitiveValues.add(value);
  for (const source of ['dist/main.js', 'dist/automations/automations.service.js', 'dist/knowledge/document-pipeline.service.js']) {
    assert.ok(fs.existsSync(path.join(backendRoot, source)), 'Execute o build do backend antes da integração');
  }
  for (const source of ['dist/automations/automations.service.js', 'dist/knowledge/document-pipeline.service.js']) {
    assert.ok(fs.readFileSync(path.join(backendRoot, source), 'utf8').includes('QUEUE_PREFIX'), 'O build precisa incluir o isolamento QUEUE_PREFIX dos dois workers');
  }
  prisma = new PrismaClient({ datasources: { db: { url: childEnv.DATABASE_URL } } });
}
function safeText(value, limit = 400) {
  let message = String(value).replace(/\x1b\[[0-9;]*m/g, '');
  for (const secret of [...sensitiveValues].filter(value => value.length >= 4).sort((a, b) => b.length - a.length)) message = message.split(secret).join('[REDACTED]');
  return message.replace(/(?:https?|postgres(?:ql)?|rediss?):\/\/[^\s'"<>]+/gi, '[ENDPOINT]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/((?:password|secret|api[_-]?key|authorization|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/[\r\n]+/g, ' ').slice(0, limit);
}
function safeError(error) { return safeText(error instanceof Error ? error.message + (error.cause?.code ? ' (' + error.cause.code + ')' : '') : 'Erro inesperado'); }
function stage(value) { phase = value; console.log('[integration] ' + value); }
function showProcessDiagnostics(child) {
  const diagnostics = child && processDiagnostics.get(child);
  if (!diagnostics) return;
  console.error('[integration] ' + diagnostics.label + ': exit=' + (child.exitCode ?? 'running') + ', signal=' + (child.signalCode ?? 'none') + ', último health=' + lastHealth);
  for (const stream of ['stdout', 'stderr']) {
    const lines = diagnostics[stream].trim().split(/\r?\n/).slice(-16).filter(Boolean);
    if (!lines.length) { console.error('[integration] ' + stream + ': sem saída'); continue; }
    for (const line of lines) console.error('[integration] ' + stream + ': ' + safeText(line, 500));
  }
}
function expectStatus(result, expected, label) { assert.equal(result.status, expected, label + ': HTTP esperado ' + expected + ', recebido ' + result.status); }
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const gateway = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/search?') && req.method === 'GET') {
    const query = new URL(req.url, gatewayUrl).searchParams.get('q');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ results: [{ title: 'Pesquisa fixture: ' + query, url: 'https://prefeitura.example/lei', description: 'Resultado do provedor local de teste.' }] }));
    return;
  }
  if (req.url !== '/chat' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  try {
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 1024 * 1024) throw new Error('Entrada excessiva'); }
    const input = JSON.parse(text);
    gatewayCalls.push({ input, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ answer: 'Resposta do provedor simulado: o prazo é de 30 dias. [Fonte 1]', usage: { inputTokens: 120, outputTokens: 24 } }));
  } catch { res.writeHead(400); res.end(); }
});
async function listenGateway() {
  await new Promise((resolve, reject) => {
    const failure = () => reject(new Error('A porta 3002 do provedor simulado está ocupada ou indisponível'));
    gateway.once('error', failure);
    gateway.listen(gatewayPort, '127.0.0.1', () => { gateway.off('error', failure); gatewayStarted = true; resolve(); });
  });
}
async function assertApiPortAvailable() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error('A porta 3001 está ocupada. Nenhum processo existente será parado pelo harness')));
    probe.listen(apiPort, '127.0.0.1', () => probe.close(resolve));
  });
}

function spawnNode(args, label, timeoutMs = 120000) {
  const child = spawn(process.execPath, args, { cwd: backendRoot, env: childEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  ownedProcesses.add(child);
  // Keep bounded diagnostics in memory; output is redacted only when a failure
  // occurs so secrets split across stream chunks are still removed together.
  const diagnostics = { label, stdout: '', stderr: '' }; processDiagnostics.set(child, diagnostics);
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { diagnostics[stream] = (diagnostics[stream] + chunk.toString()).slice(-32768); });
  const completed = new Promise((resolve, reject) => {
    const timer = timeoutMs ? setTimeout(() => { child.kill(); reject(new Error(label + ' excedeu o tempo limite')); }, timeoutMs) : undefined;
    child.once('error', () => { if (timer) clearTimeout(timer); ownedProcesses.delete(child); reject(new Error('Não foi possível iniciar ' + label)); });
    child.once('exit', (code) => {
      if (timer) clearTimeout(timer); ownedProcesses.delete(child);
      if (code === 0) resolve(); else reject(new Error(label + ' terminou sem sucesso (código ' + (code ?? 'encerrado') + ')'));
    });
  });
  return { child, completed };
}
async function migrateIsolatedSchema() {
  const extensions = await prisma.$queryRaw(Prisma.sql`SELECT n.nspname FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`);
  assert.equal(extensions.length, 1, 'Ative previamente a extensão pgvector no PostgreSQL de desenvolvimento');
  const vectorNamespace = extensions[0].nspname;
  quoteIdentifier(vectorNamespace);
  validateNamespace();
  await prisma.$executeRawUnsafe('CREATE SCHEMA ' + quoteIdentifier(schemaName)); schemaCreated = true;
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), schemaName + '_'));
  const temporarySchema = path.join(temporaryRoot, 'schema.prisma');
  fs.copyFileSync(path.join(backendRoot, 'prisma/schema.prisma'), temporarySchema);
  const migrations = path.join(backendRoot, 'prisma/migrations');
  fs.cpSync(migrations, path.join(temporaryRoot, 'migrations'), { recursive: true });
  for (const entry of fs.readdirSync(path.join(temporaryRoot, 'migrations'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filename = path.join(temporaryRoot, 'migrations', entry.name, 'migration.sql');
    if (!fs.existsSync(filename)) continue;
    // The official SQL is qualified with public. Adapt only this disposable copy;
    // the source migrations remain intact and the existing extension is untouched.
    let sql = fs.readFileSync(filename, 'utf8').replace(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+vector\s*;/gi, '');
    assert.ok(!/CREATE\s+EXTENSION|ALTER\s+EXTENSION|DROP\s+EXTENSION/i.test(sql), 'Migration contém alteração de extensão não permitida no harness');
    sql = sql.replace(/"public"\s*\./g, quoteIdentifier(schemaName) + '.');
    assert.ok(!/\bpublic\s*\./i.test(sql), 'Migration contém namespace public não adaptado');
    sql = sql.replace(/\bvector\s*\(/g, quoteIdentifier(vectorNamespace) + '."vector"(');
    fs.writeFileSync(filename, sql, 'utf8');
  }
  const migration = spawnNode([require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', temporarySchema], 'Prisma migrate deploy');
  try { await migration.completed; } catch (error) { showProcessDiagnostics(migration.child); throw error; }
  migrated = true;
  const requiredTables = ['tenants', 'users', 'roles', 'permissions', 'agents', 'ai_models', 'documents', 'document_chunks', 'automations', 'schedules', 'ai_usage', '_prisma_migrations'];
  const tables = await prisma.$queryRaw(Prisma.sql`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schemaName} AND c.relkind IN ('r','p') AND c.relname IN (${Prisma.join(requiredTables)})`);
  assert.deepEqual(tables.map(row => row.relname).sort(), [...requiredTables].sort(), 'As tabelas devem estar exclusivamente no schema fixture esperado');
  const current = await prisma.$queryRaw(Prisma.sql`SELECT current_schema() AS schema, n.nspname AS tenants_schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass('tenants')`);
  assert.equal(current.length, 1, 'A tabela tenant deve resolver dentro do namespace fixture');
  assert.equal(current[0].schema, schemaName, 'O search_path Prisma deve iniciar no schema fixture');
  assert.equal(current[0].tenants_schema, schemaName, 'O Prisma nunca deve resolver tenants em public');
  assert.equal(await prisma.tenant.count(), 0, 'O schema fixture deve iniciar sem registros');
  console.log('[integration] migrations e resolução Prisma confirmadas no namespace exclusivo');
}

async function seedFixtureCatalogue() {
  const resources = ['dashboard', 'agents', 'models', 'departments', 'knowledge-bases', 'documents', 'tools', 'conversations', 'automations', 'schedules', 'executions', 'reports', 'users', 'settings', 'licensing'];
  for (const name of ['ADMIN', 'VISUALIZADOR']) {
    const role = await prisma.role.create({ data: { name } });
    for (const resource of resources) for (const action of name === 'ADMIN' ? ['read', 'write', 'execute'] : ['read']) {
      const permission = await prisma.permission.upsert({ where: { resource_action: { resource, action } }, update: {}, create: { resource, action } });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
  }
  const provider = await prisma.aiProvider.upsert({ where: { slug: 'openai' }, update: {}, create: { name: 'Provedor de teste local', slug: 'openai' } });
  await prisma.aiModel.create({ data: { providerId: provider.id, name: 'Modelo simulado da integração', slug: 'integration-fixture-model', inputPrice: 1, outputPrice: 2 } });
}
async function startApi() {
  const started = spawnNode([path.join(backendRoot, 'dist/main.js')], 'API fixture', 0);
  apiProcess = started.child;
  started.completed.catch(() => { apiExited = true; });
  // Cold module loading on a Windows/OneDrive workspace can exceed 45 seconds.
  // Requests stay bounded and progress is reported throughout initialization.
  const deadline = Date.now() + 120000;
  let nextProgress = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (apiExited || apiProcess.exitCode !== null) throw new Error('A API fixture encerrou durante a inicialização');
    try {
      // The real health endpoint gives its S3 dependency up to three seconds.
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(4500) });
      const body = await response.json().catch(() => null);
      lastHealth = 'HTTP ' + response.status + (body ? ': ' + safeText(JSON.stringify(body), 500) : '');
      if (response.ok) { console.log('[integration] API própria pronta; ' + lastHealth); return; }
    } catch (error) { lastHealth = safeError(error); }
    if (Date.now() >= nextProgress) { console.log('[integration] aguardando API própria; ' + lastHealth); nextProgress = Date.now() + 10000; }
    await delay(250);
  }
  throw new Error('A API fixture não respondeu ao health check no tempo limite');
}
async function request(route, token, method = 'GET', body) {
  assert.ok(apiProcess && apiProcess.exitCode === null && !apiExited, 'A API deve pertencer ao processo deste harness');
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(20000), headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => null); return { status: response.status, data };
}
async function fixture(index) {
  const tenant = await prisma.tenant.create({ data: { slug: schemaName + '-' + index, name: 'Prefeitura de Teste Integrado ' + index } }); tenants.push(tenant.id);
  await prisma.license.create({ data: { tenantId: tenant.id, maxUsers: 10, maxAgents: 10, maxAutomations: 10, maxKnowledgeBases: 10, maxTokens: 100000n } });
  const password = 'Test-only-' + randomUUID(), email = schemaName + '-' + index + '@example.invalid'; sensitiveValues.add(password);
  const user = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Usuário de Teste', email, status: 'ACTIVE' } });
  const admin = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: admin.id } });
  // Prove JWT + fixture identity before any API mutation. An unrelated process
  // racing for the port cannot authenticate this independently generated secret.
  const jwt = new JwtService({ secret: jwtSecret });
  const probeToken = jwt.sign({ sub: user.id, tenantId: tenant.id, email: user.email }, { issuer: 'fixture-sgdm', audience: 'i7ai-fixture', expiresIn: '1h' }); sensitiveValues.add(probeToken);
  const identity = await request('/auth/me', probeToken); expectStatus(identity, 200, 'Identidade da API fixture'); assert.equal(identity.data.tenantId, tenant.id);
  expectStatus(await request('/auth/login', null, 'POST', { email, password }), 404, 'Login próprio removido');
  return { tenant, user, token: probeToken };
}
async function poll(route, token, predicate) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const result = await request(route, token); expectStatus(result, 200, route); if (predicate(result.data)) return result.data; await delay(300); }
  throw new Error('Tempo limite na validação integrada: ' + route);
}
async function verifySse(agent, token, conversationId, documentId) {
  assert.ok(apiProcess && apiProcess.exitCode === null && !apiExited, 'SSE deve usar somente a API deste harness');
  const response = await fetch(base + '/agents/' + agent.id + '/chat/stream', { method: 'POST', signal: AbortSignal.timeout(20000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Confirme o prazo de publicação.', conversationId }) });
  assert.ok([200, 201].includes(response.status), 'SSE POST deve responder com sucesso HTTP 200/201'); assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const text = await response.text();
  const events = text.split(/\r?\n\r?\n/).filter(frame => frame.trim() && !frame.startsWith(':')).map(frame => {
    const lines = frame.split(/\r?\n/); return { event: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')) };
  });
  assert.ok(!events.some(event => event.event === 'delta'), 'Gateway JSON não deve produzir deltas artificiais');
  assert.ok(!events.some(event => event.event === 'error'), 'SSE não deve terminar com erro');
  const complete = events.filter(event => event.event === 'complete'); assert.equal(complete.length, 1, 'SSE deve confirmar conclusão uma vez');
  assert.equal(complete[0].data.conversationId, conversationId); assert.ok(complete[0].data.answer.includes('30 dias'));
  assert.ok(complete[0].data.sources.some(source => source.documentId === documentId)); assert.equal(complete[0].data.messages.length, 2);
}

async function verifyFlows() {
  stage('JWT e fixtures'); const a = await fixture(1), b = await fixture(2);
  expectStatus(await request('/agents'), 401, 'Token ausente');
  const jwt = new JwtService({ secret: jwtSecret });
  const malformed = jwt.sign({ sub: a.user.id }); sensitiveValues.add(malformed); expectStatus(await request('/agents', malformed), 401, 'Claims incompletas');
  assert.equal((await request('/auth/me', a.token)).data.tenantId, a.tenant.id);
  stage('catálogo e agente');
  const models = await request('/models', a.token); expectStatus(models, 200, 'Modelos'); assert.equal(models.data.length, 1);
  const providers = await request('/providers', a.token); expectStatus(providers, 200, 'Provedores'); assert.ok(providers.data.every(provider => !('config' in provider)));
  // Modelos is read-only: the catalog comes from SGDM and prices from LiteLLM, so the write routes no longer exist.
  expectStatus(await request('/models/' + models.data[0].id, a.token, 'PATCH', { inputPrice: 99 }), 404, 'Catálogo de modelos sem rota de edição');
  expectStatus(await request('/models', a.token, 'POST', { providerId: models.data[0].providerId, name: 'Intruso', slug: 'intruso' }), 404, 'Catálogo de modelos sem rota de criação');
  const unchanged = await request('/models', a.token); expectStatus(unchanged, 200, 'Modelos após tentativas de escrita');
  assert.equal(unchanged.data.length, 1); assert.equal(unchanged.data[0].inputPrice, models.data[0].inputPrice);
  const department = await request('/departments', a.token, 'POST', { name: 'Compras' }); expectStatus(department, 201, 'Departamento');
  const knowledge = await request('/knowledge-bases', a.token, 'POST', { name: 'Licitações de Teste' }); expectStatus(knowledge, 201, 'Base de conhecimento');
  const creation = await request('/agents', a.token, 'POST', { name: 'Agente de Teste Integrado', description: 'Fixture local descartável', systemPrompt: 'Responda com fontes.', status: 'ACTIVE', departmentId: department.data.id, modelId: models.data[0].id, knowledgeBaseIds: [knowledge.data.id], toolIds: [], temperature: 0.2, maxTokens: 1000, advancedReasoning: false });
  expectStatus(creation, 201, 'Agente'); const agent = creation.data;
  expectStatus(await request('/agents/' + agent.id, b.token), 404, 'Isolamento do agente');
  const injection = await request('/agents', b.token, 'POST', { name: 'Vínculo indevido', systemPrompt: 'Teste', knowledgeBaseIds: [knowledge.data.id] }); assert.ok([400, 404].includes(injection.status));
  stage('upload e fila isolada');
  const form = new FormData(); form.append('knowledgeBaseId', knowledge.data.id); form.append('file', new Blob(['O prazo de publicação das licitações é de 30 dias. O portal municipal divulga os editais.'], { type: 'text/plain' }), 'prazo.txt');
  const uploaded = await request('/documents/upload', a.token, 'POST', form); expectStatus(uploaded, 201, 'Upload');
  await poll('/documents', a.token, items => items.some(item => item.id === uploaded.data.id && item.status === 'READY'));
  assert.equal((await request('/documents', b.token)).data.length, 0);
  stage('RAG, chat e histórico');
  const chat = await request('/agents/' + agent.id + '/chat', a.token, 'POST', { message: 'Qual o prazo de publicação das licitações?' }); expectStatus(chat, 201, 'Chat');
  assert.ok(chat.data.answer.includes('30 dias')); assert.ok(chat.data.sources.some(source => source.documentId === uploaded.data.id)); assert.equal(chat.data.usage.inputTokens, 120);
  assert.equal(gatewayCalls.at(-1).input.model, models.data[0].slug);
  const followup = await request('/agents/' + agent.id + '/chat', a.token, 'POST', { message: 'E onde os editais são divulgados?', conversationId: chat.data.conversationId }); expectStatus(followup, 201, 'Continuação do chat'); assert.ok(gatewayCalls.at(-1).input.history.length >= 2);
  const history = await request('/conversations/' + chat.data.conversationId, a.token); assert.equal(history.data.messages.length, 4);
  expectStatus(await request('/conversations/' + chat.data.conversationId, b.token), 404, 'Isolamento da conversa');
  stage('SSE com provedor JSON simulado'); await verifySse(agent, a.token, chat.data.conversationId, uploaded.data.id);
  assert.equal((await request('/conversations/' + chat.data.conversationId, a.token)).data.messages.length, 6);
  stage('modelo independente e anexos privados do chat');
  const catalog = await request('/chat/catalog', a.token); expectStatus(catalog, 200, 'Catálogo do chat');
  assert.ok(catalog.data.agents.some(item => item.id === agent.id)); assert.ok(catalog.data.agents.every(item => item.tenantId === a.tenant.id));
  const anthropic = await prisma.aiProvider.findUnique({ where: { slug: 'anthropic' } });
  const alternative = await prisma.aiModel.create({ data: { providerId: anthropic.id, name: 'Claude fixture', slug: 'integration-claude-fixture', capabilities: { supportsTools: true } } });
  const privateForm = new FormData(); privateForm.append('file', new Blob(['RELATORIO_PRIVADO_FIXTURE: a despesa total é de 123 reais.'], { type: 'text/plain' }), 'relatorio-privado.txt');
  const attachment = await request('/chat/attachments', a.token, 'POST', privateForm); expectStatus(attachment, 201, 'Anexo privado');
  assert.ok(!('storageKey' in attachment.data)); assert.ok(!('ownerUserId' in attachment.data));
  await poll('/chat/attachments/' + attachment.data.id, a.token, item => item.status === 'READY');
  const documents = await request('/documents', a.token); assert.ok(documents.data.every(item => item.id !== attachment.data.id));
  expectStatus(await request('/documents/' + attachment.data.id + '/download', a.token), 404, 'Anexo fora da área compartilhada');
  expectStatus(await request('/chat/attachments/' + attachment.data.id, b.token), 404, 'Anexo de outra prefeitura');
  const peer = await prisma.user.create({ data: { tenantId: a.tenant.id, name: 'Outro usuário fixture', email: randomUUID() + '@example.invalid', status: 'ACTIVE', roles: { create: { roleId: (await prisma.role.findUnique({ where: { name: 'ADMIN' } })).id } } } });
  const peerToken = jwt.sign({ sub: peer.id, tenantId: a.tenant.id }, { issuer: 'fixture-sgdm', audience: 'i7ai-fixture', expiresIn: '1h' }); sensitiveValues.add(peerToken);
  expectStatus(await request('/chat/attachments/' + attachment.data.id, peerToken), 404, 'Anexo de outro usuário da mesma prefeitura');
  const privateChat = await request('/agents/' + agent.id + '/chat', a.token, 'POST', { message: 'Analise o relatório anexado.', conversationId: chat.data.conversationId, modelId: alternative.id, attachmentIds: [attachment.data.id] }); expectStatus(privateChat, 201, 'Chat com modelo e anexo');
  assert.equal(privateChat.data.modelId, alternative.id); assert.equal(gatewayCalls.at(-1).input.model, alternative.slug);
  assert.ok(gatewayCalls.at(-1).input.agent.systemPrompt.includes('RELATORIO_PRIVADO_FIXTURE'));
  assert.equal((await prisma.agentModel.findFirst({ where: { agentId: agent.id, isPrimary: true } })).modelId, models.data[0].id);
  const privateHistory = await request('/conversations/' + chat.data.conversationId, a.token);
  assert.equal(privateHistory.data.modelId, alternative.id);
  assert.equal(privateHistory.data.messages.at(-2).attachments[0].document.id, attachment.data.id);
  assert.ok(!JSON.stringify(privateHistory.data).includes('storageKey'));
  expectStatus(await request('/chat/attachments/' + attachment.data.id, a.token, 'DELETE'), 409, 'Anexo vinculado não é removido isoladamente');
  const callsBeforeIdor = gatewayCalls.length;
  expectStatus(await request('/agents/' + agent.id + '/chat', peerToken, 'POST', { message: 'Acesso indevido', modelId: alternative.id, attachmentIds: [attachment.data.id] }), 404, 'Uso de anexo alheio');
  assert.equal(gatewayCalls.length, callsBeforeIdor);
  const invalidForm = new FormData(); invalidForm.append('file', new Blob(['arquivo ZIP falso'], { type: 'application/zip' }), 'nao-suportado.zip');
  expectStatus(await request('/chat/attachments', a.token, 'POST', invalidForm), 400, 'ZIP não suportado');
  stage('execução e agendamento');
  const automation = await request('/automations', a.token, 'POST', { name: 'Rotina Integrada', agentId: agent.id, status: 'ACTIVE', timeoutSeconds: 30, retries: 1, steps: [{ name: 'Consultar agente', actionType: 'AGENT', configuration: { prompt: 'Qual o prazo das licitações?' } }] }); expectStatus(automation, 201, 'Automação');
  const executed = await request('/automations/' + automation.data.id + '/run', a.token, 'POST', { input: { test: true } }); expectStatus(executed, 201, 'Execução');
  const completed = await poll('/executions', a.token, items => items.some(item => item.id === executed.data.id && item.status === 'SUCCESS')); assert.ok(completed.find(item => item.id === executed.data.id).durationMs >= 0);
  const schedule = await request('/automations/' + automation.data.id + '/schedules', a.token, 'POST', { name: 'Agenda de Teste', cronExpression: '0 8 * * *', timezone: 'America/Cuiaba', enabled: true }); expectStatus(schedule, 201, 'Agendamento'); assert.ok(schedule.data.nextRunAt);
  expectStatus(await request('/automations/' + automation.data.id, b.token), 404, 'Isolamento da automação');
  stage('consumo, auditoria e permissões');
  assert.equal(gatewayCalls.length, 5, 'Somente cinco chamadas ao provedor local simulado'); assert.ok(gatewayCalls.every(call => !call.authorization && ['integration-fixture-model', 'integration-claude-fixture'].includes(call.input.model)));
  const dashboard = await request('/dashboard', a.token); expectStatus(dashboard, 200, 'Dashboard'); assert.equal(dashboard.data.agents, 1); assert.equal(dashboard.data.requests, gatewayCalls.length);
  const audit = await request('/audit', a.token); expectStatus(audit, 200, 'Auditoria'); assert.ok(audit.data.some(item => item.event === 'agent.chat_completed'));
  const license = await request('/licensing', a.token); expectStatus(license, 200, 'Licenciamento'); assert.equal(license.data.usage.agents, 1);
  const users = await request('/users', a.token); assert.ok(users.data.every(user => !('passwordHash' in user)));
  const viewer = await prisma.role.findUnique({ where: { name: 'VISUALIZADOR' } });
  await prisma.userRole.deleteMany({ where: { userId: a.user.id } }); await prisma.userRole.create({ data: { userId: a.user.id, roleId: viewer.id } });
  expectStatus(await request('/agents', a.token, 'POST', { name: 'Não permitido', systemPrompt: 'Teste' }), 403, 'Perfil de leitura'); expectStatus(await request('/agents', a.token), 200, 'Leitura do perfil');
  await prisma.userRole.deleteMany({ where: { userId: a.user.id } }); const admin = await prisma.role.findUnique({ where: { name: 'ADMIN' } }); await prisma.userRole.create({ data: { userId: a.user.id, roleId: admin.id } });
  expectStatus(await request('/automations/' + automation.data.id + '/schedules/' + schedule.data.id, a.token, 'DELETE'), 200, 'Remoção do agendamento fixture');
  stage('reserva de quota concorrente em PostgreSQL');
  const { AiQuotaService } = require('../dist/ai/ai-quota.service');
  const quota = new AiQuotaService(prisma);
  const quotaTenant = await fixture(3);
  await prisma.license.updateMany({ where: { tenantId: quotaTenant.tenant.id }, data: { maxTokens: 5000n } });
  const scope = quota.scope({ tenantId: quotaTenant.tenant.id, agentId: agent.id, modelId: models.data[0].id, inputPrice: 1, outputPrice: 2 });
  // Reserve-only test avoids mixing the fixture agent's tenant with metered rows.
  const reservations = await Promise.allSettled([quota.reserve(scope, 3000n), quota.reserve({ ...scope, runId: randomUUID() }, 3000n)]);
  assert.equal(reservations.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(reservations.filter(result => result.status === 'rejected').length, 1);
  const accepted = reservations.find(result => result.status === 'fulfilled').value;
  await prisma.aiTokenReservation.update({ where: { id: accepted.id }, data: { status: 'REJECTED', reservedTokens: 0n } });
  assert.ok(await quota.reserve({ ...scope, runId: randomUUID() }, 3000n));
  stage('retenção com corte de data e isolamento em PostgreSQL');
  const { RetentionService } = require('../dist/retention/retention.service');
  const retention = new RetentionService(prisma);
  const oldDate = new Date(Date.now() - 40 * 86400000);
  const foreignAgent = await prisma.agent.create({ data: { tenantId: b.tenant.id, name: 'Agente estrangeiro fixture', systemPrompt: 'Fixture' } });
  const oldConversation = await prisma.conversation.create({ data: { tenantId: a.tenant.id, userId: a.user.id, agentId: agent.id, updatedAt: oldDate, messages: { create: { role: 'user', content: 'Conteúdo vencido fixture' } } } });
  const foreignConversation = await prisma.conversation.create({ data: { tenantId: b.tenant.id, userId: b.user.id, agentId: foreignAgent.id, updatedAt: oldDate } });
  const oldExecution = await prisma.automationExecution.create({ data: { tenantId: a.tenant.id, automationId: automation.data.id, agentId: agent.id, triggerType: 'MANUAL', status: 'SUCCESS', finishedAt: oldDate, input: { fixture: true }, output: { confidentialFixture: true } } });
  const activeExecution = await prisma.automationExecution.create({ data: { tenantId: a.tenant.id, automationId: automation.data.id, agentId: agent.id, triggerType: 'MANUAL', status: 'RUNNING', createdAt: oldDate, input: { fixture: true } } });
  const usageBefore = await prisma.aiUsage.count(); const documentsBefore = await prisma.document.count();
  assert.deepEqual(await retention.pruneTenant(a.tenant.id), { conversations: 0, executions: 0 });
  await prisma.tenant.update({ where: { id: a.tenant.id }, data: { settings: { retentionDays: 30 } } });
  assert.deepEqual(await retention.pruneTenant(a.tenant.id), { conversations: 1, executions: 1 });
  assert.equal(await prisma.conversation.findUnique({ where: { id: oldConversation.id } }), null);
  assert.equal(await prisma.message.count({ where: { conversationId: oldConversation.id } }), 0);
  assert.ok(await prisma.conversation.findUnique({ where: { id: foreignConversation.id } }));
  assert.ok(await prisma.conversation.findUnique({ where: { id: chat.data.conversationId } }));
  const purged = await prisma.automationExecution.findUnique({ where: { id: oldExecution.id } });
  assert.equal(purged.output, null); assert.equal(purged.input, null); assert.ok(purged.dataPurgedAt);
  assert.deepEqual((await prisma.automationExecution.findUnique({ where: { id: activeExecution.id } })).input, { fixture: true });
  assert.equal(await prisma.aiUsage.count(), usageBefore); assert.equal(await prisma.document.count(), documentsBefore);
  assert.deepEqual(await retention.pruneTenant(a.tenant.id), { conversations: 0, executions: 0 });
  stage('OCR de PDF digitalizado pela API, S3 e fila');
  const scan = new FormData(); scan.append('knowledgeBaseId', knowledge.data.id); scan.append('file', new Blob([scanBytes], { type: 'application/pdf' }), 'digitalizacao.pdf');
  const scanUpload = await request('/documents/upload', a.token, 'POST', scan); expectStatus(scanUpload, 201, 'Upload OCR');
  await poll('/documents', a.token, items => items.some(item => item.id === scanUpload.data.id && item.status === 'READY'));
  const scanChunks = await prisma.documentChunk.findMany({ where: { documentId: scanUpload.data.id } });
  assert.match(scanChunks.map(chunk => chunk.content).join(' '), /30 dias/i);
  stage('consulta interna e pesquisa externa pela API');
  const internal = await request('/tools', a.token, 'POST', { name: 'Documentos vinculados fixture', type: 'INTERNAL_DATABASE', config: { resource: 'documents', maxResults: 5 }, allowedDomains: [] }); expectStatus(internal, 201, 'Ferramenta interna');
  const external = await request('/tools', a.token, 'POST', { name: 'Pesquisa fixture', type: 'EXTERNAL_SEARCH', config: { endpoint: gatewayUrl + '/search', maxResults: 5 }, allowedDomains: ['127.0.0.1'] }); expectStatus(external, 201, 'Ferramenta de pesquisa');
  expectStatus(await request('/agents/' + agent.id, a.token, 'PATCH', { toolIds: [internal.data.id, external.data.id] }), 200, 'Vínculo das ferramentas fixture');
  const internalResult = await request('/tools/' + internal.data.id + '/test', a.token, 'POST', { agentId: agent.id, input: { query: 'digitalizacao', limit: 5 } }); expectStatus(internalResult, 201, 'Consulta interna');
  assert.equal(internalResult.data.data.length, 1); assert.equal(internalResult.data.data[0].id, scanUpload.data.id); assert.ok(!('storageKey' in internalResult.data.data[0]));
  const externalResult = await request('/tools/' + external.data.id + '/test', a.token, 'POST', { agentId: agent.id, input: { query: 'lei & gestão', limit: 5 } }); expectStatus(externalResult, 201, 'Pesquisa externa');
  assert.equal(externalResult.data.data[0].title, 'Pesquisa fixture: lei & gestão');
  const foreignTest = await request('/tools/' + internal.data.id + '/test', b.token, 'POST', { agentId: foreignAgent.id, input: { query: 'digitalizacao' } }); assert.ok([403, 404].includes(foreignTest.status));
  expectStatus(await request('/tools/' + internal.data.id + '/test', a.token, 'POST', { agentId: agent.id, input: { query: 'x', sql: 'SELECT * FROM users' } }), 400, 'SQL arbitrário recusado');
}

async function stopOwnedProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); });
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('O processo fixture ainda não encerrou')), 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGKILL');
    });
  }
}
async function withQueues(operation) {
  validateNamespace();
  const connection = new Redis(childEnv.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 1, connectTimeout: 3000, retryStrategy: () => null });
  connection.on('error', () => {});
  const queues = ['document.process', 'automation.execute'].map(name => new Queue(name, { connection, prefix: queuePrefix }));
  queues.forEach(queue => queue.on('error', () => {}));
  try { await operation(queues); }
  finally { await Promise.all(queues.map(queue => queue.close().catch(() => {}))); connection.disconnect(); }
}
async function cleanup() {
  const failures = [];
  const attempt = async (label, operation) => { try { await operation(); } catch { failures.push(label); } };
  if (childEnv && apiProcess && migrated) await attempt('finalização de workers fixture', () => withQueues(async queues => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if ((await Promise.all(queues.map(queue => queue.getActiveCount()))).every(count => count === 0)) return; await delay(150); }
  }));
  await attempt('processos fixture', async () => { for (const child of [...ownedProcesses]) await stopOwnedProcess(child); });
  const apiStopped = !apiProcess || apiProcess.exitCode !== null || apiProcess.signalCode !== null;
  if (childEnv && schemaCreated) await attempt('filas fixture', async () => { assert.ok(apiStopped, 'A API deve encerrar antes da limpeza da fila'); await withQueues(async queues => { for (const queue of queues) await queue.obliterate({ force: false }); }); });
  if (prisma && migrated) await attempt('arquivos S3 fixture', async () => {
    const documents = await prisma.document.findMany({ where: { tenantId: { in: tenants } }, select: { tenantId: true, storageKey: true } });
    const s3 = new S3Client({ endpoint: childEnv.S3_ENDPOINT || 'http://localhost:9000', region: childEnv.S3_REGION || 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: childEnv.S3_ACCESS_KEY || 'i7ai', secretAccessKey: childEnv.S3_SECRET_KEY || 'i7ai_dev_minio' } });
    try { for (const document of documents) { assert.ok(tenants.includes(document.tenantId) && document.storageKey.startsWith(document.tenantId + '/'), 'Arquivo fora da fixture'); await s3.send(new DeleteObjectCommand({ Bucket: childEnv.S3_BUCKET || 'i7ai-documents', Key: document.storageKey })); } }
    finally { s3.destroy(); }
  });
  if (prisma && schemaCreated) await attempt('schema fixture', async () => { assert.ok(apiStopped, 'A API deve encerrar antes da limpeza do schema'); validateNamespace(); await prisma.$executeRawUnsafe('DROP SCHEMA ' + quoteIdentifier(schemaName) + ' CASCADE'); schemaCreated = false; });
  if (prisma) await attempt('conexão Prisma', () => prisma.$disconnect());
  if (temporaryRoot) await attempt('arquivos temporários', async () => {
    validateNamespace();
    const resolved = fs.realpathSync(temporaryRoot), parent = fs.realpathSync(os.tmpdir());
    assert.ok(path.isAbsolute(resolved) && path.isAbsolute(parent), 'A limpeza temporária exige caminhos absolutos');
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase(), 'Pasta temporária fora do diretório autorizado');
    assert.ok(path.basename(resolved).startsWith(schemaName + '_'), 'Pasta temporária não pertence à fixture');
    fs.rmSync(resolved, { recursive: true, force: false });
  });
  if (gatewayStarted) await attempt('gateway fixture', async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  if (failures.length) { process.exitCode = 1; console.error('Limpeza incompleta apenas na fixture ' + schemaName + ': ' + failures.join(', ')); return false; }
  return true;
}
async function run() {
  configure();
  stage('disponibilidade das portas'); await listenGateway(); await assertApiPortAvailable();
  stage('schema isolado e migrations'); await migrateIsolatedSchema();
  stage('catálogo fixture'); await seedFixtureCatalogue();
  stage('inicialização da API própria'); await startApi();
  await verifyFlows();
}

run().then(() => true).catch(error => { process.exitCode = 1; console.error('Integração falhou em ' + phase + ': ' + safeError(error)); showProcessDiagnostics(apiProcess); return false; }).then(async passed => {
  const cleaned = await cleanup();
  if (passed && cleaned) console.log('Integração OK: schema e filas exclusivos removidos; JWT/perfis, isolamento, upload/RAG, chat/histórico/SSE, auditoria/consumo, automação/agendamento; ' + gatewayCalls.length + ' chamadas somente ao provedor local simulado.');
}).catch(() => { process.exitCode = 1; console.error('Falha ao encerrar o harness de integração; nenhum recurso fora da fixture foi selecionado para limpeza.'); });
