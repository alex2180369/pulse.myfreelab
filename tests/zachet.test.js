'use strict';
// «Зачёт» настоящими запросами от лица репетитора, учеников и родителей, в обход интерфейса.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18852;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zachet-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const dayShift = by => new Date(Date.parse(`${today()}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x20)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const T_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
    return { status: res.status, data: await res.json().catch(() => null) };
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

const tutor = new Client(); const anya = new Client(); const boris = new Client(); const mom = new Client(); const stranger = new Client();
const ids = {};
let proc;

async function invite(name, role, login, client) {
  const inv = await tutor.post('/people/invites', { name, role });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  const r = await client.post(`/auth/invite/${inv.data.token}`, { login, password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.user.id;
}

const QUESTIONS = [
  { kind: 'single', text: '2 + 2', options: ['3', '4'], correct: 1, points: 1, topic: 'Счёт' },
  { kind: 'multi', text: 'Чётные', options: ['1', '2', '4'], correct: [1, 2], points: 2, topic: 'Счёт' },
  { kind: 'short', text: 'Половина', correct: ['0.5', '1/2'], points: 1, topic: 'Дроби' },
  { kind: 'long', text: 'Объясните', points: 3, topic: 'Дроби' },
];

before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'cases/05_repetitor/app/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, DB_FILE: path.join(dir, 'z.sqlite'), ADMIN_LOGIN: 'boss', ADMIN_PASSWORD: 'adminpass1', ADMIN_NAME: 'Ольга', DEMO: '', APP_TZ: 'UTC', REMIND_TICK_MS: '3600000' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await wait(100);
  }
  assert.equal((await tutor.post('/auth/login', { login: 'boss', password: 'adminpass1' })).status, 200);
  ids.anya = await invite('Аня', 'student', 'anya', anya);
  ids.boris = await invite('Борис', 'student', 'boris', boris);
  ids.mom = await invite('Мама Ани', 'parent', 'mom', mom);
  ids.stranger = await invite('Чужой родитель', 'parent', 'stranger', stranger);
  assert.equal((await tutor.post(`/students/${ids.anya}/parents`, { parentId: ids.mom })).status, 200);
});

after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('без входа: открыты главная, справочник, открытые материалы и заявка', async () => {
  const c = new Client();
  for (const u of ['/assignments', '/journal', '/lessons', '/overview', '/stats', '/students', '/leads', '/review', '/notifications']) assert.equal((await c.get(u)).status, 401, u);
  assert.equal((await c.get('/page')).data.page.title, 'Ольга, репетитор');
  assert.deepEqual((await c.get('/materials')).data.materials, []);
  assert.equal((await c.post('/leads', { name: 'Петя', contact: '+7 900' })).status, 400, 'без согласия');
  assert.equal((await c.post('/leads', { name: 'Петя', contact: '+7 900 000-00-00', message: '8 класс', consent: true })).status, 201);
  const leads = (await tutor.get('/leads')).data.leads;
  assert.equal(leads[0].name, 'Петя');
  assert.ok((await tutor.get('/notifications')).data.notifications.some(n => n.kind === 'lead'), 'репетитору пришло уведомление');
  assert.equal((await anya.get('/leads')).status, 403);
});

test('главная: правит только репетитор, изменения сразу видны', async () => {
  assert.equal((await anya.patch('/page', { title: 'Взлом' })).status, 403);
  assert.equal((await tutor.patch('/page', { title: '' })).status, 400, 'заголовок обязателен');
  assert.equal((await tutor.patch('/page', { about: 'Новый текст', prices: '- 1500 ₽' })).status, 200);
  assert.equal((await new Client().get('/page')).data.page.about, 'Новый текст');
  assert.equal((await tutor.upload('/page/photo', Buffer.from('<svg>'), 'image/png')).status, 400);
  const p = await tutor.upload('/page/photo', PNG, 'image/png');
  assert.equal(p.status, 201);
  assert.equal((await new Client().raw(`/files/${p.data.photoId}`)).status, 200, 'обложка видна всем');
});

