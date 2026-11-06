'use strict';
// Бот на настоящем сервере и подменном Telegram: проверяем, что уходит наружу и что меняется в базе.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18802;
const TG_PORT = 18803;
const TOKEN = '123456:TEST';
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-'));
const dbFile = path.join(dir, 't.sqlite');
const wait = ms => new Promise(r => setTimeout(r, ms));

// В этом поясе сейчас полдень: утренняя сводка всегда уже разрешена.
const shift = 12 - new Date().getUTCHours();
const TZ = shift === 0 ? 'UTC' : `Etc/GMT${shift > 0 ? '-' : '+'}${Math.abs(shift)}`;

// ---------- Подменный Telegram ----------
const tg = { calls: [], updates: [], nextUpdate: 1, msgId: 100, blocked: new Set() };
const tgServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    const method = req.url.split('/').pop();
    assert.ok(req.url.startsWith(`/bot${TOKEN}/`));
    const params = raw ? JSON.parse(raw) : {};
    let result = true;
    const reply = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (method === 'getUpdates') {
      const until = Date.now() + 200;
      while (!tg.updates.length && Date.now() < until) await wait(10);
      result = tg.updates.filter(u => u.update_id >= params.offset);
      tg.updates = [];
      tg.lastOffset = params.offset;
      return reply({ ok: true, result });
    }
    tg.calls.push({ method, params });
    if (method === 'getMe') result = { id: 1, is_bot: true, username: 'puls_test_bot' };
    if (method === 'sendMessage') {
      if (tg.blocked.has(params.chat_id)) return reply({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
      result = { message_id: ++tg.msgId };
    }
    reply({ ok: true, result });
  });
});

const sent = () => tg.calls.filter(c => c.method === 'sendMessage');
const sentTo = chat => sent().filter(c => c.params.chat_id === chat);
const lastTo = chat => sentTo(chat).at(-1)?.params;
const answers = () => tg.calls.filter(c => c.method === 'answerCallbackQuery');
const clear = () => { tg.calls = []; };
async function until(fn, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(20); }
  assert.fail(`не дождались: ${label}`);
}
const person = (id, username) => ({ id, is_bot: false, first_name: 'Тест', username });
function push(update) { tg.updates.push({ update_id: tg.nextUpdate++, ...update }); }
function say(from, text, chat = { id: from.id, type: 'private' }) {
  push({ message: { message_id: 1, from, chat, date: 1, text } });
}
function press(from, data, chat = { id: from.id, type: 'private' }) {
  const id = String(tg.nextUpdate);
  push({ callback_query: { id, from, data, message: { message_id: 55, chat } } });
  return id;
}
const answerOf = async id => (await until(() => answers().find(a => a.params.callback_query_id === id), `ответ на кнопку ${id}`)).params;
const buttons = p => (p.reply_markup?.inline_keyboard || []).flat();

// ---------- Сервер ----------
let proc;
function startServer() {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'cases/01_zadachi/app/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT, DB_FILE: dbFile, ADMIN_LOGIN: 'boss', ADMIN_PASSWORD: 'adminpass1', DEMO: '',
      BOT_TOKEN: TOKEN, TELEGRAM_API: `http://127.0.0.1:${TG_PORT}`, PUBLIC_URL: 'https://pulse.test/', BOT_TICK_MS: '100', APP_TZ: TZ,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return until(() => tg.calls.some(c => c.method === 'setChatMenuButton'), 'запуск бота', 6000);
}
const stopServer = () => new Promise(r => { proc.once('exit', r); proc.kill(); });

