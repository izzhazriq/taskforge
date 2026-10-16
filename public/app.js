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
  view: { kind: 'mywork' }, // or { kind: 'board', id }, { kind: 'search', q } or { kind: 'profile' }
  board: null, members: [], tasks: [], // the open board
  myTasks: [],
  task: null, // the task open in the side panel
  onlyMine: false,
  showAllDone: false,
};
const TABS = ['summary', 'tasks', 'documents'];
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
// A person's photo, or their initials when they haven't added one.
function avatar(person, cls = 'avatar') {
  const name = person?.name || person?.user_name || '?';
  const url = person?.avatar_url || person?.user_avatar;
  return url
    ? h('img', { class: `${cls} photo`, src: url, alt: '', title: name })
    : h('span', { class: cls, title: name }, initials(name) || '?');
}
const ago = (s) => {
  const mins = Math.round((Date.now() - Date.parse(s.replace(' ', 'T') + 'Z')) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return fmtTime(s);
};
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
  renderMe();
  $('search-input').value = '';
  await loadBoards();
  const saved = localGet('tf-view');
  const id = Number(saved);
  if (saved && saved !== 'mywork' && state.boards.some((b) => b.id === id)) await showBoard(id);
  else await showMyWork();
}

function renderMe() {
  $('me-name').textContent = state.me.name;
  $('me-avatar').replaceChildren(avatar(state.me));
}

// ---------- Navigation ----------
async function loadBoards() {
  ({ boards: state.boards } = await api('/boards'));
  const projects = state.boards.filter((b) => !b.personal);
  const item = (b) => h('button', { class: 'nav-item', 'data-board': b.id, onclick: () => showBoard(b.id) },
    h('span', { class: 'name' }, b.name),
    h('small', {}, b.kind === 'personal' ? 'Personal' : b.course_code || 'School'));
  const pinned = projects.filter((b) => b.pinned);
  $('pinned-label').hidden = !pinned.length;
  $('pinned-list').replaceChildren(...pinned.map(item));
  $('project-list').replaceChildren(...projects.filter((b) => !b.pinned).map(item));
  markNav();
}

function markNav() {
  const v = state.view;
  $('nav-mywork').setAttribute('aria-current', v.kind === 'mywork');
  $('nav-personal').setAttribute('aria-current', v.kind === 'board' && v.id === personalBoard()?.id);
  $('nav-profile').setAttribute('aria-current', v.kind === 'profile');
  for (const el of document.querySelectorAll('#project-list .nav-item, #pinned-list .nav-item')) {
    el.setAttribute('aria-current', v.kind === 'board' && Number(el.dataset.board) === v.id);
  }
}

$('nav-mywork').onclick = () => showMyWork();
$('nav-personal').onclick = () => showBoard(personalBoard().id);

function showView(name) {
  for (const v of ['mywork', 'board', 'search', 'profile']) $(`${v}-view`).hidden = v !== name;
}

async function refresh() {
  if (!state.me) return;
  await loadBoards();
  const v = state.view;
  if (v.kind === 'mywork') await showMyWork();
  else if (v.kind === 'search') await showSearch(v.q);
  else if (v.kind === 'profile') showProfile();
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
    if (state.view.kind === 'board') { setTab('tasks'); document.querySelector('.column[data-status="todo"] .add-task input')?.focus(); }
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
    h('span', { class: 'title' },
      t.parent_title && h('small', { class: 'parent' }, `${t.parent_title} ›`),
      t.title, t.important ? h('span', { class: 'star-mark', title: 'Important' }, ' ★') : ''),
    h('span', { class: 'meta' },
      t.subtask_count ? h('span', {}, `${t.subtasks_done}/${t.subtask_count} subtasks`) : '',
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
  renderTab();
}

// Each project remembers which section you last looked at. New projects open on the Summary.
const tabOf = (id) => { const t = localGet(`tf-tab-${id}`); return TABS.includes(t) ? t : 'summary'; };
function setTab(tab) {
  localSet(`tf-tab-${state.board.id}`, tab);
  renderTab();
}
for (const tab of TABS) $(`tab-${tab}`).onclick = () => setTab(tab);
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = TABS.indexOf(tabOf(state.board.id)) + (e.key === 'ArrowRight' ? 1 : -1);
  setTab(TABS[(i + TABS.length) % TABS.length]);
  $(`tab-${tabOf(state.board.id)}`).focus();
});
function renderTab() {
  const tab = tabOf(state.board.id);
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute('aria-selected', t === tab);
    $(`tab-${t}`).tabIndex = t === tab ? 0 : -1;
    $(`panel-${t}`).hidden = t !== tab;
  }
  if (tab === 'summary') loadSummary();
  if (tab === 'documents') loadDocuments();
}