test('конструктор: проверка вопросов и прав', async () => {
  const base = { title: 'Тест', dueDay: dayShift(3), studentIds: [ids.anya] };
  const bad = [
    { ...base, questions: [] },
    { ...base, questions: [{ kind: 'single', text: 'x', options: ['a', 'b'] }] },
    { ...base, questions: [{ kind: 'single', text: 'x', options: ['a'], correct: 0 }] },
    { ...base, questions: [{ kind: 'multi', text: 'x', options: ['a', 'b'], correct: [5] }] },
    { ...base, questions: [{ kind: 'short', text: 'x', correct: [] }] },
    { ...base, questions: [{ kind: 'essay', text: 'x' }] },
    { ...base, questions: [{ kind: 'long', text: 'x', points: 50 }] },
    { ...base, dueDay: '2026-02-30', questions: QUESTIONS },
    { ...base, questions: QUESTIONS, studentIds: [ids.mom] },
  ];
  for (const b of bad) assert.equal((await tutor.post('/assignments', b)).status, 400, JSON.stringify(b).slice(0, 80));
  for (const c of [anya, mom]) assert.equal((await c.post('/assignments', { ...base, questions: QUESTIONS })).status, 403);
  const r = await tutor.post('/assignments', { ...base, title: 'Дроби', questions: QUESTIONS });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ids.task = r.data.assignment.id;
  ids.q = r.data.assignment.questions.map(q => q.id);
  ids.late = (await tutor.post('/assignments', { ...base, title: 'Просроченное', dueDay: dayShift(-2), questions: QUESTIONS.slice(0, 1), studentIds: [ids.anya, ids.boris] })).data.assignment.id;
});

test('ученик видит только выданное, правильных ответов до сдачи нет', async () => {
  assert.deepEqual((await anya.get('/assignments')).data.assignments.map(a => a.title).sort(), ['Дроби', 'Просроченное']);
  assert.deepEqual((await boris.get('/assignments')).data.assignments.map(a => a.title), ['Просроченное']);
  assert.equal((await boris.get(`/assignments/${ids.task}`)).status, 404, 'чужое задание');
  const mine = await anya.raw(`/assignments/${ids.task}`);
  const raw = await mine.text();
  assert.equal(raw.includes('"correct"'), false, 'в ответе сервера нет правильных ответов');
  assert.equal(raw.includes('1/2'), false);
  assert.equal((await mom.get(`/assignments/${ids.task}`)).data.readOnly, true, 'родитель видит задание ребёнка');
  assert.equal((await stranger.get(`/assignments/${ids.task}`)).status, 404, 'чужой родитель без детей');
  assert.equal((await mom.post(`/assignments/${ids.task}/submit`, { answers: {} })).status, 403, 'родитель не сдаёт');
  assert.equal((await tutor.post(`/assignments/${ids.task}/submit`, { answers: {} })).status, 403);
});

test('черновик, фото решения, сдача и автопроверка', async () => {
  const [single, multi, short, long] = ids.q;
  assert.equal((await anya.put(`/assignments/${ids.task}/answers`, { answers: { [single]: 7 } })).status, 400, 'нет такого варианта');
  const draft = await anya.put(`/assignments/${ids.task}/answers`, { answers: { [single]: 1, [long]: 'Черновик' } });
  assert.equal(draft.data.assignment.status, 'draft');
  assert.equal((await anya.upload(`/assignments/${ids.task}/files?question=${single}`, PNG, 'image/png')).status, 400, 'фото только к развёрнутому');
  assert.equal((await anya.upload(`/assignments/${ids.task}/files?question=${long}`, Buffer.from('nope'), 'image/png')).status, 400);
  assert.equal((await boris.upload(`/assignments/${ids.task}/files?question=${long}`, PNG, 'image/png')).status, 404);
  const photo = await anya.upload(`/assignments/${ids.task}/files?question=${long}`, PNG, 'image/png');
  assert.equal(photo.status, 201);
  ids.photo = photo.data.fileId;
  assert.equal((await boris.raw(`/files/${ids.photo}`)).status, 404, 'фото решения чужим закрыто');
  assert.equal((await stranger.raw(`/files/${ids.photo}`)).status, 404);
  assert.equal((await mom.raw(`/files/${ids.photo}`)).status, 200);

  const sub = await anya.post(`/assignments/${ids.task}/submit`, { answers: { [single]: 1, [multi]: [2], [short]: '  0,50 ', [long]: 'Половина это 1 из 2' } });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  const s = sub.data.assignment.submission;
  assert.equal(s.status, 'submitted', 'развёрнутый ждёт репетитора');
  assert.equal(s.score, 2, 'один ответ 1 + частичный выбор 0 + короткий 1');
  assert.equal(s.results[multi].points, 0, 'за неполный выбор балла нет');
  assert.equal(s.results[short].correct, true, '0,50 = 0.5');
  assert.equal(s.late, false);
  assert.ok(sub.data.assignment.questions.find(q => q.id === short).correct, 'после сдачи ответы открыты');
  assert.equal((await anya.post(`/assignments/${ids.task}/submit`, { answers: {} })).status, 400, 'второй раз не сдать');
  assert.equal((await anya.put(`/assignments/${ids.task}/answers`, { answers: {} })).status, 400, 'после сдачи не менять');
  assert.equal((await anya.upload(`/assignments/${ids.task}/files?question=${long}`, PNG, 'image/png')).status, 400);
  assert.equal((await tutor.patch(`/assignments/${ids.task}`, { questions: QUESTIONS })).status, 400, 'вопросы после сдачи не меняются');
});

