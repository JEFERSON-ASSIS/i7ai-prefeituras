import { BadRequestException } from '@nestjs/common';
import { fork, ForkOptions } from 'node:child_process';
import { extname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { DocumentUpload, MIME_BY_EXTENSION, UNSUPPORTED_ZIP_MESSAGE, validateDocument } from './document-extractor';

export const CHAT_ATTACHMENT_MAX_BYTES = Math.min(20 * 1024 * 1024, Math.max(1024, Number(process.env.CHAT_ATTACHMENT_MAX_BYTES) || 20 * 1024 * 1024));
export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_COUNT = 5;
export const CHAT_ATTACHMENT_TEXT_LIMIT = 48000;
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const IMAGE_MAX_PIXELS = 16_000_000;
const IMAGE_MAX_DIMENSION = 8192;

export function safeAttachmentName(name: string): string {
  // Keep the extension and a useful display name, without paths or invisible controls.
  const base = name.split(/[\\/]/).at(-1) || '';
  const safe = base.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[^\p{L}\p{N} ._()-]/gu, '_').trim();
  if (!safe || safe.startsWith('.') || safe.length > 200) throw new BadRequestException('Nome de arquivo inválido. Use um nome de até 200 caracteres.');
  return safe;
}

function boundedDimensions(width: number, height: number) {
  if (!width || !height || width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION || width * height > IMAGE_MAX_PIXELS) {
    throw new BadRequestException('A imagem excede o limite de 8192 pixels por lado ou 16 milhões de pixels.');
  }
}

function validateOfficeArchive(buffer: Buffer, extension: string) {
  // Validate and bound actual expansion before an Office parser reads the archive.
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < Math.max(0, buffer.length - 65557) || end + 22 > buffer.length) throw new BadRequestException('O conteúdo não é um documento Office válido.');
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryStart = buffer.readUInt32LE(end + 16);
  let cursor = directoryStart;
  if (!count || count > 2000 || count === 0xffff || directoryStart + directorySize !== end || end + 22 + buffer.readUInt16LE(end + 20) !== buffer.length || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count) throw new BadRequestException('O documento Office excede os limites de segurança do arquivo compactado.');
  let expanded = 0;
  const names = new Set<string>();
  const memberRanges: { start: number; end: number }[] = [];
  const expandedLimit = 64 * 1024 * 1024;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new BadRequestException('O diretório do documento Office é inválido.');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || (flags & 1) || ![0, 8].includes(method) || size === 0xffffffff || compressedSize === 0xffffffff) throw new BadRequestException('O documento Office está protegido, corrompido ou usa compactação não suportada.');
    if (size > expandedLimit - expanded) throw new BadRequestException('O documento Office excede o limite de 64 MB após descompactação.');
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || names.has(name) || /(^|\/)vbaProject\.bin$/i.test(name)) throw new BadRequestException('O documento Office contém nomes inseguros ou macros não suportadas.');
    names.add(name);
    const local = buffer.readUInt32LE(cursor + 42);
    if (local + 30 > directoryStart || buffer.readUInt32LE(local) !== 0x04034b50) throw new BadRequestException('O cabeçalho local do documento Office é inválido.');
    const localFlags = buffer.readUInt16LE(local + 6);
    const localMethod = buffer.readUInt16LE(local + 8);
    const localCrc = buffer.readUInt32LE(local + 14);
    const localCompressed = buffer.readUInt32LE(local + 18);
    const localSize = buffer.readUInt32LE(local + 22);
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    const usesDescriptor = Boolean(flags & 8);
    if (dataStart > directoryStart || dataEnd > directoryStart || localFlags !== flags || localMethod !== method || localNameLength !== nameLength || !buffer.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes) ||
      (usesDescriptor ? (localCrc !== 0 && localCrc !== crc) || (localCompressed !== 0 && localCompressed !== compressedSize) || (localSize !== 0 && localSize !== size) : localCrc !== crc || localCompressed !== compressedSize || localSize !== size)) {
      throw new BadRequestException('Os cabeçalhos e tamanhos do documento Office são inconsistentes.');
    }
    let rangeEnd = dataEnd;
    if (usesDescriptor) {
      const descriptor = dataEnd + (dataEnd + 4 <= directoryStart && buffer.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0);
      if (descriptor + 12 > directoryStart || buffer.readUInt32LE(descriptor) !== crc || buffer.readUInt32LE(descriptor + 4) !== compressedSize || buffer.readUInt32LE(descriptor + 8) !== size) throw new BadRequestException('O descritor do documento Office é inválido.');
      rangeEnd = descriptor + 12;
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    let actualSize: number;
    try {
      actualSize = method === 0 ? compressed.length : inflateRawSync(compressed, { maxOutputLength: Math.max(1, expandedLimit - expanded) }).length;
    } catch { throw new BadRequestException('O documento Office está corrompido ou excede o limite de 64 MB após descompactação.'); }
    if (actualSize > expandedLimit - expanded) throw new BadRequestException('O documento Office excede o limite de 64 MB após descompactação.');
    if (actualSize !== size) throw new BadRequestException('O tamanho real descompactado não corresponde ao tamanho declarado do documento Office.');
    expanded += actualSize;
    memberRanges.push({ start: local, end: rangeEnd });
    cursor = next;
  }
  if (cursor !== directoryStart + directorySize) throw new BadRequestException('O diretório do documento Office contém dados inconsistentes.');
  let expectedStart = 0;
  for (const range of memberRanges.sort((left, right) => left.start - right.start)) {
    if (range.start !== expectedStart) throw new BadRequestException('O documento Office contém membros ocultos ou sobrepostos.');
    expectedStart = range.end;
  }
  if (expectedStart !== directoryStart) throw new BadRequestException('O documento Office contém dados não declarados.');
  if (!names.has('[Content_Types].xml') || !names.has(extension === '.xlsx' ? 'xl/workbook.xml' : 'word/document.xml')) throw new BadRequestException('O conteúdo não corresponde ao formato Office informado.');
}

