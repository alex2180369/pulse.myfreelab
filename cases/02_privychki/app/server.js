'use strict';
const path = require('node:path');
const { openDb, createApp } = require('../../../core');
const schema = require('./schema');
const { register } = require('./api');

const env = process.env;
const sandboxMode = env.SANDBOX === '1';
const port = Number(env.PORT || 8802);
const dbFile = env.DB_FILE || path.join(__dirname, 'data', 'habits.sqlite');

const db = openDb(dbFile, schema);
const app = createApp({
  db,
  publicDir: path.join(__dirname, 'public'),
  sharedDir: path.join(__dirname, '..', '..', '..', 'core', 'public'),
  roles: ['user'],
  trustProxy: env.TRUST_PROXY === '1',
  secureCookie: env.COOKIE_SECURE === '1',
});

const service = register(app, db, {
  sandboxMode,
  pushHost: env.PUSH_TEST_HOST,
  pushSubject: env.PUSH_SUBJECT || 'https://myfreelab.ru',
});

const tick = () => service.processReminders().catch(e => console.error('Напоминания:', e.message));
setInterval(tick, Number(env.REMIND_TICK_MS || 60000)).unref();
if (sandboxMode) {
  service.cleanupSandboxes();
  setInterval(() => service.cleanupSandboxes(), Number(env.SANDBOX_CLEAN_MS || 3600e3)).unref();
}

app.server.listen(port, env.HOST || '127.0.0.1', () => console.log(`Серия: порт ${port}${sandboxMode ? ', песочница' : ''}`));
