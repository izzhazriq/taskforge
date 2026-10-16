// Account types, Sign in with Google, the profile page, GitHub links and clearing activity.
// Google and GitHub are stood in for by a fake fetch, so these tests never touch the internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { parseRepo, taskKeys } from '../src/github.js';

let server, base, uploadDir;
const calls = [];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const now = new Date().toISOString();

const googleUsers = { 'good-code': { sub: 'g-123', email: 'New.Person@gmail.com', email_verified: true, name: 'New Person' },
  'leader-code': { sub: 'g-lead', email: 'lead@x.dev', email_verified: true, name: 'Lead' } };

async function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  calls.push({ url: u.href, auth: opts.headers?.Authorization });
  if (u.host === 'oauth2.googleapis.com') {
    const code = new URLSearchParams(String(opts.body)).get('code');
    return googleUsers[code] ? json({ access_token: `at-${code}` }) : json({ error: 'invalid_grant' }, 400);
  }
  if (u.host === 'openidconnect.googleapis.com') {
    return json(googleUsers[opts.headers.Authorization.replace('Bearer at-', '')]);
  }
  if (u.host === 'api.github.com') {
    const p = u.pathname;
    if (p === '/user') return opts.headers.Authorization === 'Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaa' ? json({ login: 'izzhazriq' }) : json({}, 401);
    if (p.startsWith('/repos/izz/secret')) return opts.headers.Authorization ? json({}, 200) : json({ message: 'Not Found' }, 404);
    if (p === '/repos/izz/medina') return json({ full_name: 'izz/medina', html_url: 'https://github.com/izz/medina', description: 'Store', private: false,
      default_branch: 'main', stargazers_count: 2, language: 'JavaScript', pushed_at: now });
    if (p === '/repos/izz/medina/commits') return json([
      { sha: 'abcdef1234567', html_url: 'https://github.com/izz/medina/commit/abcdef1', commit: { message: `Add cart page (TF-${ids.cartTask})\n\nDetails`, author: { name: 'Izz', date: now } }, author: { login: 'izz' } },
      { sha: '1234567abcdef', html_url: 'https://github.com/izz/medina/commit/1234567', commit: { message: 'Fix typo TF-99999', author: { name: 'Izz', date: '2020-01-01T00:00:00Z' } }, author: null },
    ]);
    if (p === '/repos/izz/medina/pulls') return json([{ number: 5, title: 'Checkout flow', html_url: 'https://github.com/izz/medina/pull/5', user: { login: 'izz' }, draft: true, created_at: now, head: { ref: 'checkout' } }]);
    if (p === '/repos/izz/medina/issues') return json([
      { number: 7, title: 'Product photos are blurry', html_url: 'https://github.com/izz/medina/issues/7', user: { login: 'aina' }, created_at: now, labels: [{ name: 'bug' }] },
      { number: 5, title: 'Checkout flow', pull_request: {}, user: { login: 'izz' }, created_at: now },
    ]);
    if (p === '/repos/izz/medina/issues/7') return json({ number: 7, title: 'Product photos are blurry', html_url: 'https://github.com/izz/medina/issues/7', body: 'Use 2x images.' });
    return json({ message: 'Not Found' }, 404);
  }
  throw new Error(`unexpected fetch ${url}`);
}

const ids = {};
before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-acct-'));
  const google = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost/api/auth/google/callback' };
  server = createApp(openDb(':memory:'), { uploadDir, google, fetch: fakeFetch }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

// One browser: keeps its cookies and doesn't follow redirects, so tests can read where they go.
function client() {
  const jar = new Map();
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + (p.startsWith('/api') ? p : `/api${p}`), {
      method, redirect: 'manual',
      headers: { ...(body && { 'Content-Type': 'application/json' }), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body && JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      if (/Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(k); else jar.set(k, v.join('='));
    }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, location: res.headers.get('location'), data: type.includes('json') ? await res.json() : null, jar };
  };
}

const lead = client(), sup = client(), solo = client(), mate = client();
let schoolId, personalProjectId;

test('sign up asks what the account is for', async () => {
  for (const [c, email, name, accountType] of [[lead, 'lead@x.dev', 'Lead', 'student'], [sup, 'sup@x.dev', 'Dr. Sup', 'supervisor'],
    [solo, 'solo@x.dev', 'Solo', 'personal'], [mate, 'mate@x.dev', 'Mate', 'student']]) {
    const res = await c('/auth/register', { method: 'POST', body: { email, name, password: 'password123', accountType } });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.account_type, accountType);
    ids[email] = res.data.user.id;
  }
  const bad = await client()('/auth/register', { method: 'POST', body: { email: 'z@x.dev', name: 'Z', password: 'password123', accountType: 'admin' } });
  assert.equal(bad.status, 400);
});

