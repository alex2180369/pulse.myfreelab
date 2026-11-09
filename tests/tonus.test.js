'use strict';
// «Тонус» настоящими запросами от лица каждой роли, в обход интерфейса.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18842;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tonus-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const dayShift = by => new Date(Date.parse(`${today()}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x20)]);
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
  async upload(url, buf, type) {
    const res = await fetch(BASE + '/api/v1' + url, { method: 'POST', headers: { 'Content-Type': type, ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: buf });
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  raw(url) { return fetch(BASE + '/api/v1' + url, { headers: this.cookie ? { Cookie: this.cookie } : {} }); }
}

const admin = new Client(); const doctor = new Client(); const nutri = new Client(); const trainer = new Client();
const anna = new Client(); const boris = new Client();
const ids = {};
let proc;

async function invite(name, role, login, client) {
  const inv = await admin.post('/people/invites', { name, role });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  const r = await client.post(`/auth/invite/${inv.data.token}`, { login, password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.user.id;
}
const reg = (client, login, extra = {}) => client.post('/auth/register', { name: login, login, password: 'password123', consent: true, ...extra });

before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'cases/04_zdorovie/app/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, DB_FILE: path.join(dir, 't.sqlite'), ADMIN_LOGIN: 'boss', ADMIN_PASSWORD: 'adminpass1', DEMO: '', APP_TZ: 'UTC', REMIND_TICK_MS: '3600000' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await wait(100);
  }
  assert.equal((await admin.post('/auth/login', { login: 'boss', password: 'adminpass1' })).status, 200);
  ids.doctor = await invite('Врач Д', 'doctor', 'doc', doctor);
  ids.nutri = await invite('Нутрициолог Н', 'nutritionist', 'nut', nutri);
  ids.trainer = await invite('Тренер Т', 'trainer', 'trn', trainer);
  const a = await reg(anna, 'anna', { sex: 'f', birthYear: 1990, heightCm: 170 });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  ids.anna = a.data.user.id;
  ids.boris = (await reg(boris, 'boris', { sex: 'm' })).data.user.id;
});

after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('без входа закрыто всё, кроме справочника и бесплатных материалов', async () => {
  const c = new Client();
  for (const u of ['/overview', '/labs', '/metrics/weight', '/requests', '/clients', '/slots', '/meds', '/goals', '/people', '/files/1', '/notifications']) {
    assert.equal((await c.get(u)).status, 401, u);
  }
  assert.equal((await c.get('/meta')).status, 200);
  assert.equal((await c.get('/public/materials')).status, 200);
});

test('регистрация: только с согласием, логин уникален', async () => {
  const c = new Client();
  assert.equal((await c.post('/auth/register', { name: 'x', login: 'xuser', password: 'password123' })).status, 400, 'без согласия');
  assert.equal((await c.post('/auth/register', { name: 'x', login: 'anna', password: 'password123', consent: true })).status, 400, 'занятый логин');
  assert.equal((await c.post('/auth/register', { name: 'x', login: 'yuser', password: 'short', consent: true })).status, 400);
  assert.equal((await anna.get('/profile')).data.profile.heightCm, 170);
  assert.ok((await anna.get('/profile')).data.profile.consentAt, 'время согласия записано');
});

