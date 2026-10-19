import { Router } from 'express';
import path from 'node:path';
import { HttpError } from '../errors.js';
import { assertRole, avatarSql } from '../auth.js';
import { transaction, logActivity, suggestKey } from '../db.js';
import { TEMPLATES, dueForWeek } from '../templates.js';
import { createTask, TODAY_SQL, localDateSql } from '../taskUtils.js';
import { saveDocumentStream, removeFile, sendDownload, sendInline, previewType } from '../files.js';
import { parseRepo } from '../github.js';
import * as v from '../validate.js';

export const KINDS = ['school', 'personal'];

// Boards are "projects" in the interface. Each user also has one personal list, which is a board too.
export function boardRoutes(db, { uploadDir: dir, github }) {
  const r = Router();
  const uploadDir = path.resolve(dir);

  r.get('/', (req, res) => {
    const boards = db.prepare(`
      SELECT b.id, b.name, b.personal, b.kind, b.key, b.course_code, b.sem_start, m.role,
        p.created_at IS NOT NULL AS pinned,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id AND t.status != 'done') AS open_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id AND t.status = 'done') AS done_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id AND t.status != 'done' AND t.due_date < ${TODAY_SQL}) AS late_tasks,
        (SELECT COUNT(*) FROM memberships x WHERE x.board_id = b.id AND x.role != 'supervisor') AS people,
        (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id AND t.assignee_id = m.user_id AND m.role != 'supervisor'
           AND t.status != 'done' AND t.due_date <= ${TODAY_SQL}) AS my_urgent
      FROM boards b
      JOIN memberships m ON m.board_id = b.id
      LEFT JOIN pins p ON p.board_id = b.id AND p.user_id = m.user_id
      WHERE m.user_id = ? ORDER BY b.personal DESC, b.created_at, b.id`).all(req.user.id);
    res.json({ boards });
  });

  r.post('/', (req, res) => {
    const s = readSettings(req.body);
    // Supervisors only supervise; personal accounts only have personal projects.
    if (req.user.account_type === 'supervisor') {
      throw new HttpError(403, 'Supervisor accounts don’t create projects. Ask your students to add you as their supervisor.');
    }
    if (req.user.account_type === 'personal' && s.kind === 'school') {
      throw new HttpError(403, 'Personal accounts have personal projects only. Switch to a student account on your profile for school projects.');
    }
    const template = v.oneOf(req.body.template ?? 'blank', Object.keys(TEMPLATES), 'Template');
    if (s.kind === 'personal' && template !== 'blank') throw new HttpError(400, 'Templates are for school projects.');
    const board = transaction(db, () => {
      const { lastInsertRowid: id } = db.prepare(`
        INSERT INTO boards (name, kind, key, course_code, sem_start, github_repo, description) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(s.name, s.kind, s.key, s.course_code, s.sem_start, s.github_repo, v.text(req.body.description, 'Description', { max: 4000, required: false }));
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
    const settings = ['name', 'kind', 'key', 'course_code', 'sem_start', 'github_repo'].filter((k) => b[k] !== undefined);
    if (settings.length) {
      if (role !== 'owner') throw new HttpError(403, 'Only a group leader can change the project settings.');
      if (board.personal) {
        // The personal list keeps its name; it can only set when Week 1 starts.
        changes.sem_start = v.date(b.sem_start, 'Week 1 start date');
      } else {
        Object.assign(changes, readSettings({ ...board, ...b }));
        if (changes.kind !== board.kind) checkKindChange(boardId, changes.kind);
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

  // Leaders can wipe the Recent activity list, for example after setting a project up.
  r.delete('/:boardId/activity', (req, res) => {
    const boardId = v.id(req.params.boardId, 'Project id');
    assertRole(db, boardId, req.user.id, 'owner');
    db.prepare('DELETE FROM activity WHERE board_id = ?').run(boardId);
    res.status(204).end();
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

  // ----- GitHub: recent commits, open pull requests and issues for the linked repository -----

  // Uses your own GitHub token if you added one, otherwise a group leader's, otherwise none (public repositories only).
  function tokenFor(boardId, userId) {
    return db.prepare(`
      SELECT u.github_token FROM users u LEFT JOIN memberships m ON m.user_id = u.id AND m.board_id = ?
      WHERE u.github_token IS NOT NULL AND (u.id = ? OR m.role = 'owner')
      ORDER BY u.id = ? DESC LIMIT 1`).get(boardId, userId, userId)?.github_token ?? null;
  }

  r.get('/:boardId/github', async (req, res, next) => {
    try {
      const boardId = v.id(req.params.boardId, 'Project id');
      assertRole(db, boardId, req.user.id, 'supervisor');
      const { github_repo: repo, key: boardKey } = db.prepare('SELECT github_repo, key FROM boards WHERE id = ?').get(boardId);
      if (!repo) return res.json({ linked: false });
      const data = await github.overview(repo, tokenFor(boardId, req.user.id));
      // Link commits and pull requests that mention this project's keys, like MBSW-12, to those tasks.
      const numbers = [...new Set([...data.commits, ...data.pulls].flatMap((c) => c.keys)
        .filter((k) => k.key === boardKey).map((k) => k.number))];
      const tasks = numbers.length
        ? db.prepare(`SELECT id, number, title, status, ? || '-' || number AS key FROM tasks WHERE board_id = ? AND number IN (${numbers.map(() => '?').join(',')})`)
          .all(boardKey, boardId, ...numbers)
        : [];
      const imported = new Map(db.prepare(`SELECT github_issue, id, ? || '-' || number AS key FROM tasks WHERE board_id = ? AND github_issue IS NOT NULL`)
        .all(boardKey, boardId).map((t) => [t.github_issue, t]));
      const link = ({ keys, ...c }) => ({ ...c, tasks: tasks.filter((t) => keys.some((k) => k.key === boardKey && k.number === t.number)) });
      res.json({
        linked: true, ...data,
        commits: data.commits.map(link), pulls: data.pulls.map(link),
        issues: data.issues.map((i) => ({ ...i, task_id: imported.get(i.number)?.id ?? null, task_key: imported.get(i.number)?.key ?? null })),
      });
    } catch (err) { next(err); }
  });

  // Turns a GitHub issue into a task, with a link back to the issue in its notes.
  r.post('/:boardId/github/issues/:number', async (req, res, next) => {
    try {
      const boardId = v.id(req.params.boardId, 'Project id');
      const number = v.id(req.params.number, 'Issue number');
      assertRole(db, boardId, req.user.id, 'member');
      const { github_repo: repo } = db.prepare('SELECT github_repo FROM boards WHERE id = ?').get(boardId);
      if (!repo) throw new HttpError(400, 'Link a GitHub repository in the project settings first.');
      const existing = db.prepare('SELECT id FROM tasks WHERE board_id = ? AND github_issue = ?').get(boardId, number);
      if (existing) return res.json({ task: { id: existing.id }, existed: true });
      const issue = await github.issue(repo, number, tokenFor(boardId, req.user.id));
      if (issue.pull_request) throw new HttpError(400, 'That’s a pull request, not an issue.');
      const body = (issue.body || '').trim();
      const notes = `GitHub issue #${number}: ${issue.html_url}${body ? `\n\n${body.slice(0, 7000)}` : ''}`;
      const id = transaction(db, () => {
        const taskId = createTask(db, boardId, req.user.id, { title: issue.title.slice(0, 140), notes, assigneeId: req.user.id });
        db.prepare('UPDATE tasks SET github_issue = ? WHERE id = ?').run(number, taskId);
        return taskId;
      });
      res.status(201).json({ task: { id } });
    } catch (err) { next(err); }
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
      SELECT b.id, b.name, b.personal, b.kind, b.key, b.course_code, b.sem_start, b.description, b.goal, b.goal_date, b.github_repo,
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
    const user = db.prepare(`SELECT id, name, email, account_type, ${avatarSql('users')} AS avatar_url FROM users WHERE email = ?`).get(email);
    if (!user) throw new HttpError(404, 'No TaskForge account uses that email. Ask them to sign up first.');
    checkRoleFits(boardId, user, role);
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
      checkRoleFits(boardId, member, role);
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
      github_repo: parseRepo(body.github_repo),
      key: readKey(body.key, body.name),
    };
  }

  // Like Jira's project key: 2 to 10 capital letters or digits, starting with a letter.
  function readKey(raw, name) {
    if (raw === undefined || raw === null || raw === '') return suggestKey(name ?? '');
    if (typeof raw !== 'string') throw new HttpError(400, 'Project key must be text.');
    const key = raw.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new HttpError(400, 'A project key is 2 to 10 letters or digits and starts with a letter, like MBSW.');
    return key;
  }

  // The account type decides what someone can be: supervisor accounts only supervise,
  // personal accounts stay out of school projects, and personal projects have no supervisors.
  function checkRoleFits(boardId, user, role) {
    const { kind } = db.prepare('SELECT kind FROM boards WHERE id = ?').get(boardId);
    if (user.account_type === 'supervisor' && role !== 'supervisor') {
      throw new HttpError(400, `${user.name} has a supervisor account, so they can only be added as a supervisor.`);
    }
    if (kind === 'personal' && role === 'supervisor') throw new HttpError(400, 'Personal projects don’t have supervisors.');
    if (kind === 'personal' && user.account_type === 'supervisor') throw new HttpError(400, `${user.name} has a supervisor account, which is for school projects only.`);
    if (kind === 'school' && user.account_type === 'personal') {
      throw new HttpError(400, `${user.name} has a personal account, so they can’t join school projects.`);
    }
  }

  function checkKindChange(boardId, kind) {
    const members = db.prepare(`
      SELECT u.name, u.account_type, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.board_id = ?`).all(boardId);
    const clash = kind === 'personal'
      ? members.find((m) => m.role === 'supervisor' || m.account_type === 'supervisor')
      : members.find((m) => m.account_type === 'personal');
    if (clash) {
      throw new HttpError(400, kind === 'personal'
        ? `Remove ${clash.name} first. Personal projects don’t have supervisors.`
        : `Remove ${clash.name} first. They have a personal account, which can’t be in school projects.`);
    }
  }

  function notPersonal(boardId, message) {
    if (db.prepare('SELECT personal FROM boards WHERE id = ?').get(boardId).personal) throw new HttpError(400, message);
  }

  function memberOrThrow(boardId, userId) {
    const member = db.prepare(`
      SELECT u.name, u.account_type, m.role FROM memberships m JOIN users u ON u.id = m.user_id
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
  t.id, t.board_id, t.parent_id, t.number, (SELECT k.key FROM boards k WHERE k.id = t.board_id) || '-' || t.number AS key, t.title, t.status, t.important, t.position, t.assignee_id, t.due_date, t.completed_at,
  (SELECT p.title FROM tasks p WHERE p.id = t.parent_id) AS parent_title,
  (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
  (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS file_count,
  (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
  (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.status = 'done') AS subtasks_done`;
