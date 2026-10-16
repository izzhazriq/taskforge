import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './auth.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

// Files students actually hand in or share: documents, slides, spreadsheets, images, code archives.
export const ALLOWED_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
};

// Saves a file sent as the raw request body, with its name in the X-Filename header.
export function saveUpload(req, uploadDir) {
  let filename;
  try { filename = decodeURIComponent(req.get('X-Filename') || ''); } catch { filename = ''; }
  filename = path.basename(filename).replace(/[\u0000-\u001f"\\/]/g, '').trim().slice(0, 150);
  if (!filename) throw new HttpError(400, 'Send the file name in the X-Filename header.');
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!ALLOWED_TYPES[ext]) {
    throw new HttpError(400, `That file type isn't allowed. Use one of: ${Object.keys(ALLOWED_TYPES).join(', ')}.`);
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'The file is empty.');
  const stored = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, stored), req.body);
  return { filename, mime: ALLOWED_TYPES[ext], size: req.body.length, stored };
}

// Profile photos are shown inline, so the bytes must really be an image, not just named like one.
const IMAGE_SIGNATURES = [
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
export function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  return IMAGE_SIGNATURES.find((s) => s.test(buffer)) ?? null;
}

export function removeFile(uploadDir, storedName) {
  if (storedName) fs.rmSync(path.join(uploadDir, storedName), { force: true });
}

// Downloads are always sent as attachments, so an uploaded file can't run as a page on this site.
export function sendDownload(res, uploadDir, file) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.download(path.join(uploadDir, file.stored_name), file.filename, { headers: { 'Content-Type': file.mime } });
}
