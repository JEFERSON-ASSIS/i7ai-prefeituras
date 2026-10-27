import { test, expect } from '@playwright/test';
import { mockSession, fixtures, summaryConversations } from './fixtures';

for (const width of [1440, 390]) {
  test('chat seleciona agente e modelo independentes e envia pelo teclado em ' + width + 'px', async ({ page }) => {
    const writes = [];
    await page.setViewportSize({ width, height: width === 1440 ? 1050 : 844 });
    await mockSession(page, { writes });
    await page.goto('/?module=chat');
    await expect(page.getByRole('button', { name: 'Relatório da educação' })).toBeVisible();
    await page.getByLabel('Agente da conversa').selectOption('agent-1');
    await expect(page.getByLabel('Modelo da conversa')).toHaveValue('model-1');
    await page.getByLabel('Modelo da conversa').selectOption('model-2');
    await expect(page.getByLabel('Agente da conversa')).toHaveValue('agent-1');
    const composer = page.getByLabel('Mensagem', { exact: true });
    await composer.fill('Analise os dados.');
    await composer.press('Shift+Enter');
    await composer.press('End');
    await composer.type('Considere o município.');
    await expect(composer).toHaveValue('Analise os dados.\nConsidere o município.');
    await composer.press('Enter');
    await expect(page.getByText('Resposta confirmada pelo servidor.', { exact: true })).toBeVisible();
    expect(writes[0].path).toBe('/agents/agent-1/chat/stream');
    expect(JSON.parse(writes[0].body)).toEqual({ message: 'Analise os dados.\nConsidere o município.', modelId: 'model-2' });
    await expect(composer).toHaveValue('');
    await page.getByLabel('Modelo da conversa').selectOption('model-3');
    await composer.fill('Continue a análise.');
    await page.getByRole('button', { name: 'Enviar mensagem' }).click();
    await expect.poll(() => writes.length).toBe(2);
    expect(JSON.parse(writes[1].body)).toEqual({ message: 'Continue a análise.', modelId: 'model-3', conversationId: 'conversation-new' });
    await expect(page.locator('.messages').getByText('Claude · Anthropic', { exact: true })).toBeVisible();
    await expect(page.locator('.messages').getByText('Gemini · Google', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'output/verification/sgdm/screenshots-embedded/chat-models-' + width + '.png', fullPage: true });
  });
}

