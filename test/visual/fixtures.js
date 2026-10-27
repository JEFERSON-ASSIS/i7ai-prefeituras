const now='2026-10-02T12:00:00Z';
const department={id:'dept-1',name:'Administração',description:'Gestão municipal',status:'ACTIVE'};
const provider={id:'provider-1',name:'OpenAI',slug:'openai',capabilities:{supported:true,directIntegration:false,gatewayIntegration:true,integrationConfigured:true}};
const anthropic={id:'provider-2',name:'Anthropic',slug:'anthropic',capabilities:{supported:true,gatewayIntegration:true,integrationConfigured:true}};
const google={id:'provider-3',name:'Google',slug:'google',capabilities:{supported:true,gatewayIntegration:true,integrationConfigured:true}};
const model={id:'model-1',name:'GPT',slug:'gpt-fixture',providerId:provider.id,provider,capabilities:{supportsVision:true,supportsTools:true,contextWindow:128000,maxOutputTokens:8000},inputPrice:1,outputPrice:2,_count:{agents:1}};
const claude={...model,id:'model-2',name:'Claude',slug:'claude-fixture',providerId:anthropic.id,provider:anthropic};
const gemini={...model,id:'model-3',name:'Gemini',slug:'gemini-fixture',providerId:google.id,provider:google,capabilities:{supportsVision:false,supportsTools:true,contextWindow:32768}};
const base={id:'base-1',name:'Legislação municipal',description:'Normas e orientações',status:'ACTIVE',updatedAt:now,_count:{documents:1,agents:1}};
const tool={id:'tool-1',name:'Consulta ao portal',type:'HTTP_REQUEST',description:'Consulta ao portal público municipal.',status:'ACTIVE',allowedDomains:['portal.example.test'],config:{endpoint:'https://portal.example.test',method:'GET'},credentials:[]};
const agent={id:'agent-1',name:'Assistente de Gestão',description:'Orientações para a administração municipal.',systemPrompt:'Responda com base nos documentos.',status:'ACTIVE',departmentId:department.id,department,models:[{modelId:model.id,isPrimary:true,model}],tools:[{toolId:tool.id,enabled:true,tool}],knowledgeBases:[{knowledgeBaseId:base.id}],temperature:0.2,maxTokens:4000};
const educationAgent={...agent,id:'agent-2',name:'Secretaria de Educação',description:'Orientações para a educação municipal.',models:[{modelId:claude.id,isPrimary:true,model:claude}]};
const attachment={id:'attachment-1',name:'relatorio.txt',mimeType:'text/plain',sizeBytes:32,status:'READY'};
const conversation={id:'conversation-1',title:'Orientação municipal',agentId:agent.id,agent:{id:agent.id,name:agent.name},modelId:model.id,model,createdAt:now,updatedAt:now};
const educationConversation={id:'conversation-2',title:'Relatório da educação',agentId:educationAgent.id,agent:{id:educationAgent.id,name:educationAgent.name},modelId:claude.id,model:claude,createdAt:now,updatedAt:now};
const schedule={id:'schedule-1',name:'Resumo diário',cronExpression:'0 8 * * 1-5',timezone:'America/Cuiaba',enabled:true,nextRunAt:now};
const automation={id:'automation-1',name:'Resumo de gestão',description:'Consolida informações do município.',agentId:agent.id,agent,status:'ACTIVE',timeoutSeconds:300,retries:2,steps:[{id:'step-1',name:'Preparar resumo',actionType:'AGENT',configuration:{prompt:'Prepare um resumo.'}}],schedules:[schedule]};
const execution={id:'execution-1',automation,agent,schedule,status:'SUCCESS',startedAt:now,finishedAt:now,createdAt:now,durationMs:2500,input:{},output:{result:{answer:'Resumo concluído.'},steps:[{stepId:'step-1',name:'Preparar resumo',actionType:'AGENT',output:{answer:'Orientações consolidadas.'}}]}};
const summaryConversation={...conversation,id:'conversation-3',title:'Conversa longa',summary:{content:'Resumo fixture: contrato 12/2026, valor R$ 1.500,00.',throughMessageId:'message-1',updatedAt:now},summaryDisabled:false,summaryActive:true};
const fullConversation={...conversation,id:'conversation-4',title:'Conversa completa',summary:null,summaryDisabled:true};
export const summaryConversations=[summaryConversation,fullConversation];
export const fixtures={
  '/auth/me':{id:'user-1',name:'Ana de Teste',email:'ana@example.test',roles:['SUPER_ADMIN'],permissions:['*']},
  '/agents':[agent,educationAgent],'/departments':[department],'/models':[model,claude,gemini],'/providers':[provider,anthropic,google],'/tools':[tool],'/knowledge-bases':[base],
  '/chat/catalog':{agents:[agent,educationAgent],models:[model,claude,gemini],defaultModelId:model.id},
  '/chat/attachments/capabilities':{extensions:['pdf','txt','csv','xlsx','docx','md','json','xml','html','htm','png','jpg','jpeg','webp'],maxFiles:5,maxBytes:20*1024*1024,imageMaxBytes:10*1024*1024},
  '/documents':[{id:'doc-1',name:'Guia municipal.pdf',knowledgeBaseId:base.id,status:'READY',sizeBytes:123000,updatedAt:now}],
  '/automations':[automation],'/executions':[execution],'/executions/execution-1':execution,
  '/conversations':[conversation,educationConversation],
  '/conversations/conversation-1':{...conversation,messages:[{id:'message-1',role:'user',content:'Como consultar as orientações?',createdAt:now},{id:'message-2',role:'assistant',content:'Consulte o guia municipal na base de conhecimento.',createdAt:now,metadata:{modelId:model.id,model:model.slug,modelName:model.name,providerName:provider.name,sources:[{id:'doc-1',documentName:'Guia municipal.pdf'}]}}]},
  '/conversations/conversation-3':{...summaryConversation,messages:[{id:'message-5',role:'user',content:'Pergunta antiga.',createdAt:now}]},
  '/conversations/conversation-4':{...fullConversation,messages:[{id:'message-6',role:'user',content:'Pergunta completa.',createdAt:now}]},
  '/conversations/conversation-2':{...educationConversation,messages:[{id:'message-3',role:'user',content:'Analise o relatório de educação.',createdAt:now,attachments:[{document:attachment}]},{id:'message-4',role:'assistant',content:'O relatório recomenda acompanhar a frequência escolar.',createdAt:now,metadata:{modelId:claude.id,model:claude.slug,modelName:claude.name,providerName:anthropic.name}}]},
  '/chat/attachments/attachment-1':attachment,
  '/dashboard':{agents:1,conversations:1,automations:1,documents:1,requests:3,inputTokens:1500,outputTokens:600,timezone:'America/Cuiaba',daily:[{date:'2026-10-01',inputTokens:800,outputTokens:300},{date:'2026-10-02',inputTokens:700,outputTokens:300}],executions:[{status:'SUCCESS',count:1}],recent:[{event:'Agente atualizado',resource:'agents',createdAt:now}]},
  '/reports':{inputTokens:1500,outputTokens:600,requests:3,cost:0.0027,models:[{name:model.name,provider:provider.name,inputTokens:1500,outputTokens:600,cost:0.0027,costConfigured:true}]},
  '/audit':[{id:'audit-1',event:'Agente atualizado',resource:'agents',user:{name:'Ana de Teste'},createdAt:now}],
};
export async function mockSession(page,{overrides={},writes=[],context={},writeHandler}={}) {
  await page.addInitScript(context=>{window.__SGDM_CONTEXT__={accessToken:'fixture-session',tenantName:'Prefeitura de Teste',organizationName:'SGDM',modulePage:new URLSearchParams(location.search).get('module')||'dashboard',navigationManagedByHost:false,...context};},context);
  await page.route('http://localhost:3000/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.replace(/^\/api/,'');
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}});
    const headers={'Access-Control-Allow-Origin':'*'};
    if(req.method()!=='GET'){
      writes.push({path,method:req.method(),body:req.postData()});
      if(writeHandler&&await writeHandler(route,{req,path,headers}))return;
      if(path.endsWith('/chat/stream')){
        const input=req.postDataJSON(),selected=fixtures['/models'].find(item=>item.id===input.modelId)||model;
        const messages=[{id:'saved-user-'+writes.length,role:'user',content:input.message,createdAt:now,metadata:{attachments:input.attachmentIds?.map(()=>attachment)||[]}},{id:'saved-assistant-'+writes.length,role:'assistant',content:'Resposta confirmada pelo servidor.',createdAt:now,metadata:{modelId:selected.id,model:selected.slug,modelName:selected.name,providerName:selected.provider.name}}];
        const complete={conversationId:input.conversationId||'conversation-new',answer:messages[1].content,messages};
        return route.fulfill({status:200,headers:{...headers,'Content-Type':'text/event-stream'},body:'event: delta\ndata: '+JSON.stringify({text:'Resposta confirmada pelo servidor.'})+'\n\nevent: complete\ndata: '+JSON.stringify(complete)+'\n\n'});
      }
      if(path==='/chat/attachments')return route.fulfill({status:200,json:{...attachment,status:'PROCESSING'},headers});
      return route.fulfill({status:200,json:{id:'fixture-new'},headers});
    }
    if(Object.hasOwn(overrides,path)){
      const result=overrides[path];if(result?.error)return route.fulfill({status:500,json:{message:result.error},headers});
      if(result?.delay)await new Promise(resolve=>setTimeout(resolve,result.delay));
      return route.fulfill({status:200,json:result?.data??result,headers});
    }
    if(!Object.hasOwn(fixtures,path))throw new Error('Unmocked endpoint: '+path);
    return route.fulfill({status:200,json:fixtures[path],headers});
  });
}
