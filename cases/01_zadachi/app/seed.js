'use strict';
// Выдуманная команда для демо. Сроки считаются от текущего момента, поэтому демо всегда выглядит свежим.
const crypto = require('node:crypto');
const { createUser, now, tx } = require('../../../core');

const PEOPLE = [
  ['elena', 'Елена Соколова', 'admin'],
  ['maxim', 'Максим Орлов', 'lead'],
  ['darya', 'Дарья Ким', 'member'],
  ['ilya', 'Илья Марков', 'member'],
  ['sofia', 'София Беляева', 'member'],
];

const hours = h => new Date(Date.now() + h * 36e5).toISOString();

const PROJECTS = [
  { key: 'site', name: 'Новый сайт студии', description: 'Запуск к концу месяца', owner: 'maxim', members: ['maxim', 'darya', 'ilya'] },
  { key: 'clients', name: 'Работа с клиентами', description: 'Договоры, счета и обратная связь', owner: 'maxim', members: ['maxim', 'sofia', 'darya'] },
  { key: 'ops', name: 'Внутренние дела', description: 'Порядок в команде', owner: 'elena', members: ['elena', 'sofia'] },
];

const TASKS = [
  ['site', 'Собрать тексты для главной', 'done', 'normal', 'sofia', -70],
  ['site', 'Согласовать макет главной страницы', 'review', 'high', 'darya', 5],
  ['site', 'Сверстать блок с кейсами', 'progress', 'normal', 'ilya', 30],
  ['site', 'Подключить форму заявки', 'new', 'high', 'ilya', -6],
  ['site', 'Проверить сайт на телефонах', 'new', 'normal', 'darya', 96],
  ['clients', 'Подготовить договор для «Северного ветра»', 'progress', 'high', 'sofia', 4],
  ['clients', 'Выставить счёт за октябрь', 'done', 'normal', 'sofia', -48],
  ['clients', 'Созвониться с заказчиком по правкам', 'new', 'normal', 'darya', 22],
  ['clients', 'Собрать отзывы за квартал', 'review', 'low', 'darya', 72],
  ['ops', 'Обновить шаблон отчёта', 'new', 'low', 'sofia', 160],
  ['ops', 'Продлить домен и хостинг', 'progress', 'high', 'elena', -2],
  ['site', 'Утвердить план запуска', 'progress', 'high', 'maxim', 7],
  ['clients', 'Ответить на письмо заказчика', 'new', 'normal', 'maxim', -3],
  ['clients', 'Подготовить предложение на декабрь', 'new', 'low', 'maxim', 120],
];

async function seed(db) {
  const ids = {};
  for (const [login, name, role] of PEOPLE) {
    // Пароль случайный и нигде не хранится: в демо входят кнопкой.
    ids[login] = await createUser(db, { login, name, role, password: crypto.randomBytes(18).toString('base64') });
  }
  tx(db, () => {
    const projects = {};
    for (const p of PROJECTS) {
      const r = db.prepare('INSERT INTO projects (name, description, owner_id, created_at) VALUES (?, ?, ?, ?)')
        .run(p.name, p.description, ids[p.owner], now());
      projects[p.key] = Number(r.lastInsertRowid);
      for (const m of p.members) {
        db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)').run(projects[p.key], ids[m]);
      }
    }
    TASKS.forEach(([project, title, status, priority, who, dueIn], i) => {
      const r = db.prepare(`INSERT INTO tasks
        (project_id, title, status, priority, assignee_id, creator_id, due_at, position, done_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projects[project], title, status, priority, ids[who], ids.maxim, hours(dueIn), i + 1,
          status === 'done' ? hours(dueIn) : null, hours(-120), now());
      const taskId = Number(r.lastInsertRowid);
      db.prepare("INSERT INTO task_history (task_id, user_id, action, created_at) VALUES (?, ?, 'created', ?)").run(taskId, ids.maxim, hours(-120));
    });
    const first = db.prepare("SELECT id FROM tasks WHERE title LIKE 'Согласовать макет%'").get().id;
    db.prepare('INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(first, ids.darya, 'Макет готов, жду решения по цвету кнопки.', hours(-3));
    db.prepare('INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(first, ids.maxim, 'Смотрю сегодня, вернусь до вечера.', hours(-2));
  });
}

// Сброс демо: всё, что посетители изменили за день, удаляется.
async function resetDemo(db) {
  db.exec(`
    DELETE FROM sessions; DELETE FROM invites; DELETE FROM user_settings; DELETE FROM comments;
    DELETE FROM tg_links; DELETE FROM tg_codes; DELETE FROM reminders_sent; DELETE FROM bot_state WHERE key = 'history_id';
    DELETE FROM task_history; DELETE FROM tasks; DELETE FROM project_members; DELETE FROM projects; DELETE FROM users;
  `);
  await seed(db);
}

module.exports = { seed, resetDemo };
