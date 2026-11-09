'use strict';
// Логика «Тонуса». Данные о здоровье видит только сам клиент и специалист, которому клиент открыл доступ.
// Каждый запрос проверяет это на сервере, интерфейс только скрывает лишнее.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  forbid, notFound, invalid, tx, now, text, oneOf, intId, createInvite, createSession, hashPassword,
  validLogin, validPassword, Limiter, HttpError,
} = require('../../../core');
const { localParts } = require('../../../core/dateparse');
const { generateKeys, sendPush, allowedEndpoint } = require('../../../core/webpush');
const R = require('./rules');

const ROLES = ['client', 'doctor', 'nutritionist', 'trainer', 'admin'];
const SPECIALISTS = ['doctor', 'nutritionist', 'trainer'];
const REQUEST_KIND = { doctor: 'labs', nutritionist: 'menu' };
const OPEN = ['new', 'work'];
const MATERIAL_KINDS = ['menu', 'lesson', 'article'];
const SECTIONS = ['food', 'training', 'sleep', 'general'];
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_FILE = 5 * 1024 * 1024;
const FILES_PER_LAB = 5;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_DAYS = 365;
const REMIND_WINDOW_MIN = 60;
const PERIODS = [7, 30, 90];

const realDate = v => typeof v === 'string' && DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const shiftDay = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);
const weekday = day => new Date(`${day}T00:00:00Z`).getUTCDay();
const minutesOf = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const round = (v, digits = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const json = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

const isFile = (buf, type) => {
  if (type === 'application/pdf') return buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (type === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'image/png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return false;
};

function num(v, name, [min, max], { int = false } = {}) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) invalid(`${name}: нужно число`);
  if (int && !Number.isInteger(n)) invalid(`${name}: нужно целое число`);
  if (n < min || n > max) invalid(`${name}: допустимо от ${min} до ${max}`);
  return n;
}

