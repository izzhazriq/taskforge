import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

let server, base, uploadDir;

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-test-'));
  server = createApp(openDb(':memory:'), { uploadDir }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  server.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

// A tiny client that keeps its own session cookie, like one browser per user.
function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, raw, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }), ...headers },
      body: raw ?? (body && JSON.stringify(body)),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = res.status === 204 ? null : type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
}

const leader = client(), member = client(), supervisor = client(), stranger = client();
const ids = {};
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let personalId, projectId, task;

test('sign up gives everyone a personal list', async () => {
  for (const [c, email, name] of [[leader, 'leader@x.dev', 'Lina'], [member, 'member@x.dev', 'Musa'],
    [supervisor, 'sv@x.dev', 'Dr. Siti'], [stranger, 'stranger@x.dev', 'Sam']]) {
    const res = await c('/auth/register', { method: 'POST', body: { email, name, password: 'password123' } });
    assert.equal(res.status, 201);
    ids[email] = res.data.user.id;
  }
  assert.equal((await client()('/auth/login', { method: 'POST', body: { email: 'leader@x.dev', password: 'wrong-pass' } })).status, 401);
  const { data } = await leader('/boards');
  assert.equal(data.boards.length, 1);
  assert.equal(data.boards[0].personal, 1);
  personalId = data.boards[0].id;
});

test('personal tasks belong to me and stay private', async () => {
  const res = await leader(`/boards/${personalId}/tasks`, { method: 'POST', body: { title: 'Pay hostel fees', dueDate: day(0) } });
  assert.equal(res.status, 201);
  assert.equal(res.data.task.assignee_id, ids['leader@x.dev'], 'personal tasks are assigned to their owner automatically');
  assert.equal((await stranger(`/tasks/${res.data.task.id}`)).status, 404);
  assert.equal((await leader(`/boards/${personalId}/members`, { method: 'POST', body: { email: 'member@x.dev' } })).status, 400);
  assert.equal((await leader(`/boards/${personalId}`, { method: 'DELETE' })).status, 400);
});

test('create a project from the group-assignment template', async () => {
  const res = await leader('/boards', { method: 'POST', body: { name: 'Group Assignment', course_code: 'csc 584', sem_start: '2026-10-05', template: 'group' } });
  assert.equal(res.status, 201);
  projectId = res.data.board.id;
  assert.equal(res.data.board.course_code, 'CSC584');
  const { data } = await leader(`/boards/${projectId}`);
  assert.equal(data.tasks.length, 7);
  assert.equal(data.tasks[0].due_date, '2026-10-09', 'Week 1 tasks are due on the Friday of Week 1');
});

test('the leader adds the team and a supervisor; outsiders see nothing', async () => {
  assert.equal((await leader(`/boards/${projectId}/members`, { method: 'POST', body: { email: 'member@x.dev' } })).status, 201);
  assert.equal((await leader(`/boards/${projectId}/members`, { method: 'POST', body: { email: 'sv@x.dev', role: 'supervisor' } })).status, 201);
  const notLeader = await member(`/boards/${projectId}/members`, { method: 'POST', body: { email: 'stranger@x.dev' } });
  assert.equal(notLeader.status, 403);
  assert.equal(notLeader.data.error, 'Only a group leader can do that.');
  assert.equal((await stranger(`/boards/${projectId}`)).status, 404);
});

