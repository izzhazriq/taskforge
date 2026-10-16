// TaskForge front end: plain JavaScript, no build step.
const $ = (id) => document.getElementById(id);

const COLUMNS = [
  { status: 'todo', label: 'To do', color: 'var(--todo)' },
  { status: 'doing', label: 'Doing', color: 'var(--doing)' },
  { status: 'done', label: 'Done', color: 'var(--done)' },
];
const ROLE_NAME = { owner: 'Leader', member: 'Member', supervisor: 'Supervisor' };
const MAX_UPLOAD = 10 * 1024 * 1024;

const state = {
  me: null,
  boards: [],
  view: { kind: 'mywork' }, // or { kind: 'board', id } or { kind: 'search', q }
  board: null, members: [], tasks: [], // the open board
  myTasks: [],
  task: null, // the task open in the side panel
  onlyMine: false,
  showAllDone: false,
};
const DONE_SHOWN = 10; // the Done column shows the most recent ones until you ask for more

// ---------- Helpers ----------
async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  // Signed out somewhere else, or the session ran out: go back to the sign-in page.
  if (res.status === 401 && state.me && !path.startsWith('/auth/')) {
    state.me = null;
    showAuth();
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}

// Anything that fails without its own error message shows up in a small note at the bottom.
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.status === 401) return;
  toast(e.reason?.message || 'Something went wrong.');
});

// Builds elements with text content only, so user-entered text is never parsed as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'draggable') el.draggable = Boolean(v); // enumerated attribute: needs "true", not ""
    else if (k === 'checked' || k === 'disabled') el[k] = Boolean(v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const initials = (name) => name.split(/\s+/).filter((p) => /[A-Za-z]/.test(p[0])).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the viewer's time zone
const daysUntil = (date) => Math.round((Date.parse(date) - Date.parse(today())) / 86400000);
const shortDate = (date) => new Date(date + 'T00:00').toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtSize = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fmtTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const personalBoard = () => state.boards.find((b) => b.personal);
const canWork = (role) => role === 'owner' || role === 'member';

function dueText(date, status) {
  if (!date) return '';
  if (status === 'done') return shortDate(date);
  const d = daysUntil(date);
  if (d < -1) return `${-d} days late`;
  if (d === -1) return 'Yesterday';
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  return shortDate(date);
}
function dueClass(date, status) {
  if (!date || status === 'done') return 'due';
  const d = daysUntil(date);
  return d < 0 ? 'due late' : d <= 1 ? 'due soon' : 'due';
}

// Semester week for a date, counted from a Week 1 Monday.
function weekOf(date, semStart) {
  if (!semStart || !date) return null;
  const w = Math.floor((Date.parse(date) - Date.parse(semStart)) / (7 * 86400000)) + 1;
  return w >= 1 && w <= 20 ? w : null;
}

function localGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function localSet(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }

// ---------- Auth ----------
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('tab-login').setAttribute('aria-selected', mode === 'login');
  $('tab-register').setAttribute('aria-selected', mode === 'register');
  $('name-field').hidden = mode === 'login';
  $('auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('auth-error').textContent = '';
}
$('tab-login').onclick = () => setAuthMode('login');
$('tab-register').onclick = () => setAuthMode('register');
$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const body = { email: $('auth-email').value, password: $('auth-password').value };
    if (authMode === 'register') body.name = $('auth-name').value;
    ({ user: state.me } = await api(`/auth/${authMode}`, { method: 'POST', body }));
    await enterApp();
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
};
$('logout').onclick = async () => {
  await api('/auth/logout', { method: 'POST' });
  state.me = null;
  showAuth();
};

function showAuth() {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('app-view').hidden = true;
  $('auth-view').hidden = false;
  setAuthMode('login');
  api('/auth/info').then(({ demo }) => { $('demo-hint').hidden = !demo; }, () => {});
}

async function enterApp() {
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  $('me-name').textContent = state.me.name;
  $('search-input').value = '';
  await loadBoards();
  const saved = localGet('tf-view');
  const id = Number(saved);
  if (saved && saved !== 'mywork' && state.boards.some((b) => b.id === id)) await showBoard(id);
  else await showMyWork();
}

