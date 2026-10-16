// Makes a backup of the database right now. Run with: npm run backup
import { openDb, backup } from './db.js';
import { BACKUP_DIR, UPLOAD_DIR } from './config.js';

const db = openDb();
const file = backup(db, BACKUP_DIR, { force: true });
db.close();
console.log(`Saved a backup to ${file}`);
console.log(`Attached files aren't in it. They're in ${UPLOAD_DIR}, so copy that folder too if you need them.`);
