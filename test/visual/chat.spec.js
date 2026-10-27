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
  await expect(page.getByRole('alert')).toContainText('ZIP não é lido no chat; use PDF, Word, Excel, CSV ou texto.');
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
  // The cancelled exchange stays on screen only (the server saved nothing), marked as interrupted.
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.locator('.message.agent')).toContainText('Resposta interrompida.');
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

// Composer like a modern chat: the stream stays open under test control (window.__streams).
async function controlledStreams(page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__streams = [];
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/chat/stream')) return original(input, init);
      const encoder = new TextEncoder();
      let controller;
      const body = new ReadableStream({ start(value) { controller = value; } });
      const entry = { body: JSON.parse(init.body), aborted: false };
      entry.push = (event, data) => controller.enqueue(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'));
      entry.close = () => { try { controller.close(); } catch {} };
      window.__streams.push(entry);
      init.signal?.addEventListener('abort', () => { entry.aborted = true; try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    };
  });
}
const streams = page => page.evaluate(() => window.__streams.map(item => ({ body: item.body, aborted: item.aborted })));
const push = (page, index, event, data) => page.evaluate(([i, e, d]) => window.__streams[i].push(e, d), [index, event, data]);
async function finish(page, index, conversationId, answer) {
  const { body } = (await streams(page))[index];
  const now = new Date().toISOString();
  await push(page, index, 'delta', { text: answer });
  await push(page, index, 'complete', { conversationId, answer, messages: [
    { id: 'user-' + index, role: 'user', content: body.message, createdAt: now, metadata: {} },
    { id: 'assistant-' + index, role: 'assistant', content: answer, createdAt: now, metadata: {} },
  ] });
  await page.evaluate(i => window.__streams[i].close(), index);
}
async function openChat(page, options = {}) {
  await controlledStreams(page);
  await mockSession(page, options);
  await page.goto('/?module=chat');
  await page.getByLabel('Agente da conversa').selectOption('agent-1');
  return page.getByLabel('Mensagem', { exact: true });
}