// ---------- Navigation ----------
async function loadBoards() {
  ({ boards: state.boards } = await api('/boards'));
  const projects = state.boards.filter((b) => !b.personal);
  $('project-list').replaceChildren(...projects.map((b) => h('button', {
    class: 'nav-item', 'data-board': b.id, onclick: () => showBoard(b.id),
  }, h('span', { class: 'name' }, b.name), h('small', {}, b.course_code || ''))));
  markNav();
}

function markNav() {
  const v = state.view;
  $('nav-mywork').setAttribute('aria-current', v.kind === 'mywork');
  $('nav-personal').setAttribute('aria-current', v.kind === 'board' && v.id === personalBoard()?.id);
  for (const el of document.querySelectorAll('#project-list .nav-item')) {
    el.setAttribute('aria-current', v.kind === 'board' && Number(el.dataset.board) === v.id);
  }
}

$('nav-mywork').onclick = () => showMyWork();
$('nav-personal').onclick = () => showBoard(personalBoard().id);

function showView(name) {
  for (const v of ['mywork', 'board', 'search']) $(`${v}-view`).hidden = v !== name;
}

async function refresh() {
  if (!state.me) return;
  await loadBoards();
  const v = state.view;
  if (v.kind === 'mywork') await showMyWork();
  else if (v.kind === 'search') await showSearch(v.q);
  else if (state.boards.some((b) => b.id === v.id)) await showBoard(v.id);
  else await showMyWork(); // the project was deleted or you were removed from it
}

// ---------- Search ----------
async function showSearch(q) {
  state.view = { kind: 'search', q };
  const { tasks } = await api(`/search?q=${encodeURIComponent(q)}`);
  if (state.view.kind !== 'search' || state.view.q !== q) return; // a newer search started meanwhile
  showView('search');
  markNav();
  $('search-sub').textContent = tasks.length
    ? `${tasks.length === 50 ? '50 or more' : tasks.length} task${tasks.length === 1 ? '' : 's'} matching “${q}”`
    : '';
  $('search-results').hidden = !tasks.length;
  $('search-results').replaceChildren(...tasks.map((t) => renderRow(t, { showBoard: true })));
  if (!tasks.length) $('search-sub').textContent = `Nothing matches “${q}”. Search looks in task names and notes.`;
}
let searchTimer;
$('search-input').oninput = (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => (q ? showSearch(q) : state.view.kind === 'search' && showMyWork()), 200);
};
$('search-form').onsubmit = (e) => { e.preventDefault(); clearTimeout(searchTimer); const q = $('search-input').value.trim(); if (q) showSearch(q); };
$('search-input').onkeydown = (e) => { if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); if (state.view.kind === 'search') showMyWork(); } };

// Keyboard: "/" searches, "n" adds a task.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !state.me || document.querySelector('dialog[open]')) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === '/') { e.preventDefault(); $('search-input').focus(); }
  if (e.key === 'n') {
    e.preventDefault();
    if (state.view.kind === 'board') document.querySelector('.column[data-status="todo"] .add-task input')?.focus();
    else showMyWork().then(() => $('qa-title').focus());
  }
});

// ---------- My work ----------
async function showMyWork() {
  state.view = { kind: 'mywork' };
  localSet('tf-view', 'mywork');
  ({ tasks: state.myTasks } = await api('/me/tasks'));
  if (state.view.kind !== 'mywork') return;
  showView('mywork');
  markNav();
  renderMyWork();
}