test('teammates add, give out and finish tasks', async () => {
  const res = await member(`/boards/${projectId}/tasks`, { method: 'POST', body: { title: 'Write my part', dueDate: day(-2), assigneeId: ids['member@x.dev'] } });
  assert.equal(res.status, 201);
  task = res.data.task;
  assert.equal((await member(`/tasks/${task.id}`, { method: 'PATCH', body: { assigneeId: ids['sv@x.dev'] } })).status, 400,
    'supervisors are not given tasks');
  const done = await member(`/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done', important: true } });
  assert.equal(done.data.task.status, 'done');
  assert.ok(done.data.task.completed_at);
  const reopened = await member(`/tasks/${task.id}`, { method: 'PATCH', body: { status: 'doing' } });
  assert.equal(reopened.data.task.completed_at, null);
});

test('My work shows my tasks from my personal list and every project', async () => {
  const templateTask = (await leader(`/boards/${projectId}`)).data.tasks.find((t) => t.id !== task.id);
  await leader(`/tasks/${templateTask.id}`, { method: 'PATCH', body: { assigneeId: ids['leader@x.dev'] } });
  const { data } = await leader('/me/tasks');
  const places = new Set(data.tasks.map((t) => t.board_name));
  assert.deepEqual([...places].sort(), ['Group Assignment', 'Personal']);
  const musa = await member('/me/tasks');
  assert.deepEqual(musa.data.tasks.map((t) => t.title), ['Write my part']);
});

test('supervisors comment and change status, but cannot edit or add', async () => {
  assert.equal((await supervisor(`/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done' } })).status, 200);
  assert.equal((await supervisor(`/tasks/${task.id}`, { method: 'PATCH', body: { title: 'Changed' } })).status, 403);
  assert.equal((await supervisor(`/tasks/${task.id}/comments`, { method: 'POST', body: { body: 'Good work.' } })).status, 201);
  assert.equal((await supervisor(`/boards/${projectId}/tasks`, { method: 'POST', body: { title: 'Nope' } })).status, 403);
  assert.equal((await supervisor('/me/tasks')).data.tasks.length, 0);
});

test('subtasks have their own status, owner and due date, one level deep', async () => {
  const sub = await member(`/tasks/${task.id}/subtasks`, { method: 'POST', body: { title: 'Find 5 references', assigneeId: ids['leader@x.dev'], dueDate: day(1) } });
  assert.equal(sub.status, 201);
  assert.equal(sub.data.task.parent_id, task.id);
  assert.equal(sub.data.task.parent_title, 'Write my part');
  ids.subtask = sub.data.task.id;

  const done = await leader(`/tasks/${ids.subtask}`, { method: 'PATCH', body: { status: 'done' } });
  assert.equal(done.data.task.status, 'done');
  assert.equal((await supervisor(`/tasks/${ids.subtask}`, { method: 'PATCH', body: { title: 'x' } })).status, 403);
  assert.equal((await member(`/tasks/${ids.subtask}/subtasks`, { method: 'POST', body: { title: 'Too deep' } })).status, 400);
  assert.equal((await supervisor(`/tasks/${task.id}/subtasks`, { method: 'POST', body: { title: 'Nope' } })).status, 403);

  const { data } = await member(`/tasks/${task.id}`);
  assert.deepEqual(data.task.subtasks.map((t) => t.title), ['Find 5 references']);
  assert.equal(data.task.subtask_count, 1);
  assert.equal(data.task.subtasks_done, 1);
  assert.equal(data.task.comments[0].body, 'Good work.');

  const board = await leader(`/boards/${projectId}`);
  assert.ok(!board.data.tasks.some((t) => t.id === ids.subtask), 'subtasks are not cards on the board');
  const mine = await leader('/me/tasks');
  assert.ok(mine.data.tasks.some((t) => t.id === ids.subtask && t.parent_title === 'Write my part'), 'subtasks show in My work');
});

test('files upload, download and enforce type and permissions', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake report');
  const send = (c, name, body = pdf) => c(`/tasks/${task.id}/attachments`, {
    method: 'POST', raw: body, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
  });
  const up = await send(member, 'Laporan Akhir.pdf');
  assert.equal(up.status, 201);
  assert.equal(up.data.attachment.filename, 'Laporan Akhir.pdf');

  const down = await supervisor(`/attachments/${up.data.attachment.id}`);
  assert.equal(down.status, 200);
  assert.deepEqual(down.data, pdf);
  assert.match(down.headers.get('content-disposition'), /attachment/);
  assert.equal((await stranger(`/attachments/${up.data.attachment.id}`)).status, 404);
  assert.equal((await send(member, 'virus.exe', Buffer.from('MZ'))).status, 400);
  assert.equal((await send(supervisor, 'a.pdf')).status, 403);

  assert.equal((await member(`/attachments/${up.data.attachment.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(fs.readdirSync(uploadDir).length, 0, 'deleting a file removes it from disk');

  // Deleting a task removes its subtasks and their files.
  const parent = (await member(`/boards/${projectId}/tasks`, { method: 'POST', body: { title: 'Scratch' } })).data.task;
  const child = (await member(`/tasks/${parent.id}/subtasks`, { method: 'POST', body: { title: 'Scratch part' } })).data.task;
  await member(`/tasks/${child.id}/attachments`, {
    method: 'POST', raw: pdf, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'part.pdf' },
  });
  assert.equal(fs.readdirSync(uploadDir).length, 1);
  assert.equal((await member(`/tasks/${parent.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await member(`/tasks/${child.id}`)).status, 404);
  assert.equal(fs.readdirSync(uploadDir).length, 0);
});

test('contribution report counts each person’s work', async () => {
  const { data } = await supervisor(`/boards/${projectId}/contributions`);
  const musa = data.contributions.find((c) => c.name === 'Musa');
  assert.equal(musa.done, 1);
  assert.equal(musa.on_time, 0, 'finished after the due date');
  assert.ok(!data.contributions.some((c) => c.role === 'supervisor'));
});

test('a project keeps at least one group leader', async () => {
  assert.equal((await leader(`/boards/${projectId}/members/${ids['leader@x.dev']}`, { method: 'PATCH', body: { role: 'member' } })).status, 400);
  assert.equal((await leader(`/boards/${projectId}/members/${ids['leader@x.dev']}`, { method: 'DELETE' })).status, 400);
});

test('search finds tasks in my projects only, by name or notes', async () => {
  await member(`/tasks/${task.id}`, { method: 'PATCH', body: { notes: 'Use APA 7th edition referencing' } });
  const byNotes = await member('/search?q=apa 7th');
  assert.deepEqual(byNotes.data.tasks.map((t) => t.id), [task.id]);
  assert.ok((await member('/search?q=WRITE MY PART')).data.tasks.some((t) => t.id === task.id), 'search ignores case');
  assert.equal((await stranger('/search?q=Write my part')).data.tasks.length, 0, 'other people’s projects stay hidden');
  assert.equal((await leader('/search?q=hostel')).data.tasks[0].title, 'Pay hostel fees');
  assert.equal((await member('/search?q=hostel')).data.tasks.length, 0, 'personal lists stay private');
  assert.equal((await member('/search?q=%25')).data.tasks.length, 0, '% is searched for literally');
  assert.equal((await member('/search?q=')).data.tasks.length, 0);
});

test('people can rename themselves and change their password', async () => {
  const renamed = await member('/auth/me', { method: 'PATCH', body: { name: 'Musa Ali' } });
  assert.equal(renamed.data.user.name, 'Musa Ali');
  assert.equal((await member('/auth/me', { method: 'PATCH', body: { name: '  ' } })).status, 400);

  const otherBrowser = client();
  await otherBrowser('/auth/login', { method: 'POST', body: { email: 'member@x.dev', password: 'password123' } });
  assert.equal((await otherBrowser('/auth/me')).status, 200);

  const wrong = await member('/auth/password', { method: 'POST', body: { currentPassword: 'nope', newPassword: 'new-password-1' } });
  assert.equal(wrong.status, 400);
  const short = await member('/auth/password', { method: 'POST', body: { currentPassword: 'password123', newPassword: 'short' } });
  assert.equal(short.status, 400);
  const ok = await member('/auth/password', { method: 'POST', body: { currentPassword: 'password123', newPassword: 'new-password-1' } });
  assert.equal(ok.status, 204);

  assert.equal((await member('/auth/me')).status, 200, 'this browser stays signed in');
  assert.equal((await otherBrowser('/auth/me')).status, 401, 'other browsers are signed out');
  const relogin = await client()('/auth/login', { method: 'POST', body: { email: 'member@x.dev', password: 'new-password-1' } });
  assert.equal(relogin.status, 200);
});

test('projects are school or personal; personal ones have no course or week', async () => {
  const res = await leader('/boards', { method: 'POST', body: { name: 'Badminton club', kind: 'personal', course_code: 'CSC1', sem_start: '2026-10-05' } });
  assert.equal(res.status, 201);
  ids.club = res.data.board.id;
  assert.equal(res.data.board.kind, 'personal');
  assert.equal(res.data.board.course_code, '');
  assert.equal(res.data.board.sem_start, null);
  assert.equal((await leader('/boards', { method: 'POST', body: { name: 'X', kind: 'personal', template: 'fyp' } })).status, 400);
  assert.equal((await leader('/boards', { method: 'POST', body: { name: 'X', kind: 'work' } })).status, 400);
  const changed = await leader(`/boards/${ids.club}`, { method: 'PATCH', body: { kind: 'school', course_code: 'sukan 1' } });
  assert.equal(changed.data.board.kind, 'school');
  assert.equal(changed.data.board.course_code, 'SUKAN1');
  assert.equal(changed.data.board.name, 'Badminton club', 'unchanged settings are kept');
});

test('everyone pins their own projects', async () => {
  assert.equal((await member(`/boards/${projectId}/pin`, { method: 'PUT' })).status, 204);
  assert.equal((await member(`/boards/${projectId}/pin`, { method: 'PUT' })).status, 204, 'pinning twice is fine');
  const mine = (await member('/boards')).data.boards.find((b) => b.id === projectId);
  assert.equal(mine.pinned, 1);
  assert.equal((await leader('/boards')).data.boards.find((b) => b.id === projectId).pinned, 0, 'pins are per person');
  assert.equal((await stranger(`/boards/${projectId}/pin`, { method: 'PUT' })).status, 404);
  assert.equal((await leader(`/boards/${personalId}/pin`, { method: 'PUT' })).status, 400);
  assert.equal((await member(`/boards/${projectId}/pin`, { method: 'DELETE' })).status, 204);
  assert.equal((await member('/boards')).data.boards.find((b) => b.id === projectId).pinned, 0);
});

test('the summary shows the description, goal, progress, activity and workload', async () => {
  assert.equal((await member(`/boards/${projectId}`, { method: 'PATCH', body: { description: 'Hostel system database', goal: 'Get an A', goal_date: day(30) } })).status, 200);
  assert.equal((await member(`/boards/${projectId}`, { method: 'PATCH', body: { name: 'Renamed' } })).status, 403, 'only leaders change settings');
  assert.equal((await supervisor(`/boards/${projectId}`, { method: 'PATCH', body: { goal: 'x' } })).status, 403);

  const board = (await leader(`/boards/${projectId}`)).data.board;
  assert.equal(board.description, 'Hostel system database');
  assert.equal(board.goal, 'Get an A');

  const { data } = await supervisor(`/boards/${projectId}/summary`);
  const total = data.status.todo + data.status.doing + data.status.done;
  assert.equal(total, (await leader(`/boards/${projectId}`)).data.tasks.length + data.status.subtasks);
  assert.ok(data.activity.some((a) => a.detail === 'set the goal to "Get an A"'));
  assert.ok(data.activity.every((a) => a.user_name));
  assert.deepEqual(data.workload.map((w) => w.name).sort(), ['Lina', 'Musa Ali']);
  assert.ok(!data.workload.some((w) => w.role === 'supervisor'));
  assert.equal(typeof data.unassigned, 'number');
});

test('documents belong to the project and list task files too', async () => {
  const send = (c, name) => c(`/boards/${projectId}/documents`, {
    method: 'POST', raw: Buffer.from('rubric'), headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': name },
  });
  const up = await send(member, 'Rubric.pdf');
  assert.equal(up.status, 201);
  assert.equal((await send(supervisor, 'a.pdf')).status, 403);
  assert.equal((await send(member, 'run.exe')).status, 400);

  const list = await supervisor(`/boards/${projectId}/documents`);
  assert.deepEqual(list.data.documents.map((d) => d.filename), ['Rubric.pdf']);
  assert.ok(Array.isArray(list.data.taskFiles));
  const down = await supervisor(`/documents/${up.data.document.id}`);
  assert.equal(down.status, 200);
  assert.match(down.headers.get('content-disposition'), /attachment/);
  assert.equal((await stranger(`/documents/${up.data.document.id}`)).status, 404);
  assert.equal((await leader(`/boards/${projectId}/contributions`)).data.contributions.find((c) => c.name === 'Musa Ali' || c.name === 'Musa').files, 1);

  // Pictures, videos and PDFs can be shown in the browser; other files only download.
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const upload = (name, body) => member(`/boards/${projectId}/documents`, {
    method: 'POST', raw: body, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
  });
  const video = await upload('Demo video.mp4', mp4);
  assert.equal(video.status, 201);
  assert.equal(video.data.document.preview, 'video');
  assert.equal((await upload('Poster.png', png)).data.document.preview, 'image');
  assert.equal((await upload('Report.pdf', Buffer.from('%PDF-1.7 report'))).data.document.preview, 'pdf');
  assert.equal((await upload('fake.png', Buffer.from('<html><script>alert(1)</script></html>'))).data.document.preview, null,
    'a file only previews if its contents match');
  assert.equal((await upload('Design.fig', Buffer.from('figma'))).status, 201, 'any other file is fine');
  assert.equal((await upload('page.html', Buffer.from('<b>hi</b>'))).status, 201);
  assert.equal((await upload('setup.bat', Buffer.from('del *'))).status, 400, 'programs are refused');
  assert.equal((await upload('empty.txt', Buffer.alloc(0))).status, 400);

  const docs = (await member(`/boards/${projectId}/documents`)).data.documents;
  assert.ok(docs.every((d) => !('stored_name' in d)), 'internal file names stay private');
  const fake = docs.find((d) => d.filename === 'fake.png');
  const fakeView = await member(`/documents/${fake.id}?view=1`);
  assert.match(fakeView.headers.get('content-disposition'), /attachment/, 'a fake picture downloads instead of showing');
  const html = docs.find((d) => d.filename === 'page.html');
  assert.match((await member(`/documents/${html.id}?view=1`)).headers.get('content-disposition'), /attachment/);

  const play = await supervisor(`/documents/${video.data.document.id}?view=1`);
  assert.equal(play.status, 200);
  assert.equal(play.headers.get('content-type'), 'video/mp4');
  assert.match(play.headers.get('content-disposition'), /^inline/);
  assert.match(play.headers.get('content-security-policy'), /sandbox/);
  const part = await supervisor(`/documents/${video.data.document.id}?view=1`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(part.status, 206, 'videos can seek');
  assert.equal(part.data.length, 10);


  // Deleting a project removes its files from disk.
  const tmp = (await leader('/boards', { method: 'POST', body: { name: 'Temp' } })).data.board;
  await leader(`/boards/${tmp.id}/documents`, { method: 'POST', raw: Buffer.from('x'), headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'x.txt' } });
  const before = fs.readdirSync(uploadDir).length;
  assert.equal((await leader(`/boards/${tmp.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(fs.readdirSync(uploadDir).length, before - 1);
});

test('profiles have a photo, a bio and an email you can change', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const put = (c, body) => c('/me/avatar', { method: 'PUT', raw: body, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal((await put(leader, Buffer.from('<svg onload=alert(1)></svg>  '))).status, 400, 'only real images');
  const first = await put(leader, png);
  assert.equal(first.status, 200);
  assert.match(first.data.avatar_url, /^\/api\/users\/\d+\/avatar\?v=/);
  const second = await put(leader, png);
  assert.notEqual(second.data.avatar_url, first.data.avatar_url, 'a new photo gets a new address');
  const img = await stranger(second.data.avatar_url.replace('/api', ''));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await client()(second.data.avatar_url.replace('/api', ''))).status, 401, 'only signed-in people see photos');
  const members = (await member(`/boards/${projectId}`)).data.members;
  assert.equal(members.find((m) => m.name === 'Lina').avatar_url, second.data.avatar_url);
  assert.equal((await leader('/auth/me')).data.user.avatar_url, second.data.avatar_url);

  assert.equal((await leader('/auth/me', { method: 'PATCH', body: { bio: 'Group leader, CSC584' } })).data.user.bio, 'Group leader, CSC584');
  assert.equal((await leader('/auth/me')).data.user.name, 'Lina', 'changing the bio keeps the name');

  assert.equal((await leader('/auth/email', { method: 'POST', body: { email: 'new@x.dev', password: 'wrong' } })).status, 400);
  assert.equal((await leader('/auth/email', { method: 'POST', body: { email: 'member@x.dev', password: 'password123' } })).status, 409);
  assert.equal((await leader('/auth/email', { method: 'POST', body: { email: 'Lina@New.dev', password: 'password123' } })).data.user.email, 'lina@new.dev');
  assert.equal((await client()('/auth/login', { method: 'POST', body: { email: 'lina@new.dev', password: 'password123' } })).status, 200);

  const avatars = () => fs.readdirSync(uploadDir).filter((f) => f.startsWith('avatar-')).length;
  assert.equal(avatars(), 1, 'the old photo is removed');
  assert.equal((await leader('/me/avatar', { method: 'DELETE' })).status, 204);
  assert.equal(avatars(), 0);
  assert.equal((await leader('/auth/me')).data.user.avatar_url, null);
});
