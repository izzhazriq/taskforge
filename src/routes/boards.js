import { Router } from 'express';
import path from 'node:path';
import { HttpError, assertRole, avatarSql } from '../auth.js';
import { transaction, logActivity } from '../db.js';
import { TEMPLATES, dueForWeek } from '../templates.js';
import { createTask, TODAY_SQL, localDateSql } from '../taskUtils.js';
import { saveDocumentStream, removeFile, sendDownload, sendInline, previewType } from '../files.js';
import * as v from '../validate.js';

export const KINDS = ['school', 'personal'];

// Boards are "projects" in the interface. Each user also has one personal list, which is a board too.
export function boardRoutes(db, { uploadDir: dir }) {
  const r = Router();
  const uploadDir = path.resolve(dir);

  r.get('/', (req, res) => {
    const boards = db.prepare(`
      SELECT b.id, b.name, b.personal, b.kind, b.course_code, b.sem_start, m.role,
        p.created_at IS NOT NULL AS pinned,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id AND t.status != 'done') AS open_tasks
      FROM boards b
      JOIN memberships m ON m.board_id = b.id
      LEFT JOIN pins p ON p.board_id = b.id AND p.user_id = m.user_id
      WHERE m.user_id = ? ORDER BY b.personal DESC, b.created_at, b.id`).all(req.user.id);
    res.json({ boards });
  });

  r.post('/', (req, res) => {
    const s = readSettings(req.body);
    const template = v.oneOf(req.body.template ?? 'blank', Object.keys(TEMPLATES), 'Template');
    if (s.kind === 'personal' && template !== 'blank') throw new HttpError(400, 'Templates are for school projects.');
    const board = transaction(db, () => {
      const { lastInsertRowid: id } = db.prepare(`
        INSERT INTO boards (name, kind, course_code, sem_start, description) VALUES (?, ?, ?, ?, ?)`)
        .run(s.name, s.kind, s.course_code, s.sem_start, v.text(req.body.description, 'Description', { max: 4000, required: false }));
      db.prepare(`INSERT INTO memberships (board_id, user_id, role) VALUES (?, ?, 'owner')`).run(id, req.user.id);
      logActivity(db, id, req.user.id, 'board.created', `created the project "${s.name}"`);
      for (const t of TEMPLATES[template].tasks) {
        createTask(db, id, req.user.id, { ...t, dueDate: dueForWeek(s.sem_start, t.week) });
      }
      return { id, ...s, personal: 0, role: 'owner', pinned: 0 };
    });
    res.status(201).json({ board });
  });

  r.get('/:boardId', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    const role = assertRole(db, boardId, req.user.id, 'supervisor');
    const tasks = db.prepare(`
      SELECT ${TASK_LIST_COLUMNS} FROM tasks t WHERE t.board_id = ? AND t.parent_id IS NULL ORDER BY t.status, t.position`).all(boardId);
    res.json({ board: { ...getBoard(boardId, req.user.id), role }, members: getMembers(boardId), tasks });
  });

  // The Summary section: about, goal, how the work is going, recent activity and who has how much.
  r.get('/:boardId/summary', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'supervisor');
    const status = db.prepare(`
      SELECT
        COALESCE(SUM(status = 'todo'), 0) AS todo,
        COALESCE(SUM(status = 'doing'), 0) AS doing,
        COALESCE(SUM(status = 'done'), 0) AS done,
        COALESCE(SUM(status != 'done' AND due_date < ${TODAY_SQL}), 0) AS late,
        COALESCE(SUM(status != 'done' AND due_date >= ${TODAY_SQL} AND due_date <= date(${TODAY_SQL}, '+7 days')), 0) AS due_soon,
        COALESCE(SUM(parent_id IS NOT NULL), 0) AS subtasks
      FROM tasks WHERE board_id = ?`).get(boardId);
    const activity = db.prepare(`
      SELECT a.id, a.detail, a.created_at, a.user_id, u.name AS user_name, ${avatarSql('u')} AS user_avatar
      FROM activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.board_id = ? ORDER BY a.id DESC LIMIT 8`).all(boardId);
    const workload = db.prepare(`
      SELECT u.id, u.name, m.role, ${avatarSql('u')} AS avatar_url,
        COUNT(t.id) FILTER (WHERE t.status = 'todo') AS todo,
        COUNT(t.id) FILTER (WHERE t.status = 'doing') AS doing,
        COUNT(t.id) FILTER (WHERE t.status = 'done') AS done,
        COUNT(t.id) FILTER (WHERE t.status != 'done' AND t.due_date < ${TODAY_SQL}) AS late
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN tasks t ON t.board_id = m.board_id AND t.assignee_id = u.id
      WHERE m.board_id = ? AND m.role != 'supervisor'
      GROUP BY u.id ORDER BY (todo + doing) DESC, u.name`).all(boardId);
    const { unassigned } = db.prepare(`
      SELECT COUNT(*) AS unassigned FROM tasks WHERE board_id = ? AND assignee_id IS NULL AND status != 'done'`).get(boardId);
    res.json({ status, activity, workload, unassigned });
  });

  // Leaders change everything; members can also write the description and the goal.
  r.patch('/:boardId', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    const role = assertRole(db, boardId, req.user.id, 'member');
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
    const b = req.body;
    const changes = {};
    if (b.description !== undefined) changes.description = v.text(b.description, 'Description', { max: 4000, required: false });
    if (b.goal !== undefined) changes.goal = v.text(b.goal, 'Goal', { max: 300, required: false });
    if (b.goal_date !== undefined) changes.goal_date = v.date(b.goal_date, 'Goal date');
    const settings = ['name', 'kind', 'course_code', 'sem_start'].filter((k) => b[k] !== undefined);
    if (settings.length) {
      if (role !== 'owner') throw new HttpError(403, 'Only a group leader can change the project settings.');
      if (board.personal) {
        // The personal list keeps its name; it can only set when Week 1 starts.
        changes.sem_start = v.date(b.sem_start, 'Week 1 start date');
      } else {
        Object.assign(changes, readSettings({ ...board, ...b }));
      }
    }
    const cols = Object.keys(changes);
    if (!cols.length) throw new HttpError(400, 'Nothing to update.');
    db.prepare(`UPDATE boards SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => changes[c]), boardId);
    if (changes.goal !== undefined && changes.goal !== board.goal && changes.goal) {
      logActivity(db, boardId, req.user.id, 'board.goal', `set the goal to "${changes.goal}"`);
    } else if (changes.description !== undefined && changes.description !== board.description) {
      logActivity(db, boardId, req.user.id, 'board.description', 'updated the description');
    }
    res.json({ board: { ...getBoard(boardId, req.user.id), role } });
  });

  r.delete('/:boardId', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'owner');
    notPersonal(boardId, 'Your personal list can’t be deleted.');
    const files = db.prepare(`
      SELECT a.stored_name FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE t.board_id = ?
      UNION ALL SELECT stored_name FROM documents WHERE board_id = ?`).all(boardId, boardId);
    db.prepare('DELETE FROM boards WHERE id = ?').run(boardId);
    for (const f of files) removeFile(uploadDir, f.stored_name);
    res.status(204).end();
  });

  // ----- Pins: each person pins their own important projects -----

  r.put('/:boardId/pin', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'supervisor');
    notPersonal(boardId, 'Your personal list is always at the top already.');
    db.prepare('INSERT OR IGNORE INTO pins (user_id, board_id) VALUES (?, ?)').run(req.user.id, boardId);
    res.status(204).end();
  });

  r.delete('/:boardId/pin', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'supervisor');
    db.prepare('DELETE FROM pins WHERE user_id = ? AND board_id = ?').run(req.user.id, boardId);
    res.status(204).end();
  });

  // ----- Documents: files for the whole project, plus a list of every file attached to its tasks -----

  r.get('/:boardId/documents', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'supervisor');
    // `preview` says whether the browser can show it: image, video, pdf, or null for download only.
    const withPreview = (f) => {
      const { stored_name: storedName, mime, ...rest } = f;
      return { ...rest, preview: previewType({ stored_name: storedName, mime }, uploadDir)?.kind ?? null };
    };
    const documents = db.prepare(`
      SELECT d.id, d.filename, d.mime, d.size, d.created_at, d.user_id, d.stored_name, u.name AS user_name
      FROM documents d LEFT JOIN users u ON u.id = d.user_id WHERE d.board_id = ? ORDER BY d.id DESC`).all(boardId).map(withPreview);
    const taskFiles = db.prepare(`
      SELECT a.id, a.filename, a.mime, a.size, a.created_at, a.user_id, a.stored_name, u.name AS user_name,
        t.id AS task_id, t.title AS task_title
      FROM attachments a JOIN tasks t ON t.id = a.task_id LEFT JOIN users u ON u.id = a.user_id
      WHERE t.board_id = ? ORDER BY a.id DESC`).all(boardId).map(withPreview);
    res.json({ documents, taskFiles });
  });

  // The file streams straight to disk, so videos of a few hundred MB are fine.
  r.post('/:boardId/documents', async (req, res, next) => {
    let f;
    try {
      const boardId = v.id(req.params.boardId, 'Project id');
      assertRole(db, boardId, req.user.id, 'member');
      f = await saveDocumentStream(req, uploadDir);
    } catch (err) {
      req.resume(); // drain the rest of the upload so the error reaches the browser
      return next(err);
    }
    const boardId = Number(req.params.boardId);
    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO documents (board_id, user_id, filename, mime, size, stored_name) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(boardId, req.user.id, f.filename, f.mime, f.size, f.stored);
    logActivity(db, boardId, req.user.id, 'document.added', `added the document "${f.filename}"`);
    res.status(201).json({ document: {
      id, filename: f.filename, size: f.size, user_id: req.user.id, user_name: req.user.name,
      preview: previewType({ stored_name: f.stored, mime: f.mime }, uploadDir)?.kind ?? null,
    } });
  });

  // Members list, with each person's photo. Used by the board and the Team panel.
  function getMembers(boardId) {
    return db.prepare(`
      SELECT u.id, u.name, u.email, m.role, ${avatarSql('u')} AS avatar_url
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.board_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, u.name`).all(boardId);
  }

  function getBoard(boardId, userId) {
    return db.prepare(`
      SELECT b.id, b.name, b.personal, b.kind, b.course_code, b.sem_start, b.description, b.goal, b.goal_date,
        EXISTS (SELECT 1 FROM pins p WHERE p.board_id = b.id AND p.user_id = ?) AS pinned
      FROM boards b WHERE b.id = ?`).get(userId, boardId);
  }

  // ----- Team -----

  r.post('/:boardId/members', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'owner');
    notPersonal(boardId, 'Your personal list is just for you. Create a project to work with others.');
    const email = v.email(req.body.email);
    const role = v.oneOf(req.body.role ?? 'member', v.ROLES, 'Role');
    const user = db.prepare(`SELECT id, name, email, ${avatarSql('users')} AS avatar_url FROM users WHERE email = ?`).get(email);
    if (!user) throw new HttpError(404, 'No TaskForge account uses that email. Ask them to sign up first.');
    if (db.prepare('SELECT 1 FROM memberships WHERE board_id = ? AND user_id = ?').get(boardId, user.id)) {
      throw new HttpError(409, `${user.name} is already in this project.`);
    }
    db.prepare('INSERT INTO memberships (board_id, user_id, role) VALUES (?, ?, ?)').run(boardId, user.id, role);
    logActivity(db, boardId, req.user.id, 'member.added', `added ${user.name}`);
    res.status(201).json({ member: { ...user, role } });
  });

  r.patch('/:boardId/members/:userId', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    const userId = v.id(req.params.userId, 'User id');
    assertRole(db, boardId, req.user.id, 'owner');
    const role = v.oneOf(req.body.role, v.ROLES, 'Role');
    transaction(db, () => {
      const member = memberOrThrow(boardId, userId);
      if (member.role === 'owner' && role !== 'owner') ensureAnotherOwner(boardId);
      db.prepare('UPDATE memberships SET role = ? WHERE board_id = ? AND user_id = ?').run(role, boardId, userId);
      if (role === 'supervisor') db.prepare('UPDATE tasks SET assignee_id = NULL WHERE board_id = ? AND assignee_id = ?').run(boardId, userId);
    });
    res.json({ member: { id: userId, role } });
  });

  r.delete('/:boardId/members/:userId', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    const userId = v.id(req.params.userId, 'User id');
    // Leaders can remove anyone; everyone can remove themselves (leave the project).
    assertRole(db, boardId, req.user.id, userId === req.user.id ? 'supervisor' : 'owner');
    notPersonal(boardId, 'You can’t leave your personal list.');
    transaction(db, () => {
      const member = memberOrThrow(boardId, userId);
      if (member.role === 'owner') ensureAnotherOwner(boardId);
      db.prepare('DELETE FROM memberships WHERE board_id = ? AND user_id = ?').run(boardId, userId);
      db.prepare('DELETE FROM pins WHERE board_id = ? AND user_id = ?').run(boardId, userId);
      db.prepare('UPDATE tasks SET assignee_id = NULL WHERE board_id = ? AND assignee_id = ?').run(boardId, userId);
      logActivity(db, boardId, req.user.id, 'member.removed', userId === req.user.id ? 'left the project' : `removed ${member.name}`);
    });
    res.status(204).end();
  });

  // Who did what, for peer evaluation forms and supervisor check-ins.
  r.get('/:boardId/contributions', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'supervisor');
    const rows = db.prepare(`
      SELECT u.id, u.name, m.role,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = m.board_id AND t.assignee_id = u.id) AS assigned,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = m.board_id AND t.assignee_id = u.id AND t.status = 'done') AS done,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = m.board_id AND t.assignee_id = u.id AND t.status = 'done'
           AND t.due_date IS NOT NULL AND ${localDateSql('t.completed_at')} <= t.due_date) AS on_time,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = m.board_id AND t.assignee_id = u.id AND t.status != 'done'
           AND t.due_date < ${TODAY_SQL}) AS late,
        (SELECT COUNT(*) FROM comments c JOIN tasks t ON t.id = c.task_id WHERE t.board_id = m.board_id AND c.user_id = u.id) AS comments,
        (SELECT COUNT(*) FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE t.board_id = m.board_id AND a.user_id = u.id)
          + (SELECT COUNT(*) FROM documents d WHERE d.board_id = m.board_id AND d.user_id = u.id) AS files
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.board_id = ? AND m.role != 'supervisor' ORDER BY done DESC, u.name`).all(boardId);
    res.json({ contributions: rows });
  });

  // Personal projects (a side project, a club, a trip) don't use course codes or semester weeks.
  function readSettings(body) {
    const kind = v.oneOf(body.kind ?? 'school', KINDS, 'Project type');
    const school = kind === 'school';
    return {
      name: v.text(body.name, 'Project name', { max: 80 }),
      kind,
      course_code: school ? v.text(body.course_code, 'Course code', { max: 20, required: false }).replace(/\s+/g, '').toUpperCase() : '',
      sem_start: school ? v.date(body.sem_start, 'Week 1 start date') : null,
    };
  }

  function notPersonal(boardId, message) {
    if (db.prepare('SELECT personal FROM boards WHERE id = ?').get(boardId).personal) throw new HttpError(400, message);
  }

  function memberOrThrow(boardId, userId) {
    const member = db.prepare(`
      SELECT u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.board_id = ? AND m.user_id = ?`).get(boardId, userId);
    if (!member) throw new HttpError(404, 'That person is not in this project.');
    return member;
  }

  function ensureAnotherOwner(boardId) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE board_id = ? AND role = 'owner'`).get(boardId);
    if (n < 2) throw new HttpError(400, 'A project needs at least one group leader. Make someone else leader first.');
  }

  return r;
}

