// Where TaskForge keeps its data. Everything lives in one folder so it's easy to back up.
// `--demo` uses a separate folder, so demo data never mixes with your real tasks.
import path from 'node:path';

export const DEMO = process.argv.includes('--demo');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || (DEMO ? 'demo-data' : 'data'));
export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'taskforge.db');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const PORT = Number(process.env.PORT) || (DEMO ? 3001 : 3000);