test('students make school and personal projects; personal accounts only personal; supervisors none', async () => {
  const school = await lead('/boards', { method: 'POST', body: { name: 'FYP', kind: 'school' } });
  assert.equal(school.status, 201);
  schoolId = school.data.board.id;
  const site = await lead('/boards', { method: 'POST', body: { name: 'Medina Brand Store Website', kind: 'personal', github_repo: 'https://github.com/izz/medina.git' } });
  assert.equal(site.status, 201);
  personalProjectId = site.data.board.id;
  assert.equal(site.data.board.github_repo, 'izz/medina');

  assert.equal((await solo('/boards', { method: 'POST', body: { name: 'Club', kind: 'school' } })).status, 403);
  assert.equal((await solo('/boards', { method: 'POST', body: { name: 'Trip', kind: 'personal' } })).status, 201);
  assert.equal((await sup('/boards', { method: 'POST', body: { name: 'Mine', kind: 'school' } })).status, 403);
});

test('a supervisor account can only ever be a supervisor, on school projects', async () => {
  const add = (body, id = schoolId) => lead(`/boards/${id}/members`, { method: 'POST', body });
  assert.equal((await add({ email: 'sup@x.dev', role: 'member' })).status, 400);
  assert.equal((await add({ email: 'sup@x.dev', role: 'supervisor' })).status, 201);
  assert.equal((await lead(`/boards/${schoolId}/members/${ids['sup@x.dev']}`, { method: 'PATCH', body: { role: 'owner' } })).status, 400);
  assert.equal((await add({ email: 'sup@x.dev', role: 'supervisor' }, personalProjectId)).status, 400, 'no supervisors on personal projects');
  assert.equal((await add({ email: 'solo@x.dev', role: 'member' })).status, 400, 'personal accounts stay out of school projects');
  assert.equal((await add({ email: 'solo@x.dev', role: 'member' }, personalProjectId)).status, 201);
  assert.equal((await add({ email: 'mate@x.dev', role: 'supervisor' }, personalProjectId)).status, 400);

  // Turning the school project personal would leave a supervisor on a personal project.
  const flip = await lead(`/boards/${schoolId}`, { method: 'PATCH', body: { kind: 'personal' } });
  assert.equal(flip.status, 400);
  assert.match(flip.data.error, /Dr\. Sup/);
});

test('switching account type has to fit your projects', async () => {
  assert.equal((await lead('/auth/me', { method: 'PATCH', body: { account_type: 'personal' } })).status, 400);
  assert.equal((await lead('/auth/me', { method: 'PATCH', body: { account_type: 'supervisor' } })).status, 400);
  const up = await solo('/auth/me', { method: 'PATCH', body: { account_type: 'student' } });
  assert.equal(up.data.user.account_type, 'student');
  assert.equal((await solo('/auth/me', { method: 'PATCH', body: { account_type: 'personal' } })).status, 200);
});

