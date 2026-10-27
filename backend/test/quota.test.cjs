const test=require('node:test');
const assert=require('node:assert/strict');
require('reflect-metadata');
const {quotaFixture}=require('./helpers/quota-fixture.cjs');
function fixture(limit=10000n) {
 const records={usage:[]};let lock=Promise.resolve();
 const prisma={license:{findFirst:async()=>({status:'ACTIVE',startDate:new Date(Date.now()-86400000),endDate:null,maxTokens:limit})}, aiUsage:{create:async({data})=>{records.usage.push(data);return data;}}};
 prisma.$transaction=operation=>{const run=lock.then(()=>operation(prisma));lock=run.catch(()=>{});return run;};
 const quota=quotaFixture(prisma,records);
 const scope=quota.scope({tenantId:'tenant-a',agentId:'agent-a',modelId:'model-a',inputPrice:1,outputPrice:2,cacheWriteInputPrice:0,kind:'resposta'});
 return {quota,scope,records,prisma};
}
test('concurrent requests reserve tenant quota before provider execution',async()=>{
 const {quota,scope,records}=fixture(5000n);let calls=0;let release;
 const gate=new Promise(resolve=>release=resolve);
 const operation=record=>{calls++;return gate.then(()=>record({inputTokens:10,outputTokens:5,measured:true}));};
 const first=quota.runRound(scope,{message:'hello'},1000,operation);
 await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(quota.runRound({...scope,runId:'second'}, {message:'hello'},1000,operation),/Saldo/);
 release();await first;
 assert.equal(calls,1);assert.equal(records.reservations[0].reservedTokens,0n);
});
test('interrupted request retains unknown budget and measured failed usage is preserved',async()=>{
 const {quota,scope,records}=fixture();
 await assert.rejects(quota.runRound(scope,{message:'hello'},1000,async()=>{throw Error('disconnected');}));
 await quota.finish(scope,'FAILED');
 assert.equal(records.usage[0].usageMeasured,false);assert.equal(records.usage[0].status,'FAILED');assert.ok(records.reservations[0].reservedTokens>0n);
 await assert.rejects(quota.runRound(scope,{},100,async record=>{await record({inputTokens:20,outputTokens:6,measured:true});throw Error('incomplete');}));
 await quota.finish(scope,'FAILED');
 assert.equal(records.usage[1].inputTokens,20);assert.equal(records.usage[1].status,'FAILED');assert.equal(records.reservations[1].reservedTokens,0n);
});
test('repeated partial or final counters are idempotent and explicit rejection releases reservation',async()=>{
 const {quota,scope,records}=fixture();const reservation=await quota.reserve(scope,1000n);
 const usage={inputTokens:20,outputTokens:5,measured:false};
 await quota.record(scope,reservation.id,usage);await quota.record(scope,reservation.id,usage);
 assert.equal(reservation.reservedTokens,975n);assert.equal(records.usage.length,1);
 await quota.record(scope,reservation.id,{...usage,measured:true});await quota.record(scope,reservation.id,{...usage,measured:true});
 assert.equal(reservation.reservedTokens,0n);assert.equal(records.usage.length,1);
 await assert.rejects(quota.runRound(scope,{},100,async()=>{throw {status:429};}));
 assert.equal(records.reservations[1].status,'REJECTED');assert.equal(records.reservations[1].reservedTokens,0n);
 await assert.rejects(quota.record(scope,reservation.id,{inputTokens:-1,outputTokens:0,measured:true}),/inválidos/);
});

test('usage persistence retries P2028 before commit without repeating provider execution',async()=>{
 const {quota,scope,records,prisma}=fixture();
 const transaction=prisma.$transaction;let transactions=0;let providerCalls=0;
 prisma.$transaction=async operation=>{
  transactions++;
  if(transactions===2)throw Object.assign(new Error('Unable to start a transaction in the given time.'),{code:'P2028'});
  return transaction(operation);
 };
 const result=await quota.runRound(scope,{message:'hello'},100,async record=>{
  providerCalls++;await record({inputTokens:92,outputTokens:62,measured:true});return 'completed';
 });
 assert.equal(result,'completed');assert.equal(providerCalls,1);assert.equal(transactions,3);
 assert.equal(records.usage.length,1);assert.equal(records.usage[0].inputTokens,92);assert.equal(records.usage[0].outputTokens,62);assert.equal(records.usage[0].usageMeasured,true);
 assert.equal(records.reservations[0].status,'MEASURED');assert.equal(records.reservations[0].reservedTokens,0n);
});