function renderBoard() {
  const b = state.board;
  const personal = Boolean(b.personal);
  $('board-name').textContent = personal ? 'Personal' : b.name;
  const week = b.kind === 'school' ? weekOf(today(), b.sem_start) : null;
  const team = state.members.filter((m) => m.role !== 'supervisor').length;
  const bits = personal ? ['Only you can see this list']
    : [b.kind === 'personal' ? 'Personal project' : b.course_code || 'School project',
      `${team} ${team === 1 ? 'person' : 'people'}`, `you are ${ROLE_NAME[b.role].toLowerCase()}`];
  $('pin-toggle').hidden = personal;
  $('pin-toggle').setAttribute('aria-pressed', Boolean(b.pinned));
  $('pin-toggle').textContent = b.pinned ? '★ Pinned' : '☆ Pin';
  $('pin-toggle').title = b.pinned ? 'Unpin this project' : 'Pin this project to the top of the sidebar';
  $('board-sub').replaceChildren(bits.filter(Boolean).join(' · '), week ? ' · ' : '', week ? h('b', {}, `Week ${week}`) : '');
  $('show-team').hidden = personal;
  $('show-contrib').hidden = personal || team < 2;
  $('mine-toggle').hidden = personal || team < 2;
  $('show-settings').hidden = b.role !== 'owner';
  $('columns').replaceChildren(...COLUMNS.map(renderColumn));
}

$('pin-toggle').onclick = async () => {
  await api(`/boards/${state.board.id}/pin`, { method: state.board.pinned ? 'DELETE' : 'PUT' });
  state.board.pinned = state.board.pinned ? 0 : 1;
  renderBoard();
  await loadBoards();
};

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
    t.subtask_count ? `${t.subtasks_done}/${t.subtask_count} subtasks` : null,
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
      who && avatar(who)),
    t.subtask_count > 0 && h('span', { class: 'progress thin' }, h('i', { style: `width:${Math.round((t.subtasks_done / t.subtask_count) * 100)}%` })));
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

// ---------- Summary ----------
const STATUS_COLOR = { todo: 'var(--todo)', doing: 'var(--doing)', done: 'var(--done)' };
async function loadSummary() {
  const id = state.board.id;
  const data = await api(`/boards/${id}/summary`);
  if (state.view.kind !== 'board' || state.view.id !== id) return;
  renderSummary(data);
}