test('дневник: проверка значений, правка, удаление, ИМТ', async () => {
  const bad = [
    { weight: { v1: 0 } }, { weight: { v1: 'abc' } }, { pressure: { v1: 400, v2: 80 } }, { pressure: { v1: 120 } },
    { pressure: { v1: 80, v2: 120 } }, { stress: { v1: 11 } }, { stress: { v1: 3.5 } }, { sleep: { v1: 25 } }, { unknown: { v1: 1 } },
  ];
  for (const values of bad) assert.equal((await anna.put(`/day/${today()}`, { values })).status, 400, JSON.stringify(values));
  assert.equal((await anna.put(`/day/${dayShift(1)}`, { values: { weight: { v1: 70 } } })).status, 400, 'будущее');
  assert.equal((await anna.put(`/day/${dayShift(-400)}`, { values: { weight: { v1: 70 } } })).status, 400, 'больше года назад');
  assert.equal((await anna.put('/day/2026-02-30', { values: { weight: { v1: 70 } } })).status, 400);
  const ok = await anna.put(`/day/${today()}`, { values: { weight: { v1: '72,5' }, pressure: { v1: 120, v2: 80 }, sleep: { v1: 7.5, v2: 4 } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.values.weight, { v1: 72.5, v2: null }, 'запятая принимается');
  await anna.put(`/day/${today()}`, { values: { weight: { v1: 72.25 } } });
  assert.equal((await anna.get(`/day/${today()}`)).data.values.weight.v1, 72.25, 'одна запись в день, правится');
  await anna.put(`/day/${today()}`, { values: { sleep: null } });
  assert.equal((await anna.get(`/day/${today()}`)).data.values.sleep, undefined, 'null удаляет');
  assert.equal((await anna.get('/overview')).data.bmi, 25, 'ИМТ 72,25 / 1,7² = 25,0');
});

test('сравнение периодов считается верно', async () => {
  // Текущие 7 дней: 100 и 110, прошлые 7 дней: 90. Среднее 105, было 90, изменение +15.
  await boris.put(`/day/${dayShift(-1)}`, { values: { pulse: { v1: 100 } } });
  await boris.put(`/day/${dayShift(-6)}`, { values: { pulse: { v1: 110 } } });
  await boris.put(`/day/${dayShift(-8)}`, { values: { pulse: { v1: 90 } } });
  await boris.put(`/day/${dayShift(-20)}`, { values: { pulse: { v1: 50 } } });
  const s = (await boris.get('/metrics/pulse?days=7')).data;
  assert.deepEqual(s.points.map(p => p.v1), [110, 100]);
  assert.equal(s.avg.v1, 105);
  assert.equal(s.prevAvg.v1, 90);
  assert.equal(s.change.v1, 15);
  assert.equal(s.last.v1, 100);
  assert.equal((await boris.get('/metrics/pulse?days=10')).status, 400, 'только 7, 30, 90');
});

test('анализы: подсказки, проверка значений, пол для гемоглобина', async () => {
  assert.equal((await anna.post('/labs', { day: today(), values: {} })).status, 400, 'пустой анализ');
  assert.equal((await anna.post('/labs', { day: today(), values: { glucose: 0.5 } })).status, 400, 'невозможное значение');
  assert.equal((await anna.post('/labs', { day: dayShift(2), values: { glucose: 5 } })).status, 400, 'будущая дата');
  const r = await anna.post('/labs', { day: today(), values: { glucose: '5,6', cholesterol: 6.2, hemoglobin: 119 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const v = Object.fromEntries(r.data.lab.values.map(x => [x.code, x.verdict.level]));
  assert.deepEqual(v, { glucose: 'warn', cholesterol: 'bad', hemoglobin: 'warn' });
  ids.annaLab = r.data.lab.id;
  const b = await boris.post('/labs', { day: today(), values: { hemoglobin: 135 } });
  assert.equal(b.data.lab.values[0].verdict.level, 'ok', 'у мужчины 135 — норма');
  ids.borisLab = b.data.lab.id;
  await boris.patch('/profile', { sex: null });
  assert.equal((await boris.get('/labs')).data.labs[0].values[0].verdict.level, 'unknown', 'без пола подсказки нет');
  await boris.patch('/profile', { sex: 'm' });
});

test('файлы анализа: только PDF, JPG, PNG, проверка содержимого и размера', async () => {
  assert.equal((await anna.upload(`/labs/${ids.annaLab}/files`, Buffer.from('<html>'), 'text/html')).status, 415);
  assert.equal((await anna.upload(`/labs/${ids.annaLab}/files`, Buffer.from('не pdf'), 'application/pdf')).status, 400);
  assert.equal((await anna.upload(`/labs/${ids.annaLab}/files`, Buffer.alloc(6 * 1024 * 1024, 1), 'application/pdf')).status, 413);
  assert.equal((await boris.upload(`/labs/${ids.annaLab}/files`, PDF, 'application/pdf')).status, 404, 'чужой анализ');
  const ok = await anna.upload(`/labs/${ids.annaLab}/files?name=${encodeURIComponent('бланк.pdf')}`, PDF, 'application/pdf');
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  ids.annaPdf = ok.data.file.id;
  ids.annaPng = (await anna.upload(`/labs/${ids.annaLab}/files`, PNG, 'image/png')).data.file.id;
  const res = await anna.raw(`/files/${ids.annaPdf}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment/, 'PDF скачивается, а не открывается');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

test('специалист не видит данные клиента без запроса', async () => {
  for (const c of [doctor, nutri, trainer]) {
    assert.equal((await c.get(`/clients/${ids.anna}`)).status, 404);
    assert.equal((await c.get(`/metrics/weight?client=${ids.anna}`)).status, 404);
    assert.equal((await c.raw(`/files/${ids.annaPdf}`)).status, 404);
    assert.deepEqual((await c.get('/clients')).data.clients, []);
  }
  assert.equal((await boris.raw(`/files/${ids.annaPdf}`)).status, 404, 'чужой клиент');
  assert.equal((await boris.get(`/metrics/weight?client=${ids.anna}`)).status, 404);
});

test('администратор не видит данные о здоровье', async () => {
  for (const u of ['/overview', '/labs', '/metrics/weight', `/clients/${ids.anna}`, '/clients']) {
    assert.ok([403, 404].includes((await admin.get(u)).status), u);
  }
  assert.equal((await admin.raw(`/files/${ids.annaPdf}`)).status, 404);
  const people = (await admin.get('/people')).data.people;
  assert.ok(people.some(p => p.login === 'anna'));
  assert.equal(JSON.stringify(people).includes('72.25'), false);
});

test('запрос врачу: согласие, доступ, ответ, закрытие доступа', async () => {
  assert.equal((await anna.post('/requests', { specialistId: ids.doctor, message: 'Посмотрите' })).status, 400, 'без согласия');
  assert.equal((await anna.post('/requests', { specialistId: ids.trainer, message: 'x', consent: true })).status, 400, 'тренеру запрос не отправляется');
  const r = await anna.post('/requests', { specialistId: ids.doctor, message: 'Посмотрите анализы', consent: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const rid = r.data.request.id;
  assert.equal((await anna.post('/requests', { specialistId: ids.doctor, message: 'Ещё раз', consent: true })).status, 400, 'второй открытый запрос');
  assert.equal((await doctor.get('/notifications')).data.unread, 1);

  const card = await doctor.get(`/clients/${ids.anna}`);
  assert.equal(card.status, 200);
  assert.equal(card.data.labs.length, 1, 'врач видит анализы');
  assert.equal((await doctor.raw(`/files/${ids.annaPdf}`)).status, 200, 'и файлы');
  assert.equal((await nutri.get(`/clients/${ids.anna}`)).status, 404, 'нутрициолог без запроса не видит');
  assert.equal((await boris.get(`/requests/${rid}`)).status, 404, 'чужой запрос');

  assert.equal((await anna.patch(`/requests/${rid}`, { status: 'done', answer: 'сам себе' })).status, 403);
  assert.equal((await doctor.patch(`/requests/${rid}`, { status: 'cancelled' })).status, 403);
  assert.equal((await doctor.patch(`/requests/${rid}`, { status: 'done', answer: '' })).status, 400, 'пустой ответ');
  assert.equal((await doctor.patch(`/requests/${rid}`, { status: 'work' })).data.request.status, 'work');
  const done = await doctor.patch(`/requests/${rid}`, { status: 'done', answer: 'Всё в порядке' });
  assert.equal(done.data.request.status, 'done');
  assert.equal((await doctor.patch(`/requests/${rid}`, { status: 'work' })).status, 400, 'закрытый запрос не меняется');
  const notes = (await anna.get('/notifications')).data.notifications;
  assert.ok(notes.some(n => n.kind === 'answer'), 'клиенту пришёл ответ');

  const second = (await anna.post('/requests', { specialistId: ids.doctor, message: 'Новый вопрос', consent: true })).data.request.id;
  assert.equal((await anna.del(`/access/${ids.doctor}`)).status, 200);
  assert.equal((await doctor.get(`/clients/${ids.anna}`)).status, 404, 'после закрытия доступа не видно');
  assert.equal((await doctor.get(`/metrics/weight?client=${ids.anna}`)).status, 404);
  assert.equal((await doctor.raw(`/files/${ids.annaPdf}`)).status, 404);
  assert.equal((await doctor.get(`/requests/${second}`)).data.request.status, 'cancelled', 'открытый запрос отменён');
  assert.equal((await doctor.get(`/requests/${second}`)).data.request.access, false);
  const mine = (await anna.get('/requests')).data.requests;
  assert.equal(mine.find(x => x.id === rid).answer, 'Всё в порядке', 'ответ остался у клиента');
});

test('тренер: запись, места, видит только активность', async () => {
  assert.equal((await anna.post('/slots', { day: dayShift(1), time: '10:00', minutes: 60, kind: 'Йога', capacity: 1 })).status, 403);
  assert.equal((await trainer.post('/slots', { day: dayShift(-1), time: '10:00', minutes: 60, kind: 'Йога', capacity: 1 })).status, 400, 'прошлое');
  assert.equal((await trainer.post('/slots', { day: dayShift(1), time: '25:00', minutes: 60, kind: 'Йога', capacity: 1 })).status, 400);
  const s = await trainer.post('/slots', { day: dayShift(1), time: '10:00', minutes: 60, kind: 'Йога', capacity: 1 });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  const sid = s.data.slot.id;
  assert.equal((await anna.post(`/slots/${sid}/book`, {})).status, 400, 'без согласия');
  assert.equal((await anna.post(`/slots/${sid}/book`, { consent: true })).status, 200);
  assert.equal((await anna.post(`/slots/${sid}/book`, { consent: true })).status, 400, 'дважды');
  const full = await boris.post(`/slots/${sid}/book`, { consent: true });
  assert.equal(full.status, 400);
  assert.match(full.data.error.message, /мест/);
  const card = await trainer.get(`/clients/${ids.anna}`);
  assert.equal(card.status, 200);
  assert.equal(card.data.labs, null, 'тренер не видит анализы');
  assert.deepEqual(card.data.summaries.map(x => x.metric).sort(), ['activity', 'pulse', 'weight']);
  assert.equal((await trainer.get(`/metrics/pressure?client=${ids.anna}`)).status, 404, 'давление тренеру закрыто');
  assert.equal((await trainer.raw(`/files/${ids.annaPdf}`)).status, 404);
  assert.deepEqual((await trainer.get('/slots')).data.slots[0].clients.map(c => c.id), [ids.anna]);
  assert.equal((await boris.get('/slots')).data.slots[0].clients, undefined, 'клиент не видит, кто ещё записан');
  assert.equal((await anna.del(`/slots/${sid}/book`)).status, 200);
  assert.equal((await boris.post(`/slots/${sid}/book`, { consent: true })).status, 200, 'место освободилось');
  assert.equal((await trainer.del(`/slots/${sid}`)).status, 200);
  assert.ok((await boris.get('/notifications')).data.notifications.some(n => n.kind === 'booking'), 'клиента предупредили об отмене');
});

test('цель: уведомление приходит один раз', async () => {
  await anna.put(`/day/${today()}`, { values: { weight: { v1: 72 } } });
  const g = await anna.put('/goals/weight', { target: 70 });
  assert.equal(g.data.goals[0].direction, 'down');
  const first = await anna.put(`/day/${today()}`, { values: { weight: { v1: 69.8 } } });
  assert.equal(first.data.events.length, 1, JSON.stringify(first.data.events));
  const second = await anna.put(`/day/${today()}`, { values: { weight: { v1: 69.5 } } });
  assert.equal(second.data.events.length, 0);
  const notes = (await anna.get('/notifications')).data.notifications.filter(n => n.kind === 'goal');
  assert.equal(notes.length, 1);
  assert.equal((await anna.put('/goals/sleep', { target: 30 })).status, 400, 'невозможная цель');
});

test('давление выше 140/90 два дня подряд: одно предупреждение в неделю', async () => {
  const c = new Client();
  await reg(c, 'pressure_user');
  const r1 = await c.put(`/day/${dayShift(-2)}`, { values: { pressure: { v1: 150, v2: 95 } } });
  assert.equal(r1.data.events.length, 0, 'один день — не серия');
  const r2 = await c.put(`/day/${dayShift(-1)}`, { values: { pressure: { v1: 145, v2: 85 } } });
  assert.equal(r2.data.events.length, 1);
  const r3 = await c.put(`/day/${today()}`, { values: { pressure: { v1: 160, v2: 100 } } });
  assert.equal(r3.data.events.length, 0, 'повтор в ту же неделю не шлём');
});

test('лекарства: только свои, приём отмечается только во время из расписания', async () => {
  assert.equal((await anna.post('/meds', { name: 'Витамин', times: [] })).status, 400);
  assert.equal((await anna.post('/meds', { name: 'Витамин', times: ['9:00'] })).status, 400);
  assert.equal((await anna.post('/meds', { name: 'Витамин', times: ['09:00'], days: [7] })).status, 400);
  const m = await anna.post('/meds', { name: 'Витамин D', dose: '1 капсула', times: ['21:00', '09:00', '09:00'] });
  assert.equal(m.status, 201);
  assert.deepEqual(m.data.med.times, ['09:00', '21:00'], 'без повторов и по порядку');
  const id = m.data.med.id;
  assert.equal((await boris.post(`/meds/${id}/take`, { time: '09:00' })).status, 404);
  assert.equal((await boris.patch(`/meds/${id}`, { name: 'x' })).status, 404);
  assert.equal((await anna.post(`/meds/${id}/take`, { time: '10:00' })).status, 400);
  const t = await anna.post(`/meds/${id}/take`, { time: '09:00' });
  assert.equal(t.data.doses.find(d => d.time === '09:00').taken, true);
});

test('материалы: публичные без входа, черновики скрыты, меню и уроки ведёт администратор', async () => {
  assert.equal((await doctor.post('/materials', { kind: 'menu', title: 'x', body: 'y' })).status, 403);
  assert.equal((await anna.post('/materials', { title: 'x', body: 'y' })).status, 403);
  assert.equal((await doctor.post('/materials', { title: 'x', body: 'y', videoUrl: 'javascript:alert(1)' })).status, 400);
  const a = await doctor.post('/materials', { title: 'Статья врача', body: 'Текст', section: 'sleep', published: false });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const c = new Client();
  assert.equal((await c.get(`/public/materials/${a.data.material.id}`)).status, 404, 'черновик скрыт');
  assert.equal((await doctor.get(`/public/materials/${a.data.material.id}`)).status, 200, 'автору виден');
  assert.equal((await nutri.patch(`/materials/${a.data.material.id}`, { title: 'чужая' })).status, 403);
  await doctor.patch(`/materials/${a.data.material.id}`, { published: true });
  assert.equal((await c.get(`/public/materials/${a.data.material.id}`)).data.material.title, 'Статья врача');
  const menu = await admin.post('/materials', { kind: 'menu', section: 'food', title: 'Меню', body: 'День 1' });
  assert.equal(menu.status, 201);
  assert.ok((await c.get('/public/materials?kind=menu')).data.materials.some(m => m.title === 'Меню'));
});

test('администратор: приглашения и отключение', async () => {
  assert.equal((await doctor.post('/people/invites', { name: 'x', role: 'doctor' })).status, 403);
  assert.equal((await admin.post('/people/invites', { name: 'x', role: 'client' })).status, 400, 'клиенты регистрируются сами');
  assert.equal((await admin.patch(`/people/${ids.boris}`, { active: false })).status, 200);
  assert.equal((await boris.get('/overview')).status, 401, 'сессия закрыта');
  assert.equal((await admin.patch(`/people/${ids.boris}`, { active: true })).status, 200);
});
