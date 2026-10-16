import { Router } from 'express';
import { HttpError, assertRole } from '../auth.js';
import { transaction, logActivity } from '../db.js';
import { TEMPLATES, dueForWeek } from '../templates.js';
import { createTask, TODAY_SQL, localDateSql } from '../taskUtils.js';
import * as v from '../validate.js';

// Boards are "projects" in the interface. Each user also has one personal board.
export function boardRoutes(db) {
  const r = Router();

  r.get('/', (req, res) => {
    const boards = db.prepare(`
      SELECT b.id, b.name, b.personal, b.course_code, b.sem_start, m.role,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id AND t.status != 'done') AS open_tasks
      FROM boards b JOIN memberships m ON m.board_id = b.id
      WHERE m.user_id = ? ORDER BY b.personal DESC, b.created_at, b.id`).all(req.user.id);
    res.json({ boards });
  });

  r.post('/', (req, res) => {
    const s = readSettings(req.body);
    const template = v.oneOf(req.body.template ?? 'blank', Object.keys(TEMPLATES), 'Template');
    const board = transaction(db, () => {
      const { lastInsertRowid: id } = db.prepare('INSERT INTO boards (name, course_code, sem_start) VALUES (?, ?, ?)')
        .run(s.name, s.course_code, s.sem_start);
      db.prepare(`INSERT INTO memberships (board_id, user_id, role) VALUES (?, ?, 'owner')`).run(id, req.user.id);
      logActivity(db, id, req.user.id, 'board.created', `created the project "${s.name}"`);
      for (const t of TEMPLATES[template].tasks) {
        createTask(db, id, req.user.id, { ...t, dueDate: dueForWeek(s.sem_start, t.week) });
      }
      return { id, ...s, personal: 0, role: 'owner' };
    });
    res.status(201).json({ board });
  });

  r.get('/:boardId', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    const role = assertRole(db, boardId, req.user.id, 'supervisor');
    const board = db.prepare('SELECT id, name, personal, course_code, sem_start FROM boards WHERE id = ?').get(boardId);
    const members = db.prepare(`
      SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.board_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, u.name`).all(boardId);
    const tasks = db.prepare(`SELECT ${TASK_LIST_COLUMNS} FROM tasks t WHERE t.board_id = ? ORDER BY t.status, t.position`).all(boardId);
    res.json({ board: { ...board, role }, members, tasks });
  });

  // Personal boards can set their Week 1 date too, so "My work" can show the semester week.
  r.patch('/:boardId', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'owner');
    const { personal } = db.prepare('SELECT personal FROM boards WHERE id = ?').get(boardId);
    const s = personal ? { name: 'Personal', course_code: '', sem_start: v.date(req.body.sem_start, 'Week 1 start date') } : readSettings(req.body);
    db.prepare('UPDATE boards SET name = ?, course_code = ?, sem_start = ? WHERE id = ?').run(s.name, s.course_code, s.sem_start, boardId);
    res.json({ board: { id: boardId, ...s } });
  });

  r.delete('/:boardId', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'owner');
    notPersonal(boardId, 'Your personal list can’t be deleted.');
    db.prepare('DELETE FROM boards WHERE id = ?').run(boardId);
    res.status(204).end();
  });

  // ----- Team -----

  r.post('/:boardId/members', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'owner');
    notPersonal(boardId, 'Your personal list is just for you. Create a project to work with others.');
    const email = v.email(req.body.email);
    const role = v.oneOf(req.body.role ?? 'member', v.ROLES, 'Role');
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
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
        (SELECT COUNT(*) FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE t.board_id = m.board_id AND a.user_id = u.id) AS files
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.board_id = ? AND m.role != 'supervisor' ORDER BY done DESC, u.name`).all(boardId);
    res.json({ contributions: rows });
  });

  function readSettings(body) {
    return {
      name: v.text(body.name, 'Project name', { max: 80 }),
      course_code: v.text(body.course_code, 'Course code', { max: 20, required: false }).replace(/\s+/g, '').toUpperCase(),
      sem_start: v.date(body.sem_start, 'Week 1 start date'),
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

export const TASK_LIST_COLUMNS = `
  t.id, t.board_id, t.title, t.status, t.important, t.position, t.assignee_id, t.due_date, t.completed_at,
  (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
  (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS file_count,
  (SELECT COUNT(*) FROM steps s WHERE s.task_id = t.id) AS step_count,
  (SELECT COUNT(*) FROM steps s WHERE s.task_id = t.id AND s.done) AS steps_done`;
