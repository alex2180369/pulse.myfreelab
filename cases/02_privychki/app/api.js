'use strict';
// Логика «Серии». Каждый запрос ограничен данными своего пользователя.
const crypto = require('node:crypto');
const {
  HttpError, forbid, notFound, invalid, tx, now, text, intId, validLogin, validPassword, createUser, hashPassword, verifyPassword, createSession, Limiter,
} = require('../../../core');
const { localParts } = require('../../../core/dateparse');
const { generateKeys, sendPush, allowedEndpoint } = require('../../../core/webpush');
const { streaks, percent, shift } = require('./public/stats.js');

const COLORS = ['ember', 'sea', 'plum', 'moss', 'sky', 'rose'];
const MAX_HABITS = 40;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SANDBOX_DAYS = 7;
const REMIND_WINDOW_MIN = 15;

const validTz = tz => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};
const realDay = day => DAY_RE.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

const dayIn = (tz, date = new Date()) => {
  const p = localParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

function register(app, db, { sandboxMode, pushHost, pushSubject }) {
  const { route, setSession } = app;
  const registerLimit = new Limiter(10, 3600e3);

  const tzOf = userId => db.prepare('SELECT tz FROM user_meta WHERE user_id = ?').get(userId)?.tz || 'UTC';
  const habitOf = (userId, id) => {
    const h = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(intId(id, 'Привычка'), userId);
    if (!h) notFound('Привычка не найдена');
    return h;
  };

  function present(h, today) {
    const days = db.prepare('SELECT day FROM checks WHERE habit_id = ? AND done = 1 ORDER BY day').all(h.id).map(r => r.day);
    const s = streaks(days, today);
    return {
      id: h.id, title: h.title, description: h.description, color: h.color, remindAt: h.remind_at, createdDay: h.created_day,
      days, current: s.current, best: s.best, percent30: percent(days, h.created_day, today, 30),
    };
  }

  const readHabit = b => {
    const out = {};
    if ('title' in b) out.title = text(b.title, 'Название', { min: 1, max: 80 });
    if ('description' in b) out.description = text(b.description, 'Описание', { max: 500 });
    if ('color' in b) { if (!COLORS.includes(b.color)) invalid('Недопустимый цвет'); out.color = b.color; }
    if ('remindAt' in b) {
      if (b.remindAt && !TIME_RE.test(b.remindAt)) invalid('Время напоминания: ЧЧ:ММ');
      out.remindAt = b.remindAt || null;
    }
    return out;
  };

  // ---------- Аккаунт ----------

  const startMeta = (userId, tz, sandbox) => db.prepare('INSERT INTO user_meta (user_id, tz, sandbox) VALUES (?, ?, ?)')
    .run(userId, tz && validTz(tz) ? tz : 'UTC', sandbox ? 1 : 0);

  const presentUser = id => {
    const u = db.prepare('SELECT u.id, u.login, u.name, m.tz, m.sandbox FROM users u JOIN user_meta m ON m.user_id = u.id WHERE u.id = ?').get(id);
    return u && { id: u.id, login: u.login, name: u.name, tz: u.tz, sandbox: !!u.sandbox };
  };

  route('GET', '/api/v1/app/config', () => ({ sandbox: sandboxMode }), { public: true });
  route('GET', '/api/v1/account', ctx => ({ user: presentUser(ctx.user.id) }));

  route('POST', '/api/v1/auth/register', async ctx => {
    if (registerLimit.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Слишком много регистраций. Попробуйте позже.');
    const login = validLogin(ctx.body.login).toLowerCase();
    const password = validPassword(ctx.body.password);
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) invalid('Такой логин уже занят');
    if (sandboxMode && db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 3000) forbid('В демо закончились места, попробуйте позже');
    registerLimit.hit(ctx.ip);
    const id = await createUser(db, { login, name: login, role: 'user', password });
    startMeta(id, ctx.body.tz);
    setSession(ctx, createSession(db, id), 30 * 86400);
    ctx.status = 201;
    return { user: presentUser(id) };
  }, { public: true });

  // Песочница: свой аккаунт с примером, без логина и пароля, удаляется через неделю.
  if (sandboxMode) {
    route('POST', '/api/v1/auth/sandbox', async ctx => {
      if (registerLimit.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Слишком много запросов. Попробуйте позже.');
      if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 3000) forbid('В демо закончились места, попробуйте позже');
      registerLimit.hit(ctx.ip);
      const tz = validTz(ctx.body.tz) ? ctx.body.tz : 'UTC';
      const login = `guest_${crypto.randomBytes(6).toString('hex')}`;
      const id = await createUser(db, { login, name: 'Гость', role: 'user', password: crypto.randomBytes(24).toString('base64') });
      startMeta(id, tz, true);
      seedSandbox(db, id, dayIn(tz));
      setSession(ctx, createSession(db, id), SANDBOX_DAYS * 86400);
      ctx.status = 201;
      return { user: presentUser(id) };
    }, { public: true });
  }

  route('PUT', '/api/v1/account/tz', ctx => {
    if (!validTz(ctx.body.tz)) invalid('Неизвестный часовой пояс');
    db.prepare('UPDATE user_meta SET tz = ? WHERE user_id = ?').run(ctx.body.tz, ctx.user.id);
    return { ok: true };
  });

  route('POST', '/api/v1/account/delete', async ctx => {
    const row = db.prepare('SELECT u.password_hash, m.sandbox FROM users u JOIN user_meta m ON m.user_id = u.id WHERE u.id = ?').get(ctx.user.id);
    if (!row.sandbox) {
      const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
      if (!await verifyPassword(password, row.password_hash)) invalid('Неверный пароль');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(ctx.user.id);
    setSession(ctx, '', 0);
    return { ok: true };
  });

  // ---------- Привычки ----------

  route('GET', '/api/v1/habits', ctx => {
    const today = dayIn(tzOf(ctx.user.id));
    const rows = db.prepare('SELECT * FROM habits WHERE user_id = ? ORDER BY id').all(ctx.user.id);
    return { today, habits: rows.map(h => present(h, today)) };
  });

  route('POST', '/api/v1/habits', ctx => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM habits WHERE user_id = ?').get(ctx.user.id).n;
    if (n >= MAX_HABITS) forbid(`Не больше ${MAX_HABITS} привычек`);
    const h = readHabit(ctx.body);
    if (!h.title) invalid('Заполните поле «Название»');
    const today = dayIn(tzOf(ctx.user.id));
    const r = db.prepare('INSERT INTO habits (user_id, title, description, color, remind_at, created_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.user.id, h.title, h.description || '', h.color || 'ember', h.remindAt ?? null, today, now());
    ctx.status = 201;
    return { habit: present(db.prepare('SELECT * FROM habits WHERE id = ?').get(Number(r.lastInsertRowid)), today) };
  });

  route('PATCH', '/api/v1/habits/:id', ctx => {
    const h = habitOf(ctx.user.id, ctx.params.id);
    const next = readHabit(ctx.body);
    db.prepare('UPDATE habits SET title = ?, description = ?, color = ?, remind_at = ? WHERE id = ?').run(
      next.title ?? h.title, next.description ?? h.description, next.color ?? h.color,
      'remindAt' in next ? next.remindAt : h.remind_at, h.id);
    return { habit: present(db.prepare('SELECT * FROM habits WHERE id = ?').get(h.id), dayIn(tzOf(ctx.user.id))) };
  });

  route('DELETE', '/api/v1/habits/:id', ctx => {
    const h = habitOf(ctx.user.id, ctx.params.id);
    db.prepare('DELETE FROM habits WHERE id = ?').run(h.id);
    return { ok: true };
  });

  // Отметки приходят пачкой: так же работает и обычное нажатие, и досылка после работы без сети.
  // При споре двух устройств побеждает более позднее изменение.
  route('POST', '/api/v1/checks/sync', ctx => {
    const items = ctx.body.items;
    if (!Array.isArray(items) || items.length > 500) invalid('Некорректный список отметок');
    const today = dayIn(tzOf(ctx.user.id));
    const maxDay = shift(today, 1); // часовой пояс устройства мог смениться раньше настройки
    const nowIso = now();
    let applied = 0;
    tx(db, () => {
      const owned = db.prepare('SELECT 1 FROM habits WHERE id = ? AND user_id = ?');
      const current = db.prepare('SELECT changed_at FROM checks WHERE habit_id = ? AND day = ?');
      const upsert = db.prepare(`INSERT INTO checks (habit_id, day, done, changed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(habit_id, day) DO UPDATE SET done = excluded.done, changed_at = excluded.changed_at`);
      for (const it of items) {
        if (!it || !Number.isInteger(it.habitId) || !realDay(it.day)) invalid('Некорректная отметка');
        if (it.day > maxDay) invalid('Нельзя отмечать будущие дни');
        // Привычка могла быть удалена на другом устройстве: такую отметку просто пропускаем.
        if (!owned.get(it.habitId, ctx.user.id)) continue;
        const at = new Date(it.at);
        if (Number.isNaN(at.getTime())) invalid('Некорректное время отметки');
        const stamp = (at.getTime() > Date.now() ? nowIso : at.toISOString());
        const row = current.get(it.habitId, it.day);
        if (row && row.changed_at >= stamp) continue;
        upsert.run(it.habitId, it.day, it.done ? 1 : 0, stamp);
        applied++;
      }
    });
    return { applied };
  });

  // ---------- Push ----------

  function vapid() {
    const row = db.prepare("SELECT value FROM app_state WHERE key = 'vapid'").get();
    if (row) return JSON.parse(row.value);
    const keys = generateKeys();
    db.prepare("INSERT INTO app_state (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    return keys;
  }

  route('GET', '/api/v1/push/key', () => ({ key: vapid().publicKey }));

  route('POST', '/api/v1/push/subscribe', ctx => {
    const { endpoint, keys } = ctx.body;
    if (typeof endpoint !== 'string' || endpoint.length > 1000 || !allowedEndpoint(endpoint, pushHost)) invalid('Неизвестная служба уведомлений');
    if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) invalid('Некорректная подписка');
    db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(endpoint, ctx.user.id, keys.p256dh, keys.auth, now());
    return { ok: true };
  });

  route('POST', '/api/v1/push/unsubscribe', ctx => {
    db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(ctx.body.endpoint || ''), ctx.user.id);
    return { ok: true };
  });

  async function processReminders(date = new Date()) {
    const habits = db.prepare(`
      SELECT h.id, h.title, h.remind_at, h.user_id, m.tz FROM habits h JOIN user_meta m ON m.user_id = h.user_id
      WHERE h.remind_at IS NOT NULL AND EXISTS (SELECT 1 FROM push_subs s WHERE s.user_id = h.user_id)`).all();
    for (const h of habits) {
      const p = localParts(date, h.tz);
      const day = dayIn(h.tz, date);
      const [rh, rm] = h.remind_at.split(':').map(Number);
      const late = (p.h * 60 + p.min) - (rh * 60 + rm);
      // Сервер мог быть выключен: сильно опоздавшее напоминание не шлём.
      if (late < 0 || late > REMIND_WINDOW_MIN) continue;
      if (db.prepare('SELECT 1 FROM checks WHERE habit_id = ? AND day = ? AND done = 1').get(h.id, day)) continue;
      if (db.prepare('INSERT OR IGNORE INTO push_sent (habit_id, day) VALUES (?, ?)').run(h.id, day).changes !== 1) continue;
      for (const sub of db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(h.user_id)) {
        try {
          const code = await sendPush(sub, { title: h.title, body: 'Не забудьте отметить привычку сегодня', habitId: h.id }, vapid(), pushSubject);
          if (code === 404 || code === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
        } catch (e) { console.error('Push:', e.message); }
      }
    }
  }

  function cleanupSandboxes() {
    const edge = new Date(Date.now() - SANDBOX_DAYS * 864e5).toISOString();
    return db.prepare(`DELETE FROM users WHERE created_at < ? AND id IN (SELECT user_id FROM user_meta WHERE sandbox = 1)`).run(edge).changes;
  }

  return { processReminders, cleanupSandboxes };
}

// Пример для песочницы: разные привычки с правдоподобными пропусками, выполнение за сегодня оставлено посетителю.
const SAMPLE = [
  ['Прогулка 30 минут', 'Без телефона в руках', 'moss', '19:00', 34, [11]],
  ['Читать 20 страниц', 'Перед сном', 'plum', '22:00', 40, [5, 6, 17, 23, 24]],
  ['Вода с утра', 'Стакан сразу после подъёма', 'sky', null, 21, [2, 9]],
  ['Без сладкого', '', 'ember', null, 12, [1, 2, 3, 7]],
];

function seedSandbox(db, userId, today) {
  tx(db, () => {
    for (const [title, description, color, remind, age, gaps] of SAMPLE) {
      const r = db.prepare('INSERT INTO habits (user_id, title, description, color, remind_at, created_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(userId, title, description, color, remind, shift(today, -age), now());
      const habitId = Number(r.lastInsertRowid);
      for (let i = 1; i <= age; i++) {
        if (gaps.includes(i)) continue;
        db.prepare('INSERT INTO checks (habit_id, day, done, changed_at) VALUES (?, ?, 1, ?)').run(habitId, shift(today, -i), now());
      }
    }
  });
}

module.exports = { register, COLORS, dayIn, realDay };
