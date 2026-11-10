'use strict';
// Общее ядро пяти трекеров: HTTP-сервер, маршруты, база, вход, сессии, защита.
// Без сторонних пакетов: нужен только Node 22 со встроенной SQLite.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const MAX_BODY = 256 * 1024;

class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}
const forbid = (message = 'Недостаточно прав') => { throw new HttpError(403, 'forbidden', message); };
const notFound = (message = 'Не найдено') => { throw new HttpError(404, 'not_found', message); };
const invalid = (message, fields) => { throw new HttpError(400, 'invalid', message, fields); };

// ---------- База ----------

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`;

function openDb(file, schema = '') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(CORE_SCHEMA);
  if (schema) db.exec(schema);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const now = () => new Date().toISOString();
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

// ---------- Пароли и сессии ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function createSession(db, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  return token;
}

function sessionUser(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.login, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `).get(sha256(token), now()) || null;
}

// ---------- Защита от подбора ----------

class Limiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  blocked(key) {
    const t = Date.now();
    const list = (this.hits.get(key) || []).filter(x => t - x < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list.length >= this.limit;
  }
  hit(key) {
    const list = this.hits.get(key) || [];
    list.push(Date.now());
    this.hits.set(key, list);
  }
  clear(key) { this.hits.delete(key); }
}

// ---------- Проверка входных данных ----------

function text(v, name, { min = 0, max = 500 } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') invalid(`Поле «${name}» должно быть текстом`);
  const s = v.trim();
  if (s.length < min) invalid(min === 1 ? `Заполните поле «${name}»` : `Поле «${name}»: минимум ${min} симв.`);
  if (s.length > max) invalid(`Поле «${name}»: максимум ${max} симв.`);
  return s;
}

function oneOf(v, list, name) {
  if (!list.includes(v)) invalid(`Недопустимое значение поля «${name}»`);
  return v;
}

function intId(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) invalid(`Недопустимое значение поля «${name}»`);
  return n;
}

function isoDate(v, name) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) invalid(`Недопустимая дата в поле «${name}»`);
  return d.toISOString();
}

const validLogin = v => {
  const s = text(v, 'Логин', { min: 3, max: 40 });
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) invalid('Логин: только латиница, цифры, точка, дефис и подчёркивание');
  return s;
};
const validPassword = v => {
  if (typeof v !== 'string' || v.length < 8) invalid('Пароль: минимум 8 символов');
  if (v.length > 200) invalid('Пароль слишком длинный');
  return v;
};

// ---------- Сервер ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large', 'Слишком большой запрос'));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function compile(pattern) {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { re, names };
}

