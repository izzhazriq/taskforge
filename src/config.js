// Where TaskForge keeps its data. Everything lives in one folder so it's easy to back up.
// `--demo` uses a separate folder, so demo data never mixes with your real tasks.
import fs from 'node:fs';
import path from 'node:path';

// Settings such as the Google sign-in keys can go in a .env file next to package.json.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

export const DEMO = process.argv.includes('--demo');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || (DEMO ? 'demo-data' : 'data'));
export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'taskforge.db');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const PORT = Number(process.env.PORT) || (DEMO ? 3001 : 3000);

// Sign in with Google is on when both keys are set. See "Sign in with Google" in the README.
export const GOOGLE = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/auth/google/callback`,
    }
  : null;