class Client {
  constructor() { this.headers = {}; }
  async call(method, url, body) {
    const res = await fetch(BASE + '/api/v1' + url, {
      method, headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...this.headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.headers.Cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  get(u) { return this.call('GET', u); }
  post(u, b) { return this.call('POST', u, b); }
  patch(u, b) { return this.call('PATCH', u, b); }
  put(u, b) { return this.call('PUT', u, b); }
}

const admin = new Client(); const lead = new Client(); const anna = new Client(); const boris = new Client();
const LEAD_TG = person(1001, 'lead_tg'); const ANNA_TG = person(1002, 'Anna_Tg'); const BORIS_TG = person(1003, 'boris_tg');
const STRANGER = person(1999, 'stranger');
const GROUP = { id: -500, type: 'group' };
const ids = {};

async function join(name, role, login, client) {
  const inv = await admin.post('/team/invites', { name, role });
  return (await client.post(`/auth/invite/${inv.data.token}`, { login, password: 'password123' })).data.user.id;
}
async function linkTelegram(client, from) {
  const r = await client.post('/telegram/link');
  assert.equal(r.status, 200);
  const code = new URL(r.data.url).searchParams.get('start');
  assert.match(r.data.url, /^https:\/\/t\.me\/puls_test_bot\?start=/);
  const seen = sentTo(from.id).length;
  say(from, `/start ${code}`);
  await until(() => sentTo(from.id).slice(seen).some(m => m.params.text.includes('Telegram подключён')), 'подключение');
  return code;
}
const db = () => { const d = new DatabaseSync(dbFile); d.exec('PRAGMA busy_timeout = 3000'); return d; };
function sql(q, ...args) { const d = db(); d.prepare(q).run(...args); d.close(); }
function rows(q, ...args) { const d = db(); const r = d.prepare(q).all(...args); d.close(); return r; }
const hours = h => new Date(Date.now() + h * 36e5).toISOString();

before(async () => {
  await new Promise(r => tgServer.listen(TG_PORT, '127.0.0.1', r));
  await startServer();
  assert.equal((await admin.post('/auth/login', { login: 'boss', password: 'adminpass1' })).status, 200);
  ids.lead = await join('Руководитель Пётр', 'lead', 'lead1', lead);
  ids.anna = await join('Анна Смирнова', 'member', 'anna', anna);
  ids.boris = await join('Борис', 'member', 'boris', boris);
  const p = await lead.post('/projects', { name: 'Проект А', memberIds: [ids.anna] });
  ids.project = p.data.project.id;
});

after(async () => { await stopServer(); await new Promise(r => tgServer.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

test('меню и команды настроены, адрес приложения без лишнего слэша', () => {
  const menu = tg.calls.find(c => c.method === 'setChatMenuButton');
  assert.equal(menu.params.menu_button.web_app.url, 'https://pulse.test/');
  assert.ok(tg.calls.some(c => c.method === 'setMyCommands'));
});

test('незнакомец ничего не может', async () => {
  clear();
  say(STRANGER, '/task Украсть задачи');
  await until(() => sentTo(STRANGER.id).some(m => m.params.text.includes('не подключён')), 'отказ');
  say(STRANGER, 'просто текст');
  say(STRANGER, '/my');
  await until(() => sentTo(STRANGER.id).length === 3, 'три отказа');
  const id = press(STRANGER, 's:1:done');
  assert.equal((await answerOf(id)).show_alert, true);
  assert.equal(rows('SELECT COUNT(*) AS n FROM tasks')[0].n, 0);
});

test('код подключения работает один раз и только свежий', async () => {
  const code = await linkTelegram(lead, LEAD_TG);
  clear();
  say(STRANGER, `/start ${code}`);
  await until(() => sentTo(STRANGER.id).some(m => m.params.text.includes('устарела')), 'повторный код отклонён');
  say(STRANGER, '/start поддельный');
  await until(() => sentTo(STRANGER.id).length === 2, 'поддельный код отклонён');
  assert.equal(rows('SELECT COUNT(*) AS n FROM tg_links WHERE tg_id = ?', STRANGER.id)[0].n, 0);

  const old = (await anna.post('/telegram/link')).data.url.split('start=')[1];
  sql('UPDATE tg_codes SET expires_at = ?', hours(-1));
  say(ANNA_TG, `/start ${old}`);
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('устарела')), 'просроченный код');
  await linkTelegram(anna, ANNA_TG);
  await linkTelegram(boris, BORIS_TG);
  assert.equal((await anna.get('/telegram')).data.linked, true);
});

test('задача из чата команды появляется в приложении', async () => {
  clear();
  say(LEAD_TG, '/task@puls_test_bot Подготовить договор @anna_tg завтра 15:00', GROUP);
  const msg = await until(() => lastTo(GROUP.id), 'карточка в группе');
  assert.match(msg.text, /Подготовить договор/);
  assert.match(msg.text, /Анна Смирнова/);
  const task = (await anna.get('/tasks?mine=1')).data.tasks.find(t => t.title === 'Подготовить договор');
  assert.ok(task, 'задача есть в приложении у Анны');
  assert.equal(task.creatorId, ids.lead);
  assert.ok(task.dueAt);
  ids.task = task.id;
  const open = buttons(msg).find(b => b.text === 'Открыть');
  assert.equal(open.url, `https://pulse.test/?task=${task.id}`, 'в группе обычная ссылка');
  assert.equal(open.web_app, undefined);
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('Новая задача от')), 'Анна получила уведомление');
  assert.ok(buttons(lastTo(ANNA_TG.id)).find(b => b.web_app?.url), 'в личке веб-приложение');
  assert.equal(sentTo(LEAD_TG.id).filter(m => m.params.text.includes('Новая задача')).length, 0, 'себе не пишем');
});

test('задача из приложения приходит в Telegram', async () => {
  clear();
  const t = await lead.post('/tasks', { title: 'Из приложения', assigneeId: ids.anna, projectId: ids.project });
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('Из приложения')), 'уведомление');
  ids.webTask = t.data.task.id;
});

