import crypto from 'node:crypto';

export const SESSION_COOKIE = 'tf_session';
const SESSION_DAYS = 7;
const ROLE_RANK = { supervisor: 1, member: 2, owner: 3 };
export const ROLE_LABEL = { owner: 'group leader', member: 'team member', supervisor: 'supervisor' };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// Only a SHA-256 of the session token is stored, so a leaked database can't be used to log in.
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function createSession(db, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(sha256(token), userId, `+${SESSION_DAYS} days`);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function destroySession(db, req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(SESSION_COOKIE);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function requireUser(db) {
  const findSession = db.prepare(`
    SELECT u.id, u.email, u.name FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`);
  return (req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    const user = token && findSession.get(sha256(token));
    if (!user) return next(new HttpError(401, 'Please log in.'));
    req.user = user;
    next();
  };
}

// Throws unless the user has at least `minRole` on the board. Returns their actual role.
export function assertRole(db, boardId, userId, minRole) {
  const row = db.prepare('SELECT role FROM memberships WHERE board_id = ? AND user_id = ?').get(boardId, userId);
  if (!row) throw new HttpError(404, 'Board not found.');
  if (ROLE_RANK[row.role] < ROLE_RANK[minRole]) {
    throw new HttpError(403, `Only a ${ROLE_LABEL[minRole]} can do that.`);
  }
  return row.role;
}
