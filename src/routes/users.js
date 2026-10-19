import { Router, raw } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../errors.js';
import { avatarSql } from '../auth.js';
import { MAX_AVATAR_BYTES, imageType, removeFile } from '../files.js';
import * as v from '../validate.js';

// Profile photos. Mounted at /api, behind sign-in.
export function userRoutes(db, { uploadDir: dir, github }) {
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

  // The profile page: projects you're in and tasks you've worked on lately, like Jira's "Worked on".
  r.get('/me/overview', (req, res) => {
    const projects = db.prepare(`
      SELECT b.id, b.name, b.kind, b.course_code, m.role,
        (SELECT COUNT(*) FROM memberships x WHERE x.board_id = b.id) AS people,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id AND t.status != 'done') AS open_tasks
      FROM boards b JOIN memberships m ON m.board_id = b.id
      WHERE m.user_id = ? AND b.personal = 0 ORDER BY b.kind, b.name`).all(req.user.id);
    const workedOn = db.prepare(`
      SELECT t.id, t.title, t.status, t.parent_id, t.updated_at, b.name AS board_name, b.personal, b.kind
      FROM tasks t JOIN boards b ON b.id = t.board_id JOIN memberships m ON m.board_id = b.id AND m.user_id = ?
      WHERE t.assignee_id = ? OR t.created_by = ?
      ORDER BY t.updated_at DESC, t.id DESC LIMIT 10`).all(req.user.id, req.user.id, req.user.id);
    const stats = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE t.status != 'done') AS open,
        COUNT(*) FILTER (WHERE t.status = 'done') AS done,
        COUNT(*) FILTER (WHERE t.status = 'done' AND t.completed_at >= datetime('now', '-7 days')) AS done_week
      FROM tasks t JOIN memberships m ON m.board_id = t.board_id AND m.user_id = t.assignee_id
      WHERE t.assignee_id = ? AND m.role != 'supervisor'`).get(req.user.id);
    const activity = db.prepare(`
      SELECT a.id, a.detail, a.created_at, b.name AS board_name, b.personal, ${avatarSql('u')} AS user_avatar, u.name AS user_name
      FROM activity a JOIN boards b ON b.id = a.board_id JOIN users u ON u.id = a.user_id
      JOIN memberships m ON m.board_id = a.board_id AND m.user_id = a.user_id
      WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 8`).all(req.user.id);
    res.json({ projects, workedOn, stats, activity });
  });

  // A GitHub personal access token lets TaskForge read private repositories. It's checked before it's saved.
  r.put('/me/github-token', async (req, res, next) => {
    try {
      const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
      if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new HttpError(400, 'That doesn’t look like a GitHub token. It starts with github_pat_ or ghp_.');
      const me = await github.whoami(token);
      db.prepare('UPDATE users SET github_token = ?, github_login = ? WHERE id = ?').run(token, me.login, req.user.id);
      res.json({ login: me.login });
    } catch (err) { next(err); }
  });

  r.delete('/me/github-token', (req, res) => {
    db.prepare(`UPDATE users SET github_token = NULL, github_login = '' WHERE id = ?`).run(req.user.id);
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
