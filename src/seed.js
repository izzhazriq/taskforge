// Creates demo accounts, a personal list and two team projects so the app has something to show.
// Run with: npm run demo (it only ever touches the demo-data folder, never your real tasks).
import fs from 'node:fs';
import { openDb, transaction, createPersonalBoard } from './db.js';
import { DEMO, DATA_DIR } from './config.js';
import { hashPassword } from './auth.js';
import { TEMPLATES, dueForWeek } from './templates.js';
import { createTask } from './taskUtils.js';

if (!DEMO) {
  console.error('The demo data only goes in the demo folder. Run "npm run demo" instead.');
  process.exit(1);
}
fs.rmSync(DATA_DIR, { recursive: true, force: true });
const db = openDb();

// Put the demo semester in Week 7, so some work is done, some due soon and some late.
const monday = new Date();
monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 6 * 7);
const semStart = monday.toISOString().slice(0, 10);
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const people = {
  demo: ['demo@taskforge.dev', 'Demo Student'],
  aina: ['aina@taskforge.dev', 'Nur Aina'],
  farid: ['farid@taskforge.dev', 'Farid Hakim'],
  mei: ['mei@taskforge.dev', 'Tan Mei Ling'],
  supervisor: ['dr.nurul@taskforge.dev', 'Dr. Nurul Huda'],
};

transaction(db, () => {
  const id = {};
  for (const [k, [email, name]] of Object.entries(people)) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) { id[k] = existing.id; continue; }
    id[k] = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(email, name, hashPassword('demo1234')).lastInsertRowid;
    createPersonalBoard(db, id[k]);
  }
  const personal = db.prepare(`SELECT b.id FROM boards b JOIN memberships m ON m.board_id = b.id WHERE b.personal = 1 AND m.user_id = ?`);
  const setDone = db.prepare(`UPDATE tasks SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now', '-3 days') END, assignee_id = ? WHERE id = ?`);

  // ----- Personal list -----
  const mine = personal.get(id.demo).id;
  db.prepare('UPDATE boards SET sem_start = ? WHERE id = ?').run(semStart, mine);
  createTask(db, mine, id.demo, { title: 'Revise for CSC584 quiz 2', dueDate: day(1), important: true });
  createTask(db, mine, id.demo, { title: 'Pay hostel fees', dueDate: day(0) });
  createTask(db, mine, id.demo, { title: 'Apply for internship at Gamuda', dueDate: day(6) });
  createTask(db, mine, id.demo, { title: 'Return library books', dueDate: day(-1) });
  createTask(db, mine, id.demo, { title: 'Update resume' });

  let lastBoard;
  function project(name, course, members, template, plan) {
    const boardId = db.prepare('INSERT INTO boards (name, course_code, sem_start) VALUES (?, ?, ?)').run(name, course, semStart).lastInsertRowid;
    for (const [who, role] of members) db.prepare('INSERT INTO memberships (board_id, user_id, role) VALUES (?, ?, ?)').run(boardId, id[who], role);
    lastBoard = boardId;
    return TEMPLATES[template].tasks.map((t, i) => {
      const taskId = createTask(db, boardId, id.demo, { ...t, dueDate: dueForWeek(semStart, t.week) });
      const [status, who] = plan[i];
      setDone.run(status, status, who ? id[who] : null, taskId);
      return taskId;
    });
  }

  // ----- An FYP with a supervisor -----
  const fyp = project('Smart Campus Parking App', 'CSP650', [['demo', 'owner'], ['supervisor', 'supervisor']], 'fyp',
    [['done', 'demo'], ['done', 'demo'], ['done', 'demo'], ['done', 'demo'], ['doing', 'demo'],
     ['todo', 'demo'], ['todo', 'demo'], ['todo', 'demo'], ['todo', 'demo'], ['todo', 'demo']]);
  const fyp0 = lastBoard;
  const comment = db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)');
  comment.run(fyp[4], id.demo, 'First draft is done. I used Agile with two-week sprints.');
  comment.run(fyp[4], id.supervisor, 'Good start. Please add a Gantt chart and explain why Agile suits a solo project.');
  for (const [title, status] of [['Research methodology', 'done'], ['Questionnaire for requirements', 'done'], ['Gantt chart', 'doing'], ['Hardware and software list', 'todo']]) {
    createTask(db, fyp0, id.demo, { title, status, assigneeId: id.demo, parentId: fyp[4] });
  }
  db.prepare(`UPDATE boards SET description = ?, goal = ?, goal_date = ? WHERE id = ?`).run(
    'A mobile app that shows free parking spots on campus in real time, using IoT sensors and a map. Supervised by Dr. Nurul Huda.',
    'Pass the proposal presentation with a working prototype', dueForWeek(semStart, 14), fyp0);
  db.prepare('INSERT INTO pins (user_id, board_id) VALUES (?, ?)').run(id.demo, fyp0);

  // ----- A group assignment -----
  const grp = project('Group Assignment', 'CSC584', [['demo', 'owner'], ['aina', 'member'], ['farid', 'member'], ['mei', 'member']], 'group',
    [['done', 'demo'], ['done', 'aina'], ['doing', 'farid'], ['todo', 'mei'], ['doing', 'aina'], ['todo', 'demo'], ['todo', null]]);
  comment.run(grp[2], id.farid, 'Uploading my draft tonight. Can someone check the references?');
  comment.run(grp[2], id.aina, 'Sure, I will check once it is up.');
  const grp0 = lastBoard;
  for (const [title, who, status] of [['Introduction', 'demo', 'done'], ['Literature review', 'aina', 'doing'], ['ERD and normalisation', 'farid', 'doing'], ['SQL queries', 'mei', 'todo']]) {
    createTask(db, grp0, id.demo, { title, status, assigneeId: id[who], parentId: grp[2] });
  }
  db.prepare(`UPDATE boards SET description = ?, goal = ?, goal_date = ? WHERE id = ?`).run(
    'Design and build a database for a hostel management system, with a report and a 10-minute presentation.',
    'Submit the report and slides on the learning portal', dueForWeek(semStart, 6), grp0);

  // ----- A personal project -----
  const site = db.prepare(`INSERT INTO boards (name, kind, description, goal) VALUES (?, 'personal', ?, ?)`).run(
    'Portfolio website', 'My personal site with my projects, experience and a dev log.', 'Launch izzhazriq.my').lastInsertRowid;
  db.prepare(`INSERT INTO memberships (board_id, user_id, role) VALUES (?, ?, 'owner')`).run(site, id.demo);
  const home = createTask(db, site, id.demo, { title: 'Build the home page', assigneeId: id.demo, dueDate: day(4), status: 'doing' });
  for (const title of ['Hero section', 'Featured projects', 'Contact links']) createTask(db, site, id.demo, { title, assigneeId: id.demo, parentId: home });
  createTask(db, site, id.demo, { title: 'Write the first dev log post', assigneeId: id.demo, dueDate: day(10) });
  createTask(db, site, id.demo, { title: 'Buy the domain', assigneeId: id.demo, status: 'done' });
});

db.close();
console.log(`Seeded demo data (Week 1 started ${semStart}, so this is Week 7).`);
console.log('Log in as demo@taskforge.dev, aina@taskforge.dev or dr.nurul@taskforge.dev (supervisor). Password: demo1234');