test('histórico geral restaura agente, modelo e anexo privado com download autorizado', async ({ page }) => {
  const downloads = [];
  await mockSession(page);
  await page.route('http://localhost:3000/api/chat/attachments/attachment-1/download', route => {
    downloads.push(route.request().headers().authorization);
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' }, body: 'Relatório de educação.' });
  });
  await page.goto('/?module=chat');
  await page.getByRole('button', { name: 'Relatório da educação' }).click();
  await expect(page.getByLabel('Agente da conversa')).toHaveValue('agent-2');
  await expect(page.getByLabel('Modelo da conversa')).toHaveValue('model-2');
  await expect(page.getByText('O relatório recomenda acompanhar a frequência escolar.')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar relatorio.txt' }).click();
  expect((await download).suggestedFilename()).toBe('relatorio.txt');
  expect(downloads).toEqual(['Bearer fixture-session']);
  await page.screenshot({ path: 'output/verification/sgdm/screenshots-embedded/chat-restored-attachments.png', fullPage: true });
});

test('nova conversa e troca de agente cancelam histórico tardio', async ({ page }) => {
  await mockSession(page, { overrides: { '/conversations/conversation-2': { delay: 900, data: fixtures['/conversations/conversation-2'] } } });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await page.getByRole('button', { name: 'Relatório da educação' }).click();
  await expect(page.getByText('Carregando conversa...')).toBeVisible();
  await page.getByRole('button', { name: 'Nova conversa' }).click();
  await page.waitForTimeout(1100);
  await expect(page.getByLabel('Agente da conversa')).toHaveValue('agent-1');
  await expect(page.getByText('O relatório recomenda acompanhar a frequência escolar.')).toHaveCount(0);
  await expect(page.getByLabel('Mensagem', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Relatório da educação' }).click();
  await expect(page.getByText('Carregando conversa...')).toBeVisible();
  await page.getByLabel('Agente da conversa').selectOption('agent-2');
  await page.waitForTimeout(1100);
  await expect(page.getByLabel('Modelo da conversa')).toHaveValue('model-2');
  await expect(page.getByText('O relatório recomenda acompanhar a frequência escolar.')).toHaveCount(0);
});

test('anexo aguarda processamento e acompanha a mensagem sem entrar em base compartilhada', async ({ page }) => {
  const writes = [];
  await mockSession(page, { writes });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await page.getByLabel('Mensagem', { exact: true }).fill('Resuma este relatório.');
  await page.locator('input[type=file]').setInputFiles({ name: 'relatorio.txt', mimeType: 'text/plain', buffer: Buffer.from('Relatório municipal de teste.') });
  await expect(page.getByText(/KB · Processando/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
  await expect(page.getByText(/KB · Pronto/)).toBeVisible();
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page.getByText('Resposta confirmada pelo servidor.', { exact: true })).toBeVisible();
  expect(writes[0].path).toBe('/chat/attachments');
  expect(writes[0].body).not.toContain('knowledgeBaseId');
  expect(JSON.parse(writes[1].body)).toEqual({ message: 'Resuma este relatório.', modelId: 'model-1', attachmentIds: ['attachment-1'] });
  await expect(page.getByRole('button', { name: 'Remover relatorio.txt' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Baixar relatorio.txt' })).toBeVisible();
});

test('falha de processamento bloqueia envio e permite remover anexo', async ({ page }) => {
  const writes = [];
  await mockSession(page, { writes, overrides: { '/chat/attachments/attachment-1': { ...fixtures['/chat/attachments/attachment-1'], status: 'FAILED', errorMessage: 'O documento não contém texto legível.' } } });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await page.getByLabel('Mensagem', { exact: true }).fill('Analise o arquivo.');
  await page.locator('input[type=file]').setInputFiles({ name: 'relatorio.txt', mimeType: 'text/plain', buffer: Buffer.from('Relatório.') });
  await expect(page.getByText('O documento não contém texto legível.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
  await page.getByRole('button', { name: 'Remover relatorio.txt' }).click();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  expect(writes.at(-1)).toMatchObject({ path: '/chat/attachments/attachment-1', method: 'DELETE' });
});

test('imagem exige capacidade do modelo e troca incompatível bloqueia envio', async ({ page }) => {
  const writes = [];
  await mockSession(page, { writes, writeHandler: async (route, { path, headers }) => {
    if (path !== '/chat/attachments') return false;
    await route.fulfill({ status: 200, headers, json: { id: 'image-1', name: 'foto.png', mimeType: 'image/png', sizeBytes: 100, status: 'READY' } });
    return true;
  } });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await page.getByLabel('Mensagem', { exact: true }).fill('Analise esta imagem.');
  await page.locator('input[type=file]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('fixture imagem') });
  await expect(page.getByText(/KB · Pronto/)).toBeVisible();
  await page.getByLabel('Modelo da conversa').selectOption('model-3');
  await expect(page.getByText('Os anexos incluem imagens. Selecione um modelo com análise de imagens e janela de contexto configuradas ou remova esses arquivos.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
  await page.getByRole('button', { name: 'Remover foto.png' }).click();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
});

test('arquivos incompatíveis e excessivos são recusados antes do upload', async ({ page }) => {
  const writes = [];
  await mockSession(page, { writes });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await page.getByLabel('Modelo da conversa').selectOption('model-3');
  await page.locator('input[type=file]').setInputFiles([
    { name: 'arquivo.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('fixture') },
    { name: 'arquivo.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture') },
    { name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('fixture') },
    { name: 'grande.txt', mimeType: 'text/plain', buffer: Buffer.alloc(20 * 1024 * 1024 + 1, 65) },
  ]);
  await expect(page.getByRole('alert')).toContainText('XLS e ZIP ainda não são processados no chat.');
  await expect(page.getByRole('alert')).toContainText('selecione um modelo que permita analisar imagens');
  await expect(page.getByRole('alert')).toContainText('excede o limite de 20 MB');
  expect(writes).toEqual([]);
});

test('imagem no histórico exige visão e janela de contexto para continuar a conversa', async ({ page }) => {
  const history = fixtures['/conversations/conversation-2'];
  const image = { id: 'image-history', name: 'foto.png', mimeType: 'image/png', sizeBytes: 100, status: 'READY' };
  await mockSession(page, { overrides: { '/conversations/conversation-2': { ...history, messages: [{ ...history.messages[0], attachments: [], metadata: { attachments: [image] } }, history.messages[1]] } } });
  await page.goto('/?module=chat');
  await page.getByRole('button', { name: 'Relatório da educação' }).click();
  await page.getByLabel('Mensagem', { exact: true }).fill('Continue a análise da imagem.');
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  await page.getByLabel('Modelo da conversa').selectOption('model-3');
  await expect(page.getByText('Esta conversa contém imagens. Selecione um modelo com análise de imagens e janela de contexto configuradas ou inicie uma nova conversa.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
  await page.getByRole('button', { name: 'Nova conversa' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Baixar foto.png' })).toHaveCount(0);
});

test('modelo com visão sem janela de contexto não aceita imagem', async ({ page }) => {
  const writes = [];
  const catalog = fixtures['/chat/catalog'];
  await mockSession(page, { writes, overrides: { '/chat/catalog': { ...catalog, models: catalog.models.map(model => model.id === 'model-1' ? { ...model, capabilities: { supportsVision: true } } : model) } } });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await page.locator('input[type=file]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('fixture') });
  await expect(page.getByRole('alert')).toContainText('selecione um modelo que permita analisar imagens e tenha a janela de contexto configurada.');
  expect(writes).toEqual([]);
});

test('interromper resposta conserva pergunta e impede persistência visual tardia', async ({ page }) => {
  const writes = [];
  const errors = [];
  page.on('pageerror', caught => errors.push(caught.message));
  let releaseResponse;
  const pendingResponse = new Promise(resolve => { releaseResponse = resolve; });
  await mockSession(page, { writes, writeHandler: async (route, { path, headers }) => {
    if (!path.endsWith('/chat/stream')) return false;
    await pendingResponse;
    await route.fulfill({ status: 200, headers: { ...headers, 'Content-Type': 'text/event-stream' }, body: 'event: delta\ndata: {"text":"Resposta parcial"}\n\n' }).catch(() => {});
    return true;
  } });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await page.getByLabel('Mensagem', { exact: true }).fill('Pergunta para interromper.');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await page.getByRole('button', { name: 'Interromper resposta' }).click();
  expect(errors).toEqual([]);
  await expect(page.getByText(/Resposta interrompida/)).toBeVisible();
  releaseResponse();
  await page.waitForTimeout(200);
  await expect(page.getByLabel('Mensagem', { exact: true })).toHaveValue('Pergunta para interromper.');
  await expect(page.getByText('Resposta parcial', { exact: true })).toHaveCount(0);
  await expect(page.locator('.message')).toHaveCount(0);
  expect(writes).toHaveLength(1);
});

test('catálogo de chat usa permissão de execução e leitura não concede envio', async ({ page }) => {
  await mockSession(page, { overrides: { '/auth/me': { ...fixtures['/auth/me'], roles: ['USER'], permissions: ['agents:read', 'conversations:read'] } } });
  await page.goto('/?module=chat');
  await page.getByRole('button', { name: 'Orientação municipal' }).click();
  await expect(page.getByText('Consulte o guia municipal na base de conhecimento.')).toBeVisible();
  await expect(page.getByLabel('Modelo da conversa')).toBeDisabled();
  await expect(page.getByLabel('Mensagem', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Anexar arquivos' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
});

test('agente com modelo fora da lista liberada abre no modelo padrão', async ({ page }) => {
  await mockSession(page, { overrides: { '/chat/catalog': { agents: fixtures['/agents'], models: [fixtures['/models'][1], fixtures['/models'][2]], defaultModelId: 'model-3' } } });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await expect(page.getByLabel('Modelo da conversa')).toHaveValue('model-3');
});

test('sem modelos liberados o seletor fica desabilitado e explica o motivo', async ({ page }) => {
  await mockSession(page, { overrides: { '/chat/catalog': { agents: fixtures['/agents'], models: [], defaultModelId: null } } });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await expect(page.getByLabel('Modelo da conversa')).toBeDisabled();
  await expect(page.getByText('Nenhum modelo de IA foi liberado para você. Fale com o administrador da plataforma.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
});

test('recusa 403 do servidor aparece como veio', async ({ page }) => {
  const message = 'Este modelo não está liberado para você. Escolha outro no seletor do chat.';
  await mockSession(page, { writeHandler: async (route, { headers }) => { await route.fulfill({ status: 403, json: { message }, headers }); return true; } });
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  await page.getByLabel('Mensagem', { exact: true }).fill('Olá');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page.getByText(message)).toBeVisible();
});

test('resumo da conversa é visível e reversível; conversa sem resumo não mostra aviso', async ({ page }) => {
  const writes = [];
  let disabled = false;
  await mockSession(page, {
    writes,
    overrides: { '/conversations': [...fixtures['/conversations'], ...summaryConversations] },
    writeHandler: async (route, { path, headers }) => {
      if (!path.endsWith('/summary/disable')) return false;
      disabled = true;
      await route.fulfill({ status: 200, json: { id: 'conversation-3', summaryDisabled: true }, headers });
      return true;
    }
  });
  await page.route('http://localhost:3000/api/conversations/conversation-3', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const body = disabled ? { ...fixtures['/conversations/conversation-3'], summary: null, summaryDisabled: true } : fixtures['/conversations/conversation-3'];
    return route.fulfill({ status: 200, json: body, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto('/?module=chat');
  await page.getByRole('button', { name: 'Orientação municipal' }).click();
  await expect(page.getByText('Como consultar as orientações?')).toBeVisible();
  await expect(page.getByText(/foram resumidas para reduzir o custo/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Conversa longa' }).click();
  await expect(page.getByText(/As mensagens anteriores a .+ foram resumidas para reduzir o custo\. As mensagens continuam salvas\./)).toBeVisible();
  await expect(page.getByText('Pergunta antiga.')).toBeVisible();
  await page.getByRole('button', { name: 'Ver resumo' }).click();
  await expect(page.locator('pre')).toContainText('Resumo fixture: contrato 12/2026');
  await page.getByRole('button', { name: 'Usar mensagens completas' }).click();
  await expect(page.getByText('Esta conversa usa as mensagens completas.')).toBeVisible();
  await expect(page.getByText(/foram resumidas para reduzir o custo/)).toHaveCount(0);
  expect(writes.some(item => item.path === '/conversations/conversation-3/summary/disable' && item.method === 'POST')).toBe(true);
  await expect(page.getByRole('button', { name: 'Permitir resumo' })).toBeVisible();
  await expect(page.getByText('Pergunta antiga.')).toBeVisible();
});

test('conversa com resumo desligado mostra a linha e permite religar', async ({ page }) => {
  const writes = [];
  await mockSession(page, { writes, overrides: { '/conversations': [...fixtures['/conversations'], ...summaryConversations] } });
  await page.goto('/?module=chat');
  await page.getByRole('button', { name: 'Conversa completa' }).click();
  await expect(page.getByText('Esta conversa usa as mensagens completas.')).toBeVisible();
  await page.getByRole('button', { name: 'Permitir resumo' }).click();
  await expect.poll(() => writes.some(item => item.path === '/conversations/conversation-4/summary/enable')).toBe(true);
});

test('resumo guardado mas fora de uso (summaryActive falso) não mostra o aviso', async ({ page }) => {
  await mockSession(page, { overrides: { '/conversations': [...fixtures['/conversations'], ...summaryConversations] } });
  await page.route('http://localhost:3000/api/conversations/conversation-3', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, json: { ...fixtures['/conversations/conversation-3'], summaryActive: false }, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto('/?module=chat');
  await page.getByRole('button', { name: 'Conversa longa' }).click();
  await expect(page.getByText('Pergunta antiga.')).toBeVisible();
  await expect(page.getByText(/foram resumidas para reduzir o custo/)).toHaveCount(0);
});

test('desligar o resumo com a releitura falhando não deixa aviso antigo; trocar de conversa fecha o resumo aberto', async ({ page }) => {
  let reads = 0;
  await mockSession(page, {
    overrides: { '/conversations': [...fixtures['/conversations'], ...summaryConversations] },
    writeHandler: async (route, { path, headers }) => {
      if (!path.endsWith('/summary/disable')) return false;
      await route.fulfill({ status: 200, json: { id: 'conversation-3', summaryDisabled: true }, headers });
      return true;
    }
  });
  let failReads = false;
  await page.route('http://localhost:3000/api/conversations/conversation-3', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads++;
    if (failReads) return route.fulfill({ status: 500, json: { message: 'Erro' }, headers: { 'Access-Control-Allow-Origin': '*' } });
    return route.fulfill({ status: 200, json: fixtures['/conversations/conversation-3'], headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto('/?module=chat');
  await page.getByRole('button', { name: 'Conversa longa' }).click();
  await page.getByRole('button', { name: 'Ver resumo' }).click();
  await expect(page.locator('pre.chat-summary-text')).toBeVisible();
  // Another conversation and back: the summary text starts closed again.
  await page.getByRole('button', { name: 'Orientação municipal' }).click();
  await expect(page.getByText('Como consultar as orientações?')).toBeVisible();
  await page.getByRole('button', { name: 'Conversa longa' }).click();
  await expect(page.getByRole('button', { name: 'Ver resumo' })).toBeVisible();
  await expect(page.locator('pre.chat-summary-text')).toHaveCount(0);
  failReads = true;
  const before = reads;
  await page.getByRole('button', { name: 'Usar mensagens completas' }).click();
  await expect(page.getByText('Esta conversa usa as mensagens completas.')).toBeVisible();
  await expect(page.getByText(/foram resumidas para reduzir o custo/)).toHaveCount(0);
  expect(reads).toBeGreaterThan(before);
});
