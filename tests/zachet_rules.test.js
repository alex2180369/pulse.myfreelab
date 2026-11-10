'use strict';
// «Зачёт»: автопроверка на границах и напоминания по расписанию, без сети.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, createApp, createUser } = require('../core');
const G = require('../cases/05_repetitor/app/grading');
const { register } = require('../cases/05_repetitor/app/api');

test('короткий ответ: регистр, ё, пробелы, запятая, числа', () => {
  assert.equal(G.sameShort('  Ёлка ', ['елка']), true);
  assert.equal(G.sameShort('0,5', ['0.5']), true);
  assert.equal(G.sameShort('0.50', ['0.5']), true);
  assert.equal(G.sameShort('-3', ['−3']), false, 'длинное тире не минус: репетитор указывает оба написания');
  assert.equal(G.sameShort('1 000', ['1000']), true);
  assert.equal(G.sameShort('', ['0']), false, 'пустой ответ не равен нулю');
  assert.equal(G.sameShort('0', ['0']), true);
  assert.equal(G.sameShort('5x', ['5']), false);
  assert.equal(G.sameShort('1/2', ['0.5', '1/2']), true, 'одно из нескольких написаний');
});

test('один и несколько ответов', () => {
  const single = { id: 1, kind: 'single', options: ['a', 'b'], correct: 1, points: 2 };
  assert.deepEqual(G.check(single, 1), { correct: true, points: 2 });
  assert.deepEqual(G.check(single, 0), { correct: false, points: 0 });
  assert.deepEqual(G.check(single, '1'), { correct: false, points: 0 }, 'строка вместо номера не засчитывается');
  const multi = { id: 2, kind: 'multi', options: ['a', 'b', 'c'], correct: [0, 2], points: 2 };
  assert.equal(G.check(multi, [2, 0]).points, 2, 'порядок не важен');
  assert.equal(G.check(multi, [0]).points, 0, 'неполный выбор');
  assert.equal(G.check(multi, [0, 1, 2]).points, 0, 'лишний вариант');
  assert.equal(G.check(multi, undefined).points, 0);
});

test('итог: развёрнутый ждёт, после оценки считается', () => {
  const qs = [{ id: 1, kind: 'single', correct: 0, points: 1 }, { id: 2, kind: 'long', points: 3 }];
  const first = G.grade(qs, { 1: 0, 2: 'текст' });
  assert.deepEqual([first.score, first.max, first.pending], [1, 4, 1]);
  const done = G.grade(qs, { 1: 0, 2: 'текст' }, { 2: 0 });
  assert.deepEqual([done.score, done.pending], [1, 0], 'ноль баллов — тоже оценка');
  assert.equal(G.percent(1, 3), 33);
  assert.equal(G.percent(0, 0), null);
});

async function service() {
  const db = openDb(':memory:', require('../cases/05_repetitor/app/schema'));
  const app = createApp({ db, publicDir: __dirname, roles: ['tutor', 'student', 'parent'] });
  const svc = register(app, db, { demo: false, tz: 'UTC', filesDir: '/tmp/zachet-none', seedDir: '/tmp/zachet-none' });
  const sid = await createUser(db, { login: 's1', name: 'Ученик', role: 'student', password: 'password123' });
  const pid = await createUser(db, { login: 'p1', name: 'Родитель', role: 'parent', password: 'password123' });
  db.prepare('INSERT INTO parent_links (parent_id, student_id) VALUES (?, ?)').run(pid, sid);
  return { db, svc, sid, pid };
}
const at = (day, time) => new Date(`${day}T${time}:00Z`);
const notes = (db, uid) => db.prepare("SELECT text FROM notifications WHERE user_id = ? AND kind = 'remind' ORDER BY id").all(uid).map(r => r.text);

test('занятие: напоминание за 2 часа ученику и родителю, один раз', async () => {
  const { db, svc, sid, pid } = await service();
  db.prepare("INSERT INTO lessons (student_id, day, time, minutes, format, created_at) VALUES (?, '2026-11-10', '17:00', 60, 'online', 'x')").run(sid);
  db.prepare("INSERT INTO lessons (student_id, day, time, minutes, format, status, created_at) VALUES (?, '2026-11-10', '18:00', 60, 'online', 'cancelled', 'x')").run(sid);
  await svc.processReminders(at('2026-11-10', '14:30'));
  assert.equal(notes(db, sid).length, 0, 'за 2,5 часа рано');
  await svc.processReminders(at('2026-11-10', '15:10'));
  await svc.processReminders(at('2026-11-10', '16:00'));
  assert.deepEqual(notes(db, sid), ['Сегодня занятие в 17:00, онлайн'], 'отменённое не напоминаем, повтора нет');
  assert.equal(notes(db, pid).length, 1, 'родителю тоже');
});

test('срок завтра: вечером накануне и только если не сдано', async () => {
  const { db, svc, sid } = await service();
  const a1 = Number(db.prepare("INSERT INTO assignments (title, due_day, created_at) VALUES ('Степени', '2026-11-11', 'x')").run().lastInsertRowid);
  const a2 = Number(db.prepare("INSERT INTO assignments (title, due_day, created_at) VALUES ('Корни', '2026-11-11', 'x')").run().lastInsertRowid);
  for (const a of [a1, a2]) db.prepare("INSERT INTO assignment_students (assignment_id, student_id, assigned_at) VALUES (?, ?, 'x')").run(a, sid);
  db.prepare("INSERT INTO submissions (assignment_id, student_id, status, updated_at) VALUES (?, ?, 'submitted', 'x')").run(a2, sid);
  await svc.processReminders(at('2026-11-10', '12:00'));
  assert.equal(notes(db, sid).length, 0, 'днём рано');
  await svc.processReminders(at('2026-11-10', '17:05'));
  await svc.processReminders(at('2026-11-10', '20:00'));
  assert.deepEqual(notes(db, sid), ['Завтра срок сдачи: «Степени»']);
});