test('the profile keeps Jira-style details and shows what you worked on', async () => {
  const res = await lead('/auth/me', { method: 'PATCH', body: { job_title: 'CS student', department: 'FSKM', organization: 'UiTM', location: 'Shah Alam', cover: 'ocean' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.organization, 'UiTM');
  assert.equal(res.data.user.cover, 'ocean');
  assert.equal(res.data.user.has_password, 1);
  assert.equal('password_hash' in res.data.user, false);
  assert.equal((await lead('/auth/me', { method: 'PATCH', body: { cover: 'neon' } })).status, 400);

  ids.cartTask = (await lead(`/boards/${personalProjectId}/tasks`, { method: 'POST', body: { title: 'Cart page' } })).data.task.id;
  const { data } = await lead('/me/overview');
  assert.deepEqual(data.projects.map((p) => p.name).sort(), ['FYP', 'Medina Brand Store Website']);
  assert.equal(data.workedOn[0].title, 'Cart page');
  assert.ok(data.activity.length > 0);
});

test('leaders can clear a project’s recent activity', async () => {
  const before = await lead(`/boards/${personalProjectId}/summary`);
  assert.ok(before.data.activity.length > 0);
  assert.equal((await solo(`/boards/${personalProjectId}/activity`, { method: 'DELETE' })).status, 403, 'members can’t');
  assert.equal((await lead(`/boards/${personalProjectId}/activity`, { method: 'DELETE' })).status, 204);
  assert.equal((await lead(`/boards/${personalProjectId}/summary`)).data.activity.length, 0);
});

test('a linked GitHub repository shows commits, pull requests and issues, linked to tasks', async () => {
  const { status, data } = await lead(`/boards/${personalProjectId}/github`);
  assert.equal(status, 200);
  assert.equal(data.repo.full_name, 'izz/medina');
  assert.equal(data.repo.open_issues, 1, 'pull requests aren’t counted as issues');
  assert.equal(data.commits_this_week, 1);
  assert.deepEqual(data.commits[0].tasks.map((t) => t.id), [ids.cartTask], 'TF-<id> links the commit to the task');
  assert.deepEqual(data.commits[1].tasks, [], 'tasks from other projects never show');
  assert.equal(data.pulls[0].draft, true);

  const made = await lead(`/boards/${personalProjectId}/github/issues/7`, { method: 'POST' });
  assert.equal(made.status, 201);
  const task = (await lead(`/tasks/${made.data.task.id}`)).data.task;
  assert.equal(task.title, 'Product photos are blurry');
  assert.match(task.notes, /issues\/7/);
  const again = await lead(`/boards/${personalProjectId}/github/issues/7`, { method: 'POST' });
  assert.equal(again.data.existed, true);
  assert.equal((await lead(`/boards/${personalProjectId}/github`)).data.issues[0].task_id, made.data.task.id);

  assert.equal((await lead(`/boards/${schoolId}/github`)).data.linked, false);
  assert.equal((await mate(`/boards/${personalProjectId}/github`)).status, 404, 'outsiders can’t look');
});

test('private repositories need a GitHub token, which is checked and never sent back', async () => {
  assert.equal((await lead(`/boards/${schoolId}`, { method: 'PATCH', body: { github_repo: 'izz/secret' } })).status, 200);
  const blocked = await lead(`/boards/${schoolId}/github`);
  assert.equal(blocked.status, 404);
  assert.match(blocked.data.error, /token/);

  assert.equal((await lead('/me/github-token', { method: 'PUT', body: { token: 'ghp_bbbbbbbbbbbbbbbbbbbbbbbb' } })).status, 400, 'GitHub refuses it');
  const ok = await lead('/me/github-token', { method: 'PUT', body: { token: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(ok.data.login, 'izzhazriq');
  const me = (await lead('/auth/me')).data.user;
  assert.equal(me.has_github_token, 1);
  assert.equal(me.github_login, 'izzhazriq');
  assert.equal(JSON.stringify(me).includes('ghp_'), false);
  // The supervisor has no token, so the leader's is used for the project.
  calls.length = 0;
  await sup(`/boards/${schoolId}/github`).catch(() => {});
  assert.ok(calls.some((c) => c.auth === 'Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaa'));

  assert.equal((await lead(`/boards/${schoolId}`, { method: 'PATCH', body: { github_repo: 'not a repo' } })).status, 400);
  assert.equal(parseRepo('github.com/izzhazriq/taskforge/'), 'izzhazriq/taskforge');
  assert.deepEqual(taskKeys('Fix TF-3 and tf-12, again TF-3'), [3, 12]);
});

test('Sign in with Google: new people pick an account type first', async () => {
  const browser = client();
  const start = await browser('/auth/google');
  assert.equal(start.status, 302);
  const google = new URL(start.location);
  assert.equal(google.host, 'accounts.google.com');
  const state = google.searchParams.get('state');

  assert.match((await browser(`/auth/google/callback?code=good-code&state=wrong`)).location, /auth_error=/, 'a forged state is refused');
  await browser('/auth/google');
  const fresh = new URL((await browser('/auth/google')).location).searchParams.get('state');
  assert.notEqual(fresh, state);
  const back = await browser(`/auth/google/callback?code=good-code&state=${fresh}`);
  assert.equal(back.location, '/?signup=google');
  assert.equal((await browser('/auth/me')).status, 401, 'not signed in until the account type is chosen');

  assert.deepEqual((await browser('/auth/google/pending')).data, { email: 'new.person@gmail.com', name: 'New Person' });
  const made = await browser('/auth/google/complete', { method: 'POST', body: { accountType: 'personal' } });
  assert.equal(made.status, 201);
  assert.equal(made.data.user.account_type, 'personal');
  assert.equal(made.data.user.has_google, 1);
  assert.equal(made.data.user.has_password, 0);
  assert.equal((await browser('/auth/google/complete', { method: 'POST', body: { accountType: 'personal' } })).status, 400, 'used up');

  // No password yet: logging in with one explains, and a first password can be set without a current one.
  const login = await client()('/auth/login', { method: 'POST', body: { email: 'new.person@gmail.com', password: 'anything1' } });
  assert.match(login.data.error, /Google/);
  assert.equal((await browser('/auth/password', { method: 'POST', body: { newPassword: 'brandnew123' } })).status, 204);
  assert.equal((await client()('/auth/login', { method: 'POST', body: { email: 'new.person@gmail.com', password: 'brandnew123' } })).status, 200);
});

test('Sign in with Google links to an existing account with the same email', async () => {
  const browser = client();
  const state = new URL((await browser('/auth/google')).location).searchParams.get('state');
  const back = await browser(`/auth/google/callback?code=leader-code&state=${state}`);
  assert.equal(back.location, '/');
  const me = (await browser('/auth/me')).data.user;
  assert.equal(me.id, ids['lead@x.dev']);
  assert.equal(me.has_google, 1);

  const bad = client();
  const s2 = new URL((await bad('/auth/google')).location).searchParams.get('state');
  assert.match((await bad(`/auth/google/callback?code=nope&state=${s2}`)).location, /auth_error=/);
  assert.equal((await client()('/auth/info')).data.google, true);
});
