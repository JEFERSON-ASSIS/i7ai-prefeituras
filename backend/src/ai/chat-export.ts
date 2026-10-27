import MarkdownIt = require('markdown-it');
import PDFDocument = require('pdfkit');
import * as ExcelJS from 'exceljs';
import { AlignmentType, BorderStyle, Document, Footer, Header, LevelFormat, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType, HeadingLevel } from 'docx';

export type ExportFormat = 'pdf' | 'docx' | 'xlsx';
export const EXPORT_FORMATS: ExportFormat[] = ['pdf', 'docx', 'xlsx'];
export const EXPORT_MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const EXPORT_DISCLAIMER = 'Rascunho gerado com apoio de IA. Sujeito à revisão do responsável municipal.';

export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean };
export type Block =
  | { type: 'heading'; level: number; inlines: Inline[] }
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'listItem'; ordered: boolean; number: number; level: number; list: number; inlines: Inline[] }
  | { type: 'quote'; inlines: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'hr' };
export type ExportDocument = { title: string; organization: string; generatedAt: Date; blocks: Block[] };

type Token = ReturnType<MarkdownIt['parse']>[number];
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

function inlines(token: Token | undefined): Inline[] {
  const result: Inline[] = [];
  let bold = 0, italic = 0;
  for (const child of token?.children || []) {
    if (child.type === 'strong_open') bold++;
    else if (child.type === 'strong_close') bold--;
    else if (child.type === 'em_open') italic++;
    else if (child.type === 'em_close') italic--;
    else if (child.type === 'text' || child.type === 'image') result.push({ text: child.type === 'image' ? child.content || '' : child.content, bold: bold > 0, italic: italic > 0 });
    else if (child.type === 'code_inline') result.push({ text: child.content, code: true });
    // Models write one field per line without Markdown hard breaks; keep their line structure.
    else if (child.type === 'softbreak' || child.type === 'hardbreak') result.push({ text: '\n' });
  }
  return result.filter(item => item.text);
}
export const plain = (items: Inline[]) => items.map(item => item.text).join('');

/** Converts the assistant's Markdown into a small, format-neutral block list. Raw HTML is ignored. */
export function parseAnswer(source: string): Block[] {
  const tokens = markdown.parse(source || '', {});
  const blocks: Block[] = [];
  const lists: { ordered: boolean; next: number; id: number }[] = [];
  let listCount = 0, quote = 0, item: Extract<Block, { type: 'listItem' }> | null = null;
  let table: { header: string[]; rows: string[][]; row: string[] | null; head: boolean } | null = null;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    switch (token.type) {
      case 'heading_open': blocks.push({ type: 'heading', level: Number(token.tag.slice(1)), inlines: inlines(tokens[index + 1]) }); index += 2; break;
      case 'bullet_list_open': case 'ordered_list_open': lists.push({ ordered: token.type === 'ordered_list_open', next: Number(token.attrGet('start') || 1), id: ++listCount }); break;
      case 'bullet_list_close': case 'ordered_list_close': lists.pop(); break;
      case 'list_item_open': { const list = lists[lists.length - 1]; item = { type: 'listItem', ordered: list.ordered, number: list.next++, level: lists.length - 1, list: list.id, inlines: [] }; blocks.push(item); break; }
      case 'list_item_close': item = null; break;
      case 'blockquote_open': quote++; break;
      case 'blockquote_close': quote--; break;
      case 'paragraph_open': {
        const content = inlines(tokens[index + 1]);
        if (item) item.inlines.push(...(item.inlines.length ? [{ text: ' ' }] : []), ...content);
        else blocks.push(quote ? { type: 'quote', inlines: content } : { type: 'paragraph', inlines: content });
        index += 2; break;
      }
      case 'fence': case 'code_block': blocks.push({ type: 'code', text: token.content.replace(/\n$/, '') }); break;
      case 'hr': blocks.push({ type: 'hr' }); break;
      case 'table_open': table = { header: [], rows: [], row: null, head: false }; break;
      case 'thead_open': if (table) table.head = true; break;
      case 'thead_close': if (table) table.head = false; break;
      case 'tr_open': if (table) table.row = []; break;
      case 'tr_close': if (table?.row) { if (table.head) table.header = table.row; else table.rows.push(table.row); table.row = null; } break;
      case 'th_open': case 'td_open': table?.row?.push(plain(inlines(tokens[index + 1]))); index += 2; break;
      case 'table_close': if (table) blocks.push({ type: 'table', header: table.header, rows: table.rows }); table = null; break;
    }
  }
  return blocks;
}

