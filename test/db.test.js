import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, backup, BASE_SCHEMA } from '../src/db.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-db-'));

test('a database from the first release is upgraded, keeping its tasks and a copy', () => {
  const dir = tempDir();
  const file = path.join(dir, 'taskforge.db');
  const v3 = new DatabaseSync(file);
  v3.exec(BASE_SCHEMA);
  v3.exec(`PRAGMA user_version = 3;
    INSERT INTO users (email, name, password_hash) VALUES ('a@x.dev', 'Aina', 'x:y');
    INSERT INTO boards (name, personal) VALUES ('Personal', 1);
    INSERT INTO boards (name, course_code) VALUES ('Group work', 'CSC584');
    INSERT INTO tasks (board_id, title, position, assignee_id) VALUES (2, 'Keep me', 1024, 1);
    INSERT INTO steps (task_id, text, done, position) VALUES (1, 'First step', 1, 1), (1, 'Second step', 0, 2);`);
  v3.close();

  const upgraded = openDb(file);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(upgraded.prepare('SELECT key FROM boards ORDER BY id').all().map((b) => b.key), ['TODO', 'GW'], 'projects get keys from their names');
  assert.deepEqual(upgraded.prepare('SELECT number FROM tasks ORDER BY id').all().map((t) => t.number), [1, 2, 3], 'tasks are numbered in order');
  assert.equal(upgraded.prepare('SELECT next_number FROM boards WHERE id = 2').get().next_number, 4);
  assert.equal(upgraded.prepare('SELECT account_type FROM users').get().account_type, 'student', 'existing accounts become student accounts');
  const tasks = upgraded.prepare('SELECT id, title, parent_id, status, assignee_id, completed_at FROM tasks ORDER BY id').all();
  assert.equal(tasks[0].title, 'Keep me');
  assert.deepEqual(tasks.slice(1).map((t) => [t.title, t.parent_id, t.status, t.assignee_id]),
    [['First step', 1, 'done', 1], ['Second step', 1, 'todo', 1]], 'steps become subtasks');
  assert.ok(tasks[1].completed_at);
  assert.deepEqual(upgraded.prepare('SELECT kind FROM boards ORDER BY id').all().map((b) => b.kind), ['personal', 'school']);
  assert.ok(!upgraded.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'steps'`).get());
  upgraded.close();

  const copy = new DatabaseSync(path.join(dir, 'taskforge.db.v3.bak'));
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM steps').get().n, 2);
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