test('composer continua editável durante a resposta; Enter enfileira e a fila sai sozinha após concluir', async ({ page }) => {
  const composer = await openChat(page);
  await composer.fill('Primeira pergunta.');
  await composer.press('Enter');
  await expect.poll(async () => (await streams(page)).length).toBe(1);
  await expect(page.getByRole('button', { name: 'Interromper resposta' })).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(page.getByLabel('Modelo da conversa')).toBeDisabled();
  await expect(page.getByLabel('Agente da conversa')).toBeDisabled();
  await composer.type('Segunda pergunta.');
  await expect(composer).toHaveValue('Segunda pergunta.');
  await composer.press('Enter');
  await composer.fill('Terceira pergunta.');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  const queue = page.getByRole('list', { name: 'Mensagens na fila' });
  await expect(queue.getByRole('listitem')).toHaveCount(2);
  await expect(queue.getByRole('listitem').first()).toContainText('Na fila');
  await expect(queue.getByRole('listitem').first()).toContainText('Segunda pergunta.');
  // Removable from the keyboard.
  await page.getByRole('button', { name: 'Remover da fila: Terceira pergunta.' }).focus();
  await page.keyboard.press('Enter');
  await expect(queue.getByRole('listitem')).toHaveCount(1);
  expect((await streams(page)).length).toBe(1);
  await finish(page, 0, 'conversation-queue', 'Resposta da primeira.');
  await expect(page.getByText('Resposta da primeira.', { exact: true })).toBeVisible();
  await expect.poll(async () => (await streams(page)).length).toBe(2);
  expect((await streams(page))[1].body).toEqual({ message: 'Segunda pergunta.', modelId: 'model-1', conversationId: 'conversation-queue' });
  await expect(page.getByRole('list', { name: 'Mensagens na fila' })).toHaveCount(0);
  await finish(page, 1, 'conversation-queue', 'Resposta da segunda.');
  await expect(page.getByText('Resposta da segunda.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
  await page.waitForTimeout(200);
  expect((await streams(page)).map(item => item.aborted)).toEqual([false, false]);
});

test('erro na resposta para a fila e mantém os itens para reenviar', async ({ page }) => {
  const composer = await openChat(page);
  await composer.fill('Pergunta que falha.');
  await composer.press('Enter');
  await expect.poll(async () => (await streams(page)).length).toBe(1);
  await composer.fill('Pergunta na fila.');
  await composer.press('Enter');
  await push(page, 0, 'error', { message: 'Provedor indisponível.' });
  await expect(page.getByText('Provedor indisponível.')).toBeVisible();
  await expect(composer).toHaveValue('Pergunta que falha.');
  await expect(page.getByRole('list', { name: 'Mensagens na fila' }).getByRole('listitem')).toHaveCount(1);
  await page.waitForTimeout(200);
  expect((await streams(page)).length).toBe(1);
  await composer.fill('');
  await page.getByRole('button', { name: 'Enviar agora: Pergunta na fila.' }).click();
  await expect.poll(async () => (await streams(page)).length).toBe(2);
  expect((await streams(page))[1].body.message).toBe('Pergunta na fila.');
});

test('Parar e Esc interrompem a resposta e guardam o trecho recebido como parcial', async ({ page }) => {
  const composer = await openChat(page);
  await composer.fill('Explique o edital.');
  await composer.press('Enter');
  await expect.poll(async () => (await streams(page)).length).toBe(1);
  await push(page, 0, 'delta', { text: 'O edital trata de merenda' });
  await expect(page.getByText('O edital trata de merenda')).toBeVisible();
  await page.getByRole('button', { name: 'Interromper resposta' }).click();
  expect((await streams(page))[0].aborted).toBe(true);
  const partial = page.locator('.message.agent').last();
  await expect(partial).toContainText('O edital trata de merenda');
  await expect(partial).toContainText('Resposta interrompida.');
  await expect(partial.getByRole('button', { name: /Baixar resposta/ })).toHaveCount(0);
  await expect(composer).toHaveValue('Explique o edital.');
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  await composer.press('Enter');
  await expect.poll(async () => (await streams(page)).length).toBe(2);
  await composer.press('Escape');
  await expect.poll(async () => (await streams(page))[1].aborted).toBe(true);
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
});

test('progresso ao vivo mostra a etapa sem os termos pesquisados', async ({ page }) => {
  const composer = await openChat(page);
  await composer.fill('Pesquise compras de merenda.');
  await composer.press('Enter');
  await expect.poll(async () => (await streams(page)).length).toBe(1);
  const status = page.getByRole('status');
  await expect(status).toHaveText(/O agente está preparando a resposta/);
  await push(page, 0, 'progress', { etapa: 'pesquisa_compras' });
  await expect(status).toHaveText('Pesquisando em compras públicas (PNCP)…');
  await push(page, 0, 'progress', { etapa: 'pesquisa_internet' });
  await expect(status).toHaveText('Pesquisando na internet…');
  await push(page, 0, 'progress', { etapa: 'ferramenta' });
  await expect(status).toHaveText('Usando uma ferramenta do agente…');
  await push(page, 0, 'progress', { etapa: 'desconhecida' });
  await expect(status).toHaveText('Usando uma ferramenta do agente…');
  await push(page, 0, 'delta', { text: 'Encontrei dois pregões.' });
  await expect(page.getByText('Encontrei dois pregões.')).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('colar imagem anexa pelo mesmo envio de arquivos; texto colado continua texto', async ({ page }) => {
  const writes = [];
  const composer = await openChat(page, { writes });
  const prevented = await composer.evaluate(element => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect.poll(() => writes.filter(item => item.path === '/chat/attachments').length).toBe(1);
  expect(writes.find(item => item.path === '/chat/attachments').body).toContain('filename="imagem-colada-1.png"');
  await expect(page.locator('.chat-draft-file')).toHaveCount(1);
  const textPrevented = await composer.evaluate(element => {
    const data = new DataTransfer();
    data.setData('text/plain', 'Texto copiado');
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(textPrevented).toBe(false);
  expect(writes.filter(item => item.path === '/chat/attachments').length).toBe(1);
});

test('arrastar arquivo mostra "Solte para anexar" e soltar anexa', async ({ page }) => {
  const writes = [];
  await openChat(page, { writes });
  const data = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Relatório municipal.'], 'relatorio.txt', { type: 'text/plain' }));
    return transfer;
  });
  const area = page.getByRole('region', { name: 'Conversa' });
  await area.dispatchEvent('dragenter', { dataTransfer: data });
  await expect(page.getByText('Solte para anexar')).toBeVisible();
  await page.screenshot({ path: 'output/verification/sgdm/screenshots-embedded/chat-drop-overlay.png' });
  await area.dispatchEvent('drop', { dataTransfer: data });
  await expect(page.getByText('Solte para anexar')).toHaveCount(0);
  await expect.poll(() => writes.filter(item => item.path === '/chat/attachments').length).toBe(1);
  await expect(page.locator('.chat-draft-file')).toContainText('relatorio.txt');
});

test('caixa de mensagem cresce com o texto até cerca de dez linhas e depois rola', async ({ page }) => {
  const composer = await openChat(page);
  const height = () => composer.evaluate(element => element.getBoundingClientRect().height);
  const initial = await height();
  await composer.fill('linha\nlinha\nlinha\nlinha');
  const grown = await height();
  expect(grown).toBeGreaterThan(initial);
  await composer.fill(Array.from({ length: 30 }, (_, index) => 'linha ' + index).join('\n'));
  const capped = await height();
  expect(capped).toBeGreaterThan(grown);
  expect(await composer.evaluate(element => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === 'auto')).toBe(true);
  expect(capped).toBeLessThan(initial * 8);
});
