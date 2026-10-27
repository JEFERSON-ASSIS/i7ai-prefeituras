import { test, expect } from '@playwright/test';
import { mockSession, fixtures } from './fixtures';

const ID = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const view = {
  id: ID, titulo: 'Atendimento de saúde', prefeitura: 'Prefeitura de Exemplo', agente: 'Agente Saúde', modelo: 'Claude', criadaEm: '2026-10-02T12:00:00Z', truncada: true,
  mensagens: [
    { id: 'm1', role: 'user', content: 'Primeira linha\nSegunda **sem markdown**', createdAt: '2026-10-02T12:00:00Z', anexos: ['laudo.pdf'] },
    { id: 'm2', role: 'assistant', content: 'Resposta do agente.', createdAt: '2026-10-02T12:01:00Z', anexos: [] },
  ],
};

test('abre a conversa com motivo válido e mostra só leitura', async ({ page }) => {
  const writes = [];
  await mockSession(page, { writes, writeHandler: async (route, { path, headers }) => {
    if (!path.endsWith('/abrir')) return false;
    await route.fulfill({ status: 200, json: view, headers }); return true;
  } });
  await page.goto('/?conversa=' + ID);
  const reason = page.getByLabel('Motivo da abertura');
  const open = page.getByRole('button', { name: 'Abrir conversa' });
  await expect(page.getByText('Você vai abrir uma conversa de outra prefeitura. A abertura fica registrada na auditoria dela.')).toBeVisible();
  await reason.fill('123456789');
  await expect(open).toBeDisabled();
  await reason.fill('1234567890');
  await expect(open).toBeEnabled();
  await open.click();
  await expect(page.getByText('Visualização pela Central de IA (somente leitura).', { exact: false })).toBeVisible();
  expect(writes[0].path).toBe('/central/conversas/' + ID + '/abrir');
  expect(JSON.parse(writes[0].body)).toEqual({ motivo: '1234567890' });
  await expect(page.getByText('Resposta do agente.')).toBeVisible();
  await expect(page.getByText('laudo.pdf')).toBeVisible();
  await expect(page.getByText('Mostrando as 1.000 mensagens mais recentes.')).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('conversa inexistente mostra erro e Fechar remove o parâmetro', async ({ page }) => {
  await mockSession(page, { writeHandler: async (route, { path, headers }) => {
    if (!path.endsWith('/abrir')) return false;
    await route.fulfill({ status: 404, json: { message: 'Not found' }, headers }); return true;
  } });
  await page.goto('/?conversa=' + ID);
  await page.getByLabel('Motivo da abertura').fill('Verificar reclamação do cidadão');
  await page.getByRole('button', { name: 'Abrir conversa' }).click();
  await expect(page.getByText('Conversa não encontrada.')).toBeVisible();
  await page.getByRole('button', { name: 'Fechar' }).click();
  await expect(page).not.toHaveURL(/conversa=/);
});

test('conversa com id inválido abre o app normal', async ({ page }) => {
  await mockSession(page);
  await page.goto('/?conversa=nao-uuid');
  await expect(page.getByLabel('Motivo da abertura')).toHaveCount(0);
  await expect(page.getByText('Dashboard').first()).toBeVisible();
});

test('usuário sem papéis e sem conversa vê acesso restrito', async ({ page }) => {
  await mockSession(page, { overrides: { '/auth/me': { ...fixtures['/auth/me'], roles: [], permissions: [] } } });
  await page.goto('/');
  await expect(page.getByText('Seu acesso à IA do SGDM serve só para abrir conversas pela Central de IA.')).toBeVisible();
});