function renderSummary({ status, activity, workload, unassigned }) {
  const b = state.board;
  const edit = canWork(b.role);
  const total = status.todo + status.doing + status.done;
  const pct = total ? Math.round((status.done / total) * 100) : 0;
  const saveBoard = (body) => api(`/boards/${b.id}`, { method: 'PATCH', body }).then(({ board }) => {
    state.board = board;
    loadSummary();
  });

  const about = h('section', { class: 'box summary-about' },
    h('h3', {}, 'About this project'),
    edit
      ? h('textarea', { rows: 4, maxlength: 4000, 'aria-label': 'Description',
          placeholder: 'What is this project about? Add the brief, the lecturer, links, anything the team should know.',
          onchange: (e) => saveBoard({ description: e.target.value }) }, b.description || '')
      : h('p', { class: 'prewrap' }, b.description || 'No description yet.'));

  const daysLeft = b.goal_date ? daysUntil(b.goal_date) : null;
  const goal = h('section', { class: 'box summary-goal' },
    h('h3', {}, 'Goal'),
    edit
      ? h('input', { value: b.goal || '', maxlength: 300, 'aria-label': 'Goal', placeholder: 'e.g. Submit the final report by Week 14',
          onchange: (e) => saveBoard({ goal: e.target.value }) })
      : h('p', {}, b.goal || 'No goal set yet.'),
    h('label', { class: 'inline-label' }, 'Target date',
      h('input', { type: 'date', value: b.goal_date || '', disabled: !edit, onchange: (e) => saveBoard({ goal_date: e.target.value || null }) })),
    h('div', { class: 'goal-progress' },
      h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })),
      h('span', {}, h('b', {}, `${pct}%`), ' done',
        daysLeft == null ? '' : daysLeft < 0 ? ` · target passed ${-daysLeft} days ago` : daysLeft === 0 ? ' · target is today' : ` · ${daysLeft} days to go`)));

  const work = h('section', { class: 'box summary-status' },
    h('h3', {}, 'Work items'),
    h('div', { class: 'stat-row' }, COLUMNS.map((c) => h('div', { class: 'stat' },
      h('span', { class: 'stat-num' }, String(status[c.status])),
      h('span', { class: 'stat-label' }, h('span', { class: 'dot', style: `background:${c.color}` }), c.label)))),
    total > 0 && h('div', { class: 'stacked', role: 'img', 'aria-label': `${status.todo} to do, ${status.doing} doing, ${status.done} done` },
      COLUMNS.map((c) => status[c.status] > 0 && h('i', { style: `flex:${status[c.status]};background:${STATUS_COLOR[c.status]}` }))),
    h('p', { class: 'muted small-note' }, [
      total ? `${total} item${total === 1 ? '' : 's'}${status.subtasks ? `, including ${status.subtasks} subtask${status.subtasks === 1 ? '' : 's'}` : ''}` : 'No tasks yet.',
      status.late ? h('span', { class: 'due late' }, ` · ${status.late} late`) : '',
      status.due_soon ? ` · ${status.due_soon} due in the next 7 days` : '',
    ]),
    h('button', { class: 'link', onclick: () => setTab('tasks') }, 'Open tasks'));

  const recent = h('section', { class: 'box summary-activity' },
    h('h3', {}, 'Recent activity'),
    activity.length
      ? h('ul', { class: 'activity' }, activity.map((a) => h('li', {},
          avatar(a),
          h('span', {}, h('b', {}, a.user_id === state.me.id ? 'You' : a.user_name || 'Someone'), ' ', a.detail),
          h('time', { datetime: a.created_at, title: fmtTime(a.created_at) }, ago(a.created_at)))))
      : h('p', { class: 'muted' }, 'Nothing has happened yet.'));

  const team = workload.length > 1 && h('section', { class: 'box summary-team' },
    h('h3', {}, 'Team workload'),
    h('ul', { class: 'workload' }, (() => {
      const most = Math.max(1, ...workload.map((w) => w.todo + w.doing + w.done));
      return workload.map((w) => h('li', {},
        avatar(w),
        h('span', { class: 'who' }, w.id === state.me.id ? `${w.name} (you)` : w.name),
        h('span', { class: 'stacked small', title: `${w.todo} to do, ${w.doing} doing, ${w.done} done` },
          ['todo', 'doing', 'done'].map((k) => w[k] > 0 && h('i', { style: `width:${(w[k] / most) * 100}%;background:${STATUS_COLOR[k]}` }))),
        h('span', { class: 'counts' }, `${w.todo + w.doing} open`, w.late ? h('span', { class: 'due late' }, ` · ${w.late} late`) : '')));
    })()),
    unassigned > 0 && h('p', { class: 'muted small-note' }, `${unassigned} open task${unassigned === 1 ? ' has' : 's have'} nobody assigned.`));

  $('panel-summary').replaceChildren(about, goal, work, recent, team || '');
}

// ---------- Documents ----------
const MAX_DOCUMENT = 500 * 1024 * 1024;
const DOC_ICON = { pdf: 'PDF', image: 'IMG', video: '▶', other: 'FILE' };
let docFilter = 'all';
let docData = { documents: [], taskFiles: [] };
const kindOf = (f) => f.preview || 'other';

async function loadDocuments() {
  const id = state.board.id;
  const data = await api(`/boards/${id}/documents`);
  if (state.view.kind !== 'board' || state.view.id !== id) return;
  docData = data;
  renderDocuments();
}

