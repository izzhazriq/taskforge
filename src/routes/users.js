import { Router, raw } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../auth.js';
import { MAX_AVATAR_BYTES, imageType, removeFile } from '../files.js';
import * as v from '../validate.js';

// Profile photos. Mounted at /api, behind sign-in.
export function userRoutes(db, { uploadDir: dir }) {
  const r = Router();
  const uploadDir = path.resolve(dir);

  r.put('/me/avatar', raw({ type: () => true, limit: MAX_AVATAR_BYTES }), (req, res) => {
    const type = imageType(req.body);
    if (!type) throw new HttpError(400, 'Choose a PNG, JPG, GIF or WebP image.');
    const stored = `avatar-${crypto.randomUUID()}.${type.ext}`;
    fs.writeFileSync(path.join(uploadDir, stored), req.body);
    const { avatar: old } = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(stored, req.user.id);
    removeFile(uploadDir, old);
    res.json({ avatar_url: avatarUrl(req.user.id, stored) });
  });

  r.delete('/me/avatar', (req, res) => {
    const { avatar } = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(req.user.id);
    removeFile(uploadDir, avatar);
    res.status(204).end();
  });

  // Any signed-in person can see profile photos, like names in a team list.
  r.get('/users/:userId/avatar', (req, res) => {
    const user = db.prepare('SELECT avatar FROM users WHERE id = ?').get(v.id(req.params.userId, 'User id'));
    if (!user?.avatar) throw new HttpError(404, 'No photo.');
    const file = path.join(uploadDir, user.avatar);
    const type = imageType(fs.readFileSync(file));
    if (!type) throw new HttpError(404, 'No photo.');
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.type(type.mime).sendFile(file);
  });

  return r;
}

const avatarUrl = (id, stored) => `/api/users/${id}/avatar?v=${stored.slice(7, 15)}`;