// Download or delete a project document. Mounted at /api/documents.
export function documentRoutes(db, { uploadDir: dir }) {
  const r = Router();
  const uploadDir = path.resolve(dir);
  const load = (rawId) => {
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(v.id(rawId, 'Document id'));
    if (!d) throw new HttpError(404, 'Document not found.');
    return d;
  };
  r.get('/:docId', (req, res) => {
    const d = load(req.params.docId);
    assertRole(db, d.board_id, req.user.id, 'supervisor');
    // ?view=1 shows pictures, videos and PDFs in the browser; anything else always downloads.
    const type = req.query.view ? previewType(d, uploadDir) : null;
    if (type) sendInline(res, uploadDir, d, type); else sendDownload(res, uploadDir, d);
  });
  r.delete('/:docId', (req, res) => {
    const d = load(req.params.docId);
    const role = assertRole(db, d.board_id, req.user.id, 'member');
    if (d.user_id !== req.user.id && role !== 'owner') throw new HttpError(403, 'Only the person who added a document, or the group leader, can delete it.');
    db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
    removeFile(uploadDir, d.stored_name);
    res.status(204).end();
  });
  return r;
}

export const TASK_LIST_COLUMNS = `
  t.id, t.board_id, t.parent_id, t.title, t.status, t.important, t.position, t.assignee_id, t.due_date, t.completed_at,
  (SELECT p.title FROM tasks p WHERE p.id = t.parent_id) AS parent_title,
  (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
  (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS file_count,
  (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
  (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.status = 'done') AS subtasks_done`;
