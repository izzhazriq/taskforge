import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { requireUser } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { boardRoutes } from './routes/boards.js';
import { taskRoutes, MAX_UPLOAD_BYTES } from './routes/tasks.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db, { uploadDir = process.env.UPLOAD_DIR || 'uploads' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/auth', authRoutes(db));
  app.use('/api/boards', requireUser(db), boardRoutes(db));
  app.use('/api', requireUser(db), taskRoutes(db, { uploadDir }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(path.join(here, '..', 'public')));

  // Errors thrown in any route end up here as a consistent JSON shape.
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: `Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side.' : err.message });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp(openDb()).listen(port, () => console.log(`TaskForge running at http://localhost:${port}`));
}
