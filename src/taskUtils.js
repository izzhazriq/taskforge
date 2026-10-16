import { logActivity } from './db.js';

export const POSITION_GAP = 1024;
export const STATUS_LABEL = { todo: 'To do', doing: 'Doing', done: 'Done' };

// "Today" in Malaysia (UTC+8) by default, so a task due today doesn't flip to overdue at 8am.
const OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS ?? 8);
const OFFSET = `${OFFSET_HOURS >= 0 ? '+' : ''}${OFFSET_HOURS} hours`;
export const TODAY_SQL = `date('now', '${OFFSET}')`;
export const localDateSql = (column) => `date(${column}, '${OFFSET}')`;

// Adds a task at the bottom of its column, or a subtask at the end of its parent's list.
// Tasks on a personal list always belong to its owner.
export function createTask(db, boardId, userId, t) {
  const board = db.prepare('SELECT personal FROM boards WHERE id = ?').get(boardId);
  const status = t.status ?? 'todo';
  const parentId = t.parentId ?? null;
  const { maxPos } = parentId
    ? db.prepare('SELECT MAX(position) AS maxPos FROM tasks WHERE parent_id = ?').get(parentId)
    : db.prepare('SELECT MAX(position) AS maxPos FROM tasks WHERE board_id = ? AND status = ? AND parent_id IS NULL').get(boardId, status);
  // Each task takes the project's next number, so its key (MBSW-12) never changes or repeats.
  const { number } = db.prepare('UPDATE boards SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number').get(boardId);
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO tasks (board_id, parent_id, number, title, notes, status, important, position, assignee_id, due_date, completed_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') END, ?)`).run(
    boardId, parentId, number, t.title, t.notes ?? '', status, t.important ? 1 : 0, (maxPos ?? 0) + POSITION_GAP,
    board.personal ? userId : (t.assigneeId ?? null), t.dueDate ?? null, status, userId);
  logActivity(db, boardId, userId, 'task.created', parentId ? `added the subtask "${t.title}"` : `added "${t.title}"`);
  return id;
}
