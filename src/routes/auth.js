import { Router } from 'express';
import { HttpError, hashPassword, verifyPassword, createSession, destroySession, requireUser } from '../auth.js';
import * as v from '../validate.js';
import { transaction, createPersonalBoard } from '../db.js';
import { DEMO } from '../config.js';

export function authRoutes(db) {
  const r = Router();

  r.post('/register', (req, res) => {
    const email = v.email(req.body.email);
    const name = v.text(req.body.name, 'Name', { max: 80 });
    const password = v.password(req.body.password);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with that email already exists.');
    }
    const id = transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
        .run(email, name, hashPassword(password));
      createPersonalBoard(db, lastInsertRowid);
      return lastInsertRowid;
    });
    createSession(db, res, id);
    res.status(201).json({ user: { id, email, name } });
  });

  r.post('/login', (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) {
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
    createSession(db, res, user.id);
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.status(204).end();
  });

  r.get('/me', requireUser(db), (req, res) => res.json({ user: req.user }));

  // Lets the sign-in page show the demo accounts, but only when running the demo.
  r.get('/info', (req, res) => res.json({ demo: DEMO }));

  r.patch('/me', requireUser(db), (req, res) => {
    const name = req.body.name === undefined ? req.user.name : v.text(req.body.name, 'Name', { max: 80 });
    const bio = req.body.bio === undefined ? req.user.bio : v.text(req.body.bio, 'About you', { max: 300, required: false });
    db.prepare('UPDATE users SET name = ?, bio = ? WHERE id = ?').run(name, bio, req.user.id);
    res.json({ user: { ...req.user, name, bio } });
  });

  // Changing the email you log in with needs your password, in case someone else is at your laptop.
  r.post('/email', requireUser(db), (req, res) => {
    checkPassword(req.user.id, req.body.password, 'Your password is incorrect.');
    const email = v.email(req.body.email);
    const taken = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (taken && taken.id !== req.user.id) throw new HttpError(409, 'An account with that email already exists.');
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    res.json({ user: { ...req.user, email } });
  });

  // Changing the password signs out every other browser.
  r.post('/password', requireUser(db), (req, res) => {
    checkPassword(req.user.id, req.body.currentPassword, 'Your current password is incorrect.');
    const password = v.password(req.body.newPassword);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    });
    createSession(db, res, req.user.id);
    res.status(204).end();
  });

  function checkPassword(userId, password, message) {
    const { password_hash: hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    if (!verifyPassword(String(password ?? ''), hash)) throw new HttpError(400, message);
  }

  return r;
}
