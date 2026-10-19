import { Router } from 'express';
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { hashPassword, verifyPassword, createSession, destroySession, requireUser, userSql, readCookie } from '../auth.js';
import * as v from '../validate.js';
import { transaction, createPersonalBoard } from '../db.js';
import { DEMO } from '../config.js';

export const ACCOUNT_TYPES = ['student', 'personal', 'supervisor'];
const COVERS = ['ember', 'ocean', 'forest', 'dusk', 'slate', 'rose'];
const PROFILE_FIELDS = { job_title: 'Job title', department: 'Department', organization: 'Organisation', location: 'Location' };

// `google` is { clientId, clientSecret, redirectUri } when Google sign-in is set up, otherwise null.
// `fetch` is swappable so tests can stand in for Google.
export function authRoutes(db, { google = null, fetch = globalThis.fetch } = {}) {
  const r = Router();
  const getUser = (id) => db.prepare(`SELECT ${userSql('u')} FROM users u WHERE u.id = ?`).get(id);

  function createUser({ email, name, passwordHash, accountType, googleId = null }) {
    return transaction(db, () => {
      const { lastInsertRowid: id } = db
        .prepare('INSERT INTO users (email, name, password_hash, account_type, google_id) VALUES (?, ?, ?, ?, ?)')
        .run(email, name, passwordHash, accountType, googleId);
      createPersonalBoard(db, id);
      return id;
    });
  }

  r.post('/register', (req, res) => {
    const email = v.email(req.body.email);
    const name = v.text(req.body.name, 'Name', { max: 80 });
    const password = v.password(req.body.password);
    const accountType = v.oneOf(req.body.accountType ?? 'student', ACCOUNT_TYPES, 'Account type');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with that email already exists.');
    }
    const id = createUser({ email, name, passwordHash: hashPassword(password), accountType });
    createSession(db, res, id);
    res.status(201).json({ user: getUser(id) });
  });

  r.post('/login', (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user && !user.password_hash) throw new HttpError(401, 'This account signs in with Google. Use “Continue with Google”.');
    if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) {
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
    createSession(db, res, user.id);
    res.json({ user: getUser(user.id) });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.status(204).end();
  });

  r.get('/me', requireUser(db), (req, res) => res.json({ user: req.user }));

  // Tells the sign-in page whether this is the demo and whether Google sign-in is set up.
  r.get('/info', (req, res) => res.json({ demo: DEMO, google: Boolean(google) }));

  r.patch('/me', requireUser(db), (req, res) => {
    const b = req.body;
    const changes = {};
    if (b.name !== undefined) changes.name = v.text(b.name, 'Name', { max: 80 });
    if (b.bio !== undefined) changes.bio = v.text(b.bio, 'About you', { max: 300, required: false });
    for (const [key, label] of Object.entries(PROFILE_FIELDS)) {
      if (b[key] !== undefined) changes[key] = v.text(b[key], label, { max: 80, required: false });
    }
    if (b.cover !== undefined) changes.cover = v.oneOf(b.cover, COVERS, 'Cover');
    if (b.account_type !== undefined) {
      changes.account_type = v.oneOf(b.account_type, ACCOUNT_TYPES, 'Account type');
      checkAccountTypeChange(req.user.id, changes.account_type);
    }
    const cols = Object.keys(changes);
    if (!cols.length) throw new HttpError(400, 'Nothing to update.');
    db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => changes[c]), req.user.id);
    res.json({ user: getUser(req.user.id) });
  });

  // Switching account type must fit the projects you're already in.
  function checkAccountTypeChange(userId, type) {
    const count = (where) => db.prepare(`
      SELECT COUNT(*) AS n FROM memberships m JOIN boards b ON b.id = m.board_id
      WHERE m.user_id = ? AND b.personal = 0 AND ${where}`).get(userId).n;
    if (type === 'personal' && count(`b.kind = 'school'`)) {
      throw new HttpError(400, 'Leave your school projects first. A personal account only has personal projects.');
    }
    if (type === 'supervisor' && count(`m.role != 'supervisor'`)) {
      throw new HttpError(400, 'Leave the projects you work on first. A supervisor account can only supervise.');
    }
  }

  // Changing the email you log in with needs your password, in case someone else is at your laptop.
  r.post('/email', requireUser(db), (req, res) => {
    if (!req.user.has_password) throw new HttpError(400, 'Your email comes from Google. Set a password first to change it here.');
    checkPassword(req.user.id, req.body.password, 'Your password is incorrect.');
    const email = v.email(req.body.email);
    const taken = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (taken && taken.id !== req.user.id) throw new HttpError(409, 'An account with that email already exists.');
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    res.json({ user: getUser(req.user.id) });
  });

  // Changing the password signs out every other browser. Google accounts can set a first one.
  r.post('/password', requireUser(db), (req, res) => {
    if (req.user.has_password) checkPassword(req.user.id, req.body.currentPassword, 'Your current password is incorrect.');
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

  // ----- Sign in with Google (OAuth 2.0 authorization code flow) -----
  // New Google users still choose student, personal or supervisor before the account is made,
  // so their Google details wait here for up to 10 minutes.
  const pending = new Map();
  const STATE_COOKIE = 'tf_google_state';
  const PENDING_COOKIE = 'tf_google_signup';
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000 };
  const fail = (res, message) => res.redirect(`/?auth_error=${encodeURIComponent(message)}`);

  r.get('/google', (req, res) => {
    if (!google) return fail(res, 'Google sign-in isn’t set up on this TaskForge yet.');
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, cookieOpts);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: google.clientId, redirect_uri: google.redirectUri, response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account',
    });
    res.redirect(url.href);
  });

  r.get('/google/callback', async (req, res) => {
    if (!google) return fail(res, 'Google sign-in isn’t set up on this TaskForge yet.');
    const state = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE);
    if (req.query.error) return fail(res, 'Google sign-in was cancelled.');
    if (!state || req.query.state !== state || typeof req.query.code !== 'string') {
      return fail(res, 'That Google sign-in link has expired. Please try again.');
    }
    let profile;
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code, client_id: google.clientId, client_secret: google.clientSecret,
          redirect_uri: google.redirectUri, grant_type: 'authorization_code',
        }),
      });
      const token = await tokenRes.json();
      if (!tokenRes.ok || !token.access_token) throw new Error(token.error_description || token.error || 'no access token');
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      profile = await infoRes.json();
      if (!infoRes.ok || !profile.sub) throw new Error('no profile');
    } catch (err) {
      console.error('Google sign-in failed:', err.message);
      return fail(res, 'Google sign-in didn’t work. Check the Google settings in your .env file and try again.');
    }
    if (!profile.email || !profile.email_verified) return fail(res, 'Your Google account needs a verified email.');
    const email = profile.email.toLowerCase();

    // Signed in with Google before, or has a TaskForge account with the same email: link and sign in.
    const user = db.prepare('SELECT id, google_id FROM users WHERE google_id = ?').get(profile.sub)
      ?? db.prepare('SELECT id, google_id FROM users WHERE email = ?').get(email);
    if (user) {
      if (!user.google_id) db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(profile.sub, user.id);
      createSession(db, res, user.id);
      return res.redirect('/');
    }

    const ticket = crypto.randomBytes(24).toString('hex');
    for (const [k, p] of pending) if (p.expires < Date.now()) pending.delete(k);
    pending.set(ticket, { sub: profile.sub, email, name: (profile.name || email.split('@')[0]).slice(0, 80), expires: Date.now() + cookieOpts.maxAge });
    res.cookie(PENDING_COOKIE, ticket, cookieOpts);
    res.redirect('/?signup=google');
  });

  const readPending = (req) => {
    const p = pending.get(readCookie(req, PENDING_COOKIE));
    if (!p || p.expires < Date.now()) throw new HttpError(400, 'Your Google sign-up has expired. Click “Continue with Google” again.');
    return p;
  };

  r.get('/google/pending', (req, res) => {
    const p = readPending(req);
    res.json({ email: p.email, name: p.name });
  });

  r.post('/google/complete', (req, res) => {
    const p = readPending(req);
    const accountType = v.oneOf(req.body.accountType, ACCOUNT_TYPES, 'Account type');
    const name = req.body.name === undefined ? p.name : v.text(req.body.name, 'Name', { max: 80 });
    if (db.prepare('SELECT 1 FROM users WHERE email = ? OR google_id = ?').get(p.email, p.sub)) {
      throw new HttpError(409, 'An account with that email already exists. Log in instead.');
    }
    const id = createUser({ email: p.email, name, passwordHash: '', accountType, googleId: p.sub });
    pending.delete(readCookie(req, PENDING_COOKIE));
    res.clearCookie(PENDING_COOKIE);
    createSession(db, res, id);
    res.status(201).json({ user: getUser(id) });
  });

  return r;
}