export function exportTitle(blocks: Block[], fallback?: string | null) {
  const heading = blocks.find((block): block is Extract<Block, { type: 'heading' }> => block.type === 'heading');
  return (heading ? plain(heading.inlines) : fallback || 'Documento').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Documento';
}
export function exportFileName(title: string, format: ExportFormat, date: Date) {
  const slug = title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'documento';
  return `${slug}-${date.toLocaleDateString('sv-SE', { timeZone: 'America/Cuiaba' })}.${format}`;
}
const dateLabel = (date: Date) => date.toLocaleDateString('pt-BR', { timeZone: 'America/Cuiaba', day: '2-digit', month: 'long', year: 'numeric' });

// The PDF standard fonts only encode Windows-1252; replace common symbols and drop the rest (emoji, arrows).
const winAnsiExtras = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const symbolMap: Record<string, string> = { '→': '->', '←': '<-', '≤': '<=', '≥': '>=', '≠': '!=', '✓': '-', '✔': '-', '✅': '-', '❌': '-', '⚠': '' };
export function winAnsi(text: string) {
  let output = '';
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0)!;
    if (char === '\n' || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || winAnsiExtras.has(char)) output += char;
    else if (char in symbolMap) output += symbolMap[char];
  }
  return output;
}

function collect(doc: PDFKit.PDFDocument) {
  const chunks: Buffer[] = [];
  doc.on('data', chunk => chunks.push(chunk));
  return new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
}