test('сдача после срока помечается', async () => {
  const r = await boris.post(`/assignments/${ids.late}/submit`, { answers: {} });
  assert.equal(r.data.assignment.submission.late, true);
  assert.equal(r.data.assignment.submission.status, 'checked', 'без развёрнутых сразу проверено');
  assert.equal((await anya.get('/assignments')).data.assignments.find(a => a.id === ids.late).status, 'overdue');
});

test('проверка репетитором, уведомления, статистика', async () => {
  const queue = (await tutor.get('/review')).data.queue;
  assert.equal(queue.length, 1);
  const sid = queue[0].id;
  const long = ids.q[3];
  assert.equal((await anya.get(`/submissions/${sid}`)).status, 403);
  assert.equal((await tutor.patch(`/submissions/${sid}`, { scores: { [long]: 4 } })).status, 400, 'больше максимума');
  assert.equal((await tutor.patch(`/submissions/${sid}`, { scores: { [ids.q[0]]: 1 } })).status, 400, 'автопроверенный вопрос не трогаем');
  const r = await tutor.patch(`/submissions/${sid}`, { scores: { [long]: 2 }, comment: 'Хорошо' });
  assert.equal(r.data.submission.status, 'checked');
  assert.equal(r.data.submission.score, 4);
  assert.equal(r.data.submission.percent, 57);
  for (const c of [anya, mom]) assert.ok((await c.get('/notifications')).data.notifications.some(n => n.kind === 'checked'), 'ученик и родитель знают об оценке');
  const st = (await mom.get('/stats')).data.stats;
  assert.equal(st.average, 57);
  assert.deepEqual(st.topics.map(t => [t.topic, t.percent]), [['Счёт', 33], ['Дроби', 75]]);
  assert.deepEqual(st.weak.map(t => t.topic), ['Счёт']);
  assert.equal(st.overdue, 1);
  assert.equal((await boris.get(`/stats?student=${ids.anya}`)).data.student.id, ids.boris, 'ученик видит только себя');
  assert.equal((await stranger.get('/stats')).status, 404);
  const j = (await tutor.get('/journal')).data;
  assert.equal(j.cells[`${ids.anya}:${ids.task}`].percent, 57);
  assert.equal(j.cells[`${ids.anya}:${ids.late}`].status, 'overdue');
  assert.equal(j.cells[`${ids.boris}:${ids.task}`], undefined, 'не выдано');
});

test('материалы: доступ всем, ученикам и выбранным', async () => {
  assert.equal((await anya.upload('/materials?title=x', PDF, 'application/pdf')).status, 403);
  assert.equal((await tutor.upload('/materials?title=x', Buffer.from('fake'), 'application/pdf')).status, 400, 'поддельный PDF');
  assert.equal((await tutor.upload('/materials?title=x', PDF, 'text/html')).status, 415);
  const pub = await tutor.upload(`/materials?name=${encodeURIComponent('Формулы.pdf')}&access=public&topic=Алгебра`, PDF, 'application/pdf');
  assert.equal(pub.status, 201, JSON.stringify(pub.data));
  const stud = await tutor.upload('/materials?name=list.docx&access=students', DOCX, T_DOCX);
  const sel = await tutor.upload(`/materials?name=plan.pdf&access=selected&students=${ids.anya}`, PDF, 'application/pdf');
  assert.equal(sel.status, 201);
  assert.equal((await tutor.upload('/materials?name=x.pdf&access=selected', PDF, 'application/pdf')).status, 400, 'не выбраны ученики');
  const guest = new Client();
  const r1 = await guest.raw(`/files/${pub.data.material.fileId}`);
  assert.equal(r1.status, 200, 'открытый без входа по ссылке');
  assert.match(r1.headers.get('content-disposition'), /^inline/, 'PDF открывается в браузере');
  assert.equal((await guest.raw(`/files/${stud.data.material.fileId}`)).status, 404);
  const r2 = await boris.raw(`/files/${stud.data.material.fileId}`);
  assert.equal(r2.status, 200);
  assert.match(r2.headers.get('content-disposition'), /^attachment/, 'Word скачивается');
  assert.match(r2.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await boris.raw(`/files/${sel.data.material.fileId}`)).status, 404, 'выбранным: Борису нет');
  assert.equal((await anya.raw(`/files/${sel.data.material.fileId}`)).status, 200);
  assert.equal((await mom.raw(`/files/${sel.data.material.fileId}`)).status, 200, 'родителю Ани да');
  assert.equal((await stranger.raw(`/files/${sel.data.material.fileId}`)).status, 404);
  assert.deepEqual((await guest.get('/materials')).data.materials.map(m => m.title), ['Формулы']);
  assert.equal((await boris.get('/materials')).data.materials.length, 2);
  assert.equal((await anya.get('/materials')).data.materials.length, 3);
  assert.equal((await tutor.patch(`/materials/${sel.data.material.id}`, { access: 'public' })).status, 200);
  assert.equal((await guest.raw(`/files/${sel.data.material.fileId}`)).status, 200, 'доступ меняется сразу');
});

