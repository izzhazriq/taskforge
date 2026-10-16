import { Router, raw } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, assertRole } from '../auth.js';
import { transaction, logActivity } from '../db.js';
import { createTask, STATUS_LABEL, POSITION_GAP } from '../taskUtils.js';
import { TASK_LIST_COLUMNS } from './boards.js';
import * as v from '../validate.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Files students actually hand in or share: documents, slides, spreadsheets, images, code archives.
const ALLOWED_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
};

export function taskRoutes(db, { uploadDir: dir }) {
  const r = Router();
  const uploadDir = path.resolve(dir);
  fs.mkdirSync(uploadDir, { recursive: true });

  // ----- My work: everything on my plate, from my personal list and every project -----
  // Includes tasks finished in the last day, so ticking one off doesn't make it vanish instantly.
  r.get('/me/tasks', (req, res) => {
    const tasks = db.prepare(`
      SELECT ${TASK_LIST_COLUMNS}, b.name AS board_name, b.personal, b.course_code
      FROM tasks t
      JOIN boards b ON b.id = t.board_id
      JOIN memberships m ON m.board_id = t.board_id AND m.user_id = ?
      WHERE t.assignee_id = ? AND m.role != 'supervisor'
        AND (t.status != 'done' OR t.completed_at >= datetime('now', '-1 day'))
      ORDER BY t.due_date IS NULL, t.due_date, t.important DESC, t.created_at`).all(req.user.id, req.user.id);
    res.json({ tasks });
  });

  // ----- Search: tasks in any project I'm in, matching the title or notes -----
  r.get('/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    if (!q) return res.json({ tasks: [] });
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const tasks = db.prepare(`
      SELECT ${TASK_LIST_COLUMNS}, b.name AS board_name, b.personal, b.course_code
      FROM tasks t
      JOIN boards b ON b.id = t.board_id
      JOIN memberships m ON m.board_id = t.board_id AND m.user_id = ?
      WHERE (t.title LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')
      ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.updated_at DESC
      LIMIT 50`).all(req.user.id, like, like);
    res.json({ tasks });
  });

  // ----- Tasks -----

  r.post('/boards/:boardId/tasks', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'member');
    const b = req.body;
    const fields = {
      title: v.text(b.title, 'Task', { max: 140 }),
      notes: v.text(b.notes, 'Notes', { max: 8000, required: false }),
      status: v.oneOf(b.status ?? 'todo', v.STATUSES, 'Status'),
      important: Boolean(b.important),
      dueDate: v.date(b.dueDate),
      assigneeId: b.assigneeId == null ? null : checkAssignee(boardId, b.assigneeId),
    };
    const id = transaction(db, () => createTask(db, boardId, req.user.id, fields));
    res.status(201).json({ task: getTask(id) });
  });

  r.get('/tasks/:taskId', (req, res) => {
    const task = loadTask(req.params.taskId);
    const role = assertRole(db, task.board_id, req.user.id, 'supervisor');
    res.json({ task: { ...getTask(task.id), ...taskDetail(task.id) }, role });
  });

  r.patch('/tasks/:taskId', (req, res) => {
    const task = loadTask(req.params.taskId);
    const role = assertRole(db, task.board_id, req.user.id, 'supervisor');
    const b = req.body;

    // Supervisors can mark work as done or send it back, and comment, but not rewrite it.
    if (role === 'supervisor' && Object.keys(b).some((k) => !['status', 'position'].includes(k))) {
      throw new HttpError(403, 'Supervisors can change a task’s status and comment, but not edit it.');
    }

    const changes = {};
    if (b.title !== undefined) changes.title = v.text(b.title, 'Task', { max: 140 });
    if (b.notes !== undefined) changes.notes = v.text(b.notes, 'Notes', { max: 8000, required: false });
    if (b.important !== undefined) changes.important = b.important ? 1 : 0;
    if (b.status !== undefined) changes.status = v.oneOf(b.status, v.STATUSES, 'Status');
    if (b.position !== undefined) {
      if (typeof b.position !== 'number' || !Number.isFinite(b.position)) throw new HttpError(400, 'Position must be a number.');
      changes.position = b.position;
    }
    if (b.dueDate !== undefined) changes.due_date = v.date(b.dueDate);
    if (b.assigneeId !== undefined) changes.assignee_id = b.assigneeId === null ? null : checkAssignee(task.board_id, b.assigneeId);

    const statusChanged = changes.status && changes.status !== task.status;
    if (statusChanged && changes.position === undefined) {
      const { maxPos } = db.prepare('SELECT MAX(position) AS maxPos FROM tasks WHERE board_id = ? AND status = ?').get(task.board_id, changes.status);
      changes.position = (maxPos ?? 0) + POSITION_GAP;
    }

    const cols = Object.keys(changes);
    if (!cols.length) throw new HttpError(400, 'Nothing to update.');
    const completed = !statusChanged ? '' : changes.status === 'done' ? ", completed_at = datetime('now')" : ', completed_at = NULL';
    db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')}${completed}, updated_at = datetime('now') WHERE id = ?`)
      .run(...cols.map((c) => changes[c]), task.id);

    if (statusChanged && !isPersonal(task.board_id)) {
      logActivity(db, task.board_id, req.user.id, 'task.moved', `moved "${changes.title ?? task.title}" to ${STATUS_LABEL[changes.status]}`);
    }
    res.json({ task: getTask(task.id) });
  });

  r.delete('/tasks/:taskId', (req, res) => {
    const task = loadTask(req.params.taskId);
    assertRole(db, task.board_id, req.user.id, 'member');
    const files = db.prepare('SELECT stored_name FROM attachments WHERE task_id = ?').all(task.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    for (const f of files) removeFile(f.stored_name);
    if (!isPersonal(task.board_id)) logActivity(db, task.board_id, req.user.id, 'task.deleted', `deleted "${task.title}"`);
    res.status(204).end();
  });

  // ----- Comments (supervisors can comment too) -----

  r.post('/tasks/:taskId/comments', (req, res) => {
    const task = loadTask(req.params.taskId);
    assertRole(db, task.board_id, req.user.id, 'supervisor');
    const body = v.text(req.body.body, 'Comment', { max: 4000 });
    const { lastInsertRowid: id } = db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)').run(task.id, req.user.id, body);
    res.status(201).json({ comment: getComment(id) });
  });

  r.delete('/comments/:commentId', (req, res) => {
    const c = db.prepare('SELECT c.*, t.board_id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?')
      .get(v.id(req.params.commentId, 'Comment id'));
    if (!c) throw new HttpError(404, 'Comment not found.');
    const role = assertRole(db, c.board_id, req.user.id, 'supervisor');
    if (c.user_id !== req.user.id && role !== 'owner') throw new HttpError(403, 'You can only delete your own comments.');
    db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
    res.status(204).end();
  });

  // ----- Steps: a small checklist inside a task -----

  r.post('/tasks/:taskId/steps', (req, res) => {
    const task = loadTask(req.params.taskId);
    assertRole(db, task.board_id, req.user.id, 'member');
    const text = v.text(req.body.text, 'Step', { max: 200 });
    const { pos } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM steps WHERE task_id = ?').get(task.id);
    const { lastInsertRowid: id } = db.prepare('INSERT INTO steps (task_id, text, position) VALUES (?, ?, ?)').run(task.id, text, pos);
    res.status(201).json({ step: { id, text, done: 0 } });
  });

  r.patch('/steps/:stepId', (req, res) => {
    const step = loadStep(req.params.stepId);
    assertRole(db, step.board_id, req.user.id, 'member');
    const done = req.body.done === undefined ? step.done : (req.body.done ? 1 : 0);
    const text = req.body.text === undefined ? step.text : v.text(req.body.text, 'Step', { max: 200 });
    db.prepare('UPDATE steps SET done = ?, text = ? WHERE id = ?').run(done, text, step.id);
    res.json({ step: { id: step.id, text, done } });
  });

  r.delete('/steps/:stepId', (req, res) => {
    const step = loadStep(req.params.stepId);
    assertRole(db, step.board_id, req.user.id, 'member');
    db.prepare('DELETE FROM steps WHERE id = ?').run(step.id);
    res.status(204).end();
  });

  // ----- Files -----
  // The browser sends the file as the raw request body, with its name in an X-Filename header.

  r.post('/tasks/:taskId/attachments', raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
    const task = loadTask(req.params.taskId);
    assertRole(db, task.board_id, req.user.id, 'member');
    let filename;
    try { filename = decodeURIComponent(req.get('X-Filename') || ''); } catch { filename = ''; }
    filename = path.basename(filename).replace(/[\u0000-\u001f"\\/]/g, '').trim().slice(0, 150);
    if (!filename) throw new HttpError(400, 'Send the file name in the X-Filename header.');
    const ext = path.extname(filename).slice(1).toLowerCase();
    if (!ALLOWED_TYPES[ext]) {
      throw new HttpError(400, `That file type isn't allowed. Use one of: ${Object.keys(ALLOWED_TYPES).join(', ')}.`);
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'The file is empty.');

    const stored = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, stored), req.body);
    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO attachments (task_id, user_id, filename, mime, size, stored_name) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(task.id, req.user.id, filename, ALLOWED_TYPES[ext], req.body.length, stored);
    if (!isPersonal(task.board_id)) logActivity(db, task.board_id, req.user.id, 'file.added', `attached "${filename}"`);
    res.status(201).json({ attachment: getAttachment(id) });
  });

  r.get('/attachments/:attachmentId', (req, res) => {
    const a = loadAttachment(req.params.attachmentId);
    assertRole(db, a.board_id, req.user.id, 'supervisor');
    // Always download rather than render inline, so an uploaded file can't run as a page on this site.
    res.set('X-Content-Type-Options', 'nosniff');
    res.download(path.join(uploadDir, a.stored_name), a.filename, { headers: { 'Content-Type': a.mime } });
  });

  r.delete('/attachments/:attachmentId', (req, res) => {
    const a = loadAttachment(req.params.attachmentId);
    const role = assertRole(db, a.board_id, req.user.id, 'member');
    if (a.user_id !== req.user.id && role !== 'owner') throw new HttpError(403, 'Only the person who uploaded a file, or the group leader, can delete it.');
    db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
    removeFile(a.stored_name);
    res.status(204).end();
  });

  // ----- Helpers -----

  function loadTask(rawId) {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(v.id(rawId, 'Task id'));
    if (!task) throw new HttpError(404, 'Task not found.');
    return task;
  }

  const isPersonal = (boardId) => Boolean(db.prepare('SELECT personal FROM boards WHERE id = ?').get(boardId).personal);

  function getTask(id) {
    return db.prepare(`
      SELECT ${TASK_LIST_COLUMNS}, t.notes, t.created_at, b.name AS board_name, b.personal, b.course_code, b.sem_start,
             u.name AS created_by_name
      FROM tasks t JOIN boards b ON b.id = t.board_id LEFT JOIN users u ON u.id = t.created_by
      WHERE t.id = ?`).get(id);
  }

  function taskDetail(taskId) {
    return {
      comments: db.prepare(`
        SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name
        FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id`).all(taskId),
      steps: db.prepare('SELECT id, text, done FROM steps WHERE task_id = ? ORDER BY position').all(taskId),
      attachments: db.prepare(`
        SELECT a.id, a.filename, a.size, a.created_at, a.user_id, u.name AS user_name
        FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.task_id = ? ORDER BY a.id`).all(taskId),
    };
  }

  function getComment(id) {
    return db.prepare(`SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name
      FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(id);
  }

  function getAttachment(id) {
    return db.prepare(`SELECT a.id, a.filename, a.size, a.created_at, a.user_id, u.name AS user_name
      FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ?`).get(id);
  }

  function loadStep(rawId) {
    const step = db.prepare('SELECT s.*, t.board_id FROM steps s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?')
      .get(v.id(rawId, 'Step id'));
    if (!step) throw new HttpError(404, 'Step not found.');
    return step;
  }

  function loadAttachment(rawId) {
    const a = db.prepare('SELECT a.*, t.board_id FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?')
      .get(v.id(rawId, 'File id'));
    if (!a) throw new HttpError(404, 'File not found.');
    return a;
  }

  function removeFile(storedName) {
    fs.rmSync(path.join(uploadDir, storedName), { force: true });
  }

  function checkAssignee(boardId, rawId) {
    const userId = v.id(rawId, 'Assignee');
    const row = db.prepare('SELECT role FROM memberships WHERE board_id = ? AND user_id = ?').get(boardId, userId);
    if (!row || row.role === 'supervisor') throw new HttpError(400, 'You can only give tasks to people in the group.');
    return userId;
  }

  return r;
}
