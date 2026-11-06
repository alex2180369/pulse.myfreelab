'use strict';
const path = require('node:path');
const { openDb, createApp, createUser } = require('../../../core');
const schema = require('./schema');
const { register, ROLES } = require('./api');
const { seed, resetDemo } = require('./seed');
const { startBot } = require('./bot');

const env = process.env;
const demo = env.DEMO === '1';
const port = Number(env.PORT || 8801);
const dbFile = env.DB_FILE || path.join(__dirname, 'data', 'tasks.sqlite');

async function main() {
  const db = openDb(dbFile, schema);
  const empty = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  if (empty && demo) await seed(db);
  if (empty && !demo) {
    if (!env.ADMIN_LOGIN || !env.ADMIN_PASSWORD) {
      console.error('Первый запуск: задайте ADMIN_LOGIN и ADMIN_PASSWORD в .env');
      process.exit(1);
    }
    await createUser(db, { login: env.ADMIN_LOGIN, name: env.ADMIN_NAME || 'Администратор', role: 'admin', password: env.ADMIN_PASSWORD });
  }

  const app = createApp({
    db,
    publicDir: path.join(__dirname, 'public'),
    sharedDir: path.join(__dirname, '..', '..', '..', 'core', 'public'),
    demo,
    roles: ROLES,
    trustProxy: env.TRUST_PROXY === '1',
    secureCookie: env.COOKIE_SECURE === '1',
    // Веб-клиент Telegram открывает приложение во фрейме.
    frameAncestors: env.BOT_TOKEN ? 'https://web.telegram.org' : "'none'",
  });
  register(app, db, { demo });

  let bot = null;
  if (env.BOT_TOKEN) {
    if (!env.PUBLIC_URL) { console.error('Для бота задайте PUBLIC_URL'); process.exit(1); }
    bot = startBot({
      db, app, port, demo,
      token: env.BOT_TOKEN,
      publicUrl: env.PUBLIC_URL.replace(/\/$/, ''),
      telegramBase: env.TELEGRAM_API || 'https://api.telegram.org',
      tz: env.APP_TZ || 'Europe/Moscow',
      tickMs: Number(env.BOT_TICK_MS || 30000),
      pollTimeout: Number(env.BOT_POLL_TIMEOUT || 25),
    });
  } else {
    app.route('GET', '/api/v1/telegram', () => ({ enabled: false }));
  }

  if (demo) {
    setInterval(() => resetDemo(db).catch(e => console.error('Сброс демо не удался', e)), 24 * 3600e3).unref();
  }
  app.server.listen(port, env.HOST || '127.0.0.1', () => {
    console.log(`Пульс задач: порт ${port}${demo ? ', демо' : ''}`);
    bot?.start();
  });
}

main().catch(e => { console.error(e); process.exit(1); });
