'use strict';
const path = require('node:path');
const { openDb, createApp, createUser } = require('../../../core');
const schema = require('./schema');
const { register, ROLES } = require('./api');
const { seed, resetDemo } = require('./seed');

const env = process.env;
const demo = env.DEMO === '1';
const port = Number(env.PORT || 8803);
const tz = env.APP_TZ || 'Europe/Moscow';
const dbFile = env.DB_FILE || path.join(__dirname, 'data', 'prorab.sqlite');
const photosDir = env.PHOTOS_DIR || path.join(path.dirname(dbFile), 'photos');
const seedDir = path.join(__dirname, 'seed_photos');

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
  const service = register(app, db, { demo, tz, photosDir, seedDir });

  const empty = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  if (empty && demo) await seed(db, service.today());
  if (empty && !demo) {
    if (!env.ADMIN_LOGIN || !env.ADMIN_PASSWORD) {
      console.error('Первый запуск: задайте ADMIN_LOGIN и ADMIN_PASSWORD в .env');
      process.exit(1);
    }
    await createUser(db, { login: env.ADMIN_LOGIN, name: env.ADMIN_NAME || 'Директор', role: 'director', password: env.ADMIN_PASSWORD });
  }
  if (demo) {
    setInterval(() => resetDemo(db, service.today(), photosDir).catch(e => console.error('Сброс демо не удался', e)), 24 * 3600e3).unref();
  }
  app.server.listen(port, env.HOST || '127.0.0.1', () => console.log(`Прораб: порт ${port}${demo ? ', демо' : ''}`));
}

main().catch(e => { console.error(e); process.exit(1); });
