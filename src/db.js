import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE } from './config.js';
import { DatabaseSync } from 'node:sqlite';

const FIRST_VERSION = 3;

export const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- A board is either someone's personal list (personal = 1, one per user)
-- or a team project such as a group assignment or a Final Year Project.
CREATE TABLE IF NOT EXISTS boards (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  personal     INTEGER NOT NULL DEFAULT 0,
  course_code  TEXT NOT NULL DEFAULT '',  -- e.g. CSC584
  sem_start    TEXT,                      -- Monday of Week 1, YYYY-MM-DD
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- owner = group leader, member = teammate, supervisor = lecturer or FYP supervisor.
CREATE TABLE IF NOT EXISTS memberships (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'member', 'supervisor')),
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY,
  board_id     INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  important    INTEGER NOT NULL DEFAULT 0,
  position     REAL NOT NULL,
  assignee_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date     TEXT,
  completed_at TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id, status, position);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_due ON tasks(assignee_id, due_date);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id, id);

CREATE TABLE IF NOT EXISTS steps (
  id       INTEGER PRIMARY KEY,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_task ON steps(task_id, position);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY,
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_board ON activity(board_id, id);
`;

// Changes to the schema since version 3, the first release. Each entry upgrades a
// database from the version before it, so existing tasks and files are kept.
// A brand-new database gets BASE_SCHEMA and then every migration in order.
const MIGRATIONS = {
  4: `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`,

  // Profiles, school or personal projects, pins, project summaries, subtasks and documents.
  5: `
    ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN avatar TEXT; -- stored file name of the profile photo

    ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'school' CHECK (kind IN ('school', 'personal'));
    ALTER TABLE boards ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE boards ADD COLUMN goal TEXT NOT NULL DEFAULT '';
    ALTER TABLE boards ADD COLUMN goal_date TEXT;
    UPDATE boards SET kind = 'personal' WHERE personal = 1;

    CREATE TABLE pins (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, board_id)
    );

    -- Files that belong to the project as a whole rather than to one task.
    CREATE TABLE documents (
      id          INTEGER PRIMARY KEY,
      board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      filename    TEXT NOT NULL,
      mime        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_documents_board ON documents(board_id, id);

    -- A subtask is a task with a parent. Only one level deep.
    ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;
    CREATE INDEX idx_tasks_parent ON tasks(parent_id, position);

    -- Steps become subtasks, so they get their own status, owner and due date.
    INSERT INTO tasks (board_id, parent_id, title, status, position, assignee_id, completed_at, created_by)
      SELECT t.board_id, t.id, s.text, CASE WHEN s.done THEN 'done' ELSE 'todo' END, s.position * 1024,
             t.assignee_id, CASE WHEN s.done THEN datetime('now') END, t.created_by
      FROM steps s JOIN tasks t ON t.id = s.task_id ORDER BY s.task_id, s.position;
    DROP TABLE steps;
  `,

  // Account types, Google sign-in, a fuller profile and GitHub links.
  6: `
    -- student: school and personal projects. personal: personal projects only.
    -- supervisor: only ever a supervisor on school projects.
    ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'student' CHECK (account_type IN ('student', 'personal', 'supervisor'));
    ALTER TABLE users ADD COLUMN google_id TEXT;
    CREATE UNIQUE INDEX idx_users_google ON users(google_id) WHERE google_id IS NOT NULL;
    ALTER TABLE users ADD COLUMN job_title TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN organization TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN location TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN cover TEXT NOT NULL DEFAULT 'ember';
    ALTER TABLE users ADD COLUMN github_token TEXT; -- a personal access token, for private repositories
    ALTER TABLE users ADD COLUMN github_login TEXT NOT NULL DEFAULT '';

    ALTER TABLE boards ADD COLUMN github_repo TEXT NOT NULL DEFAULT ''; -- owner/name
    ALTER TABLE tasks ADD COLUMN github_issue INTEGER; -- the issue number a task was made from
  `,
};
const SCHEMA_VERSION = Math.max(FIRST_VERSION, ...Object.keys(MIGRATIONS).map(Number));

export function openDb(file = DB_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  const hasTables = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`).get();
  if (!hasTables) {
    db.exec(BASE_SCHEMA);
    for (const sql of Object.values(MIGRATIONS)) db.exec(sql);
  } else if (version < FIRST_VERSION) {
    throw new Error(`${file} was made by a TaskForge preview. Move it out of the way to start fresh.`);
  } else if (version > SCHEMA_VERSION) {
    throw new Error(`${file} was made by a newer TaskForge. Update the app before opening it.`);
  } else if (version < SCHEMA_VERSION) {
    // Keep a copy of the database as it was, in case an upgrade goes wrong.
    if (file !== ':memory:') db.exec(`VACUUM INTO '${`${file}.v${version}.bak`.replaceAll("'", "''")}'`);
    transaction(db, () => {
      for (let v = version + 1; v <= SCHEMA_VERSION; v++) if (MIGRATIONS[v]) db.exec(MIGRATIONS[v]);
    });
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

// Runs fn inside a transaction and rolls back if it throws.
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function logActivity(db, boardId, userId, action, detail) {
  db.prepare('INSERT INTO activity (board_id, user_id, action, detail) VALUES (?, ?, ?, ?)')
    .run(boardId, userId, action, detail);
}

// Every account gets one personal board for its own tasks.
// Supervisors get one too, for their own to-dos, though they never create projects.
export function createPersonalBoard(db, userId) {
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO boards (name, personal, kind) VALUES ('Personal', 1, 'personal')`).run();
  db.prepare(`INSERT INTO memberships (board_id, user_id, role) VALUES (?, ?, 'owner')`).run(id, userId);
  return id;
}

// Copies the database to backups/taskforge-YYYY-MM-DD.db and keeps the newest `keep` copies.
// VACUUM INTO makes a consistent copy even while the app is running.
export function backup(db, dir, { keep = 14, force = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `taskforge-${new Date().toLocaleDateString('en-CA')}.db`);
  if (fs.existsSync(file)) {
    if (!force) return null;
    fs.rmSync(file);
  }
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  const old = fs.readdirSync(dir).filter((f) => /^taskforge-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return file;
}
