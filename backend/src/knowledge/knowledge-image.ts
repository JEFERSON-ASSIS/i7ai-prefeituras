import { BadRequestException } from '@nestjs/common';
import { extname } from 'node:path';
import { DocumentUpload, validateDocument } from './document-extractor';
import { imageDimensions } from './chat-attachment-validation';

export const KNOWLEDGE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const KNOWLEDGE_IMAGE_MAX_PIXELS = 40_000_000;
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const IMAGE_MIME_ALIASES: Record<string, string[]> = { 'image/jpeg': ['image/jpg', 'image/pjpeg'] };

// Knowledge-base uploads accept images (read by local OCR) on top of the document formats.
export function validateKnowledgeUpload(file?: DocumentUpload): string {
  const mimeType = file?.originalname ? IMAGE_MIME[extname(file.originalname).toLowerCase()] : undefined;
  if (!mimeType) return validateDocument(file);
  if (!file?.buffer || !file.size || !file.buffer.length) throw new BadRequestException('O arquivo está vazio.');
  if (file.size > KNOWLEDGE_IMAGE_MAX_BYTES || file.buffer.length > KNOWLEDGE_IMAGE_MAX_BYTES) throw new BadRequestException('A imagem excede o limite de 20 MB.');
  const received = file.mimetype?.split(';')[0].trim().toLowerCase();
  if (received && received !== 'application/octet-stream' && received !== mimeType && !IMAGE_MIME_ALIASES[mimeType]?.includes(received)) throw new BadRequestException('O tipo MIME não corresponde à extensão da imagem.');
  const { width, height } = imageDimensions(file.buffer, mimeType);
  if (!width || !height || width * height > KNOWLEDGE_IMAGE_MAX_PIXELS) throw new BadRequestException('A imagem excede o limite de 40 megapixels.');
  return mimeType;
}