function renderMyWork() {
  const week = weekOf(today(), personalBoard()?.sem_start);
  $('today-line').replaceChildren(
    new Date().toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long' }),
    week ? ' · ' : '', week ? h('b', {}, `Week ${week}`) : '');

  // Quick add: personal list or any project I work on
  const where = $('qa-where');
  const keep = where.value;
  where.replaceChildren(...state.boards.filter((b) => canWork(b.role)).map((b) =>
    h('option', { value: b.id }, b.personal ? 'Personal' : (b.course_code ? `${b.course_code} · ${b.name}` : b.name))));
  if (keep && [...where.options].some((o) => o.value === keep)) where.value = keep;

  const open = state.myTasks.filter((t) => t.status !== 'done');
  const groups = [
    { key: 'late', title: 'Late', test: (t) => t.due_date && daysUntil(t.due_date) < 0 },
    { key: 'today', title: 'Today', test: (t) => t.due_date && daysUntil(t.due_date) === 0 },
    { key: 'tomorrow', title: 'Tomorrow', test: (t) => t.due_date && daysUntil(t.due_date) === 1 },
    { key: 'week', title: 'Next 7 days', test: (t) => t.due_date && daysUntil(t.due_date) <= 7 },
    { key: 'later', title: 'Later', test: (t) => Boolean(t.due_date) },
    { key: 'nodate', title: 'No due date', test: () => true },
  ];
  const placed = new Set();
  const sections = groups.map((g) => {
    const items = open.filter((t) => !placed.has(t.id) && g.test(t));
    items.forEach((t) => placed.add(t.id));
    return { ...g, items };
  });
  const done = state.myTasks.filter((t) => t.status === 'done');
  if (done.length) sections.push({ key: 'done', title: 'Done recently', items: done });

  const urgent = sections.filter((s) => s.key === 'late' || s.key === 'today').reduce((n, s) => n + s.items.length, 0);
  $('mywork-badge').hidden = !urgent;
  $('mywork-badge').textContent = urgent;

  const shown = sections.filter((s) => s.items.length);
  $('mywork-groups').replaceChildren(...(shown.length ? shown.map((s) => h('section', { class: `group ${s.key}` },
    h('h3', {}, s.title, h('span', { class: 'muted' }, String(s.items.length))),
    h('ul', { class: 'rows' }, s.items.map(renderRow))))
    : [h('p', { class: 'empty-note' }, 'Nothing on your plate. Add a task above, or open a project to pick something up.')]));
}

function renderRow(t, { showBoard = false } = {}) {
  const done = t.status === 'done';
  return h('li', { class: `row-item${done ? ' done' : ''}`, onclick: () => openTask(t.id) },
    h('input', { type: 'checkbox', class: 'tick', checked: done, 'aria-label': `Mark "${t.title}" as done`,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => setDone(t.id, e.target.checked) }),
    h('span', { class: 'title' }, t.title, t.important ? h('span', { class: 'star-mark', title: 'Important' }, ' ★') : ''),
    h('span', { class: 'meta' },
      t.step_count ? h('span', {}, `${t.steps_done}/${t.step_count} steps`) : '',
      t.file_count ? h('span', {}, `${t.file_count} file${t.file_count > 1 ? 's' : ''}`) : '',
      (!t.personal || showBoard) && h('span', { class: 'chip' }, t.personal ? 'Personal' : t.course_code || t.board_name),
      t.due_date && h('span', { class: dueClass(t.due_date, t.status) }, dueText(t.due_date, t.status))));
}

async function setDone(id, isDone) {
  await api(`/tasks/${id}`, { method: 'PATCH', body: { status: isDone ? 'done' : 'todo' } });
  await refresh();
}

$('quick-add').onsubmit = async (e) => {
  e.preventDefault();
  const title = $('qa-title').value.trim();
  if (!title) return;
  const boardId = Number($('qa-where').value);
  const board = state.boards.find((b) => b.id === boardId);
  await api(`/boards/${boardId}/tasks`, {
    method: 'POST',
    body: { title, dueDate: $('qa-due').value || null, ...(board.personal ? {} : { assigneeId: state.me.id }) },
  });
  $('qa-title').value = '';
  $('qa-due').value = '';
  await refresh();
  $('qa-title').focus();
};

// ---------- A project board (or the personal list) ----------
async function showBoard(id) {
  if (state.view.kind !== 'board' || state.view.id !== id) state.showAllDone = false;
  state.view = { kind: 'board', id };
  localSet('tf-view', id);
  const data = await api(`/boards/${id}`);
  if (state.view.kind !== 'board' || state.view.id !== id) return;
  Object.assign(state, { board: data.board, members: data.members, tasks: data.tasks });
  showView('board');
  markNav();
  renderBoard();
}

