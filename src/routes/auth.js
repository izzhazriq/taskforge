import { Router } from 'express';
import { HttpError, hashPassword, verifyPassword, createSession, destroySession, requireUser } from '../auth.js';
import * as v from '../validate.js';
import { transaction, createPersonalBoard } from '../db.js';

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
    createSession(db, res, user.id);
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.status(204).end();
  });

  r.get('/me', requireUser(db), (req, res) => res.json({ user: req.user }));

  return r;
}