test('usage persistence retries an ambiguous P2028 commit idempotently',async()=>{
 const {quota,scope,records,prisma}=fixture();
 const transaction=prisma.$transaction;let transactions=0;let providerCalls=0;let usageWrites=0;
 const upsert=prisma.aiUsage.upsert;prisma.aiUsage.upsert=async input=>{usageWrites++;return upsert(input);};
 prisma.$transaction=async operation=>{
  transactions++;const attempt=transactions;const result=await transaction(operation);
  if(attempt===2)throw Object.assign(new Error('Transaction result unavailable.'),{code:'P2028'});
  return result;
 };
 const result=await quota.runRound(scope,{message:'hello'},100,async record=>{
  providerCalls++;await record({inputTokens:92,outputTokens:62,measured:true});return 'completed';
 });
 assert.equal(result,'completed');assert.equal(providerCalls,1);assert.equal(transactions,3);assert.equal(usageWrites,1);
 assert.equal(records.usage.length,1);assert.equal(records.usage[0].inputTokens,92);assert.equal(records.usage[0].outputTokens,62);assert.equal(records.usage[0].usageMeasured,true);
 assert.equal(records.reservations[0].status,'MEASURED');assert.equal(records.reservations[0].reservedTokens,0n);
});

test('usage persistence retries final counters after a persisted partial report',async()=>{
 const {quota,scope,records,prisma}=fixture();
 const transaction=prisma.$transaction;let transactions=0;let providerCalls=0;
 prisma.$transaction=async operation=>{
  transactions++;
  if(transactions===3)throw Object.assign(new Error('Unable to start a transaction in the given time.'),{code:'P2028'});
  return transaction(operation);
 };
 await quota.runRound(scope,{message:'hello'},100,async record=>{
  providerCalls++;
  await record({inputTokens:92,outputTokens:5,measured:false});
  await record({inputTokens:92,outputTokens:62,measured:true});
 });
 assert.equal(providerCalls,1);assert.equal(transactions,4);assert.equal(records.usage.length,1);
 assert.equal(records.usage[0].inputTokens,92);assert.equal(records.usage[0].outputTokens,62);assert.equal(records.usage[0].usageMeasured,true);
 assert.equal(records.reservations[0].reservedTokens,0n);
});

test('usage persistence keeps the original reservation when P2028 retries are exhausted',async()=>{
 const {quota,scope,records,prisma}=fixture();
 const transaction=prisma.$transaction;let transactions=0;let providerCalls=0;
 const received=[];const record=quota.record.bind(quota);
 quota.record=async(scope,id,usage)=>{received.push({...usage});return record(scope,id,usage);};
 prisma.$transaction=async operation=>{
  transactions++;
  if(transactions>1)throw Object.assign(new Error('Unable to start a transaction in the given time.'),{code:'P2028'});
  return transaction(operation);
 };
 await assert.rejects(quota.runRound(scope,{message:'hello'},100,async report=>{
  providerCalls++;await report({inputTokens:92,outputTokens:62,measured:true});
 }),error=>error.code==='P2028');
 assert.equal(providerCalls,1);assert.equal(transactions,3);
 assert.deepEqual(received,[{inputTokens:92,outputTokens:62,measured:true}]);
 assert.equal(records.usage.length,0);assert.equal(records.reservations[0].status,'RESERVED');
 assert.equal(records.reservations[0].reservedTokens,BigInt(Buffer.byteLength(JSON.stringify({message:'hello'}),'utf8')+2048+100));
});

test('calculateUsageCost cobra tokens em cache pelo preço de cache', () => {
 const {calculateUsageCost}=require('../dist/ai/ai-gateway.service');
 assert.equal(calculateUsageCost(100,10,1,2,60,0.5),0.00009);
 assert.equal(calculateUsageCost(100,10,1,2),0.00012);
});

