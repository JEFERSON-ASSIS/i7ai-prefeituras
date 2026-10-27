import test from 'node:test';
import assert from 'node:assert/strict';
import {consumeChatEvents,readEvents} from '../src/api/event-stream.mjs';
const complete={conversationId:'persisted-id',answer:'Olá, ação!',messages:[{id:'saved-message'}]};
function body(text,size=1){const bytes=new TextEncoder().encode(text);let offset=0;return new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return;}controller.enqueue(bytes.slice(offset,offset+=size));}});}
test('reassembles UTF8 and CRLF events split into single-byte network chunks',async()=>{
  const delta=[];
  const result=await consumeChatEvents(body(': heartbeat\r\n\r\nevent: delta\r\ndata: {"text":"Olá, ação!"}\r\n\r\nevent: complete\r\ndata: '+JSON.stringify(complete)+'\r\n\r\n'),text=>delta.push(text));
  assert.equal(delta.join(''),complete.answer);assert.deepEqual(result,complete);
});
test('a gateway may complete without emitting artificial deltas',async()=>{
  let deltas=0;assert.deepEqual(await consumeChatEvents(body('event: complete\ndata: '+JSON.stringify(complete)+'\n\n',12),()=>deltas++),complete);assert.equal(deltas,0);
});
test('connection interruption and server errors never appear as a saved answer',async()=>{
  await assert.rejects(consumeChatEvents(body('event: delta\ndata: {"text":"Partial"}\n\n')),/antes de salvar/);
  await assert.rejects(consumeChatEvents(body('event: error\ndata: {"message":"Quota excedida"}\n\n')),/Quota excedida/);
});
test('supports multiline data and rejects malformed completion',async()=>{
  const events=[];for await(const event of readEvents(body('event: sample\ndata: {\ndata: "value":1}\n\n')))events.push(event);
  assert.deepEqual(events,[{event:'sample',data:{value:1}}]);
  await assert.rejects(consumeChatEvents(body('event: complete\ndata: {"answer":"not committed"}\n\n')),/não foi confirmada/);
});
test('progress events report the stage; unknown events are ignored',async()=>{
  const stages=[];
  const result=await consumeChatEvents(body('event: progress\ndata: {"etapa":"pesquisa_compras"}\n\nevent: novidade\ndata: {"x":1}\n\nevent: complete\ndata: '+JSON.stringify(complete)+'\n\n',7),()=>{},etapa=>stages.push(etapa));
  assert.deepEqual(stages,['pesquisa_compras']);assert.deepEqual(result,complete);
  assert.deepEqual(await consumeChatEvents(body('event: progress\ndata: {"etapa":"ferramenta"}\n\nevent: complete\ndata: '+JSON.stringify(complete)+'\n\n')),complete);
});