function renderBoard() {
  const b = state.board;
  const personal = Boolean(b.personal);
  $('board-name').textContent = personal ? 'Personal' : b.name;
  const week = weekOf(today(), b.sem_start);
  const team = state.members.filter((m) => m.role !== 'supervisor').length;
  const bits = personal ? ['Only you can see this list']
    : [b.course_code, `${team} ${team === 1 ? 'person' : 'people'}`, `you are ${ROLE_NAME[b.role].toLowerCase()}`];
  $('board-sub').replaceChildren(bits.filter(Boolean).join(' · '), week ? ' · ' : '', week ? h('b', {}, `Week ${week}`) : '');
  $('show-team').hidden = personal;
  $('show-contrib').hidden = personal || team < 2;
  $('mine-toggle').hidden = personal || team < 2;
  $('show-settings').hidden = b.role !== 'owner';
  $('columns').replaceChildren(...COLUMNS.map(renderColumn));
}

$('filter-mine').onchange = (e) => { state.onlyMine = e.target.checked; renderBoard(); };

function renderColumn(col) {
  const tasks = state.tasks
    .filter((t) => t.status === col.status && (!state.onlyMine || state.board.personal || t.assignee_id === state.me.id))
    .sort((a, b) => a.position - b.position);
  // Done keeps growing over a semester, so it shows the most recently finished first and hides the rest.
  let shown = tasks;
  let hidden = 0;
  if (col.status === 'done' && !state.showAllDone && tasks.length > DONE_SHOWN) {
    shown = [...tasks].sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '') || b.id - a.id).slice(0, DONE_SHOWN)
      .sort((a, b) => a.position - b.position);
    hidden = tasks.length - shown.length;
  }
  const cards = h('div', { class: 'cards' }, shown.map(renderCard));
  const column = h('section', { class: 'column', 'data-status': col.status, 'aria-label': col.label },
    h('div', { class: 'column-head' },
      h('span', { class: 'dot', style: `background:${col.color}` }), col.label,
      h('span', { class: 'count' }, String(tasks.length))),
    cards,
    hidden > 0 && h('button', { class: 'link show-older', onclick: () => { state.showAllDone = true; renderBoard(); } },
      `Show ${hidden} older`),
    canWork(state.board.role) && col.status === 'todo' && h('form', { class: 'add-task', onsubmit: addTask },
      h('input', { placeholder: 'Add a task', 'aria-label': 'Add a task', maxlength: 140 }),
      h('button', { class: 'btn', type: 'submit' }, 'Add')));
  enableDrop(column, cards, col.status);
  return column;
}