test('расписание: серия, перенос одного, отметки, видимость', async () => {
  const bad = { studentId: ids.anya, day: dayShift(1), time: '25:00' };
  assert.equal((await tutor.post('/lessons', bad)).status, 400);
  assert.equal((await tutor.post('/lessons', { ...bad, time: '17:00', link: 'javascript:alert(1)' })).status, 400);
  assert.equal((await anya.post('/lessons', { ...bad, time: '17:00' })).status, 403);
  const r = await tutor.post('/lessons', { studentId: ids.anya, day: dayShift(1), time: '17:00', minutes: 60, format: 'online', link: 'https://example.com/call', repeatWeeks: 3 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const [l1, l2, l3, l4] = r.data.lessons;
  assert.equal(r.data.lessons.length, 4);
  assert.deepEqual(r.data.lessons.map(l => l.day), [dayShift(1), dayShift(8), dayShift(15), dayShift(22)]);
  const moved = await tutor.patch(`/lessons/${l2.id}`, { day: dayShift(9), time: '18:00' });
  assert.equal(moved.data.lesson.movedFrom, `${dayShift(8)} 17:00`);
  const all = (await tutor.get(`/lessons?from=${dayShift(0)}&days=30`)).data.lessons;
  assert.deepEqual(all.map(l => `${l.day} ${l.time}`), [`${dayShift(1)} 17:00`, `${dayShift(9)} 18:00`, `${dayShift(15)} 17:00`, `${dayShift(22)} 17:00`], 'остальные не сдвинулись');
  assert.equal((await tutor.patch(`/lessons/${l3.id}`, { status: 'done' })).status, 400, 'будущее не отметить проведённым');
  assert.equal((await tutor.patch(`/lessons/${l3.id}`, { status: 'cancelled' })).data.lesson.status, 'cancelled');
  assert.ok((await mom.get('/notifications')).data.notifications.some(n => n.text.startsWith('Занятие перенесено')), 'родитель знает о переносе');
  assert.equal((await anya.get(`/lessons?from=${dayShift(0)}&days=30`)).data.lessons.length, 4);
  assert.equal((await boris.get(`/lessons?from=${dayShift(0)}&days=30`)).data.lessons.length, 0);
  assert.equal((await mom.get(`/lessons?from=${dayShift(0)}&days=30`)).data.lessons.length, 4);
  assert.equal((await boris.get(`/lessons?from=${dayShift(0)}&days=30&student=${ids.anya}`)).data.lessons.length, 0, 'параметр не открывает чужое');
  assert.equal((await mom.get(`/lessons?from=${dayShift(0)}&days=30&student=${ids.boris}`)).status, 404);
  const past = (await tutor.post('/lessons', { studentId: ids.anya, day: dayShift(-1), time: '10:00' })).data.lessons[0];
  assert.equal((await tutor.patch(`/lessons/${past.id}`, { status: 'missed' })).data.lesson.status, 'missed');
  assert.equal((await tutor.del(`/lessons/${l3.id}?future=1`)).data.removed, 2, 'удалены это и последующие в серии');
  assert.equal((await tutor.get(`/lessons?from=${dayShift(0)}&days=30`)).data.lessons.length, 2);
  assert.ok(l1 && l4);
});

test('родители и приглашения', async () => {
  assert.equal((await anya.post('/people/invites', { name: 'x', role: 'student' })).status, 403);
  assert.equal((await tutor.post('/people/invites', { name: 'x', role: 'tutor' })).status, 400);
  assert.equal((await tutor.post(`/students/${ids.anya}/parents`, { parentId: ids.boris })).status, 400, 'ученик не родитель');
  assert.deepEqual((await mom.get('/children')).data.children.map(c => c.id), [ids.anya]);
  assert.equal((await stranger.get('/overview')).status, 404, 'родитель без детей');
  assert.equal((await tutor.patch(`/people/${ids.boris}`, { active: false })).status, 200);
  assert.equal((await boris.get('/assignments')).status, 401, 'отключённый вышел');
});