function register(app, db, { demo, tz, filesDir, seedDir, pushHost, pushSubject }) {
  const { route } = app;
  const registerLimit = new Limiter(5, 60 * 60e3);

  const today = () => {
    const p = localParts(new Date(), tz);
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  };
  const nowMinutes = () => { const p = localParts(new Date(), tz); return p.h * 60 + p.min; };

  const pastOrToday = (v, name) => {
    if (!realDate(v)) invalid(`Недопустимая дата в поле «${name}»`);
    if (v > today()) invalid('Дата не может быть в будущем');
    if (v < shiftDay(today(), -HISTORY_DAYS)) invalid('Дата слишком давняя: не раньше чем год назад');
    return v;
  };

  const demoLimit = (sql, max, message) => {
    if (demo && db.prepare(sql).get().n >= max) forbid(`${message}. В демо есть предел, данные обновятся ночью`);
  };

  // ---------- Люди и права ----------

  const userRow = id => db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(id);
  const profileOf = uid => db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(uid) || { user_id: uid };
  const ensureProfile = uid => db.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').run(uid);
  const ageOf = p => (p.birth_year ? Number(today().slice(0, 4)) - p.birth_year : null);

  const onlyClient = u => { if (u.role !== 'client') forbid('Этот раздел для клиентов'); };
  const onlyAdmin = u => { if (u.role !== 'admin') forbid('Этот раздел для администратора'); };
  const hasAccess = (specialistId, clientId) => !!db.prepare('SELECT 1 FROM access WHERE client_id = ? AND specialist_id = ?').get(clientId, specialistId);

  // Специалист без доступа и все остальные видят «не найдено»: номера клиентов не перебрать.
  const clientFor = (u, id) => {
    if (!SPECIALISTS.includes(u.role)) notFound('Клиент не найден');
    const c = userRow(intId(id, 'Клиент'));
    if (!c || c.role !== 'client' || !hasAccess(u.id, c.id)) notFound('Клиент не найден');
    return c;
  };

  // ---------- Уведомления и push ----------

  function vapid() {
    const row = db.prepare("SELECT value FROM app_state WHERE key = 'vapid'").get();
    if (row) return JSON.parse(row.value);
    const keys = generateKeys();
    db.prepare("INSERT INTO app_state (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    return keys;
  }

  async function pushTo(userId, body, link) {
    for (const sub of db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId)) {
      try {
        const code = await sendPush(sub, { title: 'Тонус', body, link }, vapid(), pushSubject);
        if (code === 404 || code === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
      } catch (e) { console.error('Push:', e.message); }
    }
  }

  // В демо один клиент на всех посетителей, поэтому в push уходит только заранее заданный текст:
  // чужой текст на телефон посетителя не попадёт.
  const pending = [];
  function notify(userIds, kind, message, link, { actorId, push } = {}) {
    const add = db.prepare('INSERT INTO notifications (user_id, kind, text, link, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const id of new Set(userIds.filter(x => x && x !== actorId))) {
      add.run(id, kind, message, link, now());
      if (push) pending.push(pushTo(id, demo ? push : message, link));
    }
  }
  const flushPush = async () => { const list = pending.splice(0); await Promise.all(list); };

  // ---------- Справочник для интерфейса ----------

  route('GET', '/api/v1/meta', () => ({
    demo, today: today(), metrics: R.METRICS, goals: R.GOAL_METRICS, disclaimer: R.DISCLAIMER, periods: PERIODS,
    labs: Object.fromEntries(R.LAB_KEYS.map(k => [k, { name: R.LAB_TESTS[k].name, unit: R.LAB_TESTS[k].unit, valid: R.LAB_TESTS[k].valid, step: R.LAB_TESTS[k].step }])),
  }), { public: true });

  // ---------- Регистрация клиента ----------

  route('POST', '/api/v1/auth/register', async ctx => {
    if (demo) forbid('В демо регистрация выключена, войдите кнопкой роли');
    if (registerLimit.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Слишком много регистраций с этого адреса. Попробуйте через час.');
    const b = ctx.body;
    const name = text(b.name, 'Имя', { min: 1, max: 80 });
    const login = validLogin(b.login).toLowerCase();
    const password = validPassword(b.password);
    const p = readProfile(b);
    if (b.consent !== true) invalid('Нужно согласие на обработку данных о здоровье');
    const hash = await hashPassword(password);
    registerLimit.hit(ctx.ip);
    const user = tx(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) invalid('Такой логин уже занят');
      const r = db.prepare("INSERT INTO users (login, name, role, password_hash, created_at) VALUES (?, ?, 'client', ?, ?)").run(login, name, hash, now());
      const id = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO profiles (user_id, sex, birth_year, height_cm, consent_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, p.sex ?? null, p.birth_year ?? null, p.height_cm ?? null, now());
      return { id, login, name, role: 'client' };
    });
    app.setSession(ctx, createSession(db, user.id), 30 * 86400);
    ctx.status = 201;
    return { user };
  }, { public: true });

  // ---------- Профиль ----------

  function readProfile(b) {
    const out = {};
    if ('sex' in b) out.sex = b.sex ? oneOf(b.sex, ['f', 'm'], 'Пол') : null;
    if ('birthYear' in b) out.birth_year = b.birthYear ? num(b.birthYear, 'Год рождения', [1900, Number(today().slice(0, 4)) - 14], { int: true }) : null;
    if ('heightCm' in b) out.height_cm = b.heightCm ? num(b.heightCm, 'Рост', [100, 250]) : null;
    if ('diaryRemindAt' in b) {
      if (b.diaryRemindAt && !TIME_RE.test(b.diaryRemindAt)) invalid('Время напоминания: ЧЧ:ММ');
      out.diary_remind_at = b.diaryRemindAt || null;
    }
    if ('title' in b) out.title = text(b.title, 'Специализация', { max: 120 });
    return out;
  }

  const presentProfile = (u, p) => ({
    sex: p.sex ?? null, birthYear: p.birth_year ?? null, age: ageOf(p), heightCm: p.height_cm ?? null,
    diaryRemindAt: p.diary_remind_at ?? null, title: p.title ?? '', consentAt: p.consent_at ?? null, role: u.role,
  });

  route('GET', '/api/v1/profile', ctx => ({ profile: presentProfile(ctx.user, profileOf(ctx.user.id)) }));

  route('PATCH', '/api/v1/profile', ctx => {
    const u = ctx.user;
    const f = readProfile(ctx.body);
    if (u.role === 'client') delete f.title;
    else for (const k of ['sex', 'birth_year', 'height_cm', 'diary_remind_at']) delete f[k];
    ensureProfile(u.id);
    const cols = Object.keys(f);
    if (cols.length) db.prepare(`UPDATE profiles SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE user_id = ?`).run(...cols.map(c => f[c]), u.id);
    return { profile: presentProfile(u, profileOf(u.id)) };
  });

  // ---------- Дневник показателей ----------

  function readValue(metric, raw) {
    const m = R.METRICS[metric];
    if (!raw || typeof raw !== 'object') invalid(`${m.name}: нужно значение`);
    const v1 = num(raw.v1, m.name, m.v1, { int: !!m.v1Int });
    let v2 = null;
    if (m.v2 && raw.v2 !== null && raw.v2 !== undefined && raw.v2 !== '') v2 = num(raw.v2, `${m.name}, ${m.v2Name}`, m.v2, { int: !!m.v2Int });
    if (m.v2Required && v2 === null) invalid(`${m.name}: укажите оба значения`);
    if (metric === 'pressure' && v2 >= v1) invalid('Давление: верхнее должно быть больше нижнего');
    return { v1, v2 };
  }

  const valuesOf = (uid, day) => Object.fromEntries(db.prepare('SELECT metric, v1, v2 FROM measurements WHERE user_id = ? AND day = ?').all(uid, day)
    .map(r => [r.metric, { v1: r.v1, v2: r.v2 }]));

  const lastValue = (uid, metric, until = today()) => db.prepare('SELECT day, v1, v2 FROM measurements WHERE user_id = ? AND metric = ? AND day <= ? ORDER BY day DESC LIMIT 1').get(uid, metric, until) || null;

  route('GET', '/api/v1/day/:day', ctx => {
    onlyClient(ctx.user);
    const day = pastOrToday(ctx.params.day, 'День');
    return { day, values: valuesOf(ctx.user.id, day) };
  });

  // Сохраняет ровно то, что пришло: значение записывается, null удаляет запись за этот день.
  route('PUT', '/api/v1/day/:day', ctx => {
    const u = ctx.user;
    onlyClient(u);
    const day = pastOrToday(ctx.params.day, 'День');
    const input = ctx.body.values;
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Нет значений');
    const changes = {};
    for (const [metric, raw] of Object.entries(input)) {
      if (!R.METRICS[metric]) invalid('Неизвестный показатель');
      changes[metric] = raw === null ? null : readValue(metric, raw);
    }
    demoLimit('SELECT COUNT(*) AS n FROM measurements', 30000, 'Слишком много записей');
    const events = tx(db, () => {
      for (const [metric, v] of Object.entries(changes)) {
        if (v === null) db.prepare('DELETE FROM measurements WHERE user_id = ? AND metric = ? AND day = ?').run(u.id, metric, day);
        else {
          db.prepare(`INSERT INTO measurements (user_id, day, metric, v1, v2, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, metric, day) DO UPDATE SET v1 = excluded.v1, v2 = excluded.v2, updated_at = excluded.updated_at`)
            .run(u.id, day, metric, v.v1, v.v2, now());
        }
      }
      return [...checkAlerts(u.id, day, changes), ...checkGoals(u.id)];
    });
    flushPush();
    return { day, values: valuesOf(u.id, day), events };
  });

  // Тревожные изменения: не чаще раза в неделю на каждый вид, чтобы не засыпать человека сообщениями.
  function checkAlerts(uid, day, changes) {
    const events = [];
    const recently = kind => db.prepare('SELECT 1 FROM sent WHERE user_id = ? AND key LIKE ? AND day > ?').get(uid, `${kind}:${uid}:%`, shiftDay(day, -7));
    const mark = kind => db.prepare('INSERT OR IGNORE INTO sent (key, user_id, day, sent_at) VALUES (?, ?, ?, ?)').run(`${kind}:${uid}:${day}`, uid, day, now());
    if (changes.pressure) {
      const prev = db.prepare("SELECT v1, v2 FROM measurements WHERE user_id = ? AND metric = 'pressure' AND day = ?").get(uid, shiftDay(day, -1));
      if (R.highPressure(changes.pressure.v1, changes.pressure.v2) && prev && R.highPressure(prev.v1, prev.v2) && !recently('bp')) {
        mark('bp');
        const msg = 'Давление выше 140/90 два дня подряд. Покажите записи врачу.';
        notify([uid], 'alert', msg, '#/charts/pressure', { push: msg });
        events.push(msg);
      }
    }
    if (changes.weight) {
      const week = db.prepare("SELECT v1 FROM measurements WHERE user_id = ? AND metric = 'weight' AND day >= ? AND day < ?").all(uid, shiftDay(day, -7), day);
      const jump = week.some(w => Math.abs(w.v1 - changes.weight.v1) > 3);
      if (jump && !recently('wt')) {
        mark('wt');
        const msg = 'Вес изменился больше чем на 3 кг за неделю. Если вы не меняли питание специально, обсудите это с врачом.';
        notify([uid], 'alert', msg, '#/charts/weight', { push: 'Заметное изменение веса за неделю' });
        events.push(msg);
      }
    }
    return events;
  }

  // ---------- Графики и сравнение ----------

  const avg = (rows, key) => {
    const list = rows.map(r => r[key]).filter(v => v !== null && v !== undefined);
    return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
  };

  function summary(uid, metric, days) {
    const to = today();
    const from = shiftDay(to, -(days - 1));
    const prevFrom = shiftDay(from, -days);
    const rows = db.prepare('SELECT day, v1, v2 FROM measurements WHERE user_id = ? AND metric = ? AND day >= ? AND day <= ? ORDER BY day').all(uid, metric, prevFrom, to);
    const current = rows.filter(r => r.day >= from);
    const prev = rows.filter(r => r.day < from);
    const digits = metric === 'activity' ? 0 : 1;
    const pack = list => (list.length ? { v1: round(avg(list, 'v1'), digits), v2: round(avg(list, 'v2'), digits) } : null);
    const a = pack(current);
    const p = pack(prev);
    const change = a && p ? { v1: round(a.v1 - p.v1, digits), v2: a.v2 !== null && p.v2 !== null ? round(a.v2 - p.v2, digits) : null } : null;
    const goal = db.prepare('SELECT target FROM goals WHERE user_id = ? AND metric = ?').get(uid, metric);
    return { metric, days, from, to, points: current, last: lastValue(uid, metric, to), avg: a, prevAvg: p, change, goal: goal?.target ?? null };
  }

  const period = v => { const d = Number(v || 30); if (!PERIODS.includes(d)) invalid('Период: 7, 30 или 90 дней'); return d; };

  route('GET', '/api/v1/metrics/:metric', ctx => {
    const u = ctx.user;
    const metric = oneOf(ctx.params.metric, R.METRIC_KEYS, 'Показатель');
    const days = period(ctx.query.get('days'));
    let uid = u.id;
    if (ctx.query.get('client')) {
      const c = clientFor(u, ctx.query.get('client'));
      if (!R.SCOPE[u.role].metrics.includes(metric)) notFound('Показатель недоступен');
      uid = c.id;
    } else onlyClient(u);
    return summary(uid, metric, days);
  });

  // ---------- Цели ----------

  function goalState(uid, g) {
    const def = R.GOAL_METRICS[g.metric];
    let current = null; let progress = 0; let reached = false;
    if (def.mode === 'value') {
      current = lastValue(uid, g.metric)?.v1 ?? null;
      if (current !== null) {
        reached = g.direction === 'down' ? current <= g.target : current >= g.target;
        const span = Math.abs((g.start ?? current) - g.target);
        progress = reached ? 1 : span ? Math.max(0, Math.min(1, 1 - Math.abs(current - g.target) / span)) : 0;
      }
    } else {
      // Ежедневная цель засчитывается по среднему за последние 7 дней, если записей хотя бы 3.
      const rows = db.prepare('SELECT v1 FROM measurements WHERE user_id = ? AND metric = ? AND day > ? AND day <= ?').all(uid, g.metric, shiftDay(today(), -7), today());
      if (rows.length) {
        current = round(avg(rows, 'v1'), g.metric === 'activity' ? 0 : 1);
        reached = rows.length >= 3 && current >= g.target;
        progress = Math.max(0, Math.min(1, current / g.target));
      }
    }
    return {
      metric: g.metric, name: def.name, unit: def.unit, mode: def.mode, target: g.target, start: g.start, direction: g.direction,
      dueDay: g.due_day, current, progress: round(progress, 2), reached: !!g.reached_at || reached, reachedAt: g.reached_at,
    };
  }

  function checkGoals(uid) {
    const events = [];
    for (const g of db.prepare('SELECT * FROM goals WHERE user_id = ? AND reached_at IS NULL').all(uid)) {
      const s = goalState(uid, g);
      if (!s.reached) continue;
      db.prepare('UPDATE goals SET reached_at = ? WHERE user_id = ? AND metric = ?').run(now(), uid, g.metric);
      const msg = `Цель достигнута: ${s.name.toLowerCase()} ${String(g.target).replace('.', ',')} ${s.unit}. Поздравляем!`;
      notify([uid], 'goal', msg, '#/more/goals', { push: 'Цель достигнута, поздравляем!' });
      events.push(msg);
    }
    return events;
  }

  const goalsOf = uid => db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY metric').all(uid).map(g => goalState(uid, g));

  route('GET', '/api/v1/goals', ctx => { onlyClient(ctx.user); return { goals: goalsOf(ctx.user.id) }; });

  route('PUT', '/api/v1/goals/:metric', ctx => {
    const u = ctx.user;
    onlyClient(u);
    const metric = oneOf(ctx.params.metric, Object.keys(R.GOAL_METRICS), 'Цель');
    const def = R.METRICS[metric];
    const target = num(ctx.body.target, R.GOAL_METRICS[metric].name, def.v1);
    let due = null;
    if (ctx.body.dueDay) {
      if (!realDate(ctx.body.dueDay)) invalid('Недопустимая дата цели');
      if (ctx.body.dueDay <= today()) invalid('Срок цели должен быть в будущем');
      due = ctx.body.dueDay;
    }
    const start = lastValue(u.id, metric)?.v1 ?? null;
    const direction = metric === 'weight' && start !== null && target < start ? 'down' : 'up';
    const events = tx(db, () => {
      db.prepare(`INSERT INTO goals (user_id, metric, target, start, direction, due_day, created_at, reached_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(user_id, metric) DO UPDATE SET target = excluded.target, start = excluded.start, direction = excluded.direction,
          due_day = excluded.due_day, created_at = excluded.created_at, reached_at = NULL`).run(u.id, metric, target, start, direction, due, now());
      return checkGoals(u.id);
    });
    flushPush();
    return { goals: goalsOf(u.id), events };
  });

  route('DELETE', '/api/v1/goals/:metric', ctx => {
    onlyClient(ctx.user);
    db.prepare('DELETE FROM goals WHERE user_id = ? AND metric = ?').run(ctx.user.id, String(ctx.params.metric));
    return { goals: goalsOf(ctx.user.id) };
  });

  // ---------- Анализы ----------

  function presentLabs(uid) {
    const sex = profileOf(uid).sex;
    const labs = db.prepare('SELECT * FROM labs WHERE user_id = ? ORDER BY day, id').all(uid);
    const prevValue = {};
    const out = labs.map(l => {
      const values = db.prepare('SELECT code, value FROM lab_values WHERE lab_id = ?').all(l.id);
      const byCode = Object.fromEntries(values.map(v => [v.code, v.value]));
      const list = R.LAB_KEYS.filter(code => code in byCode).map(code => {
        const t = R.LAB_TESTS[code];
        const item = { code, name: t.name, unit: t.unit, value: byCode[code], verdict: R.labVerdict(code, byCode[code], sex), prev: prevValue[code] ?? null };
        prevValue[code] = byCode[code];
        return item;
      });
      const files = db.prepare('SELECT id, name, type, size, seeded FROM lab_files WHERE lab_id = ? ORDER BY id').all(l.id)
        .map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size, example: !!f.seeded }));
      return { id: l.id, day: l.day, note: l.note, values: list, files };
    });
    return out.reverse();
  }

  route('GET', '/api/v1/labs', ctx => {
    onlyClient(ctx.user);
    return { labs: presentLabs(ctx.user.id), disclaimer: R.DISCLAIMER, sex: profileOf(ctx.user.id).sex ?? null, uploads: !demo };
  });

  route('POST', '/api/v1/labs', ctx => {
    const u = ctx.user;
    onlyClient(u);
    const day = pastOrToday(ctx.body.day, 'Дата анализа');
    const raw = ctx.body.values && typeof ctx.body.values === 'object' ? ctx.body.values : {};
    const values = {};
    for (const code of R.LAB_KEYS) {
      const v = raw[code];
      if (v === null || v === undefined || v === '') continue;
      const t = R.LAB_TESTS[code];
      values[code] = num(v, t.name, t.valid);
    }
    if (Object.keys(raw).some(k => !R.LAB_KEYS.includes(k))) invalid('Неизвестный показатель анализа');
    if (!Object.keys(values).length) invalid('Внесите хотя бы один показатель из анализа');
    const note = text(ctx.body.note, 'Комментарий', { max: 300 });
    demoLimit('SELECT COUNT(*) AS n FROM labs', 300, 'Слишком много анализов');
    const id = tx(db, () => {
      const r = db.prepare('INSERT INTO labs (user_id, day, note, created_at) VALUES (?, ?, ?, ?)').run(u.id, day, note, now());
      const labId = Number(r.lastInsertRowid);
      for (const [code, value] of Object.entries(values)) db.prepare('INSERT INTO lab_values (lab_id, code, value) VALUES (?, ?, ?)').run(labId, code, value);
      return labId;
    });
    ctx.status = 201;
    return { lab: presentLabs(u.id).find(l => l.id === id), disclaimer: R.DISCLAIMER };
  });

  const ownLab = (u, id) => {
    const l = db.prepare('SELECT * FROM labs WHERE id = ?').get(intId(id, 'Анализ'));
    if (!l || l.user_id !== u.id) notFound('Анализ не найден');
    return l;
  };

  const removeFiles = rows => { for (const f of rows) if (!f.seeded) fs.rmSync(path.join(filesDir, path.basename(f.file)), { force: true }); };

  route('DELETE', '/api/v1/labs/:id', ctx => {
    onlyClient(ctx.user);
    const l = ownLab(ctx.user, ctx.params.id);
    const files = db.prepare('SELECT * FROM lab_files WHERE lab_id = ?').all(l.id);
    db.prepare('DELETE FROM labs WHERE id = ?').run(l.id);
    removeFiles(files);
    return { ok: true };
  });

  route('POST', '/api/v1/labs/:id/files', ctx => {
    const u = ctx.user;
    onlyClient(u);
    const l = ownLab(u, ctx.params.id);
    if (demo) forbid('В демо загрузка файлов выключена: медицинские документы на демо-сервер не отправляем');
    if (!isFile(ctx.file, ctx.fileType)) invalid('Файл не похож на PDF, JPG или PNG');
    if (db.prepare('SELECT COUNT(*) AS n FROM lab_files WHERE lab_id = ?').get(l.id).n >= FILES_PER_LAB) invalid(`К анализу можно приложить не больше ${FILES_PER_LAB} файлов`);
    const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[ctx.fileType];
    const given = String(ctx.query.get('name') || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 100);
    const name = given || `Анализ ${l.day}.${ext}`;
    const file = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, file), ctx.file);
    const r = db.prepare('INSERT INTO lab_files (lab_id, file, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(l.id, file, name, ctx.fileType, ctx.file.length, now());
    ctx.status = 201;
    return { file: { id: Number(r.lastInsertRowid), name, type: ctx.fileType, size: ctx.file.length } };
  }, { upload: { types: FILE_TYPES, maxBytes: MAX_FILE } });

  const fileFor = (u, id) => {
    const f = db.prepare('SELECT f.*, l.user_id FROM lab_files f JOIN labs l ON l.id = f.lab_id WHERE f.id = ?').get(intId(id, 'Файл'));
    if (!f) notFound('Файл не найден');
    const own = f.user_id === u.id;
    const specialist = SPECIALISTS.includes(u.role) && R.SCOPE[u.role].labs && hasAccess(u.id, f.user_id);
    if (!own && !specialist) notFound('Файл не найден');
    return { f, own };
  };

  route('GET', '/api/v1/files/:id', ctx => {
    const { f } = fileFor(ctx.user, ctx.params.id);
    ctx.sendFile = { path: path.join(f.seeded ? seedDir : filesDir, path.basename(f.file)), type: f.type, download: f.type === 'application/pdf' ? f.name : null };
  });

  route('DELETE', '/api/v1/files/:id', ctx => {
    const { f, own } = fileFor(ctx.user, ctx.params.id);
    if (!own) forbid('Удалить файл может только владелец');
    db.prepare('DELETE FROM lab_files WHERE id = ?').run(f.id);
    removeFiles([f]);
    return { ok: true };
  });

  // ---------- Лекарства и приём ----------

  function readMed(b, old) {
    const out = {};
    if ('name' in b || !old) out.name = text(b.name, 'Название', { min: 1, max: 80 });
    if ('dose' in b) out.dose = text(b.dose, 'Доза', { max: 60 });
    if ('times' in b || !old) {
      if (!Array.isArray(b.times) || !b.times.length || b.times.length > 6) invalid('Укажите от 1 до 6 времён приёма');
      if (b.times.some(t => !TIME_RE.test(t))) invalid('Время приёма: ЧЧ:ММ');
      out.times = JSON.stringify([...new Set(b.times)].sort());
    }
    if ('days' in b) {
      if (!Array.isArray(b.days) || b.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) invalid('Недопустимые дни недели');
      out.days = JSON.stringify([...new Set(b.days)].sort());
    }
    return out;
  }

  const presentMed = m => ({ id: m.id, name: m.name, dose: m.dose, times: json(m.times, []), days: json(m.days, []) });

  function dosesFor(uid, day) {
    const out = [];
    for (const m of db.prepare('SELECT * FROM meds WHERE user_id = ? ORDER BY id').all(uid)) {
      const days = json(m.days, []);
      if (days.length && !days.includes(weekday(day))) continue;
      for (const time of json(m.times, [])) {
        const taken = !!db.prepare('SELECT 1 FROM med_intakes WHERE med_id = ? AND day = ? AND time = ?').get(m.id, day, time);
        out.push({ medId: m.id, name: m.name, dose: m.dose, time, taken });
      }
    }
    return out.sort((a, b) => a.time.localeCompare(b.time));
  }

  const ownMed = (u, id) => {
    const m = db.prepare('SELECT * FROM meds WHERE id = ?').get(intId(id, 'Лекарство'));
    if (!m || m.user_id !== u.id) notFound('Лекарство не найдено');
    return m;
  };

  route('GET', '/api/v1/meds', ctx => {
    onlyClient(ctx.user);
    return { meds: db.prepare('SELECT * FROM meds WHERE user_id = ? ORDER BY id').all(ctx.user.id).map(presentMed) };
  });

  route('POST', '/api/v1/meds', ctx => {
    const u = ctx.user;
    onlyClient(u);
    if (db.prepare('SELECT COUNT(*) AS n FROM meds WHERE user_id = ?').get(u.id).n >= 20) invalid('Не больше 20 лекарств');
    const f = readMed(ctx.body);
    const r = db.prepare('INSERT INTO meds (user_id, name, dose, times, days, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(u.id, f.name, f.dose ?? '', f.times, f.days ?? '[]', now());
    ctx.status = 201;
    return { med: presentMed(db.prepare('SELECT * FROM meds WHERE id = ?').get(Number(r.lastInsertRowid))) };
  });

  route('PATCH', '/api/v1/meds/:id', ctx => {
    onlyClient(ctx.user);
    const m = ownMed(ctx.user, ctx.params.id);
    const f = readMed(ctx.body, m);
    const cols = Object.keys(f);
    if (cols.length) db.prepare(`UPDATE meds SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => f[c]), m.id);
    return { med: presentMed(db.prepare('SELECT * FROM meds WHERE id = ?').get(m.id)) };
  });

  route('DELETE', '/api/v1/meds/:id', ctx => {
    onlyClient(ctx.user);
    db.prepare('DELETE FROM meds WHERE id = ?').run(ownMed(ctx.user, ctx.params.id).id);
    return { ok: true };
  });

  // Отметка «принял» только за сегодня: задним числом приём не отмечаем.
  route('POST', '/api/v1/meds/:id/take', ctx => {
    const u = ctx.user;
    onlyClient(u);
    const m = ownMed(u, ctx.params.id);
    const time = String(ctx.body.time || '');
    if (!json(m.times, []).includes(time)) invalid('У этого лекарства нет приёма в такое время');
    const day = today();
    if (ctx.body.taken === false) db.prepare('DELETE FROM med_intakes WHERE med_id = ? AND day = ? AND time = ?').run(m.id, day, time);
    else db.prepare('INSERT OR IGNORE INTO med_intakes (med_id, day, time, taken_at) VALUES (?, ?, ?, ?)').run(m.id, day, time, now());
    return { doses: dosesFor(u.id, day) };
  });

  // ---------- Главный экран клиента ----------

  function nextBookings(uid, limit = 3) {
    const t = today();
    const nm = nowMinutes();
    return db.prepare(`SELECT s.*, u.name AS trainer_name FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN users u ON u.id = s.trainer_id
      WHERE b.client_id = ? AND s.day >= ? ORDER BY s.day, s.time`).all(uid, t)
      .filter(s => s.day > t || minutesOf(s.time) > nm).slice(0, limit)
      .map(s => ({ slotId: s.id, day: s.day, time: s.time, minutes: s.minutes, kind: s.kind, trainerName: s.trainer_name }));
  }

  route('GET', '/api/v1/overview', ctx => {
    const u = ctx.user;
    onlyClient(u);
    const t = today();
    const p = profileOf(u.id);
    const weight = lastValue(u.id, 'weight')?.v1 ?? null;
    const b = R.bmi(weight, p.height_cm);
    const answered = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE client_id = ? AND status = 'done' AND updated_at > ?").get(u.id, new Date(Date.now() - 7 * 864e5).toISOString()).n;
    return {
      today: t, values: valuesOf(u.id, t), bmi: b, bmiLabel: R.bmiLabel(b), weight, heightCm: p.height_cm ?? null,
      goals: goalsOf(u.id), doses: dosesFor(u.id, t), bookings: nextBookings(u.id), answered,
    };
  });

  // ---------- Специалисты и запросы ----------

  const presentSpecialist = s => ({ id: s.id, name: s.name, role: s.role, title: profileOf(s.id).title || '' });

  route('GET', '/api/v1/specialists', () => ({
    specialists: db.prepare(`SELECT id, name, role FROM users WHERE active = 1 AND role IN ('doctor', 'nutritionist', 'trainer') ORDER BY role, name`).all().map(presentSpecialist),
  }));

  function presentRequest(r, viewer) {
    const spec = userRow(r.specialist_id);
    const client = userRow(r.client_id);
    return {
      id: r.id, kind: r.kind, status: r.status, message: r.message, answer: r.answer, createdAt: r.created_at, updatedAt: r.updated_at,
      specialist: presentSpecialist(spec), client: { id: client.id, name: client.name },
      access: hasAccess(r.specialist_id, r.client_id), mine: viewer.id === r.client_id,
    };
  }

  const requestFor = (u, id) => {
    const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(intId(id, 'Запрос'));
    if (!r || (r.client_id !== u.id && r.specialist_id !== u.id)) notFound('Запрос не найден');
    return r;
  };

  route('GET', '/api/v1/requests', ctx => {
    const u = ctx.user;
    let rows;
    if (u.role === 'client') rows = db.prepare('SELECT * FROM requests WHERE client_id = ? ORDER BY id DESC LIMIT 100').all(u.id);
    else if (SPECIALISTS.includes(u.role)) {
      rows = db.prepare(`SELECT * FROM requests WHERE specialist_id = ? ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, id DESC LIMIT 200`).all(u.id);
    } else forbid();
    return { requests: rows.map(r => presentRequest(r, u)) };
  });

  route('POST', '/api/v1/requests', ctx => {
    const u = ctx.user;
    onlyClient(u);
    const spec = userRow(intId(ctx.body.specialistId, 'Специалист'));
    if (!spec || !spec.active || !REQUEST_KIND[spec.role]) invalid('Выберите врача или нутрициолога');
    const message = text(ctx.body.message, 'Сообщение', { min: 1, max: 1000 });
    if (ctx.body.consent !== true) invalid('Нужно согласие открыть специалисту ваши показатели и анализы');
    demoLimit('SELECT COUNT(*) AS n FROM requests', 500, 'Слишком много запросов');
    const id = tx(db, () => {
      if (db.prepare("SELECT 1 FROM requests WHERE client_id = ? AND specialist_id = ? AND status IN ('new', 'work')").get(u.id, spec.id)) {
        invalid('У вас уже есть открытый запрос к этому специалисту');
      }
      db.prepare('INSERT OR IGNORE INTO access (client_id, specialist_id, granted_at) VALUES (?, ?, ?)').run(u.id, spec.id, now());
      const r = db.prepare('INSERT INTO requests (client_id, specialist_id, kind, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(u.id, spec.id, REQUEST_KIND[spec.role], message, now(), now());
      const rid = Number(r.lastInsertRowid);
      const what = spec.role === 'doctor' ? 'посмотреть анализы' : 'составить меню';
      notify([spec.id], 'request', `Новый запрос: ${u.name}, ${what}`, `#/request/${rid}`, { push: 'Новый запрос от клиента' });
      return rid;
    });
    flushPush();
    ctx.status = 201;
    return { request: presentRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(id), u) };
  });

  route('GET', '/api/v1/requests/:id', ctx => {
    const u = ctx.user;
    const r = requestFor(u, ctx.params.id);
    return { request: presentRequest(r, u) };
  });

  route('PATCH', '/api/v1/requests/:id', ctx => {
    const u = ctx.user;
    const r = requestFor(u, ctx.params.id);
    const status = oneOf(ctx.body.status, ['work', 'done', 'rejected', 'cancelled'], 'Статус');
    if (!OPEN.includes(r.status)) invalid('Запрос уже закрыт');
    if (r.client_id === u.id) {
      if (status !== 'cancelled') forbid('Клиент может только отменить запрос');
      db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', now(), r.id);
      return { request: presentRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(r.id), u) };
    }
    if (status === 'cancelled') forbid('Отменить запрос может только клиент');
    if (!hasAccess(u.id, r.client_id)) forbid('Клиент закрыл доступ к своим данным');
    let answer = r.answer;
    if (status === 'done') answer = text(ctx.body.answer, 'Ответ', { min: 1, max: 5000 });
    if (status === 'rejected') answer = text(ctx.body.answer, 'Причина', { max: 1000 });
    if (status === 'work' && r.status !== 'new') invalid('Запрос уже в работе');
    tx(db, () => {
      db.prepare('UPDATE requests SET status = ?, answer = ?, updated_at = ? WHERE id = ?').run(status, answer, now(), r.id);
      if (status === 'done') {
        const what = r.kind === 'menu' ? 'Меню готово' : 'Заключение по анализам готово';
        notify([r.client_id], 'answer', `${what}: ${u.name}`, '#/experts', { push: `${what}. Откройте Тонус` });
      }
      if (status === 'rejected') notify([r.client_id], 'answer', `${u.name} не может взять запрос${answer ? `: ${answer}` : ''}`, '#/experts', { push: 'Специалист ответил на запрос' });
    });
    flushPush();
    return { request: presentRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(r.id), u) };
  });

  // ---------- Доступ ----------

  route('GET', '/api/v1/access', ctx => {
    onlyClient(ctx.user);
    const rows = db.prepare('SELECT a.specialist_id, a.granted_at, u.id, u.name, u.role FROM access a JOIN users u ON u.id = a.specialist_id WHERE a.client_id = ? ORDER BY a.granted_at').all(ctx.user.id);
    return { access: rows.map(r => ({ ...presentSpecialist(r), grantedAt: r.granted_at, scope: R.SCOPE[r.role] })) };
  });

  // Закрыть доступ: данные сразу перестают быть видны, открытые запросы к специалисту отменяются, ответы остаются у клиента.
  route('DELETE', '/api/v1/access/:specialistId', ctx => {
    const u = ctx.user;
    onlyClient(u);
    const sid = intId(ctx.params.specialistId, 'Специалист');
    tx(db, () => {
      db.prepare('DELETE FROM access WHERE client_id = ? AND specialist_id = ?').run(u.id, sid);
      db.prepare("UPDATE requests SET status = 'cancelled', updated_at = ? WHERE client_id = ? AND specialist_id = ? AND status IN ('new', 'work')").run(now(), u.id, sid);
    });
    return { ok: true };
  });

  // ---------- Карточка клиента для специалиста ----------

  route('GET', '/api/v1/clients', ctx => {
    const u = ctx.user;
    if (!SPECIALISTS.includes(u.role)) forbid();
    const rows = db.prepare('SELECT u.id, u.name, a.granted_at FROM access a JOIN users u ON u.id = a.client_id WHERE a.specialist_id = ? AND u.active = 1 ORDER BY u.name').all(u.id);
    return {
      clients: rows.map(c => {
        const p = profileOf(c.id);
        const open = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE client_id = ? AND specialist_id = ? AND status IN ('new', 'work')").get(c.id, u.id).n;
        return { id: c.id, name: c.name, sex: p.sex ?? null, age: ageOf(p), grantedAt: c.granted_at, openRequests: open };
      }),
    };
  });

  route('GET', '/api/v1/clients/:id', ctx => {
    const u = ctx.user;
    const c = clientFor(u, ctx.params.id);
    const scope = R.SCOPE[u.role];
    const p = profileOf(c.id);
    const weight = lastValue(c.id, 'weight')?.v1 ?? null;
    const b = R.bmi(weight, p.height_cm);
    return {
      client: { id: c.id, name: c.name, sex: p.sex ?? null, age: ageOf(p), heightCm: p.height_cm ?? null, bmi: b, bmiLabel: R.bmiLabel(b) },
      scope,
      summaries: scope.metrics.map(m => summary(c.id, m, 30)),
      labs: scope.labs ? presentLabs(c.id) : null,
      disclaimer: R.DISCLAIMER,
      requests: db.prepare('SELECT * FROM requests WHERE client_id = ? AND specialist_id = ? ORDER BY id DESC').all(c.id, u.id).map(r => presentRequest(r, u)),
    };
  });

  // ---------- Расписание тренера ----------

  const slotStarted = s => s.day < today() || (s.day === today() && minutesOf(s.time) <= nowMinutes());

  function presentSlot(s, viewer) {
    const booked = db.prepare('SELECT b.client_id, u.name FROM bookings b JOIN users u ON u.id = b.client_id WHERE b.slot_id = ? ORDER BY b.created_at').all(s.id);
    const out = {
      id: s.id, day: s.day, time: s.time, minutes: s.minutes, kind: s.kind, capacity: s.capacity, taken: booked.length,
      free: Math.max(0, s.capacity - booked.length), trainer: presentSpecialist(userRow(s.trainer_id)),
      mine: booked.some(b => b.client_id === viewer.id), started: slotStarted(s),
    };
    if (viewer.id === s.trainer_id) out.clients = booked.map(b => ({ id: b.client_id, name: b.name }));
    return out;
  }

  route('GET', '/api/v1/slots', ctx => {
    const u = ctx.user;
    const t = today();
    let rows;
    if (u.role === 'trainer') rows = db.prepare('SELECT * FROM slots WHERE trainer_id = ? AND day >= ? AND day <= ? ORDER BY day, time').all(u.id, t, shiftDay(t, 30));
    else if (u.role === 'client') rows = db.prepare('SELECT s.* FROM slots s JOIN users u ON u.id = s.trainer_id WHERE u.active = 1 AND s.day >= ? AND s.day <= ? ORDER BY s.day, s.time').all(t, shiftDay(t, 14));
    else forbid();
    return { today: t, slots: rows.filter(s => !slotStarted(s)).map(s => presentSlot(s, u)) };
  });

  route('POST', '/api/v1/slots', ctx => {
    const u = ctx.user;
    if (u.role !== 'trainer') forbid('Расписание ведёт тренер');
    const b = ctx.body;
    if (!realDate(b.day)) invalid('Недопустимая дата');
    if (!TIME_RE.test(String(b.time || ''))) invalid('Время: ЧЧ:ММ');
    if (b.day > shiftDay(today(), 60)) invalid('Расписание ведётся не дальше чем на 60 дней');
    const minutes = num(b.minutes, 'Длительность', [15, 240], { int: true });
    const capacity = num(b.capacity, 'Мест', [1, 50], { int: true });
    const kind = text(b.kind, 'Тренировка', { min: 1, max: 60 });
    if (slotStarted({ day: b.day, time: b.time })) invalid('Это время уже прошло');
    demoLimit('SELECT COUNT(*) AS n FROM slots', 300, 'Слишком много тренировок');
    if (db.prepare('SELECT 1 FROM slots WHERE trainer_id = ? AND day = ? AND time = ?').get(u.id, b.day, b.time)) invalid('В это время у вас уже есть тренировка');
    const r = db.prepare('INSERT INTO slots (trainer_id, day, time, minutes, kind, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(u.id, b.day, b.time, minutes, kind, capacity, now());
    ctx.status = 201;
    return { slot: presentSlot(db.prepare('SELECT * FROM slots WHERE id = ?').get(Number(r.lastInsertRowid)), u) };
  });

  const slotRow = id => db.prepare('SELECT * FROM slots WHERE id = ?').get(intId(id, 'Тренировка'));

  route('DELETE', '/api/v1/slots/:id', ctx => {
    const u = ctx.user;
    const s = slotRow(ctx.params.id);
    if (!s || s.trainer_id !== u.id) notFound('Тренировка не найдена');
    tx(db, () => {
      const clients = db.prepare('SELECT client_id FROM bookings WHERE slot_id = ?').all(s.id).map(x => x.client_id);
      db.prepare('DELETE FROM slots WHERE id = ?').run(s.id);
      if (!slotStarted(s)) notify(clients, 'booking', `Тренировка отменена: ${s.kind}, ${s.day.slice(8)}.${s.day.slice(5, 7)} в ${s.time}`, '#/experts', { push: 'Тренер отменил тренировку' });
    });
    flushPush();
    return { ok: true };
  });

  route('POST', '/api/v1/slots/:id/book', ctx => {
    const u = ctx.user;
    onlyClient(u);
    if (ctx.body.consent !== true) invalid('Нужно согласие показать тренеру шаги, вес и пульс');
    const s = slotRow(ctx.params.id);
    if (!s || !userRow(s.trainer_id)?.active) notFound('Тренировка не найдена');
    tx(db, () => {
      if (slotStarted(s)) invalid('Эта тренировка уже началась');
      if (db.prepare('SELECT 1 FROM bookings WHERE slot_id = ? AND client_id = ?').get(s.id, u.id)) invalid('Вы уже записаны на эту тренировку');
      if (db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ?').get(s.id).n >= s.capacity) invalid('Свободных мест нет');
      db.prepare('INSERT INTO bookings (slot_id, client_id, created_at) VALUES (?, ?, ?)').run(s.id, u.id, now());
      db.prepare('INSERT OR IGNORE INTO access (client_id, specialist_id, granted_at) VALUES (?, ?, ?)').run(u.id, s.trainer_id, now());
      notify([s.trainer_id], 'booking', `Новая запись: ${u.name}, ${s.kind}, ${s.day.slice(8)}.${s.day.slice(5, 7)} в ${s.time}`, '#/schedule', { push: 'Новая запись на тренировку' });
    });
    flushPush();
    return { slot: presentSlot(slotRow(s.id), u) };
  });

  route('DELETE', '/api/v1/slots/:id/book', ctx => {
    const u = ctx.user;
    onlyClient(u);
    const s = slotRow(ctx.params.id);
    if (!s) notFound('Тренировка не найдена');
    if (slotStarted(s)) invalid('Тренировка уже началась, отменить запись нельзя');
    const r = db.prepare('DELETE FROM bookings WHERE slot_id = ? AND client_id = ?').run(s.id, u.id);
    if (!r.changes) invalid('Вы не записаны на эту тренировку');
    notify([s.trainer_id], 'booking', `Отмена записи: ${u.name}, ${s.kind}, ${s.day.slice(8)}.${s.day.slice(5, 7)} в ${s.time}`, '#/schedule');
    return { slot: presentSlot(s, u) };
  });

  // ---------- Бесплатные материалы и статьи ----------

  const presentMaterial = (m, full) => ({
    id: m.id, kind: m.kind, section: m.section, title: m.title, summary: m.summary, videoUrl: m.video_url, published: !!m.published,
    position: m.position, authorId: m.author_id, authorName: m.author_id ? userRow(m.author_id)?.name ?? null : null,
    updatedAt: m.updated_at, ...(full ? { body: m.body } : {}),
  });

  route('GET', '/api/v1/public/materials', ctx => {
    const kind = ctx.query.get('kind');
    const rows = kind
      ? db.prepare('SELECT * FROM materials WHERE published = 1 AND kind = ? ORDER BY position, id DESC').all(oneOf(kind, MATERIAL_KINDS, 'Раздел'))
      : db.prepare('SELECT * FROM materials WHERE published = 1 ORDER BY kind, position, id DESC').all();
    return { materials: rows.map(m => presentMaterial(m, false)) };
  }, { public: true });

  const canEditMaterial = (u, m) => u && (u.role === 'admin' || (SPECIALISTS.includes(u.role) && m.author_id === u.id));

  route('GET', '/api/v1/public/materials/:id', ctx => {
    const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(intId(ctx.params.id, 'Материал'));
    if (!m || (!m.published && !canEditMaterial(ctx.user, m))) notFound('Материал не найден');
    return { material: presentMaterial(m, true), canEdit: !!canEditMaterial(ctx.user, m) };
  }, { public: true });

  route('GET', '/api/v1/materials/mine', ctx => {
    const u = ctx.user;
    if (u.role === 'admin') return { materials: db.prepare('SELECT * FROM materials ORDER BY kind, position, id DESC').all().map(m => presentMaterial(m, false)) };
    if (!SPECIALISTS.includes(u.role)) forbid();
    return { materials: db.prepare('SELECT * FROM materials WHERE author_id = ? ORDER BY id DESC').all(u.id).map(m => presentMaterial(m, false)) };
  });

  function readMaterial(u, b, old) {
    const out = {};
    if ('kind' in b || !old) {
      out.kind = oneOf(b.kind ?? 'article', MATERIAL_KINDS, 'Тип');
      if (u.role !== 'admin' && out.kind !== 'article') forbid('Пробное меню и уроки ведёт администратор');
    }
    if ('section' in b || !old) out.section = oneOf(b.section ?? 'general', SECTIONS, 'Раздел');
    if ('title' in b || !old) out.title = text(b.title, 'Заголовок', { min: 1, max: 150 });
    if ('summary' in b) out.summary = text(b.summary, 'Кратко', { max: 300 });
    if ('body' in b || !old) out.body = text(b.body, 'Текст', { min: 1, max: 20000 });
    if ('videoUrl' in b) {
      const v = text(b.videoUrl, 'Ссылка на видео', { max: 300 });
      if (v) {
        let url;
        try { url = new URL(v); } catch { invalid('Ссылка на видео: нужен полный адрес https://…'); }
        if (url.protocol !== 'https:') invalid('Ссылка на видео: только https');
      }
      out.video_url = v;
    }
    if ('published' in b) out.published = b.published ? 1 : 0;
    if ('position' in b) out.position = num(b.position, 'Порядок', [0, 999], { int: true });
    return out;
  }

  route('POST', '/api/v1/materials', ctx => {
    const u = ctx.user;
    if (u.role !== 'admin' && !SPECIALISTS.includes(u.role)) forbid('Статьи пишут специалисты и администратор');
    const f = readMaterial(u, ctx.body);
    demoLimit('SELECT COUNT(*) AS n FROM materials', 200, 'Слишком много материалов');
    const r = db.prepare(`INSERT INTO materials (kind, section, title, summary, body, video_url, position, published, author_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.kind, f.section, f.title, f.summary ?? '', f.body, f.video_url ?? '', f.position ?? 0, f.published ?? 1, u.id, now(), now());
    ctx.status = 201;
    return { material: presentMaterial(db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(r.lastInsertRowid)), true) };
  });

  const materialFor = (u, id) => {
    const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(intId(id, 'Материал'));
    if (!m) notFound('Материал не найден');
    if (!canEditMaterial(u, m)) forbid('Менять материал может автор или администратор');
    return m;
  };

  route('PATCH', '/api/v1/materials/:id', ctx => {
    const u = ctx.user;
    const m = materialFor(u, ctx.params.id);
    const f = readMaterial(u, ctx.body, m);
    const cols = Object.keys(f);
    if (cols.length) db.prepare(`UPDATE materials SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(c => f[c]), now(), m.id);
    return { material: presentMaterial(db.prepare('SELECT * FROM materials WHERE id = ?').get(m.id), true) };
  });

  route('DELETE', '/api/v1/materials/:id', ctx => {
    db.prepare('DELETE FROM materials WHERE id = ?').run(materialFor(ctx.user, ctx.params.id).id);
    return { ok: true };
  });

  // ---------- Пользователи (администратор) ----------

  route('GET', '/api/v1/people', ctx => {
    onlyAdmin(ctx.user);
    const rows = db.prepare('SELECT id, login, name, role, active, created_at FROM users ORDER BY active DESC, role, name').all();
    return { people: rows.map(r => ({ id: r.id, login: r.login, name: r.name, role: r.role, active: !!r.active, title: profileOf(r.id).title || '', createdAt: r.created_at })) };
  });

  route('POST', '/api/v1/people/invites', ctx => {
    onlyAdmin(ctx.user);
    if (demo) forbid('В демо новых специалистов не приглашаем');
    const name = text(ctx.body.name, 'Имя', { min: 1, max: 80 });
    const role = oneOf(ctx.body.role, [...SPECIALISTS, 'admin'], 'Роль');
    ctx.status = 201;
    return { token: createInvite(db, { name, role, createdBy: ctx.user.id }) };
  });

  route('PATCH', '/api/v1/people/:id', ctx => {
    onlyAdmin(ctx.user);
    if (demo) forbid('В демо состав не меняется');
    const target = userRow(intId(ctx.params.id, 'Пользователь'));
    if (!target) notFound('Пользователь не найден');
    if (target.id === ctx.user.id) invalid('Себя отключить нельзя');
    const active = ctx.body.active ? 1 : 0;
    tx(db, () => {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, target.id);
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    });
    return { ok: true };
  });

  // ---------- Уведомления ----------

  route('GET', '/api/v1/notifications', ctx => {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(ctx.user.id);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(ctx.user.id).n;
    return { unread, notifications: rows.map(n => ({ id: n.id, kind: n.kind, text: n.text, link: n.link, read: !!n.read_at, createdAt: n.created_at })) };
  });

  route('POST', '/api/v1/notifications/read', ctx => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), ctx.user.id);
    return { ok: true };
  });

  // ---------- Push ----------

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

  // ---------- Напоминания по расписанию ----------

  // Каждое напоминание отправляется один раз: ключ в таблице sent не даёт повторить его после перезапуска.
  function once(key, uid, day) {
    return db.prepare('INSERT OR IGNORE INTO sent (key, user_id, day, sent_at) VALUES (?, ?, ?, ?)').run(key, uid, day, now()).changes === 1;
  }

  async function processReminders(date = new Date()) {
    const p = localParts(date, tz);
    const day = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    const nm = p.h * 60 + p.min;
    const due = t => { const late = nm - minutesOf(t); return late >= 0 && late <= REMIND_WINDOW_MIN; };

    const meds = db.prepare('SELECT m.* FROM meds m JOIN users u ON u.id = m.user_id WHERE u.active = 1').all();
    for (const m of meds) {
      const days = json(m.days, []);
      if (days.length && !days.includes(weekday(day))) continue;
      for (const time of json(m.times, [])) {
        if (!due(time)) continue;
        if (db.prepare('SELECT 1 FROM med_intakes WHERE med_id = ? AND day = ? AND time = ?').get(m.id, day, time)) continue;
        if (!once(`med:${m.id}:${day}:${time}`, m.user_id, day)) continue;
        notify([m.user_id], 'remind', `Пора принять: ${m.name}${m.dose ? `, ${m.dose}` : ''} (${time})`, '#/today', { push: 'Пора принять лекарство' });
      }
    }

    const diary = db.prepare("SELECT p.user_id, p.diary_remind_at FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.active = 1 AND u.role = 'client' AND p.diary_remind_at IS NOT NULL").all();
    for (const d of diary) {
      if (!due(d.diary_remind_at)) continue;
      if (db.prepare('SELECT 1 FROM measurements WHERE user_id = ? AND day = ?').get(d.user_id, day)) continue;
      if (!once(`diary:${d.user_id}:${day}`, d.user_id, day)) continue;
      notify([d.user_id], 'remind', 'Заполните дневник за сегодня: это меньше минуты', '#/today', { push: 'Заполните дневник за сегодня' });
    }

    const soon = db.prepare('SELECT s.*, b.client_id FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE s.day = ?').all(day);
    for (const s of soon) {
      const left = minutesOf(s.time) - nm;
      if (left <= 0 || left > 60) continue;
      if (!once(`slot:${s.id}:${s.client_id}`, s.client_id, day)) continue;
      notify([s.client_id], 'remind', `Через час тренировка: ${s.kind} в ${s.time}`, '#/experts', { push: 'Скоро тренировка' });
    }
    await flushPush();
  }

  return { today, processReminders, notify };
}

module.exports = { register, ROLES, SPECIALISTS, SECTIONS, MATERIAL_KINDS, shiftDay };
