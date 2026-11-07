'use strict';
// «Серия» на настоящем сервере: изоляция данных, отметки, досылка, push с расшифровкой как в браузере.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18806, PUSH_PORT = 18807;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'habits-'));
const dbFile = path.join(dir, 'h.sqlite');
const wait = ms => new Promise(r => setTimeout(r, ms));
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// Пояс, в котором сейчас полдень: напоминания не упираются в полночь.
const shiftH = 12 - new Date().getUTCHours();
const NOON_TZ = shiftH === 0 ? 'UTC' : `Etc/GMT${shiftH > 0 ? '-' : '+'}${Math.abs(shiftH)}`;
const pad = n => String(n).padStart(2, '0');
const localHm = (tz, minutesAgo = 0) => {
  const d = new Date(Date.now() - minutesAgo * 60e3);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${pad(+p.hour)}:${pad(+p.minute)}`;
};
const localDayIn = tz => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date());

// ---------- Подменная служба уведомлений ----------
const push = { received: [], status: {} };
const pushServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    push.received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(push.status[req.url] || 201);
    res.end();
  });
});

function makeBrowserSub(name) {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, pub, auth, sub: { endpoint: `http://127.0.0.1:${PUSH_PORT}/${name}`, keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } } };
}

// Расшифровка так, как её делает браузер (RFC 8291).
function browserDecrypt(browser, body) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const shared = browser.ecdh.computeSecret(asPublic);
  const prk = hkdf(browser.auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), browser.pub, asPublic]), 32);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const data = body.subarray(21 + idlen);
  assert.ok(rs >= data.length, 'запись влезает в размер блока');
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'метка конца записи');
  return JSON.parse(plain.subarray(0, -1).toString());
}

function verifyVapid(header, publicKey, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, 'заголовок VAPID');
  assert.equal(m[2], publicKey);
  const [h, c, s] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400, 'срок подписи не больше суток');
  assert.match(claims.sub, /^(https:|mailto:)/);
  const raw = Buffer.from(publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'подпись верна');
}