test('права в боте те же, что в приложении', async () => {
  clear();
  say(ANNA_TG, '/task Коллеге @boris_tg');
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('только себе')), 'сотрудник не ставит задачи другим');
  say(ANNA_TG, '/task Себе со сроком завтра');
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('Срок назначает руководитель')), 'сотрудник не ставит срок');
  assert.equal(rows("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Коллеге%' OR title LIKE 'Себе%'")[0].n, 0);

  const notOwn = press(BORIS_TG, `s:${ids.task}:review`);
  assert.equal((await answerOf(notOwn)).show_alert, true, 'чужая задача');
  const selfAccept = press(ANNA_TG, `s:${ids.task}:done`);
  assert.match((await answerOf(selfAccept)).text, /принимает руководитель/);
  assert.equal(rows('SELECT status FROM tasks WHERE id = ?', ids.task)[0].status, 'new');
});

test('путь задачи кнопками и уведомления участникам', async () => {
  clear();
  await answerOf(press(ANNA_TG, `s:${ids.task}:progress`));
  await until(() => tg.calls.some(c => c.method === 'editMessageText' && c.params.text.includes('В работе')), 'сообщение обновилось');
  await answerOf(press(ANNA_TG, `s:${ids.task}:review`));
  const ask = await until(() => sentTo(LEAD_TG.id).find(m => m.params.text.includes('просит проверить')), 'руководитель получил запрос');
  assert.deepEqual(buttons(ask.params).filter(b => b.callback_data).map(b => b.text), ['Принять', 'Вернуть']);

  await answerOf(press(LEAD_TG, `s:${ids.task}:progress`));
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('вернул(а) задачу')), 'возврат на доработку');
  await answerOf(press(ANNA_TG, `s:${ids.task}:review`));
  await answerOf(press(LEAD_TG, `s:${ids.task}:done`));
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('принял(а) задачу')), 'приёмка');
  const hist = (await lead.get(`/tasks/${ids.task}`)).data.history.filter(h => h.action === 'status').map(h => h.toValue).reverse();
  assert.deepEqual(hist, ['progress', 'review', 'progress', 'review', 'done']);
});

