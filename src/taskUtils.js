import { logActivity } from './db.js';

export const POSITION_GAP = 1024;
export const STATUS_LABEL = { todo: 'To do', doing: 'Doing', done: 'Done' };

// "Today" in Malaysia (UTC+8) by default, so a task due today doesn't flip to overdue at 8am.
const OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS ?? 8);
const OFFSET = `${OFFSET_HOURS >= 0 ? '+' : ''}${OFFSET_HOURS} hours`;
export const TODAY_SQL = `date('now', '${OFFSET}')`;
export const localDateSql = (column) => `date(${column}, '${OFFSET}')`;

// Adds a task at the bottom of its column. Tasks on a personal board always belong to its owner.
export function createTask(db, boardId, userId, t) {
  const board = db.prepare('SELECT personal FROM boards WHERE id = ?').get(boardId);
  const status = t.status ?? 'todo';
  const { maxPos } = db.prepare('SELECT MAX(position) AS maxPos FROM tasks WHERE board_id = ? AND status = ?').get(boardId, status);
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO tasks (board_id, title, notes, status, important, position, assignee_id, due_date, completed_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') END, ?)`).run(
    boardId, t.title, t.notes ?? '', status, t.important ? 1 : 0, (maxPos ?? 0) + POSITION_GAP,
    board.personal ? userId : (t.assigneeId ?? null), t.dueDate ?? null, status, userId);
  if (!board.personal) logActivity(db, boardId, userId, 'task.created', `added "${t.title}"`);
  return id;
}