export function imageDimensions(buffer: Buffer, mime: string): { width: number; height: number } {
  if (mime === 'image/png') {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new BadRequestException('O conteúdo não é uma imagem PNG válida.');
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg') {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new BadRequestException('O conteúdo não é uma imagem JPEG válida.');
    let cursor = 2;
    while (cursor + 4 <= buffer.length) {
      if (buffer[cursor++] !== 0xff) break;
      while (buffer[cursor] === 0xff) cursor++;
      const marker = buffer[cursor++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (cursor + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(cursor);
      if (length < 2 || cursor + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) return { width: buffer.readUInt16BE(cursor + 5), height: buffer.readUInt16BE(cursor + 3) };
      cursor += length;
    }
    throw new BadRequestException('A imagem JPEG não contém dimensões válidas.');
  }
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== buffer.length) throw new BadRequestException('O conteúdo não é uma imagem WEBP válida.');
  const format = buffer.toString('ascii', 12, 16);
  if (format === 'VP8X') {
    if (buffer[20] & 0x02) throw new BadRequestException('WEBP animado ainda não é suportado. Envie uma imagem estática.');
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (format === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (format === 'VP8L' && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  throw new BadRequestException('A imagem WEBP não contém dimensões válidas.');
}

async function decodeImageInWorker(buffer: Buffer): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const options: ForkOptions & { windowsHide: boolean } = { windowsHide: true, serialization: 'advanced', execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] };
    const child = fork(join(__dirname, 'image-validation-worker.js'), [], options);
    let settled = false;
    const finish = (dimensions?: { width: number; height: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (dimensions) resolve(dimensions);
      else reject(new BadRequestException('Não foi possível decodificar a imagem. Envie uma imagem PNG, JPEG ou WEBP válida.'));
    };
    const timer = setTimeout(() => finish(), 10000);
    child.once('error', () => finish());
    child.once('exit', () => finish());
    child.once('message', (message: { width?: unknown; height?: unknown }) => {
      if (typeof message.width === 'number' && typeof message.height === 'number') finish({ width: message.width, height: message.height });
      else finish();
    });
    child.send({ buffer }, error => { if (error) finish(); });
  });
}

export async function validateChatAttachment(file?: DocumentUpload): Promise<{ name: string; mimeType: string; image: boolean }> {
  if (!file?.buffer || !file.originalname) throw new BadRequestException('Selecione um arquivo para enviar.');
  const name = safeAttachmentName(file.originalname);
  if (!file.size || !file.buffer.length || file.size !== file.buffer.length) throw new BadRequestException('O arquivo está vazio ou seu tamanho é inválido.');
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) throw new BadRequestException('O anexo excede o limite de 20 MB.');
  const extension = extname(name).toLowerCase();
  if (extension === '.zip') throw new BadRequestException(UNSUPPORTED_ZIP_MESSAGE);
  const mimeType = IMAGE_MIME[extension];
  if (!mimeType) {
    if (!file.mimetype) throw new BadRequestException('O tipo MIME do arquivo é obrigatório.');
    const canonical = validateDocument({ ...file, originalname: name });
    if (['.docx', '.xlsx'].includes(extension)) validateOfficeArchive(file.buffer, extension);
    if (!['.pdf', '.docx', '.xlsx', '.doc', '.xls'].includes(extension)) {
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) throw new Error('binary');
      } catch { throw new BadRequestException('O arquivo de texto contém dados binários ou não está codificado em UTF-8.'); }
    }
    return { name, mimeType: canonical, image: false };
  }
  if (file.size > CHAT_IMAGE_MAX_BYTES) throw new BadRequestException('A imagem excede o limite de 10 MB.');
  if (file.mimetype?.split(';')[0].trim().toLowerCase() !== mimeType) throw new BadRequestException('O tipo MIME não corresponde à extensão da imagem.');
  const dimensions = imageDimensions(file.buffer, mimeType);
  boundedDimensions(dimensions.width, dimensions.height);
  // Isolate the native decoder so a malformed image cannot terminate the API.
  try {
    const decoded = await decodeImageInWorker(file.buffer);
    boundedDimensions(decoded.width, decoded.height);
    if (decoded.width !== dimensions.width || decoded.height !== dimensions.height) throw new Error('dimensions');
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Não foi possível decodificar a imagem. Envie uma imagem PNG, JPEG ou WEBP válida.');
  }
  return { name, mimeType, image: true };
}

export function chatAttachmentCapabilities() {
  return { extensions: [...Object.keys(MIME_BY_EXTENSION), ...Object.keys(IMAGE_MIME)].map(extension => extension.slice(1)), maxFiles: CHAT_ATTACHMENT_MAX_COUNT, maxBytes: CHAT_ATTACHMENT_MAX_BYTES, imageMaxBytes: CHAT_IMAGE_MAX_BYTES, maxPixels: IMAGE_MAX_PIXELS, unsupported: ['zip', 'audio', 'video'] };
}
