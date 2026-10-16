import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './auth.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 500 * 1024 * 1024; // room for screen recordings and demo videos

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

function cleanFilename(req) {
  let filename;
  try { filename = decodeURIComponent(req.get('X-Filename') || ''); } catch { filename = ''; }
  filename = path.basename(filename).replace(/[\u0000-\u001f"\\/]/g, '').trim().slice(0, 150);
  if (!filename) throw new HttpError(400, 'Send the file name in the X-Filename header.');
  return filename;
}

// Saves a file sent as the raw request body, with its name in the X-Filename header.
export function saveUpload(req, uploadDir) {
  const filename = cleanFilename(req);
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

// ----- Project documents: any file except programs, and big ones too -----

// Extra types documents understand, on top of ALLOWED_TYPES. Anything else is stored as a plain download.
const DOCUMENT_TYPES = {
  ...ALLOWED_TYPES,
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  heic: 'image/heic', svg: 'image/svg+xml', bmp: 'image/bmp',
  rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', json: 'application/json', rtf: 'application/rtf',
  key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
};
// Programs and scripts that could run on someone's computer when opened.
const BLOCKED = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'ps1', 'sh', 'app', 'dmg', 'pkg', 'apk', 'jar', 'lnk', 'reg']);

export function documentType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (BLOCKED.has(ext)) {
    throw new HttpError(400, `For safety, .${ext} files can't be uploaded. Put them in a ZIP file instead.`);
  }
  return { ext, mime: DOCUMENT_TYPES[ext] || 'application/octet-stream' };
}

// Streams the request body to disk, so a big video never has to fit in memory.
export function saveDocumentStream(req, uploadDir) {
  const filename = cleanFilename(req);
  const { ext, mime } = documentType(filename);
  const declared = Number(req.get('Content-Length'));
  if (declared > MAX_DOCUMENT_BYTES) {
    throw new HttpError(413, `Documents can be up to ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
  }
  const stored = `${crypto.randomUUID()}${ext ? `.${ext}` : ''}`;
  const file = path.join(uploadDir, stored);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let size = 0;
    const fail = (err) => {
      out.destroy();
      fs.rm(file, { force: true }, () => reject(err));
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_DOCUMENT_BYTES) {
        req.unpipe(out);
        req.resume();
        fail(new HttpError(413, `Documents can be up to ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`));
      }
    });
    req.on('aborted', () => fail(new HttpError(400, 'The upload was cancelled.')));
    out.on('error', fail);
    out.on('finish', () => {
      if (size > MAX_DOCUMENT_BYTES) return;
      if (size === 0) return fail(new HttpError(400, 'The file is empty.'));
      resolve({ filename, mime, size, stored });
    });
    req.pipe(out);
  });
}

// What a document can be previewed as in the browser. The first bytes must match the type,
// so a file can't pretend to be a picture and run as a page. Everything else only downloads.
const PREVIEW_SIGNATURES = [
  { kind: 'pdf', mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  ...IMAGE_SIGNATURES.map((s) => ({ kind: 'image', mime: s.mime, test: s.test })),
  { kind: 'video', mime: 'video/webm', test: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { kind: 'video', mime: null, test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' }, // MP4, M4V and MOV
];
export function previewType(file, uploadDir) {
  const head = Buffer.alloc(16);
  let fd;
  try {
    fd = fs.openSync(path.join(uploadDir, file.stored_name), 'r');
    fs.readSync(fd, head, 0, 16, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const match = PREVIEW_SIGNATURES.find((s) => s.test(head));
  if (!match) return null;
  if (match.kind === 'video' && !file.mime.startsWith('video/')) return null;
  return { kind: match.kind, mime: match.mime ?? file.mime };
}

// Shows a picture, video or PDF in the browser. Range requests let videos seek.
export function sendInline(res, uploadDir, file, type) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  });
  if (type.kind === 'pdf') {
    // PDFs open inside TaskForge's own viewer, so this page may frame them (and only this page).
    res.set({ 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'" });
  } else {
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  }
  res.type(type.mime).sendFile(path.join(uploadDir, file.stored_name));
}
