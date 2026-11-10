'use strict';
// Логика «Зачёта». Ученик видит только своё, родитель только своих детей, репетитор всё.
// Правильные ответы уходят в браузер ученика только после сдачи. Права проверяет сервер.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  forbid, notFound, invalid, tx, now, text, oneOf, intId, createInvite, Limiter, HttpError,
} = require('../../../core');
const { localParts } = require('../../../core/dateparse');
const { generateKeys, sendPush, allowedEndpoint } = require('../../../core/webpush');
const G = require('./grading');

const ROLES = ['tutor', 'student', 'parent'];
const LESSON_STATUS = ['planned', 'done', 'missed', 'cancelled'];
const FORMATS = ['online', 'offline'];
const ACCESS = ['public', 'students', 'selected'];
const PAGE_KEYS = ['title', 'subtitle', 'about', 'subjects', 'prices', 'reviews', 'contacts'];
const PAGE_LIMITS = { title: 120, subtitle: 300, about: 3000, subjects: 2000, prices: 2000, reviews: 4000, contacts: 500 };
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const OFFICE = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', ...Object.keys(OFFICE)];
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_DOC = 10 * 1024 * 1024;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DUE_REMIND_HOUR = 17;

const realDate = v => typeof v === 'string' && DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const shiftDay = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);
const minutesOf = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const json = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };
const dm = day => `${day.slice(8)}.${day.slice(5, 7)}`;

function isFileOf(buf, type) {
  if (type === 'application/pdf') return buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (OFFICE[type]) return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  if (type === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'image/png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp') return buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

function int(v, name, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) invalid(`${name}: целое число от ${min} до ${max}`);
  return n;
}