function renderCard(t) {
  const who = !state.board.personal && state.members.find((m) => m.id === t.assignee_id);
  const extras = [
    t.step_count ? `${t.steps_done}/${t.step_count} steps` : null,
    t.file_count ? `${t.file_count} file${t.file_count > 1 ? 's' : ''}` : null,
    t.comment_count ? `${t.comment_count} comment${t.comment_count > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');

  // A div rather than a <button>, because browsers won't start a drag from a button.
  const card = h('div', {
    class: 'card', role: 'button', tabindex: 0, draggable: true, 'data-id': t.id,
    onclick: () => openTask(t.id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(t.id); } },
  },
    h('span', { class: 'card-title' }, t.title, t.important ? h('span', { class: 'star-mark' }, ' ★') : ''),
    (t.due_date || who || extras) && h('span', { class: 'card-meta' },
      t.due_date && h('span', { class: dueClass(t.due_date, t.status) }, dueText(t.due_date, t.status)),
      extras && h('span', {}, extras),
      h('span', { class: 'spacer' }),
      who && h('span', { class: 'avatar', title: who.name }, initials(who.name))));
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(t.id));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}

async function addTask(e) {
  e.preventDefault();
  const input = e.target.querySelector('input');
  const title = input.value.trim();
  if (!title) return;
  await api(`/boards/${state.board.id}/tasks`, { method: 'POST', body: { title } });
  await refresh();
  document.querySelector('.column[data-status="todo"] .add-task input')?.focus();
}

// Drag and drop. Positions are fractional: a dropped card takes the midpoint of its new neighbours.
const marker = h('div', { class: 'drop-marker' });
function dropIndex(cards, y) {
  const els = [...cards.querySelectorAll('.card:not(.dragging)')];
  const i = els.findIndex((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
  return { els, index: i === -1 ? els.length : i };
}
function enableDrop(column, cards, status) {
  column.addEventListener('dragover', (e) => {
    e.preventDefault();
    column.classList.add('drag-over');
    const { els, index } = dropIndex(cards, e.clientY);
    if (index < els.length) cards.insertBefore(marker, els[index]); else cards.append(marker);
  });
  column.addEventListener('dragleave', (e) => {
    if (!column.contains(e.relatedTarget)) { column.classList.remove('drag-over'); marker.remove(); }
  });
  column.addEventListener('drop', async (e) => {
    e.preventDefault();
    column.classList.remove('drag-over');
    marker.remove();
    const task = state.tasks.find((t) => t.id === Number(e.dataTransfer.getData('text/plain')));
    if (!task) return;
    const { els, index } = dropIndex(cards, e.clientY);
    const posOf = (el) => state.tasks.find((t) => t.id === Number(el.dataset.id)).position;
    const before = index > 0 ? posOf(els[index - 1]) : null;
    const after = index < els.length ? posOf(els[index]) : null;
    const position = before == null && after == null ? 1024 : before == null ? after - 1024 : after == null ? before + 1024 : (before + after) / 2;
    Object.assign(task, { status, position });
    renderBoard();
    try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status, position } }); }
    finally { await refresh(); }
  });
}

// ---------- Task panel ----------
// Every change saves straight away.
let panelRole = null;
let panelMembers = [];

async function openTask(id) {
  const { task, role } = await api(`/tasks/${id}`);
  state.task = task;
  panelRole = role;
  panelMembers = task.personal ? [] : (state.board?.id === task.board_id ? state.members : (await api(`/boards/${task.board_id}`)).members);
  renderTask();
  for (const id of ['t-saved', 't-error', 't-file-error']) $(id).textContent = '';
  if (!$('task-panel').open) $('task-panel').showModal();
}

async function reloadTask() {
  ({ task: state.task } = await api(`/tasks/${state.task.id}`));
  renderTask();
}

function renderTask() {
  const t = state.task;
  const edit = canWork(panelRole);
  $('t-where').textContent = t.personal ? 'Personal' : [t.course_code, t.board_name].filter(Boolean).join(' · ');
  $('t-done').checked = t.status === 'done';
  $('t-title').value = t.title;
  $('t-important').setAttribute('aria-pressed', Boolean(t.important));
  for (const b of $('t-status').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.status === t.status);
  $('t-due').value = t.due_date || '';
  const week = weekOf(t.due_date, t.sem_start);
  $('t-week').textContent = [t.due_date && t.status !== 'done' ? dueText(t.due_date) : '', week ? `Week ${week}` : ''].filter(Boolean).join(' · ');
  $('t-notes').value = t.notes;

  $('t-assignee-field').hidden = Boolean(t.personal);
  $('t-assignee').replaceChildren(h('option', { value: '' }, 'Nobody yet'),
    ...panelMembers.filter((m) => canWork(m.role)).map((m) =>
      h('option', { value: m.id, selected: m.id === t.assignee_id }, m.id === state.me.id ? `${m.name} (me)` : m.name)));

  for (const id of ['t-title', 't-due', 't-notes', 't-assignee', 't-important']) $(id).disabled = !edit;
  $('t-done').disabled = false;

  // Steps
  const stepsDone = t.steps.filter((s) => s.done).length;
  $('t-step-count').textContent = t.steps.length ? `${stepsDone}/${t.steps.length}` : '';
  $('t-steps').replaceChildren(...t.steps.map((s) => h('li', { class: s.done ? 'done' : '' },
    h('input', { type: 'checkbox', class: 'tick', checked: Boolean(s.done), disabled: !edit, 'aria-label': s.text,
      onchange: (e) => save(() => api(`/steps/${s.id}`, { method: 'PATCH', body: { done: e.target.checked } })) }),
    h('span', {}, s.text),
    edit && h('button', { class: 'link', onclick: () => save(() => api(`/steps/${s.id}`, { method: 'DELETE' })) }, 'Remove'))));
  $('t-step-form').hidden = !edit;

  // Files
  $('t-files').replaceChildren(...t.attachments.map((a) => h('li', {},
    h('span', { class: 'ext' }, a.filename.split('.').pop()),
    h('span', { class: 'grow' },
      h('a', { href: `/api/attachments/${a.id}`, download: a.filename }, a.filename),
      h('small', {}, t.personal ? fmtSize(a.size) : `${fmtSize(a.size)} · ${a.user_name || 'someone'}`)),
    edit && (a.user_id === state.me.id || panelRole === 'owner') &&
      h('button', { class: 'link', onclick: () => save(() => api(`/attachments/${a.id}`, { method: 'DELETE' })) }, 'Delete'))));
  $('t-upload').hidden = !edit;

  // Discussion (team projects only)
  $('t-comments-section').hidden = Boolean(t.personal);
  $('t-comments').replaceChildren(...t.comments.map((c) => h('li', {},
    h('span', { class: 'avatar' }, initials(c.user_name || '?')),
    h('div', {},
      h('div', { class: 'who' }, c.user_name || 'Someone', h('time', { datetime: c.created_at }, fmtTime(c.created_at)),
        (c.user_id === state.me.id || panelRole === 'owner') &&
          h('button', { class: 'link', onclick: () => save(() => api(`/comments/${c.id}`, { method: 'DELETE' })) }, 'Delete')),
      h('p', {}, c.body)))));

  $('t-delete').hidden = !edit;
  $('t-meta').textContent = t.personal ? '' : `Added by ${t.created_by_name || 'someone'}`;
}

// Runs a change, reloads the task, and flashes "Saved".
async function save(fn) {
  $('t-error').textContent = '';
  try {
    await fn();
    await reloadTask();
    $('t-saved').textContent = 'Saved';
    clearTimeout(save.timer);
    save.timer = setTimeout(() => { $('t-saved').textContent = ''; }, 1500);
  } catch (err) {
    $('t-error').textContent = err.message;
    await reloadTask().catch(() => {});
  }
}
const patch = (body) => save(() => api(`/tasks/${state.task.id}`, { method: 'PATCH', body }));

$('t-done').onchange = (e) => patch({ status: e.target.checked ? 'done' : 'todo' });
$('t-title').onchange = (e) => patch({ title: e.target.value });
$('t-title').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
$('t-important').onclick = () => patch({ important: !state.task.important });
$('t-status').onclick = (e) => { const s = e.target.dataset.status; if (s && s !== state.task.status) patch({ status: s }); };
$('t-due').onchange = (e) => patch({ dueDate: e.target.value || null });
$('t-notes').onchange = (e) => patch({ notes: e.target.value });
$('t-assignee').onchange = (e) => patch({ assigneeId: e.target.value ? Number(e.target.value) : null });

$('t-step-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('t-step-input').value.trim();
  if (!text) return;
  $('t-step-input').value = '';
  save(() => api(`/tasks/${state.task.id}/steps`, { method: 'POST', body: { text } })).then(() => $('t-step-input').focus());
};

$('t-comment-form').onsubmit = (e) => {
  e.preventDefault();
  const body = $('t-comment-input').value.trim();
  if (!body) return;
  save(async () => {
    await api(`/tasks/${state.task.id}/comments`, { method: 'POST', body: { body } });
    $('t-comment-input').value = '';
  });
};

async function uploadFiles(files) {
  $('t-file-error').textContent = '';
  for (const file of files) {
    if (file.size > MAX_UPLOAD) { $('t-file-error').textContent = `${file.name} is bigger than 10 MB.`; continue; }
    try {
      await api(`/tasks/${state.task.id}/attachments`, {
        method: 'POST', raw: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      });
    } catch (err) {
      $('t-file-error').textContent = `${file.name}: ${err.message}`;
    }
  }
  await save(async () => {});
}
$('t-file-input').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };
const drop = $('t-upload');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); uploadFiles([...e.dataTransfer.files]); });

// Two-step delete: the first click asks, the second confirms.
function confirmTwice(btn, label, action) {
  return async () => {
    if (btn.dataset.armed !== 'true') {
      btn.dataset.armed = 'true';
      btn.textContent = 'Click again to delete';
      setTimeout(() => { btn.dataset.armed = ''; btn.textContent = label; }, 3000);
      return;
    }
    btn.dataset.armed = '';
    btn.textContent = label;
    await action();
  };
}
$('t-delete').onclick = confirmTwice($('t-delete'), 'Delete task', async () => {
  await api(`/tasks/${state.task.id}`, { method: 'DELETE' });
  $('task-panel').close();
});
$('t-close').onclick = () => $('task-panel').close();
$('task-panel').addEventListener('close', () => { state.task = null; refresh(); });
// Clicking the dimmed area beside the panel closes it.
$('task-panel').addEventListener('click', (e) => { if (e.target === $('task-panel')) $('task-panel').close(); });

// ---------- Project setup and settings ----------
let editing = null;
function openProjectDialog(board) {
  editing = board;
  const personal = Boolean(board?.personal);
  $('pf-title').textContent = personal ? 'Semester week' : board ? 'Project settings' : 'New project';
  $('pf-submit').textContent = board ? 'Save' : 'Create';
  $('pf-name-field').hidden = personal;
  $('pf-course-field').hidden = personal;
  $('pf-name').value = board?.name ?? '';
  $('pf-course').value = board?.course_code ?? '';
  $('pf-start').value = board?.sem_start ?? personalBoard()?.sem_start ?? '';
  $('pf-template-field').hidden = Boolean(board);
  $('pf-delete').hidden = !board || personal;
  $('pf-error').textContent = '';
  $('project-dialog').showModal();
}
$('new-project').onclick = () => openProjectDialog(null);
$('show-settings').onclick = () => openProjectDialog(state.board);
$('pf-cancel').onclick = () => $('project-dialog').close();
$('project-form').onsubmit = async (e) => {
  e.preventDefault();
  const body = { name: $('pf-name').value, course_code: $('pf-course').value, sem_start: $('pf-start').value || null };
  try {
    if (editing) {
      await api(`/boards/${editing.id}`, { method: 'PATCH', body });
      $('project-dialog').close();
      await refresh();
    } else {
      const { board } = await api('/boards', { method: 'POST', body: { ...body, template: $('pf-template').value } });
      $('project-dialog').close();
      await loadBoards();
      await showBoard(board.id);
    }
  } catch (err) {
    $('pf-error').textContent = err.message;
  }
};
$('pf-delete').onclick = confirmTwice($('pf-delete'), 'Delete project', async () => {
  await api(`/boards/${editing.id}`, { method: 'DELETE' });
  $('project-dialog').close();
  await loadBoards();
  await showMyWork();
});

// ---------- Account ----------
function accountMessage(error, saved = '') {
  $('acc-error').textContent = error;
  $('acc-saved').textContent = saved;
}
$('me-name').onclick = () => {
  $('acc-name').value = state.me.name;
  $('acc-email').textContent = `Signed in as ${state.me.email}`;
  $('password-form').reset();
  accountMessage('');
  $('account-dialog').showModal();
};
$('acc-close').onclick = () => $('account-dialog').close();
$('name-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    ({ user: state.me } = await api('/auth/me', { method: 'PATCH', body: { name: $('acc-name').value } }));
    $('me-name').textContent = state.me.name;
    accountMessage('', 'Name saved.');
    refresh();
  } catch (err) { accountMessage(err.message); }
};
$('password-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/auth/password', { method: 'POST', body: { currentPassword: $('acc-current').value, newPassword: $('acc-new').value } });
    $('password-form').reset();
    accountMessage('', 'Password changed. Other browsers have been signed out.');
  } catch (err) { accountMessage(err.message); }
};

// ---------- Team and contributions ----------
function openPanel(title, ...content) {
  $('panel-title').textContent = title;
  $('panel-body').replaceChildren(...content);
  if (!$('panel-dialog').open) $('panel-dialog').showModal();
}
$('panel-close').onclick = () => $('panel-dialog').close();

$('show-team').onclick = renderTeam;
function renderTeam() {
  const leader = state.board.role === 'owner';
  const error = h('p', { class: 'error', role: 'alert' });
  const act = (fn) => async (e) => {
    try {
      await fn(e);
      if (e?.target?.dataset?.leave) { $('panel-dialog').close(); await loadBoards(); await showMyWork(); return; }
      await showBoard(state.board.id);
      renderTeam();
    } catch (err) { error.textContent = err.message; }
  };
  const rows = state.members.map((m) => h('div', { class: 'member' },
    h('span', { class: 'avatar' }, initials(m.name)),
    h('span', {}, m.id === state.me.id ? `${m.name} (you)` : m.name, h('small', {}, m.email)),
    leader
      ? h('select', { 'aria-label': `Role for ${m.name}`,
          onchange: act((e) => api(`/boards/${state.board.id}/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } })) },
        ...Object.entries(ROLE_NAME).map(([r, label]) => h('option', { value: r, selected: r === m.role }, label)))
      : h('span', { class: 'chip' }, ROLE_NAME[m.role]),
    (leader || m.id === state.me.id)
      ? h('button', { class: 'link', 'data-leave': m.id === state.me.id ? 'true' : null,
          onclick: act(() => api(`/boards/${state.board.id}/members/${m.id}`, { method: 'DELETE' })) }, m.id === state.me.id ? 'Leave' : 'Remove')
      : h('span')));

  const invite = leader && h('form', { class: 'inline-form', onsubmit: act(async (e) => {
    e.preventDefault();
    await api(`/boards/${state.board.id}/members`, { method: 'POST', body: { email: e.target.elements.email.value, role: e.target.elements.role.value } });
  }) },
    h('input', { name: 'email', type: 'email', placeholder: 'Groupmate or supervisor’s email', 'aria-label': 'Email', required: true }),
    h('select', { name: 'role', 'aria-label': 'Role' }, h('option', { value: 'member' }, 'Member'), h('option', { value: 'supervisor' }, 'Supervisor')),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add'));

  openPanel('Team', ...rows, invite, error,
    h('p', { class: 'muted', style: 'margin:0;font-size:13px' },
      'Leaders manage the project. Members add and do tasks. Supervisors can see everything, comment and mark work as done.'));
}

$('show-contrib').onclick = async () => {
  const { contributions } = await api(`/boards/${state.board.id}/contributions`);
  const total = contributions.reduce((s, c) => s + c.done, 0) || 1;
  openPanel('Contributions',
    h('p', { class: 'muted', style: 'margin:0;font-size:14px' }, 'Who did what in this project. Handy for peer evaluation forms.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Member', 'Tasks', 'Done', 'On time', 'Late', 'Files', 'Comments', 'Share'].map((x) => h('th', {}, x)))),
      h('tbody', {}, contributions.map((c) => {
        const share = Math.round((c.done / total) * 100);
        return h('tr', {},
          h('td', {}, c.name),
          ...[c.assigned, c.done, c.on_time, c.late, c.files, c.comments].map((n) => h('td', {}, String(n))),
          h('td', {}, h('div', { style: 'display:flex;align-items:center;gap:8px;justify-content:flex-end' },
            h('div', { class: 'bar' }, h('i', { style: `width:${share}%` })), `${share}%`)));
      })))));
};

// ---------- Boot ----------
(async () => {
  try {
    ({ user: state.me } = await api('/auth/me'));
  } catch {
    showAuth();
    return;
  }
  await enterApp();
})();