test('текст боту создаёт задачу только после подтверждения', async () => {
  clear();
  say(LEAD_TG, 'Купить бумагу @anna_tg в пятницу 12:00');
  const ask = await until(() => lastTo(LEAD_TG.id)?.text.includes('Создать задачу?') && lastTo(LEAD_TG.id), 'вопрос');
  assert.match(ask.text, /Анна Смирнова/);
  const yes = buttons(ask).find(b => b.text === 'Создать').callback_data;
  assert.equal(rows("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Купить бумагу'")[0].n, 0, 'до подтверждения пусто');
  const foreign = press(BORIS_TG, yes);
  assert.match((await answerOf(foreign)).text, /устарел/);
  assert.equal(rows("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Купить бумагу'")[0].n, 0, 'чужое нажатие не создаёт');

  say(LEAD_TG, 'Отменяемая');
  const ask2 = await until(() => lastTo(LEAD_TG.id)?.text.includes('Отменяемая') && lastTo(LEAD_TG.id), 'вопрос 2');
  await answerOf(press(LEAD_TG, buttons(ask2).find(b => b.text === 'Отмена').callback_data));
  assert.equal(rows("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Отменяемая'")[0].n, 0);

  say(LEAD_TG, 'Вторая попытка');
  const ask3 = await until(() => lastTo(LEAD_TG.id)?.text.includes('Вторая попытка') && lastTo(LEAD_TG.id), 'вопрос 3');
  const yes3 = buttons(ask3).find(b => b.text === 'Создать').callback_data;
  await answerOf(press(LEAD_TG, yes3));
  assert.equal(rows("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Вторая попытка'")[0].n, 1);
  await answerOf(press(LEAD_TG, yes3));
  assert.equal(rows("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Вторая попытка'")[0].n, 1, 'двойное нажатие не дублирует');
});

test('разметка из текста не ломает сообщение и упоминание должно быть известно', async () => {
  clear();
  say(LEAD_TG, '/task <b>Жирно</b> & <script>');
  const m = await until(() => lastTo(LEAD_TG.id), 'ответ');
  assert.match(m.text, /&lt;b&gt;Жирно&lt;\/b&gt; &amp; &lt;script&gt;/);
  say(LEAD_TG, '/task Кому-то @nobody_here');
  await until(() => sentTo(LEAD_TG.id).some(m => m.params.text.includes('Не знаю, кто такой')), 'неизвестный человек');
  say(LEAD_TG, '/task завтра');
  await until(() => sentTo(LEAD_TG.id).some(m => m.params.text.includes('Не вижу названия')), 'без названия');
});

test('команды другому боту и личный список в группе', async () => {
  clear();
  say(LEAD_TG, '/task@other_bot Чужая', GROUP);
  say(LEAD_TG, '/my', GROUP);
  const m = await until(() => lastTo(GROUP.id), 'ответ в группе');
  assert.match(m.text, /в личном чате/);
  assert.equal(rows("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Чужая'")[0].n, 0);
  assert.equal(sentTo(GROUP.id).length, 1, 'список задач в группу не ушёл');
  say(ANNA_TG, '/my');
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('Мои задачи')), 'список в личке');
});

const REMINDER_TASK = async (title, dueIn, ageHours = 100) => {
  const t = await lead.post('/tasks', { title, assigneeId: ids.anna, projectId: ids.project, dueAt: hours(dueIn) });
  sql('UPDATE tasks SET created_at = ? WHERE id = ?', hours(-ageHours), t.data.task.id);
  return t.data.task.id;
};
const reminders = (title, lead_) => sentTo(ANNA_TG.id).filter(m => m.params.text.includes(title) && m.params.text.includes(lead_));

test('напоминания приходят вовремя и не дублируются', async () => {
  clear();
  await REMINDER_TASK('Срок через сутки', 20);
  await REMINDER_TASK('Срок через 2 часа', 2);
  await REMINDER_TASK('Срок через неделю', 100);
  await until(() => reminders('Срок через сутки', 'меньше суток').length === 1, 'за 24 часа');
  await until(() => reminders('Срок через 2 часа', 'меньше 3 часов').length === 1, 'за 3 часа');
  await wait(600); // несколько проходов
  assert.equal(reminders('Срок через сутки', 'меньше суток').length, 1, 'без повторов');
  assert.equal(reminders('Срок через 2 часа', 'меньше 3 часов').length, 1, 'без повторов');
  assert.equal(reminders('Срок через 2 часа', 'меньше суток').length, 0, 'прошедшее окно не шлём');
  assert.equal(sentTo(ANNA_TG.id).filter(m => m.params.text.includes('Срок через неделю') && !m.params.text.includes('Новая')).length, 0, 'рано');
});

