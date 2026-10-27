import { test, expect } from '@playwright/test';
import { mockSession, fixtures } from './fixtures';
import fs from 'node:fs';
const folder='output/verification/sgdm/screenshots-embedded';
fs.mkdirSync(folder,{recursive:true});
const pages={dashboard:'Dashboard',chat:'Novo chat',agents:'Agentes de IA',models:'Modelos de IA',executions:'Execuções',knowledge:'Bases de conhecimento',documents:'Documentos',automations:'Automações',schedules:'Agendamentos',tools:'Ferramentas & MCP',integrations:'Integrações',reports:'Relatórios e consumo'};
for(const viewport of [{width:1440,height:1050},{width:390,height:844}]) {
  test(`12 páginas em ${viewport.width}px`,async({page})=>{
    test.setTimeout(120000);
    await page.setViewportSize(viewport);const errors=[];page.on('pageerror',error=>errors.push(error.message));await mockSession(page);
    for(const [route,title] of Object.entries(pages)) {
      await page.goto('/?module='+route);await expect(page.getByRole('region',{name:'IA do SGDM',exact:true}).getByRole('heading',{level:1,name:title,exact:true})).toBeVisible();
      await expect(page.getByRole('status').filter({hasText:'Carregando'})).toHaveCount(0);
      await page.evaluate(()=>document.fonts.ready);
      await expect.poll(()=>page.locator('body').innerText()).not.toMatch(/Carregando automações|Carregando execuções/);
      if(route==='chat'){await page.getByLabel('Agente da conversa').selectOption('agent-1');await page.getByRole('button',{name:'Orientação municipal'}).click();await expect(page.getByText('Consulte o guia municipal na base de conhecimento.')).toBeVisible();}
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),route+' horizontal overflow').toBe(true);
      await page.screenshot({path:`${folder}/${route}-${viewport.width}.png`,fullPage:true});
      const main=page.getByRole('region',{name:'IA do SGDM',exact:true});
      expect(await main.evaluate(el=>el.scrollWidth<=el.clientWidth+1),route+' main overflow').toBe(true);
      await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
      await page.screenshot({path:`${folder}/${route}-${viewport.width}-bottom.png`,fullPage:true});
      const tokens=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return {primary:s.getPropertyValue('--sd-color-primary').trim(),card:s.getPropertyValue('--sd-radius-card').trim(),control:s.getPropertyValue('--sd-radius-control').trim()};});
      expect(tokens).toEqual({primary:'30 64 175',card:'16px',control:'8px'});
    }
    expect(errors).toEqual([]);
  });
}
const editors=[['agents','Novo agente'],['knowledge','Nova base'],['automations','Nova automação'],['schedules','Novo agendamento'],['tools','Nova ferramenta']];
for(const [route,name] of editors) {
  test(`modal: ${name}`,async({page})=>{
    await mockSession(page);await page.goto('/?module='+route);const trigger=page.getByRole('button',{name,exact:true});await trigger.click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Shift+Tab');expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
    await page.screenshot({path:`${folder}/modal-${route}.png`,fullPage:true});await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused();
  });
}
test('Modelos é só consulta: sem "Novo modelo" e com o aviso do SGDM',async({page})=>{
  await mockSession(page);await page.goto('/?module=models');
  await expect(page.getByRole('heading',{level:1,name:'Modelos de IA',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Novo modelo'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Configurar'})).toHaveCount(0);
  await expect(page.getByText('Os modelos são ativados e liberados pelo dono da plataforma na Central de IA do SGDM. Os preços vêm do LiteLLM.')).toBeVisible();
  await expect(page.getByRole('cell',{name:'gpt-fixture'})).toBeVisible();
});
test('?module=users cai no Dashboard',async({page})=>{
  await mockSession(page);await page.goto('/?module=users');
  await expect(page.getByRole('region',{name:'IA do SGDM',exact:true}).getByRole('heading',{level:1,name:'Dashboard',exact:true})).toBeVisible();
});