test('calculateUsageCost cobra tokens escritos no cache pelo preço de escrita (padrão: preço de entrada)', () => {
 const {calculateUsageCost}=require('../dist/ai/ai-quota.service');
 // (100 × 1 + 600 × 0,1 + 300 × 1,25 + 100 × 2) / 1e6
 assert.equal(calculateUsageCost(1000,100,1,2,600,0.1,300,1.25),0.000735);
 assert.equal(calculateUsageCost(1000,100,1,2,600,0.1,300),calculateUsageCost(1000,100,1,2,600,0.1));
});

test('record grava os fatos de economia e os padrões quando ausentes', async () => {
 const {quota,scope,records}=fixture();
 const withFacts={...scope,conversationId:'11111111-1111-1111-1111-111111111111',kind:'resumo',cacheWriteInputPrice:1.25,cachedInputPrice:0.1};
 await quota.runRound(withFacts,{m:'a'},100,record=>record({inputTokens:1000,outputTokens:100,measured:true,cachedInputTokens:600,cacheWriteInputTokens:300,cacheHit:true,historySavedTokens:4000,lowDetailImages:2,highDetailImages:1,requestHash:'a'.repeat(64),truncated:true}));
 const row=records.usage[0];
 assert.deepEqual([row.cacheWriteInputTokens,row.cacheHit,row.historySavedTokens,row.lowDetailImages,row.highDetailImages,row.requestHash,row.truncated,row.kind,row.conversationId,row.cost],
  [300,true,4000,2,1,'a'.repeat(64),true,'resumo','11111111-1111-1111-1111-111111111111',0.000735]);
 await quota.runRound({...scope,runId:'22222222-2222-2222-2222-222222222222'},{m:'b'},100,record=>record({inputTokens:10,outputTokens:1,measured:true}));
 const plain=records.usage[1];
 assert.deepEqual([plain.cacheWriteInputTokens,plain.cacheHit,plain.historySavedTokens,plain.lowDetailImages,plain.highDetailImages,plain.requestHash,plain.truncated,plain.kind,plain.conversationId],
  [0,false,0,0,0,null,false,'resposta',null]);
});

// Per-user limits from SGDM (Central de IA), enforced inside reserve().
const USER_MONTH = 'Você atingiu o seu limite de IA deste mês. Fale com o administrador da plataforma.';
const USER_MINUTE = 'Você atingiu o seu limite de uso de IA por minuto. Aguarde um instante e tente novamente.';
function userFixture(userLimits, limit = 1_000_000n) {
 const records = { usage: [] }; const lookups = [];
 const prisma = { license: { findFirst: async () => ({ status: 'ACTIVE', startDate: new Date(Date.now() - 86400000 * 400), endDate: null, maxTokens: limit }) }, aiUsage: { create: async ({ data }) => { records.usage.push(data); return data; } } };
 prisma.$transaction = operation => operation(prisma);
 const limits = { forUser: async (tenantId, userId) => { lookups.push([tenantId, userId]); return userLimits; } };
 const quota = quotaFixture(prisma, records, limits);
 const scope = quota.scope({ tenantId: 'tenant-a', agentId: 'agent-a', modelId: 'model-a', userId: 'user-a', inputPrice: 1, outputPrice: 2, cacheWriteInputPrice: 0, kind: 'resposta' });
 return { quota, scope, records, lookups };
}
const ago = ms => new Date(Date.now() - ms);
const limitsOf = values => ({ monthlyBudgetUsd: null, block: false, callsPerMinute: null, tokensPerMinute: null, ...values });
const refused = message => error => { assert.equal(error.getStatus(), 429); assert.equal(error.message, message); return true; };
const ok = async record => { await record({ inputTokens: 1, outputTokens: 1, measured: true }); return 'ok'; };

test('orçamento mensal do usuário com bloqueio: custo 10,00 de 10 recusa com 429 sem criar reserva', async () => {
 const { quota, scope, records, lookups } = userFixture(limitsOf({ monthlyBudgetUsd: 10, block: true }));
 records.usage.push({ tenantId: 'tenant-a', userId: 'user-a', cost: 6, inputTokens: 0, outputTokens: 0, createdAt: ago(1000) });
 records.usage.push({ tenantId: 'tenant-a', userId: 'user-a', cost: 4, inputTokens: 0, outputTokens: 0, createdAt: ago(2000) });
 records.usage.push({ tenantId: 'tenant-a', userId: 'user-b', cost: 50, inputTokens: 0, outputTokens: 0, createdAt: ago(1000) });
 let calls = 0;
 await assert.rejects(quota.runRound(scope, {}, 100, async record => { calls++; return ok(record); }), refused(USER_MONTH));
 assert.equal(calls, 0); assert.equal(records.reservations.length, 0);
 assert.deepEqual(lookups, [['tenant-a', 'user-a']]);
});

