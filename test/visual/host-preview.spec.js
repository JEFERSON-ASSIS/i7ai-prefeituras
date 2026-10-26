import { test, expect } from '@playwright/test';
const routes = {
  dashboard:'Dashboard',chat:'Novo chat',agents:'Agentes de IA',models:'Modelos de IA',executions:'Execuções',
  knowledge:'Bases de conhecimento',documents:'Documentos',automations:'Automações',schedules:'Agendamentos',
  tools:'Ferramentas & MCP',integrations:'Integrações',users:'Usuários',departments:'Departamentos',
  reports:'Relatórios e consumo',licensing:'Licenciamento',settings:'Configurações',
};
for (const width of [1440,390]) {
  test(`prévia dentro do host SGDM em ${width}px`,async({page})=>{
    test.setTimeout(120000);
    await page.setViewportSize({width,height:width===1440?1050:844});
    const errors=[], apiCalls=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.url().includes('localhost:3000/api'))apiCalls.push(request.url());});
    await page.goto('/preview/sgdm.html');
    for (const [route,title] of Object.entries(routes)) {
      if(width===390)await page.getByLabel('Área da prévia').selectOption(route);
      else await page.getByRole('link',{name:route==='models'?'Modelos':route==='reports'?'Relatórios':title,exact:true}).click();
      await expect(page.getByRole('region',{name:'i7Ai',exact:true}).getByRole('heading',{level:1,name:title,exact:true})).toBeVisible();
      await expect(page.getByRole('status').filter({hasText:'Carregando'})).toHaveCount(0);
      await expect(page.getByLabel('Área do i7Ai')).toHaveCount(0);
      await expect(page.getByRole('banner')).toHaveCount(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      expect(await page.evaluate(()=>({
        documentOverflow:getComputedStyle(document.documentElement).overflowY,
        mainOverflow:getComputedStyle(document.querySelector('main')).overflowY,
      }))).toEqual({documentOverflow:'hidden',mainOverflow:'auto'});
      await page.screenshot({path:`output/verification/sgdm/screenshots-embedded/host-${route}-${width}.png`,fullPage:true});
    }
    if(width===390)await page.getByLabel('Área da prévia').selectOption('departments');
    else await page.getByRole('link',{name:'Departamentos',exact:true}).click();
    await page.getByRole('button',{name:'Novo departamento'}).click();await page.getByLabel(/^Nome/).fill('Teste da prévia');
    await page.getByRole('button',{name:'Salvar',exact:true}).click();
    await expect(page.getByText('Esta prévia usa dados de teste. Alterações e chamadas de IA estão desabilitadas.')).toBeVisible();
    expect(apiCalls).toEqual([]);expect(errors).toEqual([]);
  });
}
