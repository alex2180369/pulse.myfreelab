'use strict';
// «Тонус»: границы подсказок по анализам и напоминания по расписанию, без сети.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, createApp, createUser } = require('../core');
const R = require('../cases/04_zdorovie/app/rules');
const { register } = require('../cases/04_zdorovie/app/api');

test('глюкоза: каждая граница диапазона', () => {
  const level = v => R.labVerdict('glucose', v).level;
  assert.equal(level(3.2), 'low');
  assert.equal(level(3.3), 'ok');
  assert.equal(level(5.5), 'ok');
  assert.equal(level(5.6), 'warn');
  assert.equal(level(6.9), 'warn');
  assert.equal(level(7.0), 'bad');
  assert.equal(level(0.1 + 5.5), 'warn', '5.6 из суммы с погрешностью не уходит в норму');
});

test('холестерин: каждая граница диапазона', () => {
  const level = v => R.labVerdict('cholesterol', v).level;
  assert.equal(level(5.1), 'ok');
  assert.equal(level(5.2), 'warn');
  assert.equal(level(6.1), 'warn');
  assert.equal(level(6.2), 'bad');
});

test('гемоглобин: нормы для женщин и мужчин, без пола подсказки нет', () => {
  const level = (v, sex) => R.labVerdict('hemoglobin', v, sex).level;
  assert.equal(level(119, 'f'), 'warn');
  assert.equal(level(120, 'f'), 'ok');
  assert.equal(level(150, 'f'), 'ok');
  assert.equal(level(151, 'f'), 'warn');
  assert.equal(level(129, 'm'), 'warn');
  assert.equal(level(130, 'm'), 'ok');
  assert.equal(level(170, 'm'), 'ok');
  assert.equal(level(171, 'm'), 'warn');
  assert.equal(level(125, null), 'unknown');
  assert.equal(R.labVerdict('unknown', 1), null);
});

test('ИМТ и давление', () => {
  assert.equal(R.bmi(70, 170), 24.2);
  assert.equal(R.bmi(70, null), null);
  assert.equal(R.bmiLabel(18.4), 'ниже нормы');
  assert.equal(R.bmiLabel(25), 'выше нормы');
  assert.equal(R.highPressure(139, 89), false);
  assert.equal(R.highPressure(140, 70), true);
  assert.equal(R.highPressure(120, 90), true);
});

// Сервис без HTTP: те же правила, что на сервере, время подставляем сами.
async function service() {
  const db = openDb(':memory:', require('../cases/04_zdorovie/app/schema'));
  const app = createApp({ db, publicDir: __dirname, roles: ['client'] });
  const svc = register(app, db, { demo: false, tz: 'UTC', filesDir: '/tmp/tonus-none', seedDir: '/tmp/tonus-none' });
  const uid = await createUser(db, { login: 'c1', name: 'Клиент', role: 'client', password: 'password123' });
  db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(uid);
  return { db, svc, uid };
}
const at = (day, time) => new Date(`${day}T${time}:00Z`);
const notes = (db, uid) => db.prepare("SELECT text FROM notifications WHERE user_id = ? AND kind = 'remind' ORDER BY id").all(uid).map(r => r.text);

test('лекарство: напоминание в своё время один раз и не после отметки', async () => {
  const { db, svc, uid } = await service();
  const day = '2026-11-10';
  const med = Number(db.prepare(`INSERT INTO meds (user_id, name, dose, times, days, created_at) VALUES (?, 'Витамин D', '1 капсула', '["09:00","21:00"]', '[]', 'x')`).run(uid).lastInsertRowid);
  await svc.processReminders(at(day, '08:59'));
  assert.equal(notes(db, uid).length, 0, 'раньше времени нет');
  await svc.processReminders(at(day, '09:05'));
  await svc.processReminders(at(day, '09:06'));
  assert.deepEqual(notes(db, uid), ['Пора принять: Витамин D, 1 капсула (09:00)'], 'ровно один раз');
  db.prepare("INSERT INTO med_intakes (med_id, day, time, taken_at) VALUES (?, ?, '21:00', 'x')").run(med, day);
  await svc.processReminders(at(day, '21:01'));
  assert.equal(notes(db, uid).length, 1, 'после отметки не напоминаем');
  await svc.processReminders(at('2026-11-11', '11:30'));
  assert.equal(notes(db, uid).length, 1, 'сильно опоздавшее не шлём');
});

test('лекарство по дням недели', async () => {
  const { db, svc, uid } = await service();
  // 2026-11-10 — вторник (2), 2026-11-11 — среда (3).
  db.prepare(`INSERT INTO meds (user_id, name, dose, times, days, created_at) VALUES (?, 'Омега', '', '["10:00"]', '[3]', 'x')`).run(uid);
  await svc.processReminders(at('2026-11-10', '10:01'));
  assert.equal(notes(db, uid).length, 0);
  await svc.processReminders(at('2026-11-11', '10:01'));
  assert.equal(notes(db, uid).length, 1);
});

test('дневник: напоминание только если за день ничего нет', async () => {
  const { db, svc, uid } = await service();
  db.prepare("UPDATE profiles SET diary_remind_at = '20:00' WHERE user_id = ?").run(uid);
  db.prepare("INSERT INTO measurements (user_id, day, metric, v1, updated_at) VALUES (?, '2026-11-10', 'weight', 70, 'x')").run(uid);
  await svc.processReminders(at('2026-11-10', '20:10'));
  assert.equal(notes(db, uid).length, 0);
  await svc.processReminders(at('2026-11-11', '20:10'));
  await svc.processReminders(at('2026-11-11', '20:20'));
  assert.equal(notes(db, uid).length, 1);
});

test('тренировка: напоминание за час', async () => {
  const { db, svc, uid } = await service();
  const tr = await createUser(db, { login: 't1', name: 'Тренер', role: 'trainer', password: 'password123' });
  const sid = Number(db.prepare(`INSERT INTO slots (trainer_id, day, time, minutes, kind, capacity, created_at) VALUES (?, '2026-11-10', '18:00', 60, 'Йога', 5, 'x')`).run(tr).lastInsertRowid);
  db.prepare("INSERT INTO bookings (slot_id, client_id, created_at) VALUES (?, ?, 'x')").run(sid, uid);
  await svc.processReminders(at('2026-11-10', '16:30'));
  assert.equal(notes(db, uid).length, 0, 'за полтора часа рано');
  await svc.processReminders(at('2026-11-10', '17:05'));
  await svc.processReminders(at('2026-11-10', '17:30'));
  assert.deepEqual(notes(db, uid), ['Через час тренировка: Йога в 18:00']);
});

test('отключённому пользователю напоминания не идут', async () => {
  const { db, svc, uid } = await service();
  db.prepare(`INSERT INTO meds (user_id, name, dose, times, days, created_at) VALUES (?, 'Витамин', '', '["09:00"]', '[]', 'x')`).run(uid);
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(uid);
  await svc.processReminders(at('2026-11-10', '09:01'));
  assert.equal(notes(db, uid).length, 0);
});