// ---------- Сервер и клиент ----------
let proc;
function startServer() {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'cases/02_privychki/app/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, DB_FILE: dbFile, SANDBOX: '1', TRUST_PROXY: '1', PUSH_TEST_HOST: `127.0.0.1:${PUSH_PORT}`, REMIND_TICK_MS: '100', SANDBOX_CLEAN_MS: '150' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
const stopServer = () => new Promise(r => { proc.once('exit', r); proc.kill(); });

let ipCounter = 1;
class Client {
  constructor() { this.cookie = ''; this.ip = `10.0.0.${ipCounter++}`; }
  async call(method, url, body, headers = {}) {
    const res = await fetch(BASE + '/api/v1' + url, {
      method,
      headers: { 'X-Real-IP': this.ip, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  get(u) { return this.call('GET', u); }
  post(u, b) { return this.call('POST', u, b); }
  patch(u, b) { return this.call('PATCH', u, b); }
  del(u) { return this.call('DELETE', u); }
  put(u, b) { return this.call('PUT', u, b); }
}

async function newUser(login, tz = 'UTC') {
  const c = new Client();
  const r = await c.post('/auth/register', { login, password: 'password123', tz });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  c.id = r.data.user.id;
  return c;
}
const newHabit = async (c, title = 'Привычка', extra = {}) => {
  const r = await c.post('/habits', { title, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.habit;
};
const habits = async c => (await c.get('/habits')).data;
const checkOf = async (c, id) => (await habits(c)).habits.find(h => h.id === id);
function sql(q, ...args) { const d = new DatabaseSync(dbFile); d.exec('PRAGMA busy_timeout = 3000'); d.prepare(q).run(...args); d.close(); }
function rows(q, ...args) { const d = new DatabaseSync(dbFile); d.exec('PRAGMA busy_timeout = 3000'); const r = d.prepare(q).all(...args); d.close(); return r; }
async function until(fn, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(20); }
  assert.fail(`не дождались: ${label}`);
}

before(async () => {
  await new Promise(r => pushServer.listen(PUSH_PORT, '127.0.0.1', r));
  startServer();
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await wait(100);
  }
});
after(async () => { await stopServer(); await new Promise(r => pushServer.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

test('без входа данные недоступны', async () => {
  const c = new Client();
  for (const u of ['/habits', '/account', '/push/key']) assert.equal((await c.get(u)).status, 401, u);
  assert.equal((await c.post('/checks/sync', { items: [] })).status, 401);
  assert.equal((await c.post('/habits', { title: 'x' })).status, 401);
});

test('регистрация и вход', async () => {
  const c = new Client();
  assert.equal((await c.post('/auth/register', { login: 'ab', password: 'password123' })).status, 400, 'короткий логин');
  assert.equal((await c.post('/auth/register', { login: 'анна', password: 'password123' })).status, 400, 'кириллица в логине');
  assert.equal((await c.post('/auth/register', { login: 'valid1', password: 'short' })).status, 400, 'слабый пароль');
  await newUser('reg_user');
  assert.equal((await new Client().post('/auth/register', { login: 'REG_user', password: 'password123' })).status, 400, 'логин занят без учёта регистра');
  const again = new Client();
  assert.equal((await again.post('/auth/login', { login: 'reg_user', password: 'password123' })).status, 200);
  assert.equal((await again.get('/account')).data.user.login, 'reg_user');
});

test('регистрации с одного адреса ограничены', async () => {
  const ip = '10.9.9.9';
  let last;
  for (let i = 0; i < 12; i++) {
    const c = new Client(); c.ip = ip;
    last = await c.post('/auth/register', { login: `flood${i}`, password: 'password123' });
  }
  assert.equal(last.status, 429);
});

test('чужие привычки недоступны, в том числе напрямую', async () => {
  const a = await newUser('iso_a'); const b = await newUser('iso_b');
  const h = await newHabit(a, 'Секретная привычка');
  assert.equal((await habits(b)).habits.length, 0);
  assert.equal((await b.patch(`/habits/${h.id}`, { title: 'Взлом' })).status, 404);
  assert.equal((await b.del(`/habits/${h.id}`)).status, 404);
  const today = (await habits(b)).today;
  const r = await b.post('/checks/sync', { items: [{ habitId: h.id, day: today, done: true, at: new Date().toISOString() }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.applied, 0, 'отметка в чужой привычке не применяется');
  assert.deepEqual((await checkOf(a, h.id)).days, []);
  assert.equal((await checkOf(a, h.id)).title, 'Секретная привычка');
});

test('отметки и подсчёт на сервере', async () => {
  const c = await newUser('marks');
  const h = await newHabit(c);
  const { today } = await habits(c);
  const y = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10);
  const r = await c.post('/checks/sync', { items: [
    { habitId: h.id, day: today, done: true, at: new Date().toISOString() },
    { habitId: h.id, day: y, done: true, at: new Date().toISOString() },
  ] });
  assert.equal(r.data.applied, 2);
  const after = await checkOf(c, h.id);
  assert.equal(after.current, 2);
  assert.equal(after.best, 2);
  assert.equal(after.percent30, 100);
  await c.post('/checks/sync', { items: [{ habitId: h.id, day: today, done: false, at: new Date().toISOString() }] });
  const off = await checkOf(c, h.id);
  assert.equal(off.current, 1, 'снятая отметка: вчерашняя серия жива');
  assert.deepEqual(off.days, [y]);
});

test('день считается по часовому поясу пользователя', async () => {
  const east = await newUser('tz_east', 'Pacific/Kiritimati'); // UTC+14
  const west = await newUser('tz_west', 'Pacific/Pago_Pago'); // UTC-11
  const a = (await habits(east)).today; const b = (await habits(west)).today;
  assert.equal(a, localDayIn('Pacific/Kiritimati'));
  assert.equal(b, localDayIn('Pacific/Pago_Pago'));
  assert.notEqual(a, b, 'в один момент разные дни');
  const habit = await newHabit(west);
  const far = new Date(Date.parse(b) + 3 * 864e5).toISOString().slice(0, 10);
  assert.equal((await west.post('/checks/sync', { items: [{ habitId: habit.id, day: far, done: true, at: new Date().toISOString() }] })).status, 400, 'будущее нельзя');
  assert.equal((await west.put('/account/tz', { tz: 'Mars/Base' })).status, 400);
  assert.equal((await west.put('/account/tz', { tz: 'Europe/Moscow' })).status, 200);
  assert.equal((await habits(west)).today, localDayIn('Europe/Moscow'));
});

test('при споре двух устройств побеждает более позднее изменение', async () => {
  const c = await newUser('lww');
  const h = await newHabit(c);
  const { today } = await habits(c);
  const t = s => new Date(Date.now() - s * 1000).toISOString();
  await c.post('/checks/sync', { items: [{ habitId: h.id, day: today, done: true, at: t(100) }] });
  const old = await c.post('/checks/sync', { items: [{ habitId: h.id, day: today, done: false, at: t(200) }] });
  assert.equal(old.data.applied, 0, 'телефон без сети прислал более старое');
  assert.deepEqual((await checkOf(c, h.id)).days, [today]);
  await c.post('/checks/sync', { items: [{ habitId: h.id, day: today, done: false, at: t(50) }] });
  assert.deepEqual((await checkOf(c, h.id)).days, []);
  const future = await c.post('/checks/sync', { items: [{ habitId: h.id, day: today, done: true, at: '2099-01-01T00:00:00Z' }] });
  assert.equal(future.data.applied, 1);
  await wait(10);
  const fix = await c.post('/checks/sync', { items: [{ habitId: h.id, day: today, done: false, at: new Date().toISOString() }] });
  assert.equal(fix.data.applied, 1, 'время из будущего не блокирует правки навсегда');
});

test('удалённая на другом устройстве привычка не ломает досылку', async () => {
  const c = await newUser('deleted');
  const h = await newHabit(c); const keep = await newHabit(c, 'Оставшаяся');
  const { today } = await habits(c);
  await c.del(`/habits/${h.id}`);
  const r = await c.post('/checks/sync', { items: [
    { habitId: h.id, day: today, done: true, at: new Date().toISOString() },
    { habitId: keep.id, day: today, done: true, at: new Date().toISOString() },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.data.applied, 1);
});

test('плохие данные отклоняются', async () => {
  const c = await newUser('bad');
  const h = await newHabit(c);
  const at = new Date().toISOString();
  for (const item of [
    { habitId: h.id, day: '2026-02-31', done: true, at }, { habitId: h.id, day: '2026-13-01', done: true, at }, { habitId: h.id, day: 'вчера', done: true, at },
    { habitId: String(h.id), day: '2026-01-01', done: true, at }, { habitId: h.id, day: '2026-01-01', done: true, at: 'не время' }, null,
  ]) assert.equal((await c.post('/checks/sync', { items: [item] })).status, 400, JSON.stringify(item));
  assert.equal((await c.post('/checks/sync', { items: 'x' })).status, 400);
  assert.equal((await c.post('/checks/sync', { items: new Array(501).fill(null) })).status, 400);
  assert.equal((await c.post('/habits', { title: '' })).status, 400);
  assert.equal((await c.post('/habits', { title: 'x'.repeat(81) })).status, 400);
  assert.equal((await c.post('/habits', { title: 'x', color: 'red;}' })).status, 400);
  assert.equal((await c.post('/habits', { title: 'x', remindAt: '25:00' })).status, 400);
  assert.equal((await c.patch(`/habits/${h.id}`, { title: '  ' })).status, 400);
  assert.equal((await c.call('POST', '/habits', { title: 'x' }, { Origin: 'https://evil.example' })).status, 403);
});

test('изменение, напоминание снимается, предел привычек', async () => {
  const c = await newUser('edit');
  const h = await newHabit(c, 'Старое', { remindAt: '09:30', color: 'sea' });
  const r = await c.patch(`/habits/${h.id}`, { title: 'Новое', remindAt: null });
  assert.equal(r.data.habit.title, 'Новое');
  assert.equal(r.data.habit.remindAt, null);
  assert.equal(r.data.habit.color, 'sea', 'незатронутое поле на месте');
  for (let i = 0; i < 39; i++) await newHabit(c, `Ещё ${i}`);
  assert.equal((await c.post('/habits', { title: 'Лишняя' })).status, 403);
});

test('песочница: личная, с примером, сегодня не отмечено', async () => {
  const a = new Client(); const b = new Client();
  const ra = await a.post('/auth/sandbox', { tz: 'Europe/Moscow' });
  assert.equal(ra.status, 201);
  assert.equal(ra.data.user.sandbox, true);
  await b.post('/auth/sandbox', { tz: 'UTC' });
  const { habits: list, today } = await habits(a);
  assert.equal(list.length, 4);
  assert.ok(list.every(h => !h.days.includes(today)));
  assert.ok(list.some(h => h.current > 3), 'серия уже идёт');
  await a.patch(`/habits/${list[0].id}`, { title: 'Моя' });
  assert.ok(!(await habits(b)).habits.some(h => h.title === 'Моя'), 'песочницы разделены');
  assert.equal((await a.post('/account/delete', {})).status, 200, 'пароль песочнице не нужен');
  assert.equal((await a.get('/habits')).status, 401);
});

test('песочница удаляется через 7 дней, обычный аккаунт нет', async () => {
  const s = new Client();
  const id = (await s.post('/auth/sandbox', { tz: 'UTC' })).data.user.id;
  const reg = await newUser('stays');
  const old = new Date(Date.now() - 8 * 864e5).toISOString();
  sql('UPDATE users SET created_at = ? WHERE id IN (?, ?)', old, id, reg.id);
  await until(async () => (await s.get('/habits')).status === 401, 'удаление песочницы');
  assert.equal(rows('SELECT COUNT(*) AS n FROM habits WHERE user_id = ?', id)[0].n, 0);
  assert.equal((await reg.get('/habits')).status, 200);
});

test('удаление аккаунта требует пароль и стирает всё', async () => {
  const c = await newUser('todelete');
  const h = await newHabit(c);
  assert.equal((await c.post('/account/delete', { password: 'неверный' })).status, 400);
  assert.equal((await c.post('/account/delete', { password: 'password123' })).status, 200);
  assert.equal(rows('SELECT COUNT(*) AS n FROM habits WHERE id = ?', h.id)[0].n, 0);
  assert.equal(rows('SELECT COUNT(*) AS n FROM user_meta WHERE user_id = ?', c.id)[0].n, 0);
  assert.equal((await new Client().post('/auth/login', { login: 'todelete', password: 'password123' })).status, 401);
});

test('подписка только на известные службы', async () => {
  const c = await newUser('subs');
  const keys = { p256dh: 'x', auth: 'y' };
  for (const endpoint of ['http://169.254.169.254/latest', 'https://evil.example/push', 'http://localhost:8801/x', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x', 'не адрес', 5]) {
    assert.equal((await c.post('/push/subscribe', { endpoint, keys })).status, 400, String(endpoint));
  }
  assert.equal((await c.post('/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys })).status, 200);
  assert.equal((await c.post('/push/subscribe', { endpoint: 'https://web.push.apple.com/abc', keys })).status, 200);
  sql('DELETE FROM push_subs WHERE user_id = ?', c.id);
});

test('напоминание расшифровывается как в браузере, подпись верна', async () => {
  const c = await newUser('push_ok', NOON_TZ);
  const browser = makeBrowserSub('ok');
  assert.equal((await c.post('/push/subscribe', browser.sub)).status, 200);
  const { key } = (await c.get('/push/key')).data;
  const before = push.received.length;
  await newHabit(c, 'Прогулка <b>', { remindAt: localHm(NOON_TZ, 1) });
  const msg = await until(() => push.received.slice(before).find(m => m.url === '/ok'), 'уведомление');
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  assert.ok(Number(msg.headers.ttl) > 0);
  verifyVapid(msg.headers.authorization, key, browser.sub.endpoint);
  const payload = browserDecrypt(browser, msg.body);
  assert.equal(payload.title, 'Прогулка <b>');
  assert.ok(payload.habitId);
  assert.throws(() => browserDecrypt(makeBrowserSub('stranger'), msg.body), 'чужой браузер не расшифрует');
  await wait(400);
  assert.equal(push.received.slice(before).filter(m => m.url === '/ok').length, 1, 'одно в день');
});

test('отмеченная привычка не напоминает, чужое и будущее время тоже', async () => {
  const c = await newUser('push_quiet', NOON_TZ);
  const browser = makeBrowserSub('quiet');
  await c.post('/push/subscribe', browser.sub);
  const before = push.received.length;
  const done = await newHabit(c, 'Уже сделано', { remindAt: localHm(NOON_TZ, -2) });
  await c.post('/checks/sync', { items: [{ habitId: done.id, day: localDayIn(NOON_TZ), done: true, at: new Date().toISOString() }] });
  await newHabit(c, 'Позже', { remindAt: '18:30' });
  await newHabit(c, 'Сильно раньше', { remindAt: localHm(NOON_TZ, 60) });
  sql('UPDATE habits SET remind_at = ? WHERE id = ?', localHm(NOON_TZ, 1), done.id);
  await wait(500);
  assert.equal(push.received.slice(before).filter(m => m.url === '/quiet').length, 0);
});

test('умершая подписка удаляется, другие устройства получают', async () => {
  const c = await newUser('push_dead', NOON_TZ);
  const dead = makeBrowserSub('dead'); const live = makeBrowserSub('live');
  await c.post('/push/subscribe', dead.sub);
  await c.post('/push/subscribe', live.sub);
  push.status['/dead'] = 410;
  const before = push.received.length;
  await newHabit(c, 'Два устройства', { remindAt: localHm(NOON_TZ, 1) });
  await until(() => push.received.slice(before).some(m => m.url === '/live'), 'живое устройство');
  await until(() => rows('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?', dead.sub.endpoint)[0].n === 0, 'мёртвая удалена');
  assert.equal(rows('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?', live.sub.endpoint)[0].n, 1);
});

test('отписаться может только владелец', async () => {
  const a = await newUser('sub_a'); const b = await newUser('sub_b');
  const s = makeBrowserSub('own');
  await a.post('/push/subscribe', s.sub);
  await b.post('/push/unsubscribe', { endpoint: s.sub.endpoint });
  assert.equal(rows('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?', s.sub.endpoint)[0].n, 1);
  await a.post('/push/unsubscribe', { endpoint: s.sub.endpoint });
  assert.equal(rows('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?', s.sub.endpoint)[0].n, 0);
});

test('устройство переходит к новому пользователю: чужие напоминания не приходят', async () => {
  const a = await newUser('dev_a', NOON_TZ); const b = await newUser('dev_b', NOON_TZ);
  const s = makeBrowserSub('shared');
  await a.post('/push/subscribe', s.sub);
  await b.post('/push/subscribe', s.sub);
  assert.equal(rows('SELECT user_id FROM push_subs WHERE endpoint = ?', s.sub.endpoint)[0].user_id, b.id);
});

test('файлы приложения для установки', async () => {
  const manifest = await (await fetch(BASE + '/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  const sizes = manifest.icons.map(i => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  for (const icon of manifest.icons) {
    const res = await fetch(BASE + icon.src);
    assert.equal(res.status, 200, icon.src);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`, icon.sizes, 'размер файла совпадает');
  }
  const sw = await fetch(BASE + '/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(sw.headers.get('cache-control'), /no-cache/, 'обновления воркера не застревают');
  const text = await sw.text();
  for (const f of [...text.matchAll(/'(\/[^']*)'/g)].map(m => m[1]).filter(f => !f.includes('#'))) {
    if (f.startsWith('/api/')) continue;
    assert.equal((await fetch(BASE + f)).status, 200, f);
  }
  for (const p of ['/../server.js', '/%2e%2e/api.js', '/data/habits.sqlite']) assert.notEqual((await fetch(BASE + p)).status, 200, p);
});

test('перезапуск: ключи подписи те же, напоминания не повторяются', async () => {
  const c = await newUser('restart', NOON_TZ);
  const key = (await c.get('/push/key')).data.key;
  const s = makeBrowserSub('restart');
  await c.post('/push/subscribe', s.sub);
  const before = push.received.length;
  await newHabit(c, 'Одна', { remindAt: localHm(NOON_TZ, 1) });
  await until(() => push.received.slice(before).some(m => m.url === '/restart'), 'первое');
  await stopServer();
  startServer();
  await until(async () => { try { return (await fetch(BASE + '/health')).ok; } catch { return false; } }, 'запуск');
  assert.equal((await c.get('/push/key')).data.key, key);
  await wait(400);
  assert.equal(push.received.slice(before).filter(m => m.url === '/restart').length, 1);
});
