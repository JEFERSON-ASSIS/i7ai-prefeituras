import { createWorker, OEM, PSM } from 'tesseract.js';
process.on('disconnect', () => process.exit(0));

async function start() {
  const langPath: string = require('@tesseract.js-data/por').langPath;
  const worker = await createWorker('por', OEM.LSTM_ONLY, { langPath, cacheMethod: 'none', gzip: true, errorHandler: () => {} });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: '200' });
  process.on('message', async (message: { id?: number; image?: Buffer }) => {
    if (!Number.isInteger(message?.id) || !Buffer.isBuffer(message.image) || message.image.length > 21 * 1024 * 1024) { process.send?.({ id: message?.id, error: true }); return; }
    try { const result = await worker.recognize(message.image); process.send?.({ id: message.id, text: result.data.text }); }
    catch { process.send?.({ id: message.id, error: true }); }
  });
  process.send?.({ id: 0, ready: true });
}
start().catch(() => { process.send?.({ id: 0, error: true }); process.exitCode = 1; });