test('срок поставлен в последний момент: без лишнего напоминания', async () => {
  clear();
  const t = await lead.post('/tasks', { title: 'Свежая срочная', assigneeId: ids.anna, dueAt: hours(2) });
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('Свежая срочная')), 'новая задача');
  await wait(400);
  assert.equal(reminders('Свежая срочная', 'меньше 3 часов').length, 0);
  assert.ok(t.data.task.id);
});

test('момент срока и просрочка: ответственному и руководителю', async () => {
  clear();
  await REMINDER_TASK('Срок только что', -0.2);
  await REMINDER_TASK('Давно просрочена', -5);
  await REMINDER_TASK('Очень старая', -100, 200);
  await until(() => reminders('Срок только что', 'Срок наступил').length === 1, 'момент срока');
  await until(() => reminders('Давно просрочена', 'Задача просрочена').length === 1, 'просрочка');
  await until(() => sentTo(LEAD_TG.id).some(m => m.params.text.includes('Давно просрочена') && m.params.text.includes('Задача просрочена')), 'руководитель');
  await wait(400);
  assert.equal(sentTo(LEAD_TG.id).filter(m => m.params.text.includes('Срок только что')).length, 0, 'момент срока только ответственному');
  assert.equal(sentTo(ANNA_TG.id).filter(m => m.params.text.includes('Очень старая') && m.params.text.includes('просрочена')).length, 0, 'старые не рассылаем');
});

test('настройки, готовые задачи и перенос срока', async () => {
  clear();
  await anna.put('/settings', { before3h: false });
  await REMINDER_TASK('Отключённое', 2);
  await wait(400);
  assert.equal(reminders('Отключённое', 'меньше 3 часов').length, 0, 'настройка выключена');
  await anna.put('/settings', { before3h: true });

  const done = await REMINDER_TASK('Уже готова', 2);
  await lead.patch(`/tasks/${done}`, { status: 'done' });
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('Уже готова')), 'уведомление о приёмке');

  const moved = await REMINDER_TASK('Перенесённая', 2);
  await until(() => reminders('Перенесённая', 'меньше 3 часов').length === 1, 'первое напоминание');
  await lead.patch(`/tasks/${moved}`, { dueAt: hours(1) });
  sql("UPDATE task_history SET created_at = ? WHERE task_id = ? AND action = 'due'", hours(-5), moved);
  await until(() => reminders('Перенесённая', 'меньше 3 часов').length === 2, 'новый срок: новое напоминание');
  await wait(300);
  assert.equal(reminders('Перенесённая', 'меньше 3 часов').length, 2);
});

test('комментарий доходит до участников, кроме автора', async () => {
  clear();
  await anna.post(`/tasks/${ids.webTask}/comments`, { body: 'Есть вопрос' });
  await until(() => sentTo(LEAD_TG.id).some(m => m.params.text.includes('Есть вопрос')), 'руководителю');
  await wait(200);
  assert.equal(sentTo(ANNA_TG.id).filter(m => m.params.text.includes('Есть вопрос')).length, 0);
});

test('утренняя сводка один раз в день', async () => {
  const v = new Client();
  const id = await join('Вера', 'member', 'vera', v);
  await lead.post('/tasks', { title: 'Горящая Веры', assigneeId: id, dueAt: hours(-1) });
  clear();
  const VERA = person(1004, 'vera_tg');
  await linkTelegram(v, VERA);
  await until(() => sentTo(VERA.id).some(m => m.params.text.includes('Доброе утро') && m.params.text.includes('Горящая Веры')), 'сводка');
  await wait(400);
  assert.equal(sentTo(VERA.id).filter(m => m.params.text.includes('Доброе утро')).length, 1);
});

function signInitData(user, { authDate = Math.floor(Date.now() / 1000), token = TOKEN } = {}) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AA', user: JSON.stringify(user) });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

