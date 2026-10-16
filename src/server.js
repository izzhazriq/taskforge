import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, backup } from './db.js';
import { DEMO, UPLOAD_DIR, BACKUP_DIR, PORT, GOOGLE } from './config.js';
import { requireUser } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { boardRoutes, documentRoutes } from './routes/boards.js';
import { userRoutes } from './routes/users.js';
import { taskRoutes } from './routes/tasks.js';
import { MAX_UPLOAD_BYTES, MAX_AVATAR_BYTES } from './files.js';
import { githubClient } from './github.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// `google` turns on Sign in with Google. `fetch` reaches Google and GitHub; tests swap it for a fake.
export function createApp(db, { uploadDir = UPLOAD_DIR, google = null, fetch = globalThis.fetch } = {}) {
  const app = express();
  const github = githubClient({ fetch });
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'",
    });
    next();
  });

  app.use('/api/auth', authRoutes(db, { google, fetch }));
  app.use('/api/boards', requireUser(db), boardRoutes(db, { uploadDir, github }));
  app.use('/api/documents', requireUser(db), documentRoutes(db, { uploadDir }));
  app.use('/api', requireUser(db), userRoutes(db, { uploadDir, github }));
  app.use('/api', requireUser(db), taskRoutes(db, { uploadDir }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(path.join(here, '..', 'public')));

  // Errors thrown in any route end up here as a consistent JSON shape.
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    if (err.type === 'entity.too.large') {
      const max = req.path.endsWith('/avatar') ? MAX_AVATAR_BYTES : MAX_UPLOAD_BYTES;
      return res.status(413).json({ error: `Files can be up to ${max / 1024 / 1024} MB.` });
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side.' : err.message });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  // A backup a day, kept for two weeks, checked hourly while the app runs.
  const dailyBackup = () => {
    try { backup(db, BACKUP_DIR); } catch (err) { console.error('Backup failed:', err.message); }
  };
  if (!DEMO) {
    dailyBackup();
    setInterval(dailyBackup, 60 * 60 * 1000).unref();
  }
  const server = createApp(db, { google: GOOGLE }).listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`TaskForge${DEMO ? ' demo' : ''} is running at http://localhost:${PORT}`);
    console.log('Press Ctrl+C to stop.');
  });
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Port ${PORT} is already in use. TaskForge may already be running: try http://localhost:${PORT}`);
    process.exit(1);
  });
  // Close the database cleanly on Ctrl+C so nothing is left half-written.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(); db.close(); process.exit(0); });
  }
}
