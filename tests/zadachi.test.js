'use strict';
// Проверки «Пульса задач» настоящими HTTP-запросами в обход интерфейса.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18801;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zadachi-'));
let proc;

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body, headers = {}) {
    const res = await fetch(BASE + '/api/v1' + url, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  get(u) { return this.call('GET', u); }
  post(u, b) { return this.call('POST', u, b); }
  patch(u, b) { return this.call('PATCH', u, b); }
  del(u) { return this.call('DELETE', u); }
}

const admin = new Client();
const lead = new Client();
const lead2 = new Client();
const anna = new Client(); // сотрудник внутри проекта
const boris = new Client(); // сотрудник вне проекта
const ids = {};

async function join(name, role, login, client) {
  const inv = await admin.post('/team/invites', { name, role });
  assert.equal(inv.status, 201);
  const r = await client.post(`/auth/invite/${inv.data.token}`, { login, password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.user.id;
}

before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'cases/01_zadachi/app/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, DB_FILE: path.join(dir, 't.sqlite'), ADMIN_LOGIN: 'boss', ADMIN_PASSWORD: 'adminpass1', DEMO: '' },
    stdio: 'inherit',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const r = await admin.post('/auth/login', { login: 'boss', password: 'adminpass1' });
  assert.equal(r.status, 200);
  ids.admin = r.data.user.id;
  ids.lead = await join('Руководитель', 'lead', 'lead1', lead);
  ids.lead2 = await join('Второй', 'lead', 'lead2', lead2);
  ids.anna = await join('Анна', 'member', 'anna', anna);
  ids.boris = await join('Борис', 'member', 'boris', boris);
  const p = await lead.post('/projects', { name: 'Проект А', memberIds: [ids.anna] });
  assert.equal(p.status, 201);
  ids.project = p.data.project.id;
  const t = await lead.post('/tasks', { title: 'Задача Анны', projectId: ids.project, assigneeId: ids.anna, dueAt: '2020-01-01T10:00:00Z' });
  assert.equal(t.status, 201);
  ids.task = t.data.task.id;
});

after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('без входа данные недоступны', async () => {
  const c = new Client();
  for (const url of ['/tasks', '/projects', '/team', '/me', '/settings', `/tasks/${ids.task}`]) {
    assert.equal((await c.get(url)).status, 401, url);
  }
  assert.equal((await c.post('/tasks', { title: 'x' })).status, 401);
});

test('неверный пароль и защита от подбора', async () => {
  const c = new Client();
  const bad = await c.post('/auth/login', { login: 'lead1', password: 'wrong' });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error.message, 'Неверный логин или пароль');
  let last;
  for (let i = 0; i < 10; i++) last = await c.post('/auth/login', { login: 'lead2', password: 'wrong' });
  assert.equal(last.status, 429);
  assert.equal((await c.post('/auth/login', { login: 'lead2', password: 'password123' })).status, 429, 'заблокирован и с верным паролем');
});

test('сотрудник вне проекта не видит чужую задачу, в том числе напрямую', async () => {
  assert.equal((await boris.get(`/tasks/${ids.task}`)).status, 404);
  assert.equal((await boris.patch(`/tasks/${ids.task}`, { status: 'done' })).status, 404);
  assert.equal((await boris.post(`/tasks/${ids.task}/comments`, { body: 'x' })).status, 404);
  assert.equal((await boris.post(`/tasks/${ids.task}/move`, { status: 'progress' })).status, 404);
  assert.equal((await boris.del(`/tasks/${ids.task}`)).status, 404);
  const list = await boris.get('/tasks');
  assert.equal(list.data.tasks.length, 0);
  assert.equal((await boris.get(`/tasks?project=${ids.project}`)).data.tasks.length, 0, 'фильтр по проекту не открывает доступ');
  assert.equal((await boris.get(`/tasks?assignee=${ids.anna}`)).data.tasks.length, 0, 'фильтр по человеку не открывает доступ');
  assert.equal((await boris.get('/projects')).data.projects.length, 0);
});

test('сотрудник в проекте видит задачу, но права ограничены', async () => {
  const other = await lead.post('/tasks', { title: 'Задача руководителя', projectId: ids.project, assigneeId: ids.lead });
  assert.equal((await anna.get(`/tasks/${other.data.task.id}`)).status, 200, 'видит задачи своего проекта');
  assert.equal((await anna.patch(`/tasks/${other.data.task.id}`, { status: 'progress' })).status, 403, 'чужой статус не меняет');
  assert.equal((await anna.post(`/tasks/${other.data.task.id}/move`, { status: 'progress' })).status, 403);
  assert.equal((await anna.post(`/tasks/${other.data.task.id}/comments`, { body: 'Вопрос' })).status, 201, 'комментировать можно');
  assert.equal((await anna.patch(`/tasks/${ids.task}`, { assigneeId: ids.boris })).status, 403);
  assert.equal((await anna.patch(`/tasks/${ids.task}`, { dueAt: '2030-01-01T10:00:00Z' })).status, 403);
  assert.equal((await anna.patch(`/tasks/${ids.task}`, { title: 'Новое' })).status, 403);
  assert.equal((await anna.del(`/tasks/${ids.task}`)).status, 403);
});