test('вход в веб-приложение из Telegram только с настоящей подписью', async () => {
  const c = new Client();
  const ok = await c.post('/auth/telegram', { initData: signInitData({ id: ANNA_TG.id }) });
  assert.equal(ok.status, 200);
  const me = await fetch(BASE + '/api/v1/me', { headers: { Authorization: `Bearer ${ok.data.token}` } });
  assert.equal((await me.json()).user.id, ids.anna);

  assert.equal((await c.post('/auth/telegram', { initData: signInitData({ id: STRANGER.id }) })).status, 404, 'не подключён');
  assert.equal((await c.post('/auth/telegram', { initData: signInitData({ id: ANNA_TG.id }, { token: '999:FAKE' }) })).status, 401, 'чужой токен');
  const stale = signInitData({ id: ANNA_TG.id }, { authDate: Math.floor(Date.now() / 1000) - 2 * 86400 });
  assert.equal((await c.post('/auth/telegram', { initData: stale })).status, 401, 'старые данные');
  const forged = signInitData({ id: STRANGER.id }).replace(encodeURIComponent(STRANGER.id), encodeURIComponent(ANNA_TG.id));
  assert.equal((await c.post('/auth/telegram', { initData: forged })).status, 401, 'подмена пользователя');
  assert.equal((await c.post('/auth/telegram', { initData: '' })).status, 401);
  assert.equal((await c.post('/auth/telegram', {})).status, 401);
  const noHash = new URLSearchParams(signInitData({ id: ANNA_TG.id })); noHash.delete('hash');
  assert.equal((await c.post('/auth/telegram', { initData: noHash.toString() })).status, 401);
});

test('страница разрешает только фрейм Telegram', async () => {
  const res = await fetch(BASE + '/');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors https:\/\/web\.telegram\.org/);
});

test('заблокировавший бота человек снимается с рассылки', async () => {
  const c = new Client();
  await join('Глеб', 'member', 'gleb', c);
  const G = person(1005, 'gleb_tg');
  await linkTelegram(c, G);
  tg.blocked.add(G.id);
  const me = (await c.get('/me')).data.user.id;
  await lead.post('/tasks', { title: 'Глебу', assigneeId: me });
  await until(() => rows('SELECT COUNT(*) AS n FROM tg_links WHERE tg_id = ?', G.id)[0].n === 0, 'привязка снята');
});

test('отключённый участник теряет доступ через бота', async () => {
  const c = new Client();
  const id = await join('Дина', 'member', 'dina', c);
  const D = person(1006, 'dina_tg');
  await linkTelegram(c, D);
  await admin.patch(`/team/${id}`, { active: false });
  clear();
  say(D, '/my');
  await until(() => sentTo(D.id).some(m => m.params.text.includes('не подключён')), 'отказ');
});

test('/stop и отключение из настроек', async () => {
  const c = new Client();
  await join('Егор', 'member', 'egor', c);
  const E = person(1007, 'egor_tg');
  await linkTelegram(c, E);
  say(E, '/stop');
  await until(() => sentTo(E.id).some(m => m.params.text.includes('отключён')), 'stop');
  assert.equal((await c.get('/telegram')).data.linked, false);
  await linkTelegram(c, E);
  assert.equal((await c.call('DELETE', '/telegram/link')).status, 200);
  assert.equal((await c.get('/telegram')).data.linked, false);
});

test('поток команд от одного человека ограничен', async () => {
  const F = person(1008, 'flood');
  clear();
  for (let i = 0; i < 50; i++) say(F, '/help');
  await until(() => sentTo(F.id).length >= 30, 'первые ответы');
  await wait(400);
  assert.equal(sentTo(F.id).length, 30);
});

test('перезапуск сервера: ничего не повторяется и не теряется', async () => {
  await wait(300);
  await stopServer();
  const before = rows('SELECT COUNT(*) AS n FROM reminders_sent')[0].n;
  clear();
  await startServer();
  await wait(700);
  assert.equal(sent().length, 0, `после перезапуска лишних сообщений нет: ${sent().map(s => s.params.text.slice(0, 40)).join(' | ')}`);
  assert.equal(rows('SELECT COUNT(*) AS n FROM reminders_sent')[0].n, before);
  const missed = await lead.post('/tasks', { title: 'После перезапуска', assigneeId: ids.anna });
  assert.equal(missed.status, 200 + 1);
  await until(() => sentTo(ANNA_TG.id).some(m => m.params.text.includes('После перезапуска')), 'бот снова работает');
  say(LEAD_TG, '/my');
  await until(() => sentTo(LEAD_TG.id).length > 0, 'команды снова работают');
});