for(const [type,name] of [['INTERNAL_DATABASE','Documentos vinculados'],['EXTERNAL_SEARCH','Pesquisa autorizada']]) {
  test(`cadastro da ferramenta ${type} usa formulário oficial e configuração válida`,async({page})=>{
    const writes=[];await mockSession(page,{writes});await page.goto('/?module=tools');await page.getByRole('button',{name:'Nova ferramenta'}).click();
    await page.getByLabel(/^Nome/).fill(name);await page.getByLabel('Tipo',{exact:true}).selectOption(type);
    if(type==='INTERNAL_DATABASE') { await expect(page.getByLabel('Domínios permitidos')).toHaveCount(0); }
    else { await page.getByLabel('Domínios permitidos').fill('search.example.test');await page.getByRole('textbox',{name:'Configuração',exact:true}).fill(JSON.stringify({endpoint:'https://search.example.test/search',queryParam:'q',maxResults:5})); }
    await page.screenshot({path:`${folder}/modal-${type.toLowerCase()}.png`,fullPage:true});
    await page.getByRole('button',{name:'Salvar ferramenta'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
    const body=JSON.parse(writes[0].body);expect(body.type).toBe(type);
    if(type==='INTERNAL_DATABASE') { expect(body.allowedDomains).toEqual([]);expect(body.config.resource).toBe('documents');expect(body.credentials).toEqual([]); }
    else expect(body.config.endpoint).toBe('https://search.example.test/search');
  });
}

test('execução com dados removidos mantém status e explica a retenção',async({page})=>{
  const item={...fixtures['/executions/execution-1'],input:null,output:null,dataPurgedAt:'2026-10-02T12:00:00Z'};
  await mockSession(page,{overrides:{'/executions':[item],'/executions/execution-1':item}});await page.goto('/?module=executions');
  await page.getByRole('button',{name:'Ver detalhes'}).click();await expect(page.getByText(/Os dados desta execução foram removidos/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Entrada',exact:true})).toHaveCount(0);
  await page.screenshot({path:`${folder}/execution-retention.png`,fullPage:true});
});

test('módulo licensing não existe mais e cai no Dashboard',async({page})=>{
  await mockSession(page);await page.goto('/?module=licensing');
  await expect(page.getByRole('region',{name:'IA do SGDM',exact:true}).getByRole('heading',{level:1,name:'Dashboard',exact:true})).toBeVisible();
  await expect(page.getByText('Licenciamento')).toHaveCount(0);
});

test('agente mantém as quatro etapas e salva configurações',async({page})=>{
  const writes=[];await mockSession(page,{writes});await page.goto('/?module=agents');await page.getByRole('button',{name:'Novo agente'}).click();await page.getByLabel(/^Nome/).fill('Agente de teste');await page.getByRole('button',{name:'Próximo'}).click();await page.getByLabel('Instruções do sistema').fill('Use os documentos municipais.');await page.getByRole('button',{name:'Próximo'}).click();await page.getByLabel('Modelo principal').selectOption('model-1');await page.getByRole('button',{name:'Próximo'}).click();await page.getByLabel('Legislação municipal').check();await page.getByRole('button',{name:'Salvar agente'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(JSON.parse(writes[0].body).knowledgeBaseIds).toEqual(['base-1']);
});
test('upload oficial mantém destino e envio multipart',async({page})=>{
  const writes=[];await mockSession(page,{writes});await page.goto('/?module=documents');await expect(page.getByRole('button',{name:'Carregar documento'})).toBeDisabled();await page.getByLabel('Base para upload').selectOption('base-1');await page.locator('input[type=file]').setInputFiles({name:'guia.txt',mimeType:'text/plain',buffer:Buffer.from('Guia de teste')});await expect(page.getByText('1 documento(s) enviado(s) para processamento.')).toBeVisible();expect(writes[0].path).toBe('/documents/upload');expect(writes[0].body).toContain('base-1');
});
test('vazio, falha e carregamento usam estados oficiais',async({page})=>{
  await mockSession(page,{overrides:{'/agents':[]}});await page.goto('/?module=agents');await expect(page.getByText('Nenhum agente encontrado. Crie um agente para começar.')).toBeVisible();await page.screenshot({path:`${folder}/empty.png`});
  await page.unroute('http://localhost:3000/api/**');await mockSession(page,{overrides:{'/agents':{error:'Falha de teste'}}});await page.reload();await expect(page.getByText('Falha de teste')).toBeVisible();await expect(page.getByRole('button',{name:'Tentar novamente'})).toBeVisible();await page.screenshot({path:`${folder}/error.png`});
  await page.unroute('http://localhost:3000/api/**');await mockSession(page,{overrides:{'/agents':{delay:1500,data:[]}}});await page.reload();await expect(page.getByRole('status').filter({hasText:'Carregando'})).toBeVisible();
});
test('navegação do módulo preserva a rota e a estrutura do SGDM',async({page})=>{
  await page.setViewportSize({width:390,height:844});await mockSession(page);await page.goto('/?module=dashboard#/sgdm/municipio');
  await page.evaluate(()=>{window.lastNavigation=null;window.addEventListener('i7ai:navigate',event=>window.lastNavigation=event.detail);});
  await page.getByLabel('Área da IA do SGDM').selectOption('agents');await expect(page.getByRole('heading',{level:1,name:'Agentes de IA',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>location.hash)).toBe('#/sgdm/municipio');expect(await page.evaluate(()=>window.lastNavigation)).toEqual({page:'agents'});
  await expect(page.getByRole('banner')).toHaveCount(0);await expect(page.getByRole('navigation')).toHaveCount(0);await expect(page.getByRole('button',{name:/Entrar|Sair/})).toHaveCount(0);
});

test('SGDM controla página e renovação de sessão sem login próprio',async({page})=>{
  await mockSession(page,{context:{navigationManagedByHost:true}});await page.goto('/');await expect(page.getByRole('heading',{level:1,name:'Dashboard',exact:true})).toBeVisible();await expect(page.getByLabel('Área da IA do SGDM')).toHaveCount(0);
  await page.evaluate(()=>{window.__SGDM_CONTEXT__.modulePage='agents';window.dispatchEvent(new Event('sgdm:context-updated'));});await expect(page.getByRole('heading',{level:1,name:'Agentes de IA',exact:true})).toBeVisible();
  await page.evaluate(()=>{window.sessionReason=null;window.addEventListener('i7ai:session-required',event=>window.sessionReason=event.detail.reason);window.dispatchEvent(new Event('i7ai:session-expired'));});
  await expect(page.getByText('Sessão do SGDM expirada',{exact:true})).toBeVisible();expect(await page.evaluate(()=>window.sessionReason)).toBe('expired');await expect(page.getByLabel(/^Senha/)).toHaveCount(0);
  await page.evaluate(()=>{window.__SGDM_CONTEXT__.accessToken='fixture-refreshed';window.dispatchEvent(new Event('sgdm:context-updated'));});await expect(page.getByRole('heading',{level:1,name:'Agentes de IA',exact:true})).toBeVisible();
});

test('sessão ausente ignora login legado e solicita acesso ao SGDM',async({page})=>{
  const apiCalls=[];page.on('request',request=>{if(request.url().includes('localhost:3000/api'))apiCalls.push(request.url());});
  await page.addInitScript(()=>{sessionStorage.setItem('i7ai-token','legacy-local-session');window.sessionReason=null;window.addEventListener('i7ai:session-required',event=>window.sessionReason=event.detail.reason);});
  await page.goto('/');await expect(page.getByText('Sessão do SGDM indisponível',{exact:true})).toBeVisible();await expect(page.getByLabel('E-mail')).toHaveCount(0);await expect(page.getByLabel(/^Senha/)).toHaveCount(0);
  expect(await page.evaluate(()=>window.sessionReason)).toBe('missing');expect(apiCalls).toEqual([]);await page.screenshot({path:folder+'/session-required.png'});
});