export async function renderPdf(input: ExportDocument): Promise<Buffer> {
  const margin = 56;
  const doc = new PDFDocument({ size: 'A4', margins: { top: 88, bottom: 72, left: margin, right: margin }, bufferPages: true, info: { Title: winAnsi(input.title), Author: winAnsi(input.organization), Creator: 'SGDM' } });
  const done = collect(doc);
  const width = doc.page.width - margin * 2;
  const ink = '#0f172a', muted = '#64748b', rule = '#cbd5e1';
  const font = (item: Inline) => item.code ? 'Courier' : item.bold && item.italic ? 'Helvetica-BoldOblique' : item.bold ? 'Helvetica-Bold' : item.italic ? 'Helvetica-Oblique' : 'Helvetica';
  // pdfkit keeps layout options from the first continued call and misplaces runs after an embedded "\n",
  // so each source line is drawn as its own continued sequence.
  const runs = (items: Inline[], size: number, x = margin, y?: number) => {
    const lines: Inline[][] = [[]];
    for (const item of items) item.text.split('\n').forEach((text, index) => { if (index) lines.push([]); const clean = winAnsi(text); if (clean) lines[lines.length - 1].push({ ...item, text: clean }); });
    while (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
    lines.forEach((line, number) => {
      if (line.length) line[0] = { ...line[0], text: line[0].text.replace(/^ +/, '') };
      const visible = line.filter(item => item.text);
      const top = number === 0 ? y ?? doc.y : doc.y;
      if (!visible.length) { doc.font('Helvetica').fontSize(size).text(' ', x, top, { width: width - (x - margin), lineGap: 3 }); return; }
      visible.forEach((item, index) => {
        const continued = index < visible.length - 1;
        doc.font(font(item)).fontSize(size).fillColor(ink);
        if (index === 0) doc.text(item.text, x, top, { width: width - (x - margin), lineGap: 3, continued });
        else doc.text(item.text, { continued });
      });
    });
  };
  doc.y = 88;
  for (const block of input.blocks) {
    if (doc.y > doc.page.height - 120) doc.addPage();
    if (block.type === 'heading') { doc.moveDown(0.6); runs(block.inlines.map(item => ({ ...item, bold: true })), block.level === 1 ? 16 : block.level === 2 ? 13.5 : 12); doc.moveDown(0.4); }
    else if (block.type === 'paragraph') { runs(block.inlines, 11); doc.moveDown(0.6); }
    else if (block.type === 'listItem') {
      const x = margin + 18 + block.level * 18, top = doc.y;
      doc.font('Helvetica').fontSize(11).fillColor(ink).text(block.ordered ? block.number + '.' : '•', x - 18, top, { width: 16, lineBreak: false });
      runs(block.inlines, 11, x, top);
      doc.moveDown(0.25);
    } else if (block.type === 'quote') {
      const top = doc.y;
      runs(block.inlines.map(item => ({ ...item, italic: true })), 10.5, margin + 14);
      doc.save().rect(margin, top - 2, 3, doc.y - top + 2).fill(rule).restore();
      doc.moveDown(0.6);
    } else if (block.type === 'code') {
      const text = winAnsi(block.text);
      doc.font('Courier').fontSize(9);
      const height = doc.heightOfString(text, { width: width - 20 }) + 16;
      if (doc.y + height > doc.page.height - 72) doc.addPage();
      const top = doc.y;
      doc.save().rect(margin, top, width, height).fill('#f1f5f9').restore();
      doc.fillColor(ink).text(text, margin + 10, top + 8, { width: width - 20 });
      doc.y = top + height; doc.moveDown(0.6);
    } else if (block.type === 'table') {
      // Keep the header with at least two rows instead of stranding it at the page bottom.
      if (doc.y + Math.min(block.rows.length + 1, 3) * 30 > doc.page.height - 72) doc.addPage();
      const columns = Math.max(block.header.length, ...block.rows.map(row => row.length), 1);
      const pad = (row: string[]) => Array.from({ length: columns }, (_, index) => winAnsi(row[index] || ''));
      doc.font('Helvetica').fontSize(9.5).fillColor(ink);
      doc.table({
        position: { x: margin, y: doc.y }, maxWidth: width,
        defaultStyle: { padding: 5, border: 0.5, borderColor: rule },
        rowStyles: (row: number) => row === 0 && block.header.length ? { backgroundColor: '#f1f5f9' } : undefined,
        data: [...(block.header.length ? [pad(block.header).map(text => ({ text, font: { src: 'Helvetica-Bold' }, type: 'TH' as const }))] : []), ...block.rows.map(pad)],
      });
      doc.x = margin; doc.moveDown(0.8);
    } else if (block.type === 'hr') {
      doc.moveDown(0.3); doc.save().moveTo(margin, doc.y).lineTo(margin + width, doc.y).lineWidth(0.5).stroke(rule).restore(); doc.moveDown(0.6);
    }
  }
  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text(winAnsi(input.organization), margin, 40, { width: width * 0.65, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(winAnsi(dateLabel(input.generatedAt)), margin, 41, { width, align: 'right', lineBreak: false });
    doc.save().moveTo(margin, 60).lineTo(margin + width, 60).lineWidth(0.5).stroke(rule).restore();
    doc.font('Helvetica').fontSize(8).fillColor(muted).text(winAnsi(EXPORT_DISCLAIMER), margin, doc.page.height - 44, { width: width - 80, lineBreak: false });
    doc.text(`Página ${page - range.start + 1} de ${range.count}`, margin, doc.page.height - 44, { width, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

export async function renderDocx(input: ExportDocument): Promise<Buffer> {
  const runs = (items: Inline[], extra: { italics?: boolean; bold?: boolean; size?: number } = {}) => items.flatMap(item => item.text.split('\n').map((text, line) => new TextRun({ text, break: line ? 1 : undefined, bold: item.bold || extra.bold, italics: item.italic || extra.italics, size: extra.size, font: item.code ? 'Courier New' : undefined })));
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' };
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  const children: (Paragraph | Table)[] = [];
  for (const block of input.blocks) {
    if (block.type === 'heading') children.push(new Paragraph({ heading: headings[Math.min(block.level, 4) - 1], children: runs(block.inlines) }));
    // Word stretches a justified line that ends in a manual break, so field lists stay left-aligned.
    else if (block.type === 'paragraph') children.push(new Paragraph({ children: runs(block.inlines), alignment: plain(block.inlines).includes('\n') ? AlignmentType.LEFT : AlignmentType.JUSTIFIED, spacing: { after: 160 } }));
    else if (block.type === 'listItem') children.push(new Paragraph({ children: runs(block.inlines), ...(block.ordered ? { numbering: { reference: 'ordered', level: Math.min(block.level, 2), instance: block.list } } : { bullet: { level: Math.min(block.level, 2) } }) }));
    else if (block.type === 'quote') children.push(new Paragraph({ children: runs(block.inlines, { italics: true }), indent: { left: 360 }, border: { left: { ...border, size: 12, space: 8 } }, spacing: { after: 160 } }));
    else if (block.type === 'code') children.push(...block.text.split('\n').map(line => new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Courier New', size: 18 })], shading: { type: ShadingType.CLEAR, fill: 'F1F5F9', color: 'auto' } })));
    else if (block.type === 'hr') children.push(new Paragraph({ border: { bottom: border }, spacing: { after: 160 } }));
    else if (block.type === 'table') {
      const columns = Math.max(block.header.length, ...block.rows.map(row => row.length), 1);
      const row = (cells: string[], header: boolean) => new TableRow({ tableHeader: header, children: Array.from({ length: columns }, (_, index) => new TableCell({ shading: header ? { type: ShadingType.CLEAR, fill: 'F1F5F9', color: 'auto' } : undefined, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: [new Paragraph({ children: [new TextRun({ text: cells[index] || '', bold: header, size: 20 })] })] })) });
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [...(block.header.length ? [row(block.header, true)] : []), ...block.rows.map(cells => row(cells, false))] }));
      children.push(new Paragraph({ text: '' }));
    }
  }
  const document = new Document({
    creator: 'SGDM', title: input.title, description: EXPORT_DISCLAIMER,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'ordered', levels: [0, 1, 2].map(level => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } } })) }] },
    sections: [{
      headers: { default: new Header({ children: [new Paragraph({ border: { bottom: border }, children: [new TextRun({ text: input.organization, bold: true, size: 20 }), new TextRun({ text: '\t' + dateLabel(input.generatedAt), size: 18, color: '64748B' })], tabStops: [{ type: 'right', position: 9000 }] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: EXPORT_DISCLAIMER + '  ', size: 16, color: '64748B' }), new TextRun({ children: ['Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES], size: 16, color: '64748B' })] })] }) },
      children: children.length ? children : [new Paragraph({ text: '' })],
    }],
  });
  return Packer.toBuffer(document);
}

const moneyPattern = /^(-?)\s*R\$\s*(-?)\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d+))?$/;
const numberPattern = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;
const datePattern = /^(\d{2})\/(\d{2})\/(\d{4})$/;
/** Turns pt-BR money, numbers and dates into typed cells so the sheet can be summed and sorted. */
export function typedCell(value: string): { value: string | number | Date; numFmt?: string } {
  const text = value.trim().replace(/\*\*/g, '');
  const money = moneyPattern.exec(text);
  if (money) return { value: (money[1] || money[2] ? -1 : 1) * Number(money[3].replace(/\./g, '') + '.' + (money[4] || '0')), numFmt: '"R$" #,##0.00' };
  if (numberPattern.test(text) && !/^0\d/.test(text)) return { value: Number(text.replace(/\./g, '').replace(',', '.')), numFmt: text.includes(',') ? '#,##0.00' : '#,##0' };
  const date = datePattern.exec(text);
  if (date) { const parsed = new Date(Date.UTC(Number(date[3]), Number(date[2]) - 1, Number(date[1]))); if (parsed.getUTCDate() === Number(date[1])) return { value: parsed, numFmt: 'dd/mm/yyyy' }; }
  return { value: text };
}

export async function renderXlsx(input: ExportDocument): Promise<Buffer> {
  const tables = input.blocks.filter((block): block is Extract<Block, { type: 'table' }> => block.type === 'table');
  if (!tables.length) throw new Error('NO_TABLES');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SGDM'; workbook.title = input.title; workbook.company = input.organization; workbook.created = input.generatedAt;
  tables.forEach((table, index) => {
    const sheet = workbook.addWorksheet(tables.length === 1 ? 'Tabela' : 'Tabela ' + (index + 1), { views: [{ state: 'frozen', ySplit: table.header.length ? 1 : 0 }] });
    if (table.header.length) {
      const header = sheet.addRow(table.header);
      header.font = { bold: true };
      header.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }; cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } }; });
    }
    for (const cells of table.rows) {
      const row = sheet.addRow([]);
      cells.forEach((text, column) => { const typed = typedCell(text); const cell = row.getCell(column + 1); cell.value = typed.value; if (typed.numFmt) cell.numFmt = typed.numFmt; });
    }
    const columns = Math.max(table.header.length, ...table.rows.map(row => row.length));
    for (let column = 1; column <= columns; column++) {
      const longest = Math.max(table.header[column - 1]?.length || 0, ...table.rows.map(row => (row[column - 1] || '').length));
      sheet.getColumn(column).width = Math.min(60, Math.max(10, longest + 2));
    }
  });
  const note = workbook.addWorksheet('Sobre');
  note.addRows([[input.title], [input.organization], [dateLabel(input.generatedAt)], [], [EXPORT_DISCLAIMER]]);
  note.getRow(1).font = { bold: true, size: 13 };
  note.getColumn(1).width = 90;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function renderExport(format: ExportFormat, input: ExportDocument) {
  return format === 'pdf' ? renderPdf(input) : format === 'docx' ? renderDocx(input) : renderXlsx(input);
}
export const hasTables = (source: string) => parseAnswer(source).some(block => block.type === 'table');
