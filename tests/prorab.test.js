'use strict';
// «Прораб» настоящими запросами от лица каждой роли, в обход интерфейса.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18809;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-'));
const dbFile = path.join(dir, 'p.sqlite');
const photosDir = path.join(dir, 'photos');
const wait = ms => new Promise(r => setTimeout(r, ms));

// Пояс, где сейчас 20:00: отчёт на сегодня уже должен быть.
const shift = 20 - new Date().getUTCHours();
const norm = shift > 12 ? shift - 24 : shift < -12 ? shift + 24 : shift;
const TZ = norm === 0 ? 'UTC' : `Etc/GMT${norm > 0 ? '-' : '+'}${Math.abs(norm)}`;
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
const dayShift = by => new Date(Date.parse(`${today()}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body, headers = {}) {
    const res = await fetch(BASE + '/api/v1' + url, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  }
  get(u) { return this.call('GET', u); }
  post(u, b) { return this.call('POST', u, b); }
  patch(u, b) { return this.call('PATCH', u, b); }
  put(u, b) { return this.call('PUT', u, b); }
  del(u) { return this.call('DELETE', u); }
  async upload(url, buf, type = 'image/jpeg', headers = {}) {
    const res = await fetch(BASE + '/api/v1' + url, {
      method: 'POST', headers: { 'Content-Type': type, ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: buf,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  async raw(url) { return fetch(BASE + '/api/v1' + url, { headers: this.cookie ? { Cookie: this.cookie } : {} }); }
}

const director = new Client(); const managerA = new Client(); const managerB = new Client();
const foremanA = new Client(); const foremanB = new Client(); const workerA = new Client(); const workerB = new Client();
const ids = {};
let proc;

async function join(name, role, login, client) {
  const inv = await director.post('/team/invites', { name, role });
  assert.equal(inv.status, 201);
  const r = await client.post(`/auth/invite/${inv.data.token}`, { login, password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.user.id;
}
function sql(q, ...args) { const d = new DatabaseSync(dbFile); d.exec('PRAGMA busy_timeout = 3000'); d.prepare(q).run(...args); d.close(); }
const report = { doneText: 'Штукатурка', workers: 4, problems: [], problemText: '' };

before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'cases/03_stroyka/app/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, DB_FILE: dbFile, PHOTOS_DIR: photosDir, ADMIN_LOGIN: 'boss', ADMIN_PASSWORD: 'adminpass1', DEMO: '', APP_TZ: TZ },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await wait(100);
  }
  assert.equal((await director.post('/auth/login', { login: 'boss', password: 'adminpass1' })).status, 200);
  ids.managerA = await join('Менеджер А', 'manager', 'mgr_a', managerA);
  ids.managerB = await join('Менеджер Б', 'manager', 'mgr_b', managerB);
  ids.foremanA = await join('Прораб А', 'foreman', 'frm_a', foremanA);
  ids.foremanB = await join('Прораб Б', 'foreman', 'frm_b', foremanB);
  ids.workerA = await join('Рабочий А', 'worker', 'wrk_a', workerA);
  ids.workerB = await join('Рабочий Б', 'worker', 'wrk_b', workerB);
  const a = await director.post('/sites', { name: 'Объект А', address: 'Адрес А', managerId: ids.managerA, foremanId: ids.foremanA });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  ids.siteA = a.data.site.id;
  ids.siteB = (await director.post('/sites', { name: 'Объект Б', managerId: ids.managerB, foremanId: ids.foremanB })).data.site.id;
  ids.taskA = (await foremanA.post(`/sites/${ids.siteA}/tasks`, { title: 'Задача рабочего А', assigneeId: ids.workerA, dueDate: dayShift(1) })).data.task.id;
  ids.taskB = (await foremanB.post(`/sites/${ids.siteB}/tasks`, { title: 'Задача рабочего Б', assigneeId: ids.workerB })).data.task.id;
});

after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('без входа закрыто всё, включая фото', async () => {
  const c = new Client();
  for (const u of ['/sites', `/sites/${ids.siteA}`, '/my-tasks', '/team', '/notifications', '/photos/1']) assert.equal((await c.get(u)).status, 401, u);
  assert.equal((await c.upload(`/sites/${ids.siteA}/photos`, JPEG)).status, 401);
});

test('каждый видит только свои объекты', async () => {
  const names = async c => (await c.get('/sites')).data.sites.map(s => s.name);
  assert.deepEqual(await names(director), ['Объект А', 'Объект Б']);
  assert.deepEqual(await names(managerA), ['Объект А']);
  assert.deepEqual(await names(foremanB), ['Объект Б']);
  assert.deepEqual(await names(workerA), []);
  for (const c of [managerB, foremanB, workerA, workerB]) {
    for (const u of [`/sites/${ids.siteA}`, `/sites/${ids.siteA}/reports/${today()}`]) assert.equal((await c.get(u)).status, 404, u);
    assert.equal((await c.patch(`/sites/${ids.siteA}`, { name: 'Взлом' })).status, 404);
    assert.equal((await c.post(`/sites/${ids.siteA}/tasks`, { title: 'x' })).status, 404);
    assert.equal((await c.put(`/sites/${ids.siteA}/reports/${today()}`, report)).status, 404);
  }
});

test('рабочий видит только свои задачи и меняет только статус', async () => {
  const mine = (await workerA.get('/my-tasks')).data.tasks;
  assert.deepEqual(mine.map(t => t.title), ['Задача рабочего А']);
  assert.equal((await workerB.patch(`/tasks/${ids.taskA}`, { status: 'done' })).status, 404, 'чужая задача');
  assert.equal((await workerB.del(`/tasks/${ids.taskA}`)).status, 404);
  assert.equal((await workerA.patch(`/tasks/${ids.taskA}`, { title: 'Переписал' })).status, 403);
  assert.equal((await workerA.patch(`/tasks/${ids.taskA}`, { assigneeId: ids.workerB })).status, 403);
  assert.equal((await workerA.patch(`/tasks/${ids.taskA}`, { status: 'doing', dueDate: dayShift(9) })).status, 403, 'лишнее поле вместе со статусом');
  assert.equal((await workerA.del(`/tasks/${ids.taskA}`)).status, 403);
  assert.equal((await workerA.patch(`/tasks/${ids.taskA}`, { status: 'doing' })).data.task.status, 'doing');
  assert.equal((await workerA.get('/team')).status, 403);
});

test('права на объекты и команду', async () => {
  assert.equal((await foremanA.post('/sites', { name: 'x' })).status, 403);
  assert.equal((await workerA.post('/sites', { name: 'x' })).status, 403);
  assert.equal((await foremanA.patch(`/sites/${ids.siteA}`, { status: 'hold' })).status, 403);
  const own = await managerA.post('/sites', { name: 'Свой', managerId: ids.managerB });
  assert.equal(own.data.site.managerId, ids.managerA, 'менеджер создаёт только на себя');
  assert.equal((await managerA.patch(`/sites/${ids.siteA}`, { managerId: ids.managerB })).status, 403);
  assert.equal((await director.post('/sites', { name: 'x', foremanId: ids.workerA })).status, 400, 'прорабом может быть только прораб');
  assert.equal((await director.post('/sites', { name: 'x', startDate: dayShift(5), endDate: dayShift(1) })).status, 400);
  assert.equal((await director.post('/sites', { name: 'x', startDate: '2026-02-31' })).status, 400);
  for (const c of [managerA, foremanA, workerA]) {
    assert.equal((await c.post('/team/invites', { name: 'x', role: 'director' })).status, 403);
    assert.equal((await c.patch(`/team/${ids.workerA}`, { role: 'director' })).status, 403);
  }
  const team = (await foremanA.get('/team')).data.members;
  assert.equal(team[0].login, undefined, 'логины видит только директор');
  assert.equal((await director.patch('/team/1', { role: 'worker' })).status, 400, 'последний директор');
});

test('отчёт заполняет только прораб объекта и только сегодня', async () => {
  const url = `/sites/${ids.siteA}/reports/${today()}`;
  assert.equal((await director.put(url, report)).status, 403);
  assert.equal((await managerA.put(url, report)).status, 403);
  const bad = await foremanA.put(url, { ...report, workers: -1 });
  assert.equal(bad.status, 400);
  assert.equal((await foremanA.put(url, { ...report, workers: 'много' })).status, 400);
  assert.equal((await foremanA.put(url, { ...report, doneText: '  ' })).status, 400);
  assert.equal((await foremanA.put(url, { ...report, problems: ['пожар'] })).status, 400);
  assert.equal((await foremanA.put(`/sites/${ids.siteA}/reports/${dayShift(1)}`, report)).status, 403, 'будущее');
  assert.equal((await foremanA.put(`/sites/${ids.siteA}/reports/${dayShift(-1)}`, report)).status, 403, 'прошлое');
  const first = await foremanA.put(url, report);
  assert.equal(first.status, 201);
  const second = await foremanA.put(url, { ...report, workers: 7 });
  assert.equal(second.status, 200, 'правка в тот же день');
  assert.equal(second.data.report.workers, 7);
  assert.equal(second.data.report.id, first.data.report.id, 'тот же отчёт, а не второй');
  const seen = await director.get(url);
  assert.equal(seen.data.report.workers, 7);
  assert.equal(seen.data.canEdit, false);
  assert.equal((await foremanA.get(url)).data.canEdit, true);
});

test('вчерашний отчёт закрыт', async () => {
  sql('UPDATE reports SET day = ? WHERE site_id = ?', dayShift(-1), ids.siteA);
  const url = `/sites/${ids.siteA}/reports/${dayShift(-1)}`;
  const old = await foremanA.get(url);
  assert.equal(old.data.canEdit, false);
  assert.equal(old.data.report.locked, true);
  assert.equal((await foremanA.put(url, report)).status, 403);
  assert.equal((await foremanA.upload(`/sites/${ids.siteA}/photos?report=${old.data.report.id}`, JPEG)).status, 403, 'фото к закрытому отчёту');
});

test('сводка показывает объект без отчёта и проблему', async () => {
  const hold = (await director.post('/sites', { name: 'На паузе', status: 'hold', foremanId: ids.foremanA })).data.site;
  const list = async () => (await director.get('/sites')).data.sites;
  const a = (await list()).find(s => s.id === ids.siteA);
  assert.equal(a.reportToday, false);
  assert.equal(a.reportMissing, true, 'в 20:00 отчёт уже ждут');
  assert.equal((await list()).find(s => s.id === hold.id).reportMissing, false, 'приостановленный объект не ждёт');
  await foremanA.put(`/sites/${ids.siteA}/reports/${today()}`, { ...report, problems: ['materials', 'power'], problemText: 'Нет бетона' });
  const after = (await list()).find(s => s.id === ids.siteA);
  assert.equal(after.reportMissing, false);
  assert.deepEqual(after.problemsToday, ['нет материалов', 'нет электричества', 'Нет бетона']);
  const overdue = await foremanA.post(`/sites/${ids.siteA}/tasks`, { title: 'Просроченная', dueDate: dayShift(-2) });
  assert.equal(overdue.data.task.overdue, true);
  assert.equal((await list()).find(s => s.id === ids.siteA).overdueTasks, 1);
  await foremanA.patch(`/tasks/${overdue.data.task.id}`, { status: 'done' });
  assert.equal((await list()).find(s => s.id === ids.siteA).overdueTasks, 0, 'готовая не просрочена');
});

test('уведомления получают нужные люди и не получает автор', async () => {
  await director.post('/notifications/read', {});
  await managerA.post('/notifications/read', {});
  await managerB.post('/notifications/read', {});
  await foremanA.post('/notifications/read', {});
  sql('DELETE FROM reports WHERE site_id = ? AND day = ?', ids.siteA, today());
  await foremanA.put(`/sites/${ids.siteA}/reports/${today()}`, { ...report, problems: ['weather'] });
  const texts = async c => (await c.get('/notifications')).data.notifications.filter(n => !n.read).map(n => n.text);
  for (const c of [director, managerA]) {
    const t = await texts(c);
    assert.ok(t.some(x => x.includes('Отчёт за сегодня')), 'отчёт');
    assert.ok(t.some(x => x.includes('погода')), 'проблема');
  }
  assert.deepEqual(await texts(managerB), [], 'чужой менеджер');
  assert.deepEqual(await texts(foremanA), [], 'автор');
  await foremanA.put(`/sites/${ids.siteA}/reports/${today()}`, { ...report, problems: ['weather'], workers: 9 });
  assert.equal((await texts(managerA)).filter(x => x.includes('погода')).length, 1, 'правка без новой проблемы не шумит');
  await workerB.post('/notifications/read', {});
  await foremanB.post(`/sites/${ids.siteB}/tasks`, { title: 'Новая для Б', assigneeId: ids.workerB });
  assert.ok((await texts(workerB)).some(x => x.includes('Новая для Б')));
  assert.equal((await workerA.get('/notifications')).data.notifications.filter(n => n.text.includes('Новая для Б')).length, 0);
  await managerA.post('/notifications/read', {});
  assert.equal((await managerA.get('/notifications')).data.unread, 0);
});

test('фото: кто может загрузить и посмотреть', async () => {
  const up = await foremanA.upload(`/sites/${ids.siteA}/photos`, JPEG);
  assert.equal(up.status, 201);
  const id = up.data.photo.id;
  assert.equal((await foremanA.raw(`/photos/${id}`)).status, 200);
  assert.equal((await director.raw(`/photos/${id}`)).status, 200);
  assert.equal((await managerA.raw(`/photos/${id}`)).status, 200);
  for (const c of [managerB, foremanB, workerA, workerB]) assert.equal((await c.raw(`/photos/${id}`)).status, 404, 'чужой');
  assert.equal((await new Client().raw(`/photos/${id}`)).status, 401);
  assert.equal((await workerA.upload(`/sites/${ids.siteA}/photos`, JPEG)).status, 404, 'рабочий без своей задачи');
  assert.equal((await foremanB.upload(`/sites/${ids.siteA}/photos`, JPEG)).status, 404);

  const toTask = await workerA.upload(`/sites/${ids.siteA}/photos?task=${ids.taskA}`, PNG, 'image/png');
  assert.equal(toTask.status, 201, 'рабочий к своей задаче');
  assert.equal((await workerA.raw(`/photos/${toTask.data.photo.id}`)).status, 200);
  assert.equal((await workerB.raw(`/photos/${toTask.data.photo.id}`)).status, 404);
  assert.equal((await workerA.upload(`/sites/${ids.siteA}/photos?task=${ids.taskB}`, JPEG)).status, 404, 'к чужой задаче');
  assert.equal((await workerB.upload(`/sites/${ids.siteA}/photos?task=${ids.taskB}`, JPEG)).status, 400, 'задача с другого объекта');
});

test('подделки и большие файлы не проходят', async () => {
  const url = `/sites/${ids.siteA}/photos`;
  assert.equal((await foremanA.upload(url, Buffer.from('<script>alert(1)</script>'))).status, 400, 'текст под видом jpeg');
  assert.equal((await foremanA.upload(url, Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')).status, 415);
  assert.equal((await foremanA.upload(url, Buffer.from('<html>'), 'text/html')).status, 415);
  assert.equal((await foremanA.upload(url, Buffer.alloc(0))).status, 400, 'пустой файл');
  assert.equal((await foremanA.upload(url, Buffer.concat([JPEG, Buffer.alloc(3.5 * 1024 * 1024)]))).status, 413);
  assert.equal((await foremanA.upload(url, JPEG, 'image/jpeg', { Origin: 'https://evil.example' })).status, 403, 'чужой сайт');
  assert.equal((await foremanA.post(url, { any: 1 })).status, 415, 'JSON вместо файла');
  assert.equal((await foremanA.get('/sites')).status, 200, 'сервер жив после отказа');
});

test('файл отдаётся безопасно и удаляется по правилам', async () => {
  const up = await foremanA.upload(`/sites/${ids.siteA}/photos`, JPEG);
  const id = up.data.photo.id;
  const res = await foremanA.raw(`/photos/${id}`);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.match(res.headers.get('cache-control'), /private/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
  const before = fs.readdirSync(photosDir);
  assert.ok(before.every(f => /^[0-9a-f]{32}$/.test(f)), 'случайные имена файлов');
  assert.equal((await managerA.del(`/photos/${id}`)).status, 403, 'менеджер не автор');
  assert.equal((await foremanA.del(`/photos/${id}`)).status, 200);
  assert.equal((await foremanA.raw(`/photos/${id}`)).status, 404);
  assert.equal(fs.readdirSync(photosDir).length, before.length - 1, 'файл удалён с диска');
  assert.equal((await new Client().get('/photos/abc')).status, 401);
  assert.equal((await foremanA.get('/photos/abc')).status, 400);
});

test('контроль качества: дефект, фото, задача один раз', async () => {
  const site = await managerA.get(`/sites/${ids.siteA}`);
  const lists = site.data.qc;
  assert.deepEqual(lists.map(l => l.name), ['Гипсокартон', 'Малярные работы', 'Плитка']);
  const item = lists[0].items[0];
  await foremanA.post('/notifications/read', {});
  assert.equal((await managerB.patch(`/qc/${item.id}`, { state: 'ok' })).status, 404);
  assert.equal((await workerA.patch(`/qc/${item.id}`, { state: 'ok' })).status, 404);
  assert.equal((await managerA.patch(`/qc/${item.id}`, { state: 'плохо' })).status, 400);
  assert.equal((await managerA.post(`/qc/${item.id}/task`, {})).status, 400, 'задача без дефекта');
  assert.equal((await managerA.patch(`/qc/${item.id}`, { state: 'fix', note: 'Волна' })).status, 200);
  assert.ok((await foremanA.get('/notifications')).data.notifications.some(n => !n.read && n.text.includes('Нужно исправить')), 'прораб узнал');
  const photo = await managerA.upload(`/sites/${ids.siteA}/photos?qc=${item.id}`, JPEG);
  assert.equal(photo.status, 201);
  assert.equal((await managerB.upload(`/sites/${ids.siteB}/photos?qc=${item.id}`, JPEG)).status, 400, 'пункт другого объекта');
  const made = await managerA.post(`/qc/${item.id}/task`, { assigneeId: ids.workerA, dueDate: dayShift(2) });
  assert.equal(made.status, 201);
  assert.match(made.data.task.title, /^Исправить:/);
  assert.deepEqual(made.data.task.photos, [photo.data.photo.id], 'фото дефекта перешло к задаче');
  assert.equal((await managerA.post(`/qc/${item.id}/task`, {})).status, 400, 'вторую не создаём');
  assert.equal((await workerA.raw(`/photos/${photo.data.photo.id}`)).status, 200, 'рабочий видит фото дефекта своей задачи');
});

test('приглашения и отключение', async () => {
  const c = new Client();
  const id = await join('Временный', 'worker', 'tmp_w', c);
  const t = await foremanA.post(`/sites/${ids.siteA}/tasks`, { title: 'x', assigneeId: id });
  assert.equal(t.status, 201);
  assert.equal((await director.patch(`/team/${id}`, { active: false })).status, 200);
  assert.equal((await c.get('/my-tasks')).status, 401);
  assert.equal((await foremanA.post(`/sites/${ids.siteA}/tasks`, { title: 'y', assigneeId: id })).status, 400, 'отключённому нельзя');
});

test('файлы сервера и база не отдаются', async () => {
  for (const p of ['/../server.js', '/%2e%2e/api.js', '/seed_photos/crack.jpg', '/data/p.sqlite', '/shared/../../index.js']) {
    assert.notEqual((await fetch(BASE + p)).status, 200, p);
  }
});
