'use strict';
const path = require('node:path');
const { openDb, createApp, createUser } = require('../../../core');
const schema = require('./schema');
const { register, ROLES } = require('./api');
const { seed, resetDemo } = require('./seed');

const env = process.env;
const demo = env.DEMO === '1';
const port = Number(env.PORT || 8805);
const tz = env.APP_TZ || 'Europe/Moscow';
const dbFile = env.DB_FILE || path.join(__dirname, 'data', 'zachet.sqlite');
const filesDir = env.FILES_DIR || path.join(path.dirname(dbFile), 'files');
const seedDir = path.join(__dirname, 'seed_files');

async function main() {
  const db = openDb(dbFile, schema);
  const app = createApp({
    db,
    publicDir: path.join(__dirname, 'public'),
    sharedDir: path.join(__dirname, '..', '..', '..', 'core', 'public'),
    demo,
    roles: ROLES,
    trustProxy: env.TRUST_PROXY === '1',
    secureCookie: env.COOKIE_SECURE === '1',
  });
  const service = register(app, db, {
    demo, tz, filesDir, seedDir, pushHost: env.PUSH_TEST_HOST, pushSubject: env.PUSH_SUBJECT || 'https://myfreelab.ru',
  });

  const empty = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  if (empty && demo) await seed(db, service.today());
  if (empty && !demo) {
    if (!env.ADMIN_LOGIN || !env.ADMIN_PASSWORD) {
      console.error('Первый запуск: задайте ADMIN_LOGIN и ADMIN_PASSWORD в .env');
      process.exit(1);
    }
    await createUser(db, { login: env.ADMIN_LOGIN, name: env.ADMIN_NAME || 'Репетитор', role: 'tutor', password: env.ADMIN_PASSWORD });
    db.prepare("INSERT OR IGNORE INTO page (key, value) VALUES ('title', ?)").run(env.ADMIN_NAME ? `${env.ADMIN_NAME}, репетитор` : 'Репетитор');
  }
  if (demo) {
    setInterval(() => resetDemo(db, service.today(), filesDir).catch(e => console.error('Сброс демо не удался', e)), 24 * 3600e3).unref();
  }
  const tick = () => service.processReminders().catch(e => console.error('Напоминания:', e.message));
  setInterval(tick, Number(env.REMIND_TICK_MS || 60000)).unref();
  app.server.listen(port, env.HOST || '127.0.0.1', () => console.log(`Зачёт: порт ${port}${demo ? ', демо' : ''}`));
}

main().catch(e => { console.error(e); process.exit(1); });
