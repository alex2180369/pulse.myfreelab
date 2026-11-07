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
