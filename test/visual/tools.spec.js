import { test, expect } from '@playwright/test';
import { mockSession } from './fixtures';

const bodyOf = write => JSON.parse(write.body);

test('nova ferramenta HTTP: monta domínios e configuração sozinha', async ({ page }) => {
  const writes = []; await mockSession(page, { writes });
  await page.goto('/?module=tools');
  await page.getByRole('button', { name: 'Nova ferramenta' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Tipo', { exact: true })).toContainText('Ler site ou API (GET/POST)');
  await dialog.getByLabel('Nome').fill('Notícias de Vera');
  await dialog.getByLabel('Endereço da página ou serviço').fill('https://www.vera.mt.gov.br/Imprensa/Noticias/');
  await expect(dialog.getByLabel('Domínios permitidos')).toHaveValue('vera.mt.gov.br, www.vera.mt.gov.br');
  await expect(dialog.getByLabel('Tipo de acesso')).toHaveValue('GET');
  await expect(dialog.getByLabel('Tempo máximo de espera')).toHaveValue('15000');
  await dialog.getByRole('button', { name: 'Salvar ferramenta' }).click();
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  const sent = bodyOf(writes[0]);
  expect(writes[0].path).toBe('/tools');
  expect(sent.allowedDomains).toEqual(['vera.mt.gov.br', 'www.vera.mt.gov.br']);
  expect(sent.config).toEqual({ endpoint: 'https://www.vera.mt.gov.br/Imprensa/Noticias/', method: 'GET', headers: {}, timeoutMs: 15000 });
});

test('domínios editados à mão não são recalculados; POST envia cabeçalho e corpo', async ({ page }) => {
  const writes = []; await mockSession(page, { writes });
  await page.goto('/?module=tools');
  await page.getByRole('button', { name: 'Nova ferramenta' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome').fill('Webhook');
  await dialog.getByLabel('Endereço da página ou serviço').fill('https://api.exemplo.com/hook');
  await expect(dialog.getByLabel('Domínios permitidos')).toHaveValue('api.exemplo.com');
  await dialog.getByLabel('Domínios permitidos').fill('api.exemplo.com, outro.com');
  await dialog.getByLabel('Endereço da página ou serviço').fill('https://api.exemplo.com/novo');
  await expect(dialog.getByLabel('Domínios permitidos')).toHaveValue('api.exemplo.com, outro.com');
  await dialog.getByLabel('Tipo de acesso').selectOption('POST');
  await dialog.getByRole('button', { name: 'Avançado' }).click();
  await dialog.getByRole('button', { name: 'Adicionar cabeçalho' }).click();
  await dialog.getByLabel('Nome do cabeçalho').fill('Accept');
  await dialog.getByLabel('Valor', { exact: true }).fill('application/json');
  await dialog.getByLabel('Conteúdo a enviar (JSON)').fill('{"a":1}');
  await expect(dialog.getByLabel('Configuração gerada (somente leitura)')).toHaveValue(/"method": "POST"/);
  await dialog.getByRole('button', { name: 'Salvar ferramenta' }).click();
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(bodyOf(writes[0]).config).toEqual({ endpoint: 'https://api.exemplo.com/novo', method: 'POST', headers: { Accept: 'application/json' }, timeoutMs: 15000, body: { a: 1 } });
});

test('editar ferramenta existente mostra os campos e o modo JSON sincroniza', async ({ page }) => {
  const writes = []; await mockSession(page, { writes });
  await page.goto('/?module=tools');
  await page.getByRole('button', { name: 'Configurar' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Endereço da página ou serviço')).toHaveValue('https://portal.example.test');
  await expect(dialog.getByLabel('Domínios permitidos')).toHaveValue('portal.example.test');
  await dialog.getByRole('button', { name: 'Avançado' }).click();
  await dialog.getByLabel('Editar configuração em JSON').check();
  const json = dialog.getByLabel('Configuração (JSON)');
  await expect(json).toHaveValue(/portal\.example\.test/);
  await json.fill(JSON.stringify({ endpoint: 'https://portal.example.test/v2', method: 'POST', headers: {}, timeoutMs: 30000 }));
  await dialog.getByLabel('Editar configuração em JSON').uncheck();
  await expect(dialog.getByLabel('Endereço da página ou serviço')).toHaveValue('https://portal.example.test/v2');
  await expect(dialog.getByLabel('Tipo de acesso')).toHaveValue('POST');
  await expect(dialog.getByLabel('Tempo máximo de espera')).toHaveValue('30000');
  await dialog.getByRole('button', { name: 'Salvar ferramenta' }).click();
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes[0].method).toBe('PATCH');
  expect(bodyOf(writes[0]).config).toEqual({ endpoint: 'https://portal.example.test/v2', method: 'POST', headers: {}, timeoutMs: 30000 });
});

test('configuração com campos desconhecidos abre direto em JSON', async ({ page }) => {
  await mockSession(page, { overrides: { '/tools': [{ id: 'tool-9', name: 'Mcp', type: 'HTTP_REQUEST', status: 'ACTIVE', allowedDomains: ['a.test'], config: { endpoint: 'https://a.test', transport: 'streamable-http' }, credentials: [] }] } });
  await page.goto('/?module=tools');
  await page.getByRole('button', { name: 'Configurar' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Endereço da página ou serviço')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Avançado' }).click();
  await expect(dialog.getByLabel('Configuração (JSON)')).toHaveValue(/streamable-http/);
});

const bareAgent = { id: 'agent-9', name: 'Agente sem ferramentas', status: 'ACTIVE', description: '', departmentId: 'dept-1', models: [], tools: [{ toolId: 'tool-old', enabled: true }], knowledgeBases: [] };
const activeTool = { id: 'tool-1', name: 'Consulta ao portal', type: 'HTTP_REQUEST', status: 'ACTIVE', allowedDomains: ['portal.example.test'], config: { endpoint: 'https://portal.example.test', method: 'GET' }, credentials: [] };

test('testar ferramenta sem agente: autoriza no agente sem apagar vínculos', async ({ page }) => {
  const writes = []; await mockSession(page, { writes, overrides: { '/agents': [bareAgent] } });
  await page.goto('/?module=tools');
  await page.getByRole('button', { name: 'Testar' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Nenhum agente usa esta ferramenta ainda.')).toBeVisible();
  await dialog.getByLabel('Autorizar no agente…').selectOption('agent-9');
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes[0].path).toBe('/agents/agent-9');
  expect(writes[0].method).toBe('PATCH');
  expect(bodyOf(writes[0]).toolIds).toEqual(['tool-old', 'tool-1']);
});

test('automação: etapa de ferramenta sem vínculo oferece autorizar no agente', async ({ page }) => {
  const writes = []; await mockSession(page, { writes, overrides: { '/agents': [bareAgent], '/tools': [activeTool] } });
  await page.goto('/?module=automations');
  await page.getByRole('button', { name: 'Nova automação' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Agente', exact: true }).selectOption('agent-9');
  await dialog.getByLabel('Ação').selectOption('HTTP_TOOL');
  await expect(dialog.getByText('Este agente ainda não usa nenhuma ferramenta.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Autorizar ferramenta neste agente' }).click();
  await dialog.getByLabel('Ferramenta a autorizar').selectOption('tool-1');
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes[0].path).toBe('/agents/agent-9');
  expect(bodyOf(writes[0]).toolIds).toEqual(['tool-old', 'tool-1']);
});