function renderDocuments() {
  const { documents, taskFiles } = docData;
  const edit = canWork(state.board.role);
  $('doc-upload').hidden = !edit;
  for (const b of document.querySelectorAll('.doc-filters button')) b.setAttribute('aria-pressed', b.dataset.filter === docFilter);
  const shown = (list) => list.filter((f) => docFilter === 'all' || kindOf(f) === docFilter);
  const canDelete = (f) => edit && (f.user_id === state.me.id || state.board.role === 'owner');

  const tile = (f, { base, task }) => {
    const kind = kindOf(f);
    const href = `${base}/${f.id}`;
    const thumb = kind === 'image'
      ? h('img', { src: `${href}?view=1`, alt: '', loading: 'lazy' })
      : kind === 'video'
        ? h('video', { src: `${href}?view=1#t=0.5`, preload: 'metadata', muted: true, playsinline: true })
        : h('span', { class: 'doc-icon' }, kind === 'other' ? (f.filename.split('.').pop() || 'file').slice(0, 5) : DOC_ICON[kind]);
    return h('li', { class: `doc-tile ${kind}` },
      h('button', { class: 'doc-thumb', onclick: () => openViewer(f, base), 'aria-label': `Open ${f.filename}` },
        thumb, kind === 'video' && h('span', { class: 'play', 'aria-hidden': 'true' }, '▶')),
      h('div', { class: 'doc-info' },
        h('a', { class: 'doc-name', href, download: f.filename, title: f.filename }, f.filename),
        h('small', {}, [fmtSize(f.size), f.user_name || 'someone', fmtTime(f.created_at)].join(' · ')),
        task && h('button', { class: 'link', onclick: () => openTask(f.task_id) }, `In “${f.task_title}”`),
        canDelete(f) && !task && h('button', { class: 'link danger', onclick: async () => {
          await api(`/documents/${f.id}`, { method: 'DELETE' });
          loadDocuments();
        } }, 'Delete')));
  };
  const docs = shown(documents);
  const files = shown(taskFiles);
  const empty = (text) => [h('li', { class: 'empty-row' }, text)];
  $('doc-count').textContent = documents.length ? String(docs.length) : '';
  $('task-file-count').textContent = taskFiles.length ? String(files.length) : '';
  $('doc-list').replaceChildren(...(docs.length ? docs.map((d) => tile(d, { base: '/api/documents' }))
    : empty(documents.length ? 'Nothing of this kind yet.' : edit ? 'No documents yet. Add the brief, the rubric, photos, recordings, anything the project needs.' : 'No documents yet.')));
  $('task-file-list').replaceChildren(...(files.length ? files.map((f) => tile(f, { base: '/api/attachments', task: true }))
    : empty(taskFiles.length ? 'Nothing of this kind yet.' : 'Files attached to tasks show up here too.')));
}
for (const b of document.querySelectorAll('.doc-filters button')) b.onclick = () => { docFilter = b.dataset.filter; renderDocuments(); };

// Pictures, videos and PDFs open in a viewer; anything else downloads.
function openViewer(f, base) {
  const href = `${base}/${f.id}`;
  const kind = kindOf(f);
  if (kind === 'other') { location.href = href; return; }
  const view = `${href}?view=1`;
  $('viewer-name').textContent = f.filename;
  $('viewer-download').href = href;
  $('viewer-download').setAttribute('download', f.filename);
  $('viewer-open').href = view;
  $('viewer-body').replaceChildren(
    kind === 'image' ? h('img', { src: view, alt: f.filename })
      : kind === 'video' ? h('video', { src: view, controls: true, autoplay: true, playsinline: true,
          onerror: (e) => e.target.replaceWith(h('p', { class: 'viewer-note' },
            'This browser can’t play this video. Download it to watch it, or try Chrome or Edge.')) })
        : h('iframe', { src: view, title: f.filename }));
  $('viewer').showModal();
}
$('viewer-close').onclick = () => $('viewer').close();
$('viewer').addEventListener('close', () => $('viewer-body').replaceChildren()); // stops a playing video
$('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) $('viewer').close(); });

// Uploads one file at a time with a progress bar, since videos can take a while.
function sendWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${url}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || 'The upload failed.'));
    };
    xhr.onerror = () => reject(new Error('The upload failed. Is TaskForge still running?'));
    xhr.send(file);
  });
}