function register(app, db, { demo, tz, filesDir, seedDir, pushHost, pushSubject }) {
  const { route } = app;
  const leadLimit = new Limiter(5, 60 * 60e3);

  const today = () => {
    const p = localParts(new Date(), tz);
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  };
  const nowMinutes = () => { const p = localParts(new Date(), tz); return p.h * 60 + p.min; };
  const demoLimit = (sql, max, message) => {
    if (demo && db.prepare(sql).get().n >= max) forbid(`${message}. В демо есть предел, данные обновятся ночью`);
  };

  // ---------- Люди и права ----------

  const userRow = id => db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(id);
  const onlyTutor = u => { if (u.role !== 'tutor') forbid('Это может только репетитор'); };
  const childrenOf = pid => db.prepare('SELECT l.student_id AS id FROM parent_links l JOIN users u ON u.id = l.student_id WHERE l.parent_id = ? AND u.active = 1 ORDER BY u.name').all(pid).map(r => r.id);
  const parentsOf = sid => db.prepare('SELECT l.parent_id AS id FROM parent_links l JOIN users u ON u.id = l.parent_id WHERE l.student_id = ? AND u.active = 1').all(sid).map(r => r.id);
  const tutors = () => db.prepare("SELECT id FROM users WHERE role = 'tutor' AND active = 1").all().map(r => r.id);
  const ensureStudents = () => db.prepare("INSERT OR IGNORE INTO students (user_id) SELECT id FROM users WHERE role = 'student'").run();

  // Чей ученик: репетитор — любой, ученик — только сам, родитель — свои дети. Остальное «не найдено».
  function studentFor(u, id) {
    const sid = intId(id, 'Ученик');
    const s = userRow(sid);
    if (!s || s.role !== 'student') notFound('Ученик не найден');
    if (u.role === 'tutor') return s;
    if (u.role === 'student' && u.id === sid) return s;
    if (u.role === 'parent' && childrenOf(u.id).includes(sid)) return s;
    notFound('Ученик не найден');
  }
  // Кого показывать на экранах ученика и родителя: параметр student или первый ребёнок.
  function viewedStudent(u, param) {
    if (u.role === 'student') return userRow(u.id);
    if (u.role === 'parent') {
      const kids = childrenOf(u.id);
      if (!kids.length) notFound('К вашему аккаунту пока не привязан ученик. Попросите репетитора');
      return studentFor(u, param || kids[0]);
    }
    if (!param) invalid('Выберите ученика');
    return studentFor(u, param);
  }
  const familyOf = sid => [sid, ...parentsOf(sid)];

  // ---------- Уведомления и push ----------

  function vapid() {
    const row = db.prepare("SELECT value FROM app_state WHERE key = 'vapid'").get();
    if (row) return JSON.parse(row.value);
    const keys = generateKeys();
    db.prepare("INSERT INTO app_state (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    return keys;
  }
  async function pushTo(userId, body, link) {
    for (const sub of db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId)) {
      try {
        const code = await sendPush(sub, { title: 'Зачёт', body, link }, vapid(), pushSubject);
        if (code === 404 || code === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
      } catch (e) { console.error('Push:', e.message); }
    }
  }
  // В демо аккаунты общие, поэтому в push только заранее заданный текст.
  const pending = [];
  function notify(userIds, kind, message, link, { actorId, push } = {}) {
    const add = db.prepare('INSERT INTO notifications (user_id, kind, text, link, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const id of new Set(userIds.filter(x => x && x !== actorId))) {
      add.run(id, kind, message, link, now());
      if (push) pending.push(pushTo(id, demo ? push : message, link));
    }
  }
  const flushPush = async () => { await Promise.all(pending.splice(0)); };
  const once = key => db.prepare('INSERT OR IGNORE INTO sent (key, sent_at) VALUES (?, ?)').run(key, now()).changes === 1;

  // ---------- Файлы ----------

  function saveFile(kind, buf, type, name, ownerId) {
    const file = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, file), buf);
    const r = db.prepare('INSERT INTO files (kind, file, name, type, size, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, file, name, type, buf.length, ownerId, now());
    return Number(r.lastInsertRowid);
  }
  const removeFile = f => {
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    if (!f.seeded) fs.rmSync(path.join(filesDir, path.basename(f.file)), { force: true });
  };
  const cleanName = (v, fallback) => String(v || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 120) || fallback;
  const uploadsLeft = () => demoLimit('SELECT COUNT(*) AS n FROM files WHERE seeded = 0', 80, 'Слишком много файлов');

  function canSeeMaterial(u, m) {
    if (m.access === 'public') return true;
    if (!u) return false;
    if (u.role === 'tutor') return true;
    if (m.access === 'students') return u.role === 'student' || u.role === 'parent';
    const allowed = db.prepare('SELECT student_id FROM material_access WHERE material_id = ?').all(m.id).map(r => r.student_id);
    if (u.role === 'student') return allowed.includes(u.id);
    return childrenOf(u.id).some(id => allowed.includes(id));
  }

  function canSeeFile(u, f) {
    if (f.kind === 'photo') return true;
    if (f.kind === 'material') {
      const m = db.prepare('SELECT * FROM materials WHERE file_id = ?').get(f.id);
      return !!m && canSeeMaterial(u, m);
    }
    if (!u) return false;
    if (u.role === 'tutor') return true;
    const mine = u.role === 'student' ? [u.id] : childrenOf(u.id);
    if (f.kind === 'question') {
      return mine.some(sid => db.prepare(`SELECT 1 FROM questions q JOIN assignment_students a ON a.assignment_id = q.assignment_id
        WHERE q.image_id = ? AND a.student_id = ?`).get(f.id, sid));
    }
    if (f.kind === 'answer') return mine.includes(f.owner_id);
    return false;
  }

  // Открытый маршрут: открытые материалы и фото на главной доступны без входа по постоянной ссылке.
  route('GET', '/api/v1/files/:id', ctx => {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(intId(ctx.params.id, 'Файл'));
    if (!f || !canSeeFile(ctx.user, f)) notFound('Файл не найден или доступ закрыт');
    const file = path.join(f.seeded ? seedDir : filesDir, path.basename(f.file));
    if (f.type === 'application/pdf') ctx.sendFile = { path: file, type: f.type, viewer: f.name };
    else if (IMAGE_TYPES.includes(f.type)) ctx.sendFile = { path: file, type: f.type };
    else ctx.sendFile = { path: file, type: f.type, download: f.name };
  }, { public: true });

  // ---------- Справочник и главная страница ----------

  route('GET', '/api/v1/meta', () => ({ demo, today: today(), kinds: G.KIND_NAME }), { public: true });

  const pageOf = () => Object.fromEntries(db.prepare('SELECT key, value FROM page').all().map(r => [r.key, r.value]));

  route('GET', '/api/v1/page', () => {
    const p = pageOf();
    return { page: Object.fromEntries(PAGE_KEYS.map(k => [k, p[k] || ''])), photoId: p.photo_id ? Number(p.photo_id) : null };
  }, { public: true });

  route('PATCH', '/api/v1/page', ctx => {
    onlyTutor(ctx.user);
    const set = db.prepare('INSERT INTO page (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const names = { title: 'Заголовок', subtitle: 'Подзаголовок', about: 'О себе', subjects: 'Предметы', prices: 'Цены', reviews: 'Отзывы', contacts: 'Контакты' };
    const changes = PAGE_KEYS.filter(k => k in ctx.body).map(k => [k, text(ctx.body[k], names[k], { min: k === 'title' ? 1 : 0, max: PAGE_LIMITS[k] })]);
    tx(db, () => { for (const [k, v] of changes) set.run(k, v); });
    return { ok: true };
  });

  route('POST', '/api/v1/page/photo', ctx => {
    onlyTutor(ctx.user);
    if (!isFileOf(ctx.file, ctx.fileType)) invalid('Это не изображение');
    uploadsLeft();
    const old = pageOf().photo_id;
    const id = tx(db, () => {
      const fid = saveFile('photo', ctx.file, ctx.fileType, 'Фото', ctx.user.id);
      db.prepare("INSERT INTO page (key, value) VALUES ('photo_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(fid));
      return fid;
    });
    const prev = old && db.prepare('SELECT * FROM files WHERE id = ?').get(Number(old));
    if (prev) removeFile(prev);
    ctx.status = 201;
    return { photoId: id };
  }, { upload: { types: IMAGE_TYPES, maxBytes: MAX_IMAGE } });

  // ---------- Заявки с главной ----------

  route('POST', '/api/v1/leads', ctx => {
    if (leadLimit.blocked(ctx.ip)) throw new HttpError(429, 'too_many', 'Слишком много заявок с этого адреса. Попробуйте через час.');
    const name = text(ctx.body.name, 'Имя', { min: 1, max: 80 });
    const contact = text(ctx.body.contact, 'Телефон или мессенджер', { min: 3, max: 100 });
    const message = text(ctx.body.message, 'Сообщение', { max: 1000 });
    if (ctx.body.consent !== true) invalid('Нужно согласие на обработку персональных данных');
    leadLimit.hit(ctx.ip);
    // В демо контакты посетителей не сохраняем: их увидел бы любой, кто войдёт как репетитор.
    if (demo) return { ok: true, demo: true };
    const r = db.prepare('INSERT INTO leads (name, contact, message, consent_at, created_at) VALUES (?, ?, ?, ?, ?)').run(name, contact, message, now(), now());
    notify(tutors(), 'lead', `Заявка на пробное занятие: ${name}`, '#/leads', { push: 'Новая заявка на пробное занятие' });
    flushPush();
    ctx.status = 201;
    return { ok: true, id: Number(r.lastInsertRowid) };
  }, { public: true });

  route('GET', '/api/v1/leads', ctx => {
    onlyTutor(ctx.user);
    return { leads: db.prepare('SELECT * FROM leads ORDER BY done, id DESC LIMIT 200').all().map(l => ({ id: l.id, name: l.name, contact: l.contact, message: l.message, done: !!l.done, createdAt: l.created_at })) };
  });

  route('PATCH', '/api/v1/leads/:id', ctx => {
    onlyTutor(ctx.user);
    const r = db.prepare('UPDATE leads SET done = ? WHERE id = ?').run(ctx.body.done ? 1 : 0, intId(ctx.params.id, 'Заявка'));
    if (!r.changes) notFound('Заявка не найдена');
    return { ok: true };
  });

  // ---------- Материалы ----------

  function presentMaterial(m, u) {
    const f = db.prepare('SELECT id, name, type, size FROM files WHERE id = ?').get(m.file_id);
    const out = { id: m.id, title: m.title, topic: m.topic, access: m.access, fileId: f.id, fileName: f.name, type: f.type, size: f.size, createdAt: m.created_at };
    if (u?.role === 'tutor') out.studentIds = db.prepare('SELECT student_id FROM material_access WHERE material_id = ?').all(m.id).map(r => r.student_id);
    return out;
  }

  route('GET', '/api/v1/materials', ctx => {
    const rows = db.prepare('SELECT * FROM materials ORDER BY topic, title').all();
    return { materials: rows.filter(m => canSeeMaterial(ctx.user, m)).map(m => presentMaterial(m, ctx.user)) };
  }, { public: true });

  function readAccess(b) {
    const access = oneOf(b.access ?? 'students', ACCESS, 'Доступ');
    let ids = [];
    if (access === 'selected') {
      if (!Array.isArray(b.studentIds) || !b.studentIds.length) invalid('Выберите учеников, которым открыть документ');
      ids = [...new Set(b.studentIds.map(x => intId(x, 'Ученик')))];
      for (const id of ids) if (userRow(id)?.role !== 'student') invalid('Ученик не найден');
    }
    return { access, ids };
  }

  // Файл приходит телом запроса, название и доступ — в адресе: так загрузка остаётся одним запросом.
  route('POST', '/api/v1/materials', ctx => {
    const u = ctx.user;
    onlyTutor(u);
    if (!isFileOf(ctx.file, ctx.fileType)) invalid('Файл не похож на PDF, Word, Excel, PowerPoint или картинку');
    uploadsLeft();
    const q = ctx.query;
    const name = cleanName(q.get('name'), 'Документ');
    const title = text(q.get('title') || name.replace(/\.[^.]+$/, ''), 'Название', { min: 1, max: 150 });
    const topic = text(q.get('topic') || '', 'Тема', { max: 80 });
    const { access, ids } = readAccess({ access: q.get('access') || 'students', studentIds: q.get('students') ? q.get('students').split(',') : [] });
    const id = tx(db, () => {
      const fid = saveFile('material', ctx.file, ctx.fileType, name, u.id);
      const r = db.prepare('INSERT INTO materials (file_id, title, topic, access, created_at) VALUES (?, ?, ?, ?, ?)').run(fid, title, topic, access, now());
      const mid = Number(r.lastInsertRowid);
      for (const sid of ids) db.prepare('INSERT INTO material_access (material_id, student_id) VALUES (?, ?)').run(mid, sid);
      return mid;
    });
    const targets = access === 'selected' ? ids : access === 'students' ? db.prepare("SELECT id FROM users WHERE role = 'student' AND active = 1").all().map(r => r.id) : [];
    notify(targets, 'material', `Новый материал: ${title}`, '#/materials');
    ctx.status = 201;
    return { material: presentMaterial(db.prepare('SELECT * FROM materials WHERE id = ?').get(id), u) };
  }, { upload: { types: DOC_TYPES, maxBytes: MAX_DOC } });

  const materialRow = id => {
    const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(intId(id, 'Материал'));
    if (!m) notFound('Материал не найден');
    return m;
  };

  route('PATCH', '/api/v1/materials/:id', ctx => {
    onlyTutor(ctx.user);
    const m = materialRow(ctx.params.id);
    const b = ctx.body;
    tx(db, () => {
      if ('title' in b) db.prepare('UPDATE materials SET title = ? WHERE id = ?').run(text(b.title, 'Название', { min: 1, max: 150 }), m.id);
      if ('topic' in b) db.prepare('UPDATE materials SET topic = ? WHERE id = ?').run(text(b.topic, 'Тема', { max: 80 }), m.id);
      if ('access' in b) {
        const { access, ids } = readAccess(b);
        db.prepare('UPDATE materials SET access = ? WHERE id = ?').run(access, m.id);
        db.prepare('DELETE FROM material_access WHERE material_id = ?').run(m.id);
        for (const sid of ids) db.prepare('INSERT INTO material_access (material_id, student_id) VALUES (?, ?)').run(m.id, sid);
      }
    });
    return { material: presentMaterial(materialRow(m.id), ctx.user) };
  });

  route('DELETE', '/api/v1/materials/:id', ctx => {
    onlyTutor(ctx.user);
    const m = materialRow(ctx.params.id);
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(m.file_id);
    tx(db, () => { db.prepare('DELETE FROM materials WHERE id = ?').run(m.id); removeFile(f); });
    return { ok: true };
  });

  // ---------- Задания ----------

  function readQuestion(raw, i) {
    const n = `Вопрос ${i + 1}`;
    if (!raw || typeof raw !== 'object') invalid(`${n}: пустой`);
    const kind = oneOf(raw.kind, G.KINDS, `${n}, тип`);
    const q = { kind, text: text(raw.text, `${n}, текст`, { min: 1, max: 1000 }), points: int(raw.points ?? 1, `${n}, баллы`, 1, 20), topic: text(raw.topic, `${n}, тема`, { max: 60 }), options: [], correct: null, imageId: null };
    if (kind === 'single' || kind === 'multi') {
      if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 8) invalid(`${n}: нужно от 2 до 8 вариантов`);
      q.options = raw.options.map((o, k) => text(o, `${n}, вариант ${k + 1}`, { min: 1, max: 200 }));
      if (kind === 'single') {
        if (!Number.isInteger(raw.correct) || raw.correct < 0 || raw.correct >= q.options.length) invalid(`${n}: отметьте верный вариант`);
        q.correct = raw.correct;
      } else {
        const list = Array.isArray(raw.correct) ? [...new Set(raw.correct)] : [];
        if (!list.length || list.some(x => !Number.isInteger(x) || x < 0 || x >= q.options.length)) invalid(`${n}: отметьте верные варианты`);
        q.correct = list.sort((a, b) => a - b);
      }
    }
    if (kind === 'short') {
      const list = Array.isArray(raw.correct) ? raw.correct.map(x => String(x ?? '').trim()).filter(Boolean) : [];
      if (!list.length || list.length > 5) invalid(`${n}: укажите от 1 до 5 верных ответов`);
      q.correct = list.map((x, k) => text(x, `${n}, ответ ${k + 1}`, { min: 1, max: 100 }));
    }
    if (raw.imageId) {
      const f = db.prepare("SELECT id FROM files WHERE id = ? AND kind = 'question'").get(intId(raw.imageId, `${n}, картинка`));
      if (!f) invalid(`${n}: картинка не найдена`);
      q.imageId = f.id;
    }
    return q;
  }

  const questionsOf = aid => db.prepare('SELECT * FROM questions WHERE assignment_id = ? ORDER BY position').all(aid)
    .map(q => ({ id: q.id, kind: q.kind, text: q.text, options: json(q.options, []), correct: json(q.correct, null), points: q.points, topic: q.topic, imageId: q.image_id }));

  const assignmentRow = id => db.prepare('SELECT * FROM assignments WHERE id = ?').get(intId(id, 'Задание'));
  const issuedTo = aid => db.prepare('SELECT student_id FROM assignment_students WHERE assignment_id = ?').all(aid).map(r => r.student_id);
  const submissionOf = (aid, sid) => db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(aid, sid);

  function statusOf(a, sub) {
    if (sub?.status === 'checked') return 'checked';
    if (sub?.status === 'submitted') return 'submitted';
    if (today() > a.due_day) return 'overdue';
    return sub ? 'draft' : 'issued';
  }

  function presentSubmission(sub, questions, { reveal }) {
    if (!sub) return null;
    const files = db.prepare('SELECT af.question_id, f.id, f.name FROM answer_files af JOIN files f ON f.id = af.file_id WHERE af.submission_id = ?').all(sub.id);
    const done = sub.status !== 'draft';
    return {
      id: sub.id, status: sub.status, answers: json(sub.answers, {}), late: !!sub.late, comment: sub.comment,
      submittedAt: sub.submitted_at, checkedAt: sub.checked_at,
      score: done ? sub.score : null, max: done ? sub.max_score : null,
      percent: sub.status === 'checked' ? G.percent(sub.score, sub.max_score) : null,
      results: done && reveal ? json(sub.results, {}) : null,
      files: files.map(f => ({ questionId: f.question_id, id: f.id, name: f.name })),
    };
  }

  // Для ученика и родителя: без правильных ответов, пока работа не сдана.
  function presentForStudent(a, sid) {
    const sub = submissionOf(a.id, sid);
    const reveal = !!sub && sub.status !== 'draft' && !!a.show_answers;
    const questions = questionsOf(a.id).map(q => ({
      id: q.id, kind: q.kind, text: q.text, options: q.options, points: q.points, topic: q.topic, imageId: q.imageId,
      ...(reveal && q.kind !== 'long' ? { correct: q.correct } : {}),
    }));
    return {
      id: a.id, title: a.title, description: a.description, dueDay: a.due_day, showAnswers: !!a.show_answers,
      status: statusOf(a, sub), maxScore: questions.reduce((s, q) => s + q.points, 0), questions,
      submission: presentSubmission(sub, questions, { reveal }),
    };
  }

  function presentForTutor(a, full) {
    const students = issuedTo(a.id).map(sid => {
      const sub = submissionOf(a.id, sid);
      return { id: sid, name: userRow(sid)?.name, status: statusOf(a, sub), percent: sub?.status === 'checked' ? G.percent(sub.score, sub.max_score) : null, late: !!sub?.late, submissionId: sub?.id ?? null };
    });
    const qs = questionsOf(a.id);
    return {
      id: a.id, title: a.title, description: a.description, dueDay: a.due_day, showAnswers: !!a.show_answers, createdAt: a.created_at,
      maxScore: qs.reduce((s, q) => s + q.points, 0), questionCount: qs.length, students,
      ...(full ? { questions: qs } : {}),
    };
  }

  route('GET', '/api/v1/assignments', ctx => {
    const u = ctx.user;
    if (u.role === 'tutor') return { assignments: db.prepare('SELECT * FROM assignments ORDER BY due_day DESC, id DESC').all().map(a => presentForTutor(a, false)) };
    const s = viewedStudent(u, ctx.query.get('student'));
    const rows = db.prepare('SELECT a.* FROM assignments a JOIN assignment_students x ON x.assignment_id = a.id WHERE x.student_id = ? ORDER BY a.due_day DESC, a.id DESC').all(s.id);
    return { student: { id: s.id, name: s.name }, assignments: rows.map(a => { const p = presentForStudent(a, s.id); delete p.questions; return p; }) };
  });

  function readAssignment(b, old) {
    const out = {};
    if ('title' in b || !old) out.title = text(b.title, 'Название', { min: 1, max: 150 });
    if ('description' in b) out.description = text(b.description, 'Описание', { max: 2000 });
    if ('dueDay' in b || !old) {
      if (!realDate(b.dueDay)) invalid('Укажите срок сдачи');
      out.due_day = b.dueDay;
    }
    if ('showAnswers' in b) out.show_answers = b.showAnswers ? 1 : 0;
    return out;
  }

  function readQuestions(list) {
    if (!Array.isArray(list) || !list.length) invalid('Добавьте хотя бы один вопрос');
    if (list.length > 40) invalid('Не больше 40 вопросов');
    return list.map(readQuestion);
  }

  function readStudents(list) {
    if (!Array.isArray(list)) return [];
    const ids = [...new Set(list.map(x => intId(x, 'Ученик')))];
    for (const id of ids) { const s = userRow(id); if (!s || s.role !== 'student' || !s.active) invalid('Ученик не найден'); }
    return ids;
  }

  const insertQuestions = (aid, qs) => qs.forEach((q, i) => db.prepare(`INSERT INTO questions (assignment_id, position, kind, text, options, correct, points, topic, image_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(aid, i, q.kind, q.text, JSON.stringify(q.options), JSON.stringify(q.correct), q.points, q.topic, q.imageId));

  function issue(a, ids, actor) {
    const fresh = ids.filter(sid => db.prepare('INSERT OR IGNORE INTO assignment_students (assignment_id, student_id, assigned_at) VALUES (?, ?, ?)').run(a.id, sid, now()).changes);
    for (const sid of fresh) notify(familyOf(sid), 'assignment', `Новое задание: ${a.title}, срок ${dm(a.due_day)}`, `#/task/${a.id}`, { actorId: actor, push: 'Новое домашнее задание' });
  }

  route('POST', '/api/v1/assignments', ctx => {
    const u = ctx.user;
    onlyTutor(u);
    const f = readAssignment(ctx.body);
    const qs = readQuestions(ctx.body.questions);
    const ids = readStudents(ctx.body.studentIds);
    demoLimit('SELECT COUNT(*) AS n FROM assignments', 120, 'Слишком много заданий');
    const id = tx(db, () => {
      const r = db.prepare('INSERT INTO assignments (title, description, due_day, show_answers, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(f.title, f.description ?? '', f.due_day, f.show_answers ?? 1, now());
      const aid = Number(r.lastInsertRowid);
      insertQuestions(aid, qs);
      issue(assignmentRow(aid), ids, u.id);
      return aid;
    });
    flushPush();
    ctx.status = 201;
    return { assignment: presentForTutor(assignmentRow(id), true) };
  });

  route('GET', '/api/v1/assignments/:id', ctx => {
    const u = ctx.user;
    const a = assignmentRow(ctx.params.id);
    if (!a) notFound('Задание не найдено');
    if (u.role === 'tutor') return { assignment: presentForTutor(a, true) };
    const s = viewedStudent(u, ctx.query.get('student'));
    if (!issuedTo(a.id).includes(s.id)) notFound('Задание не найдено');
    return { assignment: presentForStudent(a, s.id), student: { id: s.id, name: s.name }, readOnly: u.role !== 'student' };
  });

  route('PATCH', '/api/v1/assignments/:id', ctx => {
    const u = ctx.user;
    onlyTutor(u);
    const a = assignmentRow(ctx.params.id);
    if (!a) notFound('Задание не найдено');
    const f = readAssignment(ctx.body, a);
    const qs = 'questions' in ctx.body ? readQuestions(ctx.body.questions) : null;
    const ids = 'studentIds' in ctx.body ? readStudents(ctx.body.studentIds) : null;
    tx(db, () => {
      const cols = Object.keys(f);
      if (cols.length) db.prepare(`UPDATE assignments SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => f[c]), a.id);
      if (qs) {
        // Сданные работы проверены по старым вопросам: менять вопросы после сдачи нельзя.
        if (db.prepare("SELECT 1 FROM submissions WHERE assignment_id = ? AND status <> 'draft'").get(a.id)) invalid('Задание уже сдают, вопросы менять нельзя. Создайте новое');
        db.prepare('DELETE FROM questions WHERE assignment_id = ?').run(a.id);
        db.prepare('DELETE FROM submissions WHERE assignment_id = ?').run(a.id);
        insertQuestions(a.id, qs);
      }
      if (ids) issue(assignmentRow(a.id), ids, u.id);
    });
    flushPush();
    return { assignment: presentForTutor(assignmentRow(a.id), true) };
  });

  route('DELETE', '/api/v1/assignments/:id', ctx => {
    onlyTutor(ctx.user);
    const a = assignmentRow(ctx.params.id);
    if (!a) notFound('Задание не найдено');
    const files = db.prepare(`SELECT f.* FROM files f WHERE f.id IN (SELECT image_id FROM questions WHERE assignment_id = ?)
      OR f.id IN (SELECT af.file_id FROM answer_files af JOIN submissions s ON s.id = af.submission_id WHERE s.assignment_id = ?)`).all(a.id, a.id);
    tx(db, () => { db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id); for (const f of files) removeFile(f); });
    return { ok: true };
  });

  route('POST', '/api/v1/question-images', ctx => {
    onlyTutor(ctx.user);
    if (!isFileOf(ctx.file, ctx.fileType)) invalid('Это не изображение');
    uploadsLeft();
    ctx.status = 201;
    return { imageId: saveFile('question', ctx.file, ctx.fileType, 'Картинка к вопросу', ctx.user.id) };
  }, { upload: { types: IMAGE_TYPES, maxBytes: MAX_IMAGE } });

  // ---------- Выполнение ученика ----------

  function studentAssignment(u, id) {
    if (u.role !== 'student') forbid('Задание выполняет ученик');
    const a = assignmentRow(id);
    if (!a || !issuedTo(a.id).includes(u.id)) notFound('Задание не найдено');
    return a;
  }

  function readAnswers(questions, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Нет ответов');
    const out = {};
    for (const q of questions) {
      const v = raw[q.id];
      if (v === undefined || v === null || v === '') continue;
      if (q.kind === 'single') {
        if (!Number.isInteger(v) || v < 0 || v >= q.options.length) invalid('Недопустимый вариант ответа');
        out[q.id] = v;
      } else if (q.kind === 'multi') {
        if (!Array.isArray(v) || v.some(x => !Number.isInteger(x) || x < 0 || x >= q.options.length)) invalid('Недопустимые варианты ответа');
        if (v.length) out[q.id] = [...new Set(v)].sort((a, b) => a - b);
      } else {
        out[q.id] = text(v, 'Ответ', { max: q.kind === 'short' ? 200 : 5000 });
      }
    }
    return out;
  }

  function draftFor(a, sid) {
    let sub = submissionOf(a.id, sid);
    if (!sub) {
      db.prepare('INSERT INTO submissions (assignment_id, student_id, updated_at) VALUES (?, ?, ?)').run(a.id, sid, now());
      sub = submissionOf(a.id, sid);
    }
    if (sub.status !== 'draft') invalid('Работа уже сдана, изменить её нельзя');
    return sub;
  }

  route('PUT', '/api/v1/assignments/:id/answers', ctx => {
    const u = ctx.user;
    const a = studentAssignment(u, ctx.params.id);
    const answers = readAnswers(questionsOf(a.id), ctx.body.answers);
    tx(db, () => {
      const sub = draftFor(a, u.id);
      db.prepare('UPDATE submissions SET answers = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(answers), now(), sub.id);
    });
    return { assignment: presentForStudent(a, u.id) };
  });

  route('POST', '/api/v1/assignments/:id/submit', ctx => {
    const u = ctx.user;
    const a = studentAssignment(u, ctx.params.id);
    const qs = questionsOf(a.id);
    const answers = readAnswers(qs, ctx.body.answers ?? {});
    const g = tx(db, () => {
      const sub = draftFor(a, u.id);
      const res = G.grade(qs, answers);
      const status = res.pending ? 'submitted' : 'checked';
      const late = today() > a.due_day ? 1 : 0;
      db.prepare(`UPDATE submissions SET status = ?, answers = ?, results = ?, score = ?, max_score = ?, late = ?, submitted_at = ?, checked_at = ?, updated_at = ? WHERE id = ?`)
        .run(status, JSON.stringify(answers), JSON.stringify(res.results), res.score, res.max, late, now(), status === 'checked' ? now() : null, now(), sub.id);
      const what = `${u.name}, «${a.title}»${late ? ', с опозданием' : ''}`;
      if (res.pending) notify(tutors(), 'submitted', `Ждёт проверки: ${what}`, `#/check/${sub.id}`, { push: 'Работа ждёт проверки' });
      else {
        notify(tutors(), 'submitted', `Сдано: ${what}, ${G.percent(res.score, res.max)}%`, `#/check/${sub.id}`);
        notify(parentsOf(u.id), 'checked', `Проверено: «${a.title}», ${res.score} из ${res.max}`, `#/task/${a.id}`, { push: 'Задание проверено' });
      }
      return res;
    });
    flushPush();
    return { assignment: presentForStudent(a, u.id), pending: g.pending };
  });

  route('POST', '/api/v1/assignments/:id/files', ctx => {
    const u = ctx.user;
    const a = studentAssignment(u, ctx.params.id);
    const qid = intId(ctx.query.get('question'), 'Вопрос');
    const q = questionsOf(a.id).find(x => x.id === qid);
    if (!q || q.kind !== 'long') invalid('Фото прикладывается только к развёрнутому ответу');
    if (!isFileOf(ctx.file, ctx.fileType)) invalid('Это не изображение');
    uploadsLeft();
    const fid = tx(db, () => {
      const sub = draftFor(a, u.id);
      if (db.prepare('SELECT COUNT(*) AS n FROM answer_files WHERE submission_id = ? AND question_id = ?').get(sub.id, qid).n >= 3) invalid('К ответу можно приложить не больше 3 фото');
      const id = saveFile('answer', ctx.file, ctx.fileType, 'Фото решения', u.id);
      db.prepare('INSERT INTO answer_files (submission_id, question_id, file_id) VALUES (?, ?, ?)').run(sub.id, qid, id);
      return id;
    });
    ctx.status = 201;
    return { fileId: fid };
  }, { upload: { types: IMAGE_TYPES, maxBytes: MAX_IMAGE } });

  route('DELETE', '/api/v1/answer-files/:id', ctx => {
    const u = ctx.user;
    const row = db.prepare(`SELECT f.*, s.status, s.student_id FROM answer_files af JOIN files f ON f.id = af.file_id JOIN submissions s ON s.id = af.submission_id WHERE f.id = ?`).get(intId(ctx.params.id, 'Файл'));
    if (!row || row.student_id !== u.id) notFound('Файл не найден');
    if (row.status !== 'draft') invalid('Работа уже сдана');
    removeFile(row);
    return { ok: true };
  });

  // ---------- Проверка репетитором ----------

  const submissionRow = id => db.prepare('SELECT * FROM submissions WHERE id = ?').get(intId(id, 'Работа'));

  route('GET', '/api/v1/review', ctx => {
    onlyTutor(ctx.user);
    const rows = db.prepare(`SELECT s.id, s.submitted_at, s.late, a.title, a.id AS aid, u.name FROM submissions s JOIN assignments a ON a.id = s.assignment_id
      JOIN users u ON u.id = s.student_id WHERE s.status = 'submitted' ORDER BY s.submitted_at`).all();
    return { queue: rows.map(r => ({ id: r.id, assignmentId: r.aid, title: r.title, student: r.name, submittedAt: r.submitted_at, late: !!r.late })) };
  });

  route('GET', '/api/v1/submissions/:id', ctx => {
    onlyTutor(ctx.user);
    const sub = submissionRow(ctx.params.id);
    if (!sub || sub.status === 'draft') notFound('Работа не найдена');
    const a = assignmentRow(sub.assignment_id);
    const qs = questionsOf(a.id);
    return { assignment: { id: a.id, title: a.title, dueDay: a.due_day }, student: { id: sub.student_id, name: userRow(sub.student_id)?.name }, questions: qs, submission: presentSubmission(sub, qs, { reveal: true }) };
  });

  route('PATCH', '/api/v1/submissions/:id', ctx => {
    const u = ctx.user;
    onlyTutor(u);
    const sub = submissionRow(ctx.params.id);
    if (!sub || sub.status === 'draft') notFound('Работа не найдена');
    const a = assignmentRow(sub.assignment_id);
    const qs = questionsOf(a.id);
    const prev = json(sub.results, {});
    const manual = Object.fromEntries(qs.filter(q => q.kind === 'long' && prev[q.id]?.points !== null && prev[q.id]?.points !== undefined).map(q => [q.id, prev[q.id].points]));
    const scores = ctx.body.scores && typeof ctx.body.scores === 'object' ? ctx.body.scores : {};
    for (const [qid, v] of Object.entries(scores)) {
      const q = qs.find(x => String(x.id) === String(qid));
      if (!q || q.kind !== 'long') invalid('Баллы ставятся только за развёрнутые ответы');
      manual[q.id] = int(v, `Баллы за вопрос ${qs.indexOf(q) + 1}`, 0, q.points);
    }
    const comment = 'comment' in ctx.body ? text(ctx.body.comment, 'Комментарий', { max: 2000 }) : sub.comment;
    const res = G.grade(qs, json(sub.answers, {}), manual);
    const status = res.pending ? 'submitted' : 'checked';
    tx(db, () => {
      db.prepare('UPDATE submissions SET status = ?, results = ?, score = ?, max_score = ?, comment = ?, checked_at = ?, updated_at = ? WHERE id = ?')
        .run(status, JSON.stringify(res.results), res.score, res.max, comment, status === 'checked' ? now() : null, now(), sub.id);
      if (status === 'checked' && sub.status !== 'checked') {
        notify(familyOf(sub.student_id), 'checked', `Проверено: «${a.title}», ${res.score} из ${res.max}`, `#/task/${a.id}`, { push: 'Задание проверено' });
      }
    });
    flushPush();
    return { submission: presentSubmission(submissionRow(sub.id), qs, { reveal: true }), pending: res.pending };
  });

  // ---------- Журнал и статистика ----------

  function stats(sid) {
    const subs = db.prepare(`SELECT s.*, a.title, a.due_day FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.student_id = ? AND s.status <> 'draft'`).all(sid);
    const checked = subs.filter(s => s.status === 'checked').sort((x, y) => (x.submitted_at < y.submitted_at ? -1 : 1));
    const percents = checked.map(s => G.percent(s.score, s.max_score));
    const issued = db.prepare('SELECT a.* FROM assignments a JOIN assignment_students x ON x.assignment_id = a.id WHERE x.student_id = ?').all(sid);
    const overdue = issued.filter(a => statusOf(a, submissionOf(a.id, sid)) === 'overdue').length;
    const lessons = db.prepare("SELECT status, COUNT(*) AS n FROM lessons WHERE student_id = ? AND status IN ('done', 'missed') GROUP BY status").all(sid);
    const done = lessons.find(l => l.status === 'done')?.n ?? 0;
    const missed = lessons.find(l => l.status === 'missed')?.n ?? 0;
    const topics = {};
    for (const s of checked) {
      const results = json(s.results, {});
      for (const q of questionsOf(s.assignment_id)) {
        if (!q.topic || !results[q.id] || results[q.id].points === null) continue;
        topics[q.topic] ??= { topic: q.topic, score: 0, max: 0 };
        topics[q.topic].score += results[q.id].points;
        topics[q.topic].max += q.points;
      }
    }
    const topicList = Object.values(topics).map(t => ({ ...t, percent: G.percent(t.score, t.max) })).sort((a, b) => a.percent - b.percent);
    return {
      average: percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : null,
      checked: checked.length, submitted: subs.length, late: subs.filter(s => s.late).length,
      onTime: subs.length ? Math.round(((subs.length - subs.filter(s => s.late).length) / subs.length) * 100) : null,
      issued: issued.length, overdue,
      attendance: done + missed ? Math.round((done / (done + missed)) * 100) : null, lessonsDone: done, lessonsMissed: missed,
      series: checked.map(s => ({ assignmentId: s.assignment_id, title: s.title, day: s.submitted_at.slice(0, 10), percent: G.percent(s.score, s.max_score) })),
      topics: topicList, weak: topicList.filter(t => t.percent < 60),
    };
  }

  route('GET', '/api/v1/stats', ctx => {
    const s = viewedStudent(ctx.user, ctx.query.get('student'));
    return { student: { id: s.id, name: s.name }, stats: stats(s.id) };
  });

  route('GET', '/api/v1/journal', ctx => {
    onlyTutor(ctx.user);
    ensureStudents();
    const students = db.prepare("SELECT u.id, u.name, s.grade FROM users u JOIN students s ON s.user_id = u.id WHERE u.role = 'student' AND u.active = 1 ORDER BY u.name").all();
    const assignments = db.prepare('SELECT * FROM assignments ORDER BY due_day DESC, id DESC LIMIT 12').all().reverse();
    const cells = {};
    for (const a of assignments) {
      const ids = issuedTo(a.id);
      for (const s of students) {
        if (!ids.includes(s.id)) continue;
        const sub = submissionOf(a.id, s.id);
        cells[`${s.id}:${a.id}`] = { status: statusOf(a, sub), percent: sub?.status === 'checked' ? G.percent(sub.score, sub.max_score) : null, late: !!sub?.late, submissionId: sub && sub.status !== 'draft' ? sub.id : null };
      }
    }
    return { students, assignments: assignments.map(a => ({ id: a.id, title: a.title, dueDay: a.due_day })), cells, review: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'submitted'").get().n };
  });

  // ---------- Ученики, родители, приглашения ----------

  function presentStudent(s) {
    const row = db.prepare('SELECT * FROM students WHERE user_id = ?').get(s.id) || {};
    const parents = db.prepare('SELECT u.id, u.name FROM parent_links l JOIN users u ON u.id = l.parent_id WHERE l.student_id = ?').all(s.id);
    const st = stats(s.id);
    return { id: s.id, name: s.name, active: !!s.active, grade: row.grade || '', goal: row.goal || '', parents, average: st.average, attendance: st.attendance, overdue: st.overdue, weak: st.weak.map(t => t.topic) };
  }

  route('GET', '/api/v1/students', ctx => {
    onlyTutor(ctx.user);
    ensureStudents();
    return { students: db.prepare("SELECT id, name, active FROM users WHERE role = 'student' ORDER BY active DESC, name").all().map(presentStudent) };
  });

  route('GET', '/api/v1/students/:id', ctx => {
    const s = studentFor(ctx.user, ctx.params.id);
    ensureStudents();
    const st = stats(s.id);
    const assignments = db.prepare('SELECT a.* FROM assignments a JOIN assignment_students x ON x.assignment_id = a.id WHERE x.student_id = ? ORDER BY a.due_day DESC').all(s.id)
      .map(a => { const sub = submissionOf(a.id, s.id); return { id: a.id, title: a.title, dueDay: a.due_day, status: statusOf(a, sub), percent: sub?.status === 'checked' ? G.percent(sub.score, sub.max_score) : null, late: !!sub?.late, submissionId: sub && sub.status !== 'draft' ? sub.id : null }; });
    return { student: presentStudent(s), stats: st, assignments };
  });

  route('PATCH', '/api/v1/students/:id', ctx => {
    onlyTutor(ctx.user);
    const s = studentFor(ctx.user, ctx.params.id);
    ensureStudents();
    if ('grade' in ctx.body) db.prepare('UPDATE students SET grade = ? WHERE user_id = ?').run(text(ctx.body.grade, 'Класс', { max: 30 }), s.id);
    if ('goal' in ctx.body) db.prepare('UPDATE students SET goal = ? WHERE user_id = ?').run(text(ctx.body.goal, 'Цель', { max: 200 }), s.id);
    return { student: presentStudent(s) };
  });

  route('POST', '/api/v1/students/:id/parents', ctx => {
    onlyTutor(ctx.user);
    const s = studentFor(ctx.user, ctx.params.id);
    const p = userRow(intId(ctx.body.parentId, 'Родитель'));
    if (!p || p.role !== 'parent') invalid('Выберите родителя');
    db.prepare('INSERT OR IGNORE INTO parent_links (parent_id, student_id) VALUES (?, ?)').run(p.id, s.id);
    return { student: presentStudent(s) };
  });

  route('DELETE', '/api/v1/students/:id/parents/:parentId', ctx => {
    onlyTutor(ctx.user);
    const s = studentFor(ctx.user, ctx.params.id);
    db.prepare('DELETE FROM parent_links WHERE student_id = ? AND parent_id = ?').run(s.id, intId(ctx.params.parentId, 'Родитель'));
    return { student: presentStudent(s) };
  });

  route('GET', '/api/v1/people', ctx => {
    onlyTutor(ctx.user);
    return { people: db.prepare('SELECT id, login, name, role, active FROM users ORDER BY role, name').all().map(p => ({ ...p, active: !!p.active, children: p.role === 'parent' ? childrenOf(p.id) : undefined })) };
  });

  route('POST', '/api/v1/people/invites', ctx => {
    onlyTutor(ctx.user);
    if (demo) forbid('В демо новых учеников не приглашаем');
    const name = text(ctx.body.name, 'Имя', { min: 1, max: 80 });
    const role = oneOf(ctx.body.role, ['student', 'parent'], 'Роль');
    ctx.status = 201;
    return { token: createInvite(db, { name, role, createdBy: ctx.user.id }) };
  });

  route('PATCH', '/api/v1/people/:id', ctx => {
    onlyTutor(ctx.user);
    if (demo) forbid('В демо состав не меняется');
    const p = userRow(intId(ctx.params.id, 'Пользователь'));
    if (!p) notFound('Пользователь не найден');
    if (p.role === 'tutor') invalid('Репетитора отключить нельзя');
    const active = ctx.body.active ? 1 : 0;
    tx(db, () => {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, p.id);
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(p.id);
    });
    return { ok: true };
  });

  route('GET', '/api/v1/children', ctx => {
    const u = ctx.user;
    if (u.role === 'parent') return { children: childrenOf(u.id).map(id => ({ id, name: userRow(id).name })) };
    if (u.role === 'student') return { children: [{ id: u.id, name: u.name }] };
    return { children: [] };
  });

  // ---------- Расписание ----------

  const presentLesson = l => ({
    id: l.id, studentId: l.student_id, studentName: userRow(l.student_id)?.name, seriesId: l.series_id, day: l.day, time: l.time, minutes: l.minutes,
    format: l.format, link: l.link, status: l.status, movedFrom: l.moved_from,
  });
  const lessonStarted = l => l.day < today() || (l.day === today() && minutesOf(l.time) <= nowMinutes());

  route('GET', '/api/v1/lessons', ctx => {
    const u = ctx.user;
    const from = ctx.query.get('from') || today();
    if (!realDate(from)) invalid('Недопустимая дата');
    const days = int(ctx.query.get('days') || 7, 'Дней', 1, 62);
    const to = shiftDay(from, days - 1);
    let ids;
    if (u.role === 'tutor') ids = ctx.query.get('student') ? [studentFor(u, ctx.query.get('student')).id] : null;
    else if (u.role === 'student') ids = [u.id];
    else ids = ctx.query.get('student') ? [studentFor(u, ctx.query.get('student')).id] : childrenOf(u.id);
    const rows = ids
      ? (ids.length ? db.prepare(`SELECT * FROM lessons WHERE day >= ? AND day <= ? AND student_id IN (${ids.map(() => '?').join(',')}) ORDER BY day, time`).all(from, to, ...ids) : [])
      : db.prepare('SELECT * FROM lessons WHERE day >= ? AND day <= ? ORDER BY day, time').all(from, to);
    return { from, to, today: today(), lessons: rows.map(presentLesson) };
  });

  function readLesson(b, old) {
    const out = {};
    if ('day' in b || !old) { if (!realDate(b.day)) invalid('Укажите дату'); out.day = b.day; }
    if ('time' in b || !old) { if (!TIME_RE.test(String(b.time || ''))) invalid('Время: ЧЧ:ММ'); out.time = b.time; }
    if ('minutes' in b || !old) out.minutes = int(b.minutes ?? 60, 'Длительность', 30, 240);
    if ('format' in b || !old) out.format = oneOf(b.format ?? 'online', FORMATS, 'Формат');
    if ('link' in b) {
      const v = text(b.link, 'Ссылка на звонок', { max: 300 });
      if (v) { let url; try { url = new URL(v); } catch { invalid('Ссылка на звонок: нужен полный адрес https://…'); } if (url.protocol !== 'https:') invalid('Ссылка на звонок: только https'); }
      out.link = v;
    }
    return out;
  }

  route('POST', '/api/v1/lessons', ctx => {
    const u = ctx.user;
    onlyTutor(u);
    const s = studentFor(u, ctx.body.studentId);
    const f = readLesson(ctx.body);
    const weeks = int(ctx.body.repeatWeeks ?? 0, 'Повторять недель', 0, 26);
    if (f.day < shiftDay(today(), -60)) invalid('Дата слишком давняя');
    demoLimit('SELECT COUNT(*) AS n FROM lessons', 1500, 'Слишком много занятий');
    const ids = tx(db, () => {
      const out = [];
      for (let w = 0; w <= weeks; w++) {
        const r = db.prepare('INSERT INTO lessons (student_id, series_id, day, time, minutes, format, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(s.id, out[0] ?? null, shiftDay(f.day, 7 * w), f.time, f.minutes, f.format, f.link ?? '', now());
        out.push(Number(r.lastInsertRowid));
      }
      if (weeks) db.prepare('UPDATE lessons SET series_id = ? WHERE id = ?').run(out[0], out[0]);
      const when = weeks ? `каждую неделю с ${dm(f.day)} в ${f.time}` : `${dm(f.day)} в ${f.time}`;
      notify(familyOf(s.id), 'lesson', `Новое занятие: ${when}`, '#/schedule', { actorId: u.id });
      return out;
    });
    ctx.status = 201;
    return { lessons: ids.map(id => presentLesson(db.prepare('SELECT * FROM lessons WHERE id = ?').get(id))) };
  });

  const lessonRow = id => {
    const l = db.prepare('SELECT * FROM lessons WHERE id = ?').get(intId(id, 'Занятие'));
    if (!l) notFound('Занятие не найдено');
    return l;
  };

  // Перенос и отмена меняют только одно занятие, остальные в серии остаются как были.
  route('PATCH', '/api/v1/lessons/:id', ctx => {
    const u = ctx.user;
    onlyTutor(u);
    const l = lessonRow(ctx.params.id);
    const f = readLesson(ctx.body, l);
    const status = 'status' in ctx.body ? oneOf(ctx.body.status, LESSON_STATUS, 'Статус') : null;
    const moved = (f.day && f.day !== l.day) || (f.time && f.time !== l.time);
    if (status && ['done', 'missed'].includes(status) && !lessonStarted({ ...l, ...f })) invalid('Отметить можно только занятие, которое уже началось');
    tx(db, () => {
      const cols = Object.keys(f);
      if (cols.length) db.prepare(`UPDATE lessons SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => f[c]), l.id);
      if (moved && !l.moved_from) db.prepare('UPDATE lessons SET moved_from = ? WHERE id = ?').run(`${l.day} ${l.time}`, l.id);
      if (status) db.prepare('UPDATE lessons SET status = ? WHERE id = ?').run(status, l.id);
      const n = db.prepare('SELECT * FROM lessons WHERE id = ?').get(l.id);
      if (moved) notify(familyOf(l.student_id), 'lesson', `Занятие перенесено: ${dm(l.day)} ${l.time} → ${dm(n.day)} ${n.time}`, '#/schedule', { actorId: u.id, push: 'Занятие перенесено' });
      if (status === 'cancelled' && l.status !== 'cancelled') notify(familyOf(l.student_id), 'lesson', `Занятие отменено: ${dm(l.day)} в ${l.time}`, '#/schedule', { actorId: u.id, push: 'Занятие отменено' });
    });
    flushPush();
    return { lesson: presentLesson(lessonRow(l.id)) };
  });

  route('DELETE', '/api/v1/lessons/:id', ctx => {
    onlyTutor(ctx.user);
    const l = lessonRow(ctx.params.id);
    const future = ctx.query.get('future') === '1' && l.series_id;
    const r = future
      ? db.prepare('DELETE FROM lessons WHERE series_id = ? AND day >= ?').run(l.series_id, l.day)
      : db.prepare('DELETE FROM lessons WHERE id = ?').run(l.id);
    return { removed: r.changes };
  });

  // ---------- Главный экран ученика и родителя ----------

  route('GET', '/api/v1/overview', ctx => {
    const u = ctx.user;
    const s = viewedStudent(u, ctx.query.get('student'));
    const t = today();
    const lessons = db.prepare("SELECT * FROM lessons WHERE student_id = ? AND day >= ? AND status = 'planned' ORDER BY day, time LIMIT 6").all(s.id, t)
      .filter(l => !lessonStarted(l)).slice(0, 3).map(presentLesson);
    const issued = db.prepare('SELECT a.* FROM assignments a JOIN assignment_students x ON x.assignment_id = a.id WHERE x.student_id = ? ORDER BY a.due_day').all(s.id);
    const todo = issued.map(a => ({ a, st: statusOf(a, submissionOf(a.id, s.id)) })).filter(x => ['issued', 'draft', 'overdue'].includes(x.st))
      .map(({ a, st }) => ({ id: a.id, title: a.title, dueDay: a.due_day, status: st }));
    const recent = db.prepare(`SELECT s.*, a.title FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.student_id = ? AND s.status = 'checked' ORDER BY s.checked_at DESC LIMIT 3`).all(s.id)
      .map(x => ({ assignmentId: x.assignment_id, title: x.title, score: x.score, max: x.max_score, percent: G.percent(x.score, x.max_score), comment: x.comment }));
    const st = stats(s.id);
    return { today: t, student: { id: s.id, name: s.name }, lessons, todo, recent, average: st.average, attendance: st.attendance, weak: st.weak.map(w => w.topic) };
  });

  // ---------- Уведомления и push ----------

  route('GET', '/api/v1/notifications', ctx => {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(ctx.user.id);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(ctx.user.id).n;
    return { unread, notifications: rows.map(n => ({ id: n.id, kind: n.kind, text: n.text, link: n.link, read: !!n.read_at, createdAt: n.created_at })) };
  });

  route('POST', '/api/v1/notifications/read', ctx => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), ctx.user.id);
    return { ok: true };
  });

  route('GET', '/api/v1/push/key', () => ({ key: vapid().publicKey }));

  route('POST', '/api/v1/push/subscribe', ctx => {
    const { endpoint, keys } = ctx.body;
    if (typeof endpoint !== 'string' || endpoint.length > 1000 || !allowedEndpoint(endpoint, pushHost)) invalid('Неизвестная служба уведомлений');
    if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) invalid('Некорректная подписка');
    db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`).run(endpoint, ctx.user.id, keys.p256dh, keys.auth, now());
    return { ok: true };
  });

  route('POST', '/api/v1/push/unsubscribe', ctx => {
    db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(ctx.body.endpoint || ''), ctx.user.id);
    return { ok: true };
  });

  // ---------- Напоминания по расписанию ----------

  async function processReminders(date = new Date()) {
    const p = localParts(date, tz);
    const day = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    const nm = p.h * 60 + p.min;
    // Занятие через 2 часа: ученику и родителям, один раз.
    for (const l of db.prepare("SELECT l.* FROM lessons l JOIN users u ON u.id = l.student_id WHERE l.day = ? AND l.status = 'planned' AND u.active = 1").all(day)) {
      const left = minutesOf(l.time) - nm;
      if (left <= 0 || left > 120) continue;
      if (!once(`lesson:${l.id}:${l.day}:${l.time}`)) continue;
      notify(familyOf(l.student_id), 'remind', `Сегодня занятие в ${l.time}${l.format === 'online' ? ', онлайн' : ''}`, '#/schedule', { push: 'Скоро занятие' });
    }
    // Срок завтра: вечером накануне, если работа ещё не сдана.
    if (p.h >= DUE_REMIND_HOUR) {
      const tomorrow = shiftDay(day, 1);
      for (const a of db.prepare('SELECT * FROM assignments WHERE due_day = ?').all(tomorrow)) {
        for (const sid of issuedTo(a.id)) {
          if (!userRow(sid)?.active) continue;
          const sub = submissionOf(a.id, sid);
          if (sub && sub.status !== 'draft') continue;
          if (!once(`due:${a.id}:${sid}`)) continue;
          notify([sid], 'remind', `Завтра срок сдачи: «${a.title}»`, `#/task/${a.id}`, { push: 'Завтра срок сдачи задания' });
        }
      }
    }
    await flushPush();
  }

  return { today, processReminders };
}

module.exports = { register, ROLES, PAGE_KEYS, shiftDay };
