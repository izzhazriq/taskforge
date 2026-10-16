import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, backup } from '../src/db.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-db-'));

test('a database from the first release is upgraded, keeping its tasks and a copy', () => {
  const dir = tempDir();
  const file = path.join(dir, 'taskforge.db');
  const db = openDb(file);
  db.exec(`DROP INDEX idx_sessions_user; PRAGMA user_version = 3;`); // what version 3 looked like
  db.exec(`INSERT INTO users (email, name, password_hash) VALUES ('a@x.dev', 'Aina', 'x:y')`);
  db.exec(`INSERT INTO boards (name, personal) VALUES ('Personal', 1)`);
  db.exec(`INSERT INTO tasks (board_id, title, position) VALUES (1, 'Keep me', 1024)`);
  db.close();

  const upgraded = openDb(file);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(upgraded.prepare('SELECT title FROM tasks').get().title, 'Keep me');
  assert.ok(upgraded.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_sessions_user'`).get());
  upgraded.close();

  const copy = new DatabaseSync(path.join(dir, 'taskforge.db.v3.bak'));
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  copy.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a database from a newer TaskForge is refused rather than damaged', () => {
  const dir = tempDir();
  const file = path.join(dir, 'taskforge.db');
  openDb(file).exec('PRAGMA user_version = 99');
  assert.throws(() => openDb(file), /newer TaskForge/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backups are made once a day and only the newest two weeks are kept', () => {
  const dir = tempDir();
  const db = openDb(path.join(dir, 'taskforge.db'));
  db.exec(`INSERT INTO users (email, name, password_hash) VALUES ('a@x.dev', 'Aina', 'x:y')`);
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups);
  for (let d = 1; d <= 20; d++) fs.writeFileSync(path.join(backups, `taskforge-2025-01-${String(d).padStart(2, '0')}.db`), '');

  const file = backup(db, backups);
  assert.ok(file, 'the first backup of the day is made');
  assert.equal(backup(db, backups), null, 'a second one the same day is skipped');
  const kept = fs.readdirSync(backups).sort();
  assert.equal(kept.length, 14);
  assert.equal(kept.at(-1), path.basename(file));
  const copy = new DatabaseSync(file);
  assert.equal(copy.prepare('SELECT name FROM users').get().name, 'Aina');
  copy.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