test('orçamento mensal sem bloqueio não recusa; gasto de outro usuário não conta', async () => {
 const { quota, scope, records } = userFixture(limitsOf({ monthlyBudgetUsd: 10, block: false }));
 records.usage.push({ tenantId: 'tenant-a', userId: 'user-a', cost: 12, inputTokens: 0, outputTokens: 0, createdAt: ago(1000) });
 assert.equal(await quota.runRound(scope, {}, 100, ok), 'ok');
 assert.equal(records.reservations.length, 1);
 const other = userFixture(limitsOf({ monthlyBudgetUsd: 10, block: true }));
 other.records.usage.push({ tenantId: 'tenant-a', userId: 'user-b', cost: 50, inputTokens: 0, outputTokens: 0, createdAt: ago(1000) });
 assert.equal(await other.quota.runRound(other.scope, {}, 100, ok), 'ok');
});

test('chamadas por minuto: 3 reservas nos últimos 60 s com limite 3 recusam; reserva de 61 s atrás não conta', async () => {
 const { quota, scope, records } = userFixture(limitsOf({ callsPerMinute: 3 }));
 for (const ms of [1000, 20000, 59000]) records.reservations.push({ id: 'r' + ms, runId: 'x', tenantId: 'tenant-a', userId: 'user-a', reservedTokens: 0n, status: 'MEASURED', createdAt: ago(ms) });
 await assert.rejects(quota.runRound(scope, {}, 100, ok), refused(USER_MINUTE));
 assert.equal(records.reservations.length, 3);
 records.reservations[2].createdAt = ago(61000);
 assert.equal(await quota.runRound(scope, {}, 100, ok), 'ok');
});

test('tokens por minuto: 900 usados de 1000 passam mesmo com reserva de imagem de 128000; 1000 usados recusam', async () => {
 const first = userFixture(limitsOf({ tokensPerMinute: 1000 }));
 first.records.usage.push({ tenantId: 'tenant-a', userId: 'user-a', cost: 0, inputTokens: 600, outputTokens: 300, createdAt: ago(30000) });
 first.records.usage.push({ tenantId: 'tenant-a', userId: 'user-a', cost: 0, inputTokens: 5000, outputTokens: 5000, createdAt: ago(61000) });
 assert.equal(await first.quota.runRound(first.scope, { image: true }, 100, ok, 128000), 'ok');
 const second = userFixture(limitsOf({ tokensPerMinute: 1000 }));
 second.records.usage.push({ tenantId: 'tenant-a', userId: 'user-a', cost: 0, inputTokens: 700, outputTokens: 300, createdAt: ago(30000) });
 await assert.rejects(second.quota.runRound(second.scope, {}, 100, ok), refused(USER_MINUTE));
 // Pending reservations of the user in the window count too.
 const third = userFixture(limitsOf({ tokensPerMinute: 1000 }));
 third.records.usage.push({ tenantId: 'tenant-a', userId: 'user-a', cost: 0, inputTokens: 300, outputTokens: 200, createdAt: ago(30000) });
 third.records.reservations.push({ id: 'pending', runId: 'x', tenantId: 'tenant-a', userId: 'user-a', reservedTokens: 500n, status: 'RESERVED', createdAt: ago(5000) });
 await assert.rejects(third.quota.runRound(third.scope, {}, 100, ok), refused(USER_MINUTE));
});

test('automação (sem userId) não consulta limites do usuário; a reserva criada leva o userId', async () => {
 const { quota, scope, records, lookups } = userFixture(limitsOf({ callsPerMinute: 1 }));
 const automation = { ...scope, userId: undefined, automationId: 'auto-a' };
 assert.equal(await quota.runRound(automation, {}, 100, ok), 'ok');
 assert.equal(await quota.runRound(automation, {}, 100, ok), 'ok');
 assert.equal(lookups.length, 0);
 assert.equal(await quota.runRound(scope, {}, 100, ok), 'ok');
 assert.equal(records.reservations[2].userId, 'user-a');
 assert.equal(lookups.length, 1);
});
