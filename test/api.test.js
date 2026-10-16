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

test('steps can be added, ticked and removed', async () => {
  const s = await member(`/tasks/${task.id}/steps`, { method: 'POST', body: { text: 'Find 5 references' } });
  assert.equal(s.status, 201);
  assert.equal((await member(`/steps/${s.data.step.id}`, { method: 'PATCH', body: { done: true } })).data.step.done, 1);
  assert.equal((await supervisor(`/steps/${s.data.step.id}`, { method: 'PATCH', body: { done: false } })).status, 403);
  const { data } = await member(`/tasks/${task.id}`);
  assert.equal(data.task.steps.length, 1);
  assert.equal(data.task.comments[0].body, 'Good work.');
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