function createApp({ db, publicDir, sharedDir, demo = false, trustProxy = false, secureCookie = false, roles, frameAncestors = "'none'" }) {
  const routes = [];
  const loginLimit = new Limiter(8, 15 * 60e3);
  const ipLimit = new Limiter(40, 15 * 60e3);
  const inviteLimit = new Limiter(20, 15 * 60e3);

  const route = (method, pattern, handler, opts = {}) => {
    routes.push({ method, ...compile(pattern), handler, public: !!opts.public, upload: opts.upload || null });
  };

  const clientIp = req => (trustProxy && req.headers['x-real-ip']) || req.socket.remoteAddress || '';
  const isSecure = req => secureCookie || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const setSession = (ctx, token, maxAge) => {
    const parts = [`sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (isSecure(ctx.req)) parts.push('Secure');
    ctx.headers['Set-Cookie'] = parts.join('; ');
  };

  // Вход и профиль одинаковы во всех трекерах.
  route('POST', '/api/v1/auth/login', async ctx => {
    const login = text(ctx.body.login, 'Логин', { min: 1, max: 40 }).toLowerCase();
    const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
    const key = `${ctx.ip}|${login}`;
    if (loginLimit.blocked(key) || ipLimit.blocked(ctx.ip)) {
      throw new HttpError(429, 'too_many', 'Слишком много попыток. Подождите 15 минут.');
    }
    const user = db.prepare('SELECT * FROM users WHERE login = ? AND active = 1').get(login);
    // Для несуществующего логина считаем хеш впустую: по времени ответа логин не угадать.
    let ok = false;
    if (user) ok = await verifyPassword(password, user.password_hash);
    else await scrypt(password, 'tracker-dummy-salt', 32);
    if (!ok) {
      loginLimit.hit(key);
      ipLimit.hit(ctx.ip);
      throw new HttpError(401, 'bad_login', 'Неверный логин или пароль');
    }
    loginLimit.clear(key);
    const token = createSession(db, user.id);
    setSession(ctx, token, SESSION_DAYS * 86400);
    return { user: publicUser(user), ...(ctx.body.bearer ? { token } : {}) };
  }, { public: true });

  route('POST', '/api/v1/auth/logout', ctx => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(ctx.token));
    setSession(ctx, '', 0);
    return { ok: true };
  });

  if (demo) {
    route('POST', '/api/v1/auth/demo', ctx => {
      const role = oneOf(ctx.body.role, roles, 'Роль');
      const user = db.prepare('SELECT * FROM users WHERE role = ? AND active = 1 ORDER BY id LIMIT 1').get(role);
      if (!user) notFound('Демо-пользователь не найден');
      const token = createSession(db, user.id);
      setSession(ctx, token, 86400);
      return { user: publicUser(user), ...(ctx.body.bearer ? { token } : {}) };
    }, { public: true });
  }

  route('GET', '/api/v1/auth/config', () => ({ demo, roles }), { public: true });

  route('GET', '/api/v1/auth/invite/:token', ctx => {
    if (inviteLimit.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Слишком много попыток. Подождите 15 минут.');
    const invite = activeInvite(ctx.params.token);
    if (!invite) { inviteLimit.hit(ctx.ip); notFound('Приглашение недействительно или устарело'); }
    return { name: invite.name, role: invite.role };
  }, { public: true });

  route('POST', '/api/v1/auth/invite/:token', async ctx => {
    if (demo) forbid('В демо новые участники не регистрируются');
    if (inviteLimit.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Слишком много попыток. Подождите 15 минут.');
    const login = validLogin(ctx.body.login).toLowerCase();
    const password = validPassword(ctx.body.password);
    const hash = await hashPassword(password);
    const user = tx(db, () => {
      const invite = activeInvite(ctx.params.token);
      if (!invite) { inviteLimit.hit(ctx.ip); notFound('Приглашение недействительно или устарело'); }
      if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) invalid('Такой логин уже занят');
      const r = db.prepare('INSERT INTO users (login, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(login, invite.name, invite.role, hash, now());
      db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(now(), sha256(ctx.params.token));
      return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
    });
    setSession(ctx, createSession(db, user.id), SESSION_DAYS * 86400);
    return { user: publicUser(user) };
  }, { public: true });

  function activeInvite(token) {
    return db.prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(sha256(token), now());
  }

  route('GET', '/api/v1/me', ctx => ({ user: ctx.user, demo }));

  route('PATCH', '/api/v1/me', ctx => {
    if (demo) forbid('В демо профиль не меняется');
    const name = text(ctx.body.name, 'Имя', { min: 1, max: 80 });
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, ctx.user.id);
    return { user: { ...ctx.user, name } };
  });

  route('POST', '/api/v1/me/password', async ctx => {
    if (demo) forbid('В демо пароль не меняется');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id);
    const old = typeof ctx.body.old === 'string' ? ctx.body.old : '';
    if (!await verifyPassword(old, row.password_hash)) invalid('Текущий пароль указан неверно');
    const hash = await hashPassword(validPassword(ctx.body.new));
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, ctx.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(ctx.user.id, sha256(ctx.token));
    });
    return { ok: true };
  });

  async function handleApi(req, res, url) {
    const ctx = { req, url, query: url.searchParams, ip: clientIp(req), headers: {}, status: 200, db, body: {} };
    try {
      const pathMatches = routes.filter(r => r.re.test(url.pathname));
      if (!pathMatches.length) notFound();
      const r = pathMatches.find(x => x.method === req.method);
      if (!r) throw new HttpError(405, 'method', 'Метод не поддерживается');
      const m = r.re.exec(url.pathname);
      ctx.params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));

      const cookies = parseCookies(req.headers.cookie);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      ctx.token = bearer ? bearer[1] : cookies.sid;
      ctx.user = sessionUser(db, ctx.token);
      if (!r.public && !ctx.user) throw new HttpError(401, 'unauthorized', 'Войдите в систему');

      if (req.method !== 'GET') {
        // Защита от подделки запросов с чужих сайтов: только JSON (или разрешённый файл) и только со своего адреса.
        const type = String(req.headers['content-type'] || '').split(';')[0].trim();
        if (r.upload) {
          if (!r.upload.types.includes(type)) throw new HttpError(415, 'bad_type', 'Этот формат не поддерживается');
          const declared = Number(req.headers['content-length']);
          if (declared > r.upload.maxBytes) throw new HttpError(413, 'too_large', 'Файл слишком большой');
        } else if (type !== 'application/json') {
          throw new HttpError(415, 'bad_type', 'Нужен JSON');
        }
        const origin = req.headers.origin;
        if (origin && !bearer) {
          const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
          let originHost = '';
          try { originHost = new URL(origin).host; } catch {}
          if (originHost !== host) forbid('Запрос с чужого сайта');
        }
        if (r.upload) {
          ctx.file = await readBody(req, r.upload.maxBytes);
          ctx.fileType = type;
        } else {
          const raw = (await readBody(req)).toString('utf8');
          if (raw) {
            try { ctx.body = JSON.parse(raw); } catch { invalid('Некорректный JSON'); }
            if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) invalid('Некорректный JSON');
          }
        }
      }
      const result = await r.handler(ctx);
      if (ctx.sendFile) {
        const data = await fs.promises.readFile(ctx.sendFile.path).catch(() => null);
        if (!data) notFound('Файл не найден');
        // Файл нельзя выполнить как страницу, даже если под видом картинки загрузили что-то другое.
        // Документы, которые браузер не показывает как картинку, отдаются на скачивание.
        const disposition = ctx.sendFile.download
          ? `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(ctx.sendFile.download)}`
          : ctx.sendFile.viewer ? `inline; filename="file"; filename*=UTF-8''${encodeURIComponent(ctx.sendFile.viewer)}` : null;
        // viewer: PDF от доверенного автора открывается во встроенном просмотрщике браузера,
        // а ему мешает sandbox. Остальные файлы отдаются в песочнице.
        res.writeHead(200, {
          'Content-Type': ctx.sendFile.type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
          ...(ctx.sendFile.viewer ? {} : { 'Content-Security-Policy': "default-src 'none'; sandbox" }),
          ...(disposition ? { 'Content-Disposition': disposition } : {}),
        });
        res.end(data);
        return;
      }
      send(res, ctx.status, result ?? { ok: true }, ctx.headers);
    } catch (e) {
      if (e instanceof HttpError) {
        send(res, e.status, { error: { code: e.code, message: e.message, fields: e.fields } }, ctx.headers);
      } else {
        console.error(e);
        send(res, 500, { error: { code: 'server', message: 'Ошибка сервера. Попробуйте ещё раз.' } }, ctx.headers);
      }
    }
  }

  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "base-uri 'none'", "form-action 'self'", `frame-ancestors ${frameAncestors}`,
  ].join('; ');

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    if (pathname === '/') pathname = '/index.html';
    // Общие файлы ядра доступны как /shared/..., файлы трекера как обычно.
    const fromShared = pathname.startsWith('/shared/') && sharedDir;
    const root = fromShared ? sharedDir : publicDir;
    const rel = fromShared ? pathname.slice('/shared'.length) : pathname;
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
        return;
      }
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache', ETag: etag,
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; }
    if (url.pathname === '/health') { send(res, 200, { ok: true }); return; }
    if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
    else serveStatic(req, res, url);
  });

  return { route, server, setSession };
}

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

const publicUser = u => ({ id: u.id, login: u.login, name: u.name, role: u.role });

async function createUser(db, { login, name, role, password }) {
  const hash = await hashPassword(password);
  const r = db.prepare('INSERT INTO users (login, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(login.toLowerCase(), name, role, hash, now());
  return Number(r.lastInsertRowid);
}

function createInvite(db, { name, role, createdBy, days = 7 }) {
  const token = randomToken();
  db.prepare('INSERT INTO invites (token_hash, name, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), name, role, createdBy, new Date(Date.now() + days * 864e5).toISOString());
  return token;
}

module.exports = {
  HttpError, forbid, notFound, invalid, openDb, tx, now, randomToken, hashPassword, verifyPassword, createSession,
  text, oneOf, intId, isoDate, validLogin, validPassword, createApp, createUser, createInvite, Limiter,
};
