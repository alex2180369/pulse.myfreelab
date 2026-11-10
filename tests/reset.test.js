'use strict';
// Ночной сброс демо: обе песочницы с общими данными должны пересобираться без ошибок.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../core');

test('Пульс задач: сброс возвращает исходное демо и убирает следы посетителей', async () => {
  const { seed, resetDemo } = require('../cases/01_zadachi/app/seed');
  const db = openDb(':memory:', require('../cases/01_zadachi/app/schema'));
  await seed(db);
  const tasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  const user = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare("INSERT INTO tasks (title, creator_id, created_at, updated_at) VALUES ('Мусор посетителя', ?, 'x', 'x')").run(user);
  db.prepare('INSERT INTO tg_links (tg_id, user_id, chat_id) VALUES (1, ?, 1)').run(user);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h', ?, '2999')").run(user);
  await resetDemo(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, tasks);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Мусор%'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tg_links').get().n, 0, 'номера чатов удалены');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('Прораб: сброс возвращает демо и удаляет загруженные фото', async () => {
  const { seed, resetDemo } = require('../cases/03_stroyka/app/seed');
  const db = openDb(':memory:', require('../cases/03_stroyka/app/schema'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-reset-'));
  await seed(db, '2026-11-07');
  const counts = () => ['sites', 'tasks', 'reports', 'photos', 'qc_items', 'notifications'].map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  const start = counts();
  assert.ok(start.every(n => n > 0), 'демо не пустое');
  fs.writeFileSync(path.join(dir, 'upload'), 'x');
  const site = db.prepare('SELECT id FROM sites LIMIT 1').get().id;
  db.prepare("INSERT INTO photos (site_id, file, type, size, day, created_at) VALUES (?, 'upload', 'image/jpeg', 1, '2026-11-07', 'x')").run(site);
  await resetDemo(db, '2026-11-08', dir);
  assert.deepEqual(counts(), start);
  assert.equal(fs.existsSync(dir), false, 'загруженные файлы удалены');
  const seedFiles = new Set(fs.readdirSync(path.join(__dirname, '../cases/03_stroyka/app/seed_photos')));
  for (const { file } of db.prepare('SELECT file FROM photos').all()) assert.ok(seedFiles.has(file), `файл демо есть: ${file}`);
  assert.ok(db.prepare("SELECT 1 FROM reports WHERE day = '2026-11-08'").get(), 'даты пересчитаны от нового дня');
});

test('Тонус: сброс возвращает демо и удаляет файлы посетителей', async () => {
  const { seed, resetDemo } = require('../cases/04_zdorovie/app/seed');
  const db = openDb(':memory:', require('../cases/04_zdorovie/app/schema'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tonus-reset-'));
  await seed(db, '2026-11-09');
  const tables = ['users', 'profiles', 'measurements', 'goals', 'labs', 'lab_values', 'lab_files', 'meds', 'requests', 'access', 'slots', 'bookings', 'materials', 'notifications'];
  const counts = () => tables.map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  const start = counts();
  assert.ok(start.every(n => n > 0), 'демо не пустое');
  const anna = db.prepare("SELECT id FROM users WHERE login = 'anna'").get().id;
  db.prepare("INSERT INTO measurements (user_id, day, metric, v1, updated_at) VALUES (?, '2026-11-09', 'pulse', 999, 'x')").run(anna);
  db.prepare("INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES ('https://fcm.googleapis.com/x', ?, 'k', 'a', 'x')").run(anna);
  fs.writeFileSync(path.join(dir, 'upload'), 'x');
  await resetDemo(db, '2026-11-10', dir);
  // Число записей зависит от дня недели, поэтому сравниваем со свежим демо того же дня.
  const fresh = openDb(':memory:', require('../cases/04_zdorovie/app/schema'));
  await seed(fresh, '2026-11-10');
  assert.deepEqual(counts(), tables.map(t => fresh.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM measurements WHERE v1 = 999').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0, 'подписки посетителей удалены');
  assert.equal(fs.existsSync(dir), false, 'загруженные файлы удалены');
  const seedFiles = new Set(fs.readdirSync(path.join(__dirname, '../cases/04_zdorovie/app/seed_files')));
  for (const { file } of db.prepare('SELECT file FROM lab_files').all()) assert.ok(seedFiles.has(file), `файл демо есть: ${file}`);
  assert.ok(db.prepare("SELECT 1 FROM measurements WHERE day = '2026-11-10'").get(), 'даты пересчитаны от нового дня');
  assert.equal(db.prepare("SELECT login FROM users WHERE role = 'client' ORDER BY id LIMIT 1").get().login, 'anna', 'демо-вход ведёт к Анне');
});

test('Зачёт: сброс возвращает демо и удаляет файлы посетителей', async () => {
  const { seed, resetDemo } = require('../cases/05_repetitor/app/seed');
  const schema = require('../cases/05_repetitor/app/schema');
  const db = openDb(':memory:', schema);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zachet-reset-'));
  await seed(db, '2026-11-10');
  const tables = ['users', 'students', 'parent_links', 'page', 'files', 'materials', 'assignments', 'questions', 'assignment_students', 'submissions', 'lessons', 'notifications'];
  const counts = d => tables.map(t => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  assert.ok(counts(db).every(n => n > 0), 'демо не пустое');
  db.prepare("INSERT INTO leads (name, contact, consent_at, created_at) VALUES ('Посетитель', '+7', 'x', 'x')").run();
  db.prepare("INSERT INTO files (kind, file, name, type, size, created_at) VALUES ('answer', 'upload', 'x', 'image/png', 1, 'x')").run();
  fs.writeFileSync(path.join(dir, 'upload'), 'x');
  await resetDemo(db, '2026-11-11', dir);
  const fresh = openDb(':memory:', schema);
  await seed(fresh, '2026-11-11');
  assert.deepEqual(counts(db), counts(fresh));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0, 'заявки посетителей удалены');
  assert.equal(fs.existsSync(dir), false, 'загруженные файлы удалены');
  const seedFiles = new Set(fs.readdirSync(path.join(__dirname, '../cases/05_repetitor/app/seed_files')));
  for (const { file } of db.prepare('SELECT file FROM files').all()) assert.ok(seedFiles.has(file), `файл демо есть: ${file}`);
  assert.equal(db.prepare("SELECT login FROM users WHERE role = 'student' ORDER BY id LIMIT 1").get().login, 'danya', 'демо-вход ученика ведёт к Дане');
  assert.equal(db.prepare("SELECT login FROM users WHERE role = 'parent' ORDER BY id LIMIT 1").get().login, 'smirnova', 'родитель — мама Дани');
  assert.ok(db.prepare("SELECT 1 FROM submissions WHERE status = 'submitted'").get(), 'у репетитора есть работы на проверку');
  assert.ok(db.prepare("SELECT 1 FROM lessons WHERE moved_from IS NOT NULL").get(), 'есть перенесённое занятие');
});
