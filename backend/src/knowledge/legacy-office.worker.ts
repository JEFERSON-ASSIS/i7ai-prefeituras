import { parentPort, workerData } from 'node:worker_threads';
import * as XLSX from 'xlsx';

const MAX_CELLS = 2_000_000;
const MAX_SHEETS = 50;
const MAX_CHARS = 4_000_000;
const MAX_ROWS = 200_000;
const TOO_BIG = 'A planilha é grande demais para ser lida no chat. Divida em arquivos menores ou salve como .xlsx.';

function readXls(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false, dense: true, sheetRows: MAX_ROWS });
  if (workbook.SheetNames.length > MAX_SHEETS) throw new Error(TOO_BIG);
  for (const name of workbook.SheetNames) {
    const ref = workbook.Sheets[name]?.['!ref'];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > MAX_CELLS) throw new Error(TOO_BIG);
  }
  const lines: string[] = [];
  let chars = 0;
  for (const name of workbook.SheetNames) {
    lines.push(`[Planilha: ${name}]`);
    const rows = ((workbook.Sheets[name] as unknown as { '!data'?: (XLSX.CellObject | undefined)[][] })['!data']) ?? [];
    for (const row of rows) {
      if (!row) continue;
      const cells: string[] = [];
      let any = false;
      for (let index = 0; index < row.length; index++) {
        const cell = row[index];
        const value = cell ? (cell.w ?? (cell.v == null ? '' : String(cell.v))) : '';
        if (value) any = true;
        cells.push(value);
      }
      if (!any) continue;
      const line = cells.join('\t');
      chars += line.length + 1;
      lines.push(line);
      if (chars > MAX_CHARS) return lines.join('\n');
    }
  }
  return lines.join('\n');
}

async function readDoc(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const WordExtractor = require('word-extractor') as new () => { extract(input: Buffer): Promise<{ getBody(): string }> };
  return (await new WordExtractor().extract(buffer)).getBody();
}

(async () => {
  const { kind, buffer } = workerData as { kind: 'doc' | 'xls'; buffer: Uint8Array };
  const input = Buffer.from(buffer);
  try {
    parentPort?.postMessage({ text: kind === 'doc' ? await readDoc(input) : readXls(input) });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Não foi possível ler o arquivo.' });
  }
})();
