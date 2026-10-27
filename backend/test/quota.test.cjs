const test=require('node:test');
const assert=require('node:assert/strict');
require('reflect-metadata');
const {quotaFixture}=require('./helpers/quota-fixture.cjs');
function fixture(limit=10000n) {
 const records={usage:[]};let lock=Promise.resolve();
 const prisma={license:{findFirst:async()=>({status:'ACTIVE',startDate:new Date(Date.now()-86400000),endDate:null,maxTokens:limit})}, aiUsage:{create:async({data})=>{records.usage.push(data);return data;}}};
 prisma.$transaction=operation=>{const run=lock.then(()=>operation(prisma));lock=run.catch(()=>{});return run;};
 const quota=quotaFixture(prisma,records);
 const scope=quota.scope({tenantId:'tenant-a',agentId:'agent-a',modelId:'model-a',inputPrice:1,outputPrice:2});
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