async function uploadDocuments(files) {
  $('doc-error').textContent = '';
  const boardId = state.board.id;
  const errors = [];
  for (const file of files) {
    if (file.size > MAX_DOCUMENT) { errors.push(`${file.name} is bigger than 500 MB.`); continue; }
    const bar = h('i');
    const pct = h('span', { class: 'pct' }, '0%');
    const row = h('li', {}, h('span', { class: 'name' }, file.name), h('span', { class: 'progress' }, bar), pct);
    $('doc-progress').append(row);
    try {
      await sendWithProgress(`/boards/${boardId}/documents`, file, (p) => {
        bar.style.width = `${Math.round(p * 100)}%`;
        pct.textContent = `${Math.round(p * 100)}%`;
      });
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
    row.remove();
  }
  $('doc-error').textContent = errors.join(' ');
  if (state.view.kind === 'board' && state.view.id === boardId) loadDocuments();
}
$('doc-file-input').onchange = (e) => { uploadDocuments([...e.target.files]); e.target.value = ''; };
const docDrop = $('doc-upload');
docDrop.addEventListener('dragover', (e) => { e.preventDefault(); docDrop.classList.add('drag'); });
docDrop.addEventListener('dragleave', () => docDrop.classList.remove('drag'));
docDrop.addEventListener('drop', (e) => { e.preventDefault(); docDrop.classList.remove('drag'); uploadDocuments([...e.dataTransfer.files]); });

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
  const isSub = Boolean(t.parent_id);
  $('task-panel').classList.toggle('is-subtask', isSub);
  $('t-where').textContent = t.personal ? 'Personal' : [t.course_code, t.board_name].filter(Boolean).join(' · ');
  $('t-kind').hidden = !isSub;
  $('t-parent').hidden = !isSub;
  $('t-parent').replaceChildren('← Back to ', h('b', {}, t.parent_title || 'the task'));
  $('t-done').setAttribute('aria-label', isSub ? 'Mark subtask as done' : 'Mark as done');
  $('t-done').checked = t.status === 'done';
  $('t-title').value = t.title;
  $('t-important').setAttribute('aria-pressed', Boolean(t.important));
  for (const b of $('t-status').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.status === t.status);
  $('t-due').value = t.due_date || '';
  const week = t.kind === 'school' ? weekOf(t.due_date, t.sem_start) : null;
  $('t-week').textContent = [t.due_date && t.status !== 'done' ? dueText(t.due_date) : '', week ? `Week ${week}` : ''].filter(Boolean).join(' · ');
  $('t-notes').value = t.notes;

  $('t-assignee-field').hidden = Boolean(t.personal);
  $('t-assignee').replaceChildren(h('option', { value: '' }, 'Nobody yet'),
    ...panelMembers.filter((m) => canWork(m.role)).map((m) =>
      h('option', { value: m.id, selected: m.id === t.assignee_id }, m.id === state.me.id ? `${m.name} (me)` : m.name)));

  for (const id of ['t-title', 't-due', 't-notes', 't-assignee', 't-important']) $(id).disabled = !edit;
  $('t-done').disabled = false;

  // Subtasks: only top-level tasks have them. Each one opens in its own panel.
  $('t-subtasks-section').hidden = isSub;
  const subs = t.subtasks || [];
  const subsDone = subs.filter((x) => x.status === 'done').length;
  $('t-sub-count').textContent = subs.length ? `${subsDone}/${subs.length}` : '';
  $('t-sub-progress').hidden = !subs.length;
  $('t-sub-progress').firstElementChild.style.width = subs.length ? `${(subsDone / subs.length) * 100}%` : '0';
  $('t-subtasks').replaceChildren(...subs.map((x) => {
    const who = panelMembers.find((m) => m.id === x.assignee_id);
    return h('li', { class: x.status === 'done' ? 'done' : '' },
      h('input', { type: 'checkbox', class: 'tick', checked: x.status === 'done', disabled: panelRole === null, 'aria-label': `Mark "${x.title}" as done`,
        onchange: (e) => save(() => api(`/tasks/${x.id}`, { method: 'PATCH', body: { status: e.target.checked ? 'done' : 'todo' } })) }),
      h('button', { class: 'sub-open', onclick: () => openTask(x.id) },
        h('span', { class: 'sub-title' }, x.title),
        h('span', { class: 'sub-meta' },
          x.status === 'doing' && h('span', { class: 'chip doing' }, 'Doing'),
          x.due_date && h('span', { class: dueClass(x.due_date, x.status) }, dueText(x.due_date, x.status)),
          who && !t.personal && avatar(who),
          h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'))));
  }));
  $('t-sub-form').hidden = !edit;

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
    avatar(c),
    h('div', {},
      h('div', { class: 'who' }, c.user_name || 'Someone', h('time', { datetime: c.created_at }, fmtTime(c.created_at)),
        (c.user_id === state.me.id || panelRole === 'owner') &&
          h('button', { class: 'link', onclick: () => save(() => api(`/comments/${c.id}`, { method: 'DELETE' })) }, 'Delete')),
      h('p', {}, c.body)))));

  $('t-delete').hidden = !edit;
  $('t-delete').dataset.armed = '';
  $('t-delete').textContent = $('t-delete').dataset.label = isSub ? 'Delete subtask' : 'Delete task';
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

$('t-sub-form').onsubmit = (e) => {
  e.preventDefault();
  const title = $('t-sub-input').value.trim();
  if (!title) return;
  $('t-sub-input').value = '';
  save(() => api(`/tasks/${state.task.id}/subtasks`, { method: 'POST', body: { title } })).then(() => $('t-sub-input').focus());
};
$('t-parent').onclick = () => openTask(state.task.parent_id);

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
function confirmTwice(btn, action) {
  return async () => {
    const label = btn.dataset.label || btn.textContent;
    btn.dataset.label = label;
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
$('t-delete').onclick = confirmTwice($('t-delete'), async () => {
  const { id, parent_id: parentId } = state.task;
  await api(`/tasks/${id}`, { method: 'DELETE' });
  // Deleting a subtask goes back to its task; deleting a task closes the panel.
  if (parentId) await openTask(parentId); else $('task-panel').close();
});
$('t-close').onclick = () => $('task-panel').close();
$('task-panel').addEventListener('close', () => { state.task = null; refresh(); });
// Clicking the dimmed area beside the panel closes it.
$('task-panel').addEventListener('click', (e) => { if (e.target === $('task-panel')) $('task-panel').close(); });

// ---------- Project setup and settings ----------
let editing = null;
let formKind = 'school';
function setFormKind(kind) {
  formKind = kind;
  const school = kind === 'school';
  for (const b of $('pf-kind').querySelectorAll('button')) b.setAttribute('aria-checked', b.dataset.kind === kind);
  $('pf-kind-hint').textContent = school
    ? 'For courses, group assignments and your FYP. Shows the course code and semester week.'
    : 'For anything outside class: a side project, a club, an event or a trip.';
  $('pf-course-field').hidden = !school;
  $('pf-start-field').hidden = !school;
  $('pf-template-field').hidden = Boolean(editing) || !school;
  $('pf-name').placeholder = school ? 'Database group assignment' : 'Portfolio website';
}
for (const b of $('pf-kind').querySelectorAll('button')) b.onclick = () => setFormKind(b.dataset.kind);

function openProjectDialog(board) {
  editing = board;
  const personal = Boolean(board?.personal);
  $('pf-title').textContent = personal ? 'Semester week' : board ? 'Project settings' : 'New project';
  $('pf-submit').textContent = board ? 'Save' : 'Create';
  $('pf-name').value = board?.name ?? '';
  $('pf-course').value = board?.course_code ?? '';
  $('pf-start').value = board?.sem_start ?? personalBoard()?.sem_start ?? '';
  $('pf-template').value = 'blank';
  $('pf-delete').hidden = !board || personal;
  $('pf-error').textContent = '';
  setFormKind(personal ? 'school' : board?.kind ?? 'school');
  // The personal list only has a Week 1 date.
  $('pf-kind-field').hidden = personal;
  $('pf-name-field').hidden = personal;
  if (personal) $('pf-course-field').hidden = true;
  $('project-dialog').showModal();
}
$('new-project').onclick = () => openProjectDialog(null);
$('show-settings').onclick = () => openProjectDialog(state.board);
$('pf-cancel').onclick = () => $('project-dialog').close();
$('project-form').onsubmit = async (e) => {
  e.preventDefault();
  const body = editing?.personal
    ? { sem_start: $('pf-start').value || null }
    : { name: $('pf-name').value, kind: formKind, course_code: $('pf-course').value, sem_start: $('pf-start').value || null };
  try {
    if (editing) {
      await api(`/boards/${editing.id}`, { method: 'PATCH', body });
      $('project-dialog').close();
      await refresh();
    } else {
      const template = formKind === 'school' ? $('pf-template').value : 'blank';
      const { board } = await api('/boards', { method: 'POST', body: { ...body, template } });
      $('project-dialog').close();
      await loadBoards();
      await showBoard(board.id);
    }
  } catch (err) {
    $('pf-error').textContent = err.message;
  }
};
$('pf-delete').onclick = confirmTwice($('pf-delete'), async () => {
  await api(`/boards/${editing.id}`, { method: 'DELETE' });
  $('project-dialog').close();
  await loadBoards();
  await showMyWork();
});

// ---------- Profile ----------
function showProfile() {
  state.view = { kind: 'profile' };
  showView('profile');
  markNav();
  renderProfile();
}
function renderProfile() {
  const me = state.me;
  $('profile-avatar').replaceChildren(avatar(me, 'avatar avatar-xl'));
  $('profile-name').textContent = me.name;
  $('profile-email').textContent = me.email;
  $('profile-bio').textContent = me.bio || '';
  $('profile-bio').hidden = !me.bio;
  $('photo-remove').hidden = !me.avatar_url;
  $('pr-name').value = me.name;
  $('pr-bio').value = me.bio || '';
  $('pr-email').value = me.email;
  renderMe();
}
$('nav-profile').onclick = () => {
  for (const f of ['email-form', 'password-form']) $(f).reset();
  for (const id of ['photo-error', 'details-error', 'details-saved', 'email-error', 'email-saved', 'password-error', 'password-saved']) $(id).textContent = '';
  showProfile();
};

// Each form shows its own result beside its button.
function profileForm(id, action) {
  $(`${id}-form`).onsubmit = async (e) => {
    e.preventDefault();
    $(`${id}-error`).textContent = '';
    $(`${id}-saved`).textContent = '';
    try {
      $(`${id}-saved`).textContent = await action();
      renderProfile();
    } catch (err) { $(`${id}-error`).textContent = err.message; }
  };
}
profileForm('details', async () => {
  ({ user: state.me } = await api('/auth/me', { method: 'PATCH', body: { name: $('pr-name').value, bio: $('pr-bio').value } }));
  return 'Saved.';
});
profileForm('email', async () => {
  ({ user: state.me } = await api('/auth/email', { method: 'POST', body: { email: $('pr-email').value, password: $('pr-email-password').value } }));
  $('pr-email-password').value = '';
  return 'Email changed. Use it next time you log in.';
});
profileForm('password', async () => {
  await api('/auth/password', { method: 'POST', body: { currentPassword: $('pr-current').value, newPassword: $('pr-new').value } });
  $('password-form').reset();
  return 'Password changed. Other browsers have been signed out.';
});

$('photo-input').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('photo-error').textContent = '';
  if (file.size > 2 * 1024 * 1024) { $('photo-error').textContent = 'Photos can be up to 2 MB.'; return; }
  try {
    const { avatar_url } = await api('/me/avatar', { method: 'PUT', raw: file, headers: { 'Content-Type': 'application/octet-stream' } });
    state.me = { ...state.me, avatar_url };
    renderProfile();
  } catch (err) { $('photo-error').textContent = err.message; }
};
$('photo-remove').onclick = async () => {
  await api('/me/avatar', { method: 'DELETE' });
  state.me = { ...state.me, avatar_url: null };
  renderProfile();
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
    avatar(m),
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
