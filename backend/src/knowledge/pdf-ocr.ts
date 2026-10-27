import type { PDFParse, PageTextResult } from 'pdf-parse';
import { LocalOcrProcess } from './local-ocr-process';

export async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('O OCR excedeu o tempo limite. Divida o PDF em arquivos menores.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function ocrPdfPages(parser: PDFParse, pages: PageTextResult[]): Promise<string> {
  const missing = pages.filter(page => !page.text.trim());
  if (!missing.length) return pages.map(page => page.text).join('\n\n');
  if (missing.length > 20) throw new Error('O PDF excede o limite de 20 páginas que precisam de OCR. Divida o arquivo.');
  const info = await parser.getInfo({ parsePageInfo: true, partial: missing.map(page => page.num) });
  for (const page of info.pages) if (!page.width || !page.height || page.height / page.width > 3 || page.width / page.height > 3) throw new Error('Dimensões de página incompatíveis com o OCR local.');
  // The subprocess uses the bundled local Portuguese model. No OCR service or
  // runtime language-model download receives the document.
  const worker = new LocalOcrProcess();
  const deadline = Date.now() + 180000;
  try {
    await bounded(worker.ready, 60000);
    const texts: string[] = [];
    for (const page of pages) {
      if (page.text.trim()) { texts.push(page.text); continue; }
      const remaining = Math.min(60000, deadline - Date.now());
      if (remaining <= 0) throw new Error('O OCR excedeu o tempo limite. Divida o PDF em arquivos menores.');
      const image = await bounded(parser.getScreenshot({ partial: [page.num], desiredWidth: 1600, imageDataUrl: false, imageBuffer: true }), remaining);
      const screenshot = image.pages[0];
      if (!screenshot || screenshot.width * screenshot.height > 8_000_000) throw new Error('A página excede o limite de imagem do OCR.');
      const text = await bounded(worker.recognize(Buffer.from(screenshot.data)), Math.min(60000, Math.max(1, deadline - Date.now())));
      texts.push(text);
    }
    return texts.join('\n\n');
  } finally { await worker.close(); }
}

export const IMAGE_OCR_NO_TEXT_MESSAGE = 'Não foi possível ler texto nesta imagem.';

// Same bundled Portuguese model and subprocess isolation as scanned PDFs.
export async function ocrImage(image: Buffer): Promise<string> {
  const worker = new LocalOcrProcess();
  try {
    await bounded(worker.ready, 60000);
    return await bounded(worker.recognize(image), 90000);
  } finally { await worker.close(); }
}