test('сотрудник ставит задачи только себе и без срока', async () => {
  assert.equal((await anna.post('/tasks', { title: 'x', assigneeId: ids.boris })).status, 403);
  assert.equal((await anna.post('/tasks', { title: 'x', dueAt: '2030-01-01T10:00:00Z' })).status, 403);
  const ok = await anna.post('/tasks', { title: 'Себе' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.task.assigneeId, ids.anna);
  assert.equal((await boris.post('/tasks', { title: 'x', projectId: ids.project })).status, 403, 'не в чужой проект');
  assert.equal((await anna.patch(`/tasks/${ok.data.task.id}`, { title: 'Переименовала' })).status, 200, 'свою черновую задачу правит');
});

test('сотрудник не принимает работу сам', async () => {
  const id = ids.task;
  assert.equal((await anna.patch(`/tasks/${id}`, { status: 'progress' })).status, 200);
  assert.equal((await anna.patch(`/tasks/${id}`, { status: 'done' })).status, 403);
  assert.equal((await anna.post(`/tasks/${id}/move`, { status: 'done' })).status, 403);
  assert.equal((await anna.patch(`/tasks/${id}`, { status: 'review' })).status, 200);
  const done = await lead.patch(`/tasks/${id}`, { status: 'done' });
  assert.equal(done.status, 200);
  assert.ok(done.data.task.doneAt);
  assert.equal(done.data.task.overdue, false, 'готовая задача не просрочена');
  assert.equal((await anna.patch(`/tasks/${id}`, { status: 'progress' })).status, 403, 'готовую не возвращает');
  const back = await lead.patch(`/tasks/${id}`, { status: 'progress' });
  assert.equal(back.data.task.doneAt, null);
  assert.equal(back.data.task.overdue, true, 'срок прошёл: снова просрочена');
});

test('история показывает все изменения', async () => {
  const { data } = await lead.get(`/tasks/${ids.task}`);
  const steps = data.history.filter(h => h.action === 'status').map(h => h.toValue).reverse();
  assert.deepEqual(steps, ['progress', 'review', 'done', 'progress']);
  assert.ok(data.history.some(h => h.action === 'created'));
});

test('руководитель удаляет только в своих проектах и не управляет командой', async () => {
  const t = await lead.post('/tasks', { title: 'На удаление', projectId: ids.project });
  assert.equal((await lead2.del(`/tasks/${t.data.task.id}`)).status, 403);
  assert.equal((await lead2.patch(`/projects/${ids.project}`, { name: 'Чужой' })).status, 403);
  assert.equal((await lead.del(`/tasks/${t.data.task.id}`)).status, 200);
  assert.equal((await lead.post('/team/invites', { name: 'x', role: 'member' })).status, 403);
  assert.equal((await lead.patch(`/team/${ids.anna}`, { role: 'admin' })).status, 403);
});

test('сотрудник не повышает себе роль и не видит логины команды', async () => {
  assert.equal((await anna.patch(`/team/${ids.anna}`, { role: 'admin' })).status, 403);
  assert.equal((await anna.post('/team/invites', { name: 'x', role: 'admin' })).status, 403);
  assert.equal((await anna.post('/projects', { name: 'x' })).status, 403);
  const team = await anna.get('/team');
  assert.equal(team.data.members[0].login, undefined);
  assert.equal(team.data.members[0].open, undefined);
});

test('приглашение работает один раз', async () => {
  const inv = await admin.post('/team/invites', { name: 'Вера', role: 'member' });
  const c = new Client();
  assert.equal((await c.get(`/auth/invite/${inv.data.token}`)).data.name, 'Вера');
  const weak = await c.post(`/auth/invite/${inv.data.token}`, { login: 'vera', password: 'short' });
  assert.equal(weak.status, 400);
  assert.equal((await c.post(`/auth/invite/${inv.data.token}`, { login: 'anna', password: 'password123' })).status, 400, 'занятый логин');
  assert.equal((await c.post(`/auth/invite/${inv.data.token}`, { login: 'vera', password: 'password123' })).status, 200);
  const again = new Client();
  assert.equal((await again.post(`/auth/invite/${inv.data.token}`, { login: 'vera2', password: 'password123' })).status, 404);
  assert.equal((await again.post('/auth/invite/ненастоящий', { login: 'vera3', password: 'password123' })).status, 404);
});

test('смена пароля отключает другие устройства', async () => {
  const phone = new Client();
  assert.equal((await phone.post('/auth/login', { login: 'boris', password: 'password123' })).status, 200);
  assert.equal((await boris.post('/me/password', { old: 'неверный', new: 'newpassword1' })).status, 400);
  assert.equal((await boris.post('/me/password', { old: 'password123', new: 'newpassword1' })).status, 200);
  assert.equal((await phone.get('/me')).status, 401);
  assert.equal((await boris.get('/me')).status, 200);
  const fresh = new Client();
  assert.equal((await fresh.post('/auth/login', { login: 'boris', password: 'newpassword1' })).status, 200);
});

test('изменение имени сохраняется', async () => {
  assert.equal((await anna.patch('/me', { name: 'Анна Иванова' })).status, 200);
  assert.equal((await anna.get('/me')).data.user.name, 'Анна Иванова');
  assert.equal((await anna.patch('/me', { name: '   ' })).status, 400);
});

test('отключённый участник сразу теряет доступ, последний админ защищён', async () => {
  const c = new Client();
  await join('Временный', 'member', 'temp', c);
  const team = await admin.get('/team');
  const temp = team.data.members.find(m => m.login === 'temp');
  assert.equal((await admin.patch(`/team/${temp.id}`, { active: false })).status, 200);
  assert.equal((await c.get('/me')).status, 401);
  assert.equal((await c.post('/auth/login', { login: 'temp', password: 'password123' })).status, 401);
  assert.equal((await admin.patch(`/team/${ids.admin}`, { active: false })).status, 400);
  assert.equal((await admin.patch(`/team/${ids.admin}`, { role: 'member' })).status, 400);
  assert.equal((await lead.post('/tasks', { title: 'x', assigneeId: temp.id })).status, 400, 'отключённому задачу не назначить');
});

test('порядок на доске сохраняется', async () => {
  const mk = async title => (await lead.post('/tasks', { title, projectId: ids.project })).data.task.id;
  const a = await mk('A'); const b = await mk('B'); const c = await mk('C');
  assert.equal((await lead.post(`/tasks/${c}/move`, { status: 'new', beforeId: a })).status, 200);
  assert.equal((await lead.post(`/tasks/${b}/move`, { status: 'review' })).status, 200);
  const list = (await lead.get(`/tasks?project=${ids.project}&status=new`)).data.tasks.map(t => t.id);
  assert.ok(list.indexOf(c) < list.indexOf(a));
  assert.ok(!list.includes(b));
});

test('защита от подделки запросов и плохих данных', async () => {
  assert.equal((await lead.call('POST', '/tasks', '{"title":"x"}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await lead.call('POST', '/tasks', { title: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await lead.call('POST', '/tasks', { title: 'свой' }, { Origin: BASE })).status, 201);
  assert.equal((await lead.call('POST', '/tasks', 'не json')).status, 400);
  assert.equal((await lead.post('/tasks', { title: '' })).status, 400);
  assert.equal((await lead.post('/tasks', { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await lead.post('/tasks', { title: { a: 1 } })).status, 400);
  assert.equal((await lead.post('/tasks', { title: 'x', priority: 'срочно' })).status, 400);
  assert.equal((await lead.post('/tasks', { title: 'x', dueAt: 'когда-нибудь' })).status, 400);
  assert.equal((await lead.post('/tasks', { title: 'x', projectId: 99999 })).status, 400);
  assert.equal((await lead.get('/tasks/abc')).status, 400);
  assert.equal((await lead.patch(`/tasks/${ids.task}`, { status: 'закрыто' })).status, 400);
  const tooBig = await lead.post('/tasks', { title: 'x', description: 'y'.repeat(300 * 1024) }).catch(() => ({ status: 413 }));
  assert.equal(tooBig.status, 413);
});

test('файлы сервера не отдаются и заголовки защиты на месте', async () => {
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/shared/../../index.js', '/shared/..%2findex.js', '/api.js', '/data/tasks.sqlite']) {
    const res = await fetch(BASE + p);
    assert.notEqual(res.status, 200, p);
  }
  const index = await fetch(BASE + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  const css = await fetch(BASE + '/shared/base.css');
  assert.equal(css.status, 200);
  const login = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'anna', password: 'password123' }),
  });
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
});

test('пароль в базе не хранится открытым текстом', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 't.sqlite'), { readOnly: true });
  const rows = db.prepare('SELECT password_hash FROM users').all();
  db.close();
  assert.ok(rows.length > 3);
  for (const r of rows) assert.match(r.password_hash, /^scrypt\$/);
});
