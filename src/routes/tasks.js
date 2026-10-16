import { Router, raw } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, assertRole, avatarSql } from '../auth.js';
import { transaction, logActivity } from '../db.js';
import { createTask, STATUS_LABEL, POSITION_GAP } from '../taskUtils.js';
import { MAX_UPLOAD_BYTES, saveUpload, removeFile, sendDownload, sendInline, previewType } from '../files.js';
import { TASK_LIST_COLUMNS } from './boards.js';
import * as v from '../validate.js';

export { MAX_UPLOAD_BYTES };

export function taskRoutes(db, { uploadDir: dir }) {
  const r = Router();
  const uploadDir = path.resolve(dir);
  fs.mkdirSync(uploadDir, { recursive: true });

  // ----- My work: everything on my plate, from my personal list and every project -----
  // Includes tasks finished in the last day, so ticking one off doesn't make it vanish instantly.
  r.get('/me/tasks', (req, res) => {
    const tasks = db.prepare(`
      SELECT ${TASK_LIST_COLUMNS}, b.name AS board_name, b.personal, b.course_code, b.kind
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
      SELECT ${TASK_LIST_COLUMNS}, b.name AS board_name, b.personal, b.course_code, b.kind
      FROM tasks t
      JOIN boards b ON b.id = t.board_id
      JOIN memberships m ON m.board_id = t.board_id AND m.user_id = ?
      WHERE (t.title LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')
      ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.updated_at DESC
      LIMIT 50`).all(req.user.id, like, like);
    res.json({ tasks });
  });

  // ----- Tasks and subtasks -----

  r.post('/boards/:boardId/tasks', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'member');
    const fields = readNewTask(boardId, req.body);
    const id = transaction(db, () => createTask(db, boardId, req.user.id, fields));
    res.status(201).json({ task: getTask(id) });
  });

  // A subtask belongs to a task on the same project. Subtasks can't have subtasks of their own.
  r.post('/tasks/:taskId/subtasks', (req, res) => {
    const parent = loadTask(req.params.taskId);
    assertRole(db, parent.board_id, req.user.id, 'member');
    if (parent.parent_id) throw new HttpError(400, 'A subtask can’t have subtasks of its own.');
    const fields = { ...readNewTask(parent.board_id, req.body), parentId: parent.id };
    const id = transaction(db, () => createTask(db, parent.board_id, req.user.id, fields));
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
    // A task moved to another column goes to the bottom of it. Subtasks keep their place in their list.
    if (statusChanged && changes.position === undefined && !task.parent_id) {
      const { maxPos } = db.prepare('SELECT MAX(position) AS maxPos FROM tasks WHERE board_id = ? AND status = ? AND parent_id IS NULL')
        .get(task.board_id, changes.status);
      changes.position = (maxPos ?? 0) + POSITION_GAP;
    }

    const cols = Object.keys(changes);
    if (!cols.length) throw new HttpError(400, 'Nothing to update.');
    const completed = !statusChanged ? '' : changes.status === 'done' ? ", completed_at = datetime('now')" : ', completed_at = NULL';
    db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')}${completed}, updated_at = datetime('now') WHERE id = ?`)
      .run(...cols.map((c) => changes[c]), task.id);

    if (statusChanged) {
      const what = task.parent_id ? 'the subtask ' : '';
      logActivity(db, task.board_id, req.user.id, 'task.moved', `moved ${what}"${changes.title ?? task.title}" to ${STATUS_LABEL[changes.status]}`);
    }
    res.json({ task: getTask(task.id) });
  });

  r.delete('/tasks/:taskId', (req, res) => {
    const task = loadTask(req.params.taskId);
    assertRole(db, task.board_id, req.user.id, 'member');
    // Deleting a task deletes its subtasks too, so remove their files as well.
    const files = db.prepare(`
      SELECT a.stored_name FROM attachments a JOIN tasks t ON t.id = a.task_id
      WHERE t.id = ? OR t.parent_id = ?`).all(task.id, task.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    for (const f of files) removeFile(uploadDir, f.stored_name);
    logActivity(db, task.board_id, req.user.id, 'task.deleted', `deleted ${task.parent_id ? 'the subtask ' : ''}"${task.title}"`);
    res.status(204).end();
  });

  // ----- Comments (supervisors can comment too) -----

  r.post('/tasks/:taskId/comments', (req, res) => {
    const task = loadTask(req.params.taskId);
    assertRole(db, task.board_id, req.user.id, 'supervisor');
    const body = v.text(req.body.body, 'Comment', { max: 4000 });
    const { lastInsertRowid: id } = db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)').run(task.id, req.user.id, body);
    logActivity(db, task.board_id, req.user.id, 'comment.added', `commented on "${task.title}"`);
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

  // ----- Files attached to a task -----

  r.post('/tasks/:taskId/attachments', raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
    const task = loadTask(req.params.taskId);
    assertRole(db, task.board_id, req.user.id, 'member');
    const f = saveUpload(req, uploadDir);
    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO attachments (task_id, user_id, filename, mime, size, stored_name) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(task.id, req.user.id, f.filename, f.mime, f.size, f.stored);
    logActivity(db, task.board_id, req.user.id, 'file.added', `attached "${f.filename}" to "${task.title}"`);
    res.status(201).json({ attachment: getAttachment(id) });
  });

  r.get('/attachments/:attachmentId', (req, res) => {
    const a = loadAttachment(req.params.attachmentId);
    assertRole(db, a.board_id, req.user.id, 'supervisor');
    const type = req.query.view ? previewType(a, uploadDir) : null;
    if (type) sendInline(res, uploadDir, a, type); else sendDownload(res, uploadDir, a);
  });

  r.delete('/attachments/:attachmentId', (req, res) => {
    const a = loadAttachment(req.params.attachmentId);
    const role = assertRole(db, a.board_id, req.user.id, 'member');
    if (a.user_id !== req.user.id && role !== 'owner') throw new HttpError(403, 'Only the person who uploaded a file, or the group leader, can delete it.');
    db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
    removeFile(uploadDir, a.stored_name);
    res.status(204).end();
  });

  // ----- Helpers -----

  function readNewTask(boardId, b) {
    return {
      title: v.text(b.title, 'Task', { max: 140 }),
      notes: v.text(b.notes, 'Notes', { max: 8000, required: false }),
      status: v.oneOf(b.status ?? 'todo', v.STATUSES, 'Status'),
      important: Boolean(b.important),
      dueDate: v.date(b.dueDate),
      assigneeId: b.assigneeId == null ? null : checkAssignee(boardId, b.assigneeId),
    };
  }

  function loadTask(rawId) {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(v.id(rawId, 'Task id'));
    if (!task) throw new HttpError(404, 'Task not found.');
    return task;
  }

  function getTask(id) {
    return db.prepare(`
      SELECT ${TASK_LIST_COLUMNS}, t.notes, t.created_at, b.name AS board_name, b.personal, b.course_code, b.sem_start, b.kind, b.github_repo,
             t.github_issue, u.name AS created_by_name
      FROM tasks t JOIN boards b ON b.id = t.board_id LEFT JOIN users u ON u.id = t.created_by
      WHERE t.id = ?`).get(id);
  }

  function taskDetail(taskId) {
    return {
      comments: db.prepare(`
        SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name, ${avatarSql('u')} AS user_avatar
        FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id`).all(taskId),
      subtasks: db.prepare(`SELECT ${TASK_LIST_COLUMNS} FROM tasks t WHERE t.parent_id = ? ORDER BY t.position`).all(taskId),
      attachments: db.prepare(`
        SELECT a.id, a.filename, a.size, a.created_at, a.user_id, u.name AS user_name
        FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.task_id = ? ORDER BY a.id`).all(taskId),
    };
  }

  function getComment(id) {
    return db.prepare(`SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name, ${avatarSql('u')} AS user_avatar
      FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(id);
  }

  function getAttachment(id) {
    return db.prepare(`SELECT a.id, a.filename, a.size, a.created_at, a.user_id, u.name AS user_name
      FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ?`).get(id);
  }

  function loadAttachment(rawId) {
    const a = db.prepare('SELECT a.*, t.board_id FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?')
      .get(v.id(rawId, 'File id'));
    if (!a) throw new HttpError(404, 'File not found.');
    return a;
  }

  function checkAssignee(boardId, rawId) {
    const userId = v.id(rawId, 'Assignee');
    const row = db.prepare('SELECT role FROM memberships WHERE board_id = ? AND user_id = ?').get(boardId, userId);
    if (!row || row.role === 'supervisor') throw new HttpError(400, 'You can only give tasks to people in the group.');
    return userId;
  }

  return r;
}
