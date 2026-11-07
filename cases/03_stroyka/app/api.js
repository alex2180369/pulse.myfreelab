'use strict';
// Логика «Прораба». Каждый запрос проверяет право на конкретный объект, интерфейс только скрывает лишнее.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  HttpError, forbid, notFound, invalid, tx, now, text, oneOf, intId, createInvite,
} = require('../../../core');
const { localParts } = require('../../../core/dateparse');

const ROLES = ['director', 'manager', 'foreman', 'worker'];
const SITE_STATUS = ['active', 'hold', 'done'];
const TASK_STATUS = ['todo', 'doing', 'done'];
const PROBLEMS = ['materials', 'power', 'people', 'weather'];
const PROBLEM_LABEL = { materials: 'нет материалов', power: 'нет электричества', people: 'не хватает людей', weather: 'погода' };
const QC_KINDS = ['drywall', 'paint', 'tile'];
const QC_NAME = { drywall: 'Гипсокартон', paint: 'Малярные работы', tile: 'Плитка' };
const QC_TEMPLATE = {
  drywall: ['Ровность плоскости по правилу', 'Шаг и крепление профиля', 'Заделка стыков и лента', 'Углы без трещин'],
  paint: ['Подготовка и грунт', 'Ровный цвет без полос', 'Нет потёков', 'Чистые примыкания к потолку и плинтусу'],
  tile: ['Ровность плоскости', 'Одинаковая ширина швов', 'Нет пустот под плиткой', 'Затирка без пропусков'],
};
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO = 3 * 1024 * 1024;
const DEMO_MAX_UPLOADS = 200;
const REPORT_DUE_HOUR = 17;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isImage = (buf, type) => {
  if (type === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'image/png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp') return buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
};

const realDate = v => DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const optDate = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !realDate(v)) invalid(`Недопустимая дата в поле «${name}»`);
  return v;
};

function register(app, db, { demo, tz, photosDir, seedDir }) {
  const { route } = app;

  const today = () => {
    const p = localParts(new Date(), tz);
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  };
  const hourNow = () => localParts(new Date(), tz).h;

  // ---------- Права ----------

  const site = id => db.prepare('SELECT * FROM sites WHERE id = ?').get(intId(id, 'Объект'));
  const leads = (u, s) => u.role === 'director' || (u.role === 'manager' && s.manager_id === u.id) || (u.role === 'foreman' && s.foreman_id === u.id);

  // Рабочий и посторонний видят «не найдено»: номера объектов не перебрать.
  const siteFor = (u, id) => {
    const s = site(id);
    if (!s || !leads(u, s)) notFound('Объект не найден');
    return s;
  };
  const taskRow = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(intId(id, 'Задача'));
  const taskFor = (u, id) => {
    const t = taskRow(id);
    if (!t) notFound('Задача не найдена');
    if (t.assignee_id === u.id) return t;
    if (!leads(u, site(t.site_id))) notFound('Задача не найдена');
    return t;
  };
  const activeUser = id => {
    const row = db.prepare('SELECT id, name, role FROM users WHERE id = ? AND active = 1').get(intId(id, 'Сотрудник'));
    if (!row) invalid('Сотрудник не найден');
    return row;
  };

  // ---------- Уведомления ----------

  const notify = (userIds, kind, message, link, actorId) => {
    const add = db.prepare('INSERT INTO notifications (user_id, kind, text, link, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const id of new Set(userIds.filter(x => x && x !== actorId))) add.run(id, kind, message, link, now());
  };
  const directors = () => db.prepare("SELECT id FROM users WHERE role = 'director' AND active = 1").all().map(x => x.id);
  const leadership = s => [...directors(), s.manager_id];

  // ---------- Представление данных ----------

  const nameOf = id => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null : null);

  const presentTask = t => ({
    id: t.id, siteId: t.site_id, siteName: db.prepare('SELECT name FROM sites WHERE id = ?').get(t.site_id)?.name,
    title: t.title, assigneeId: t.assignee_id, assigneeName: nameOf(t.assignee_id), dueDate: t.due_date, status: t.status,
    overdue: !!t.due_date && t.status !== 'done' && t.due_date < today(),
    photos: db.prepare('SELECT id FROM photos WHERE task_id = ? ORDER BY id').all(t.id).map(x => x.id),
  });

  const presentReport = r => ({
    id: r.id, siteId: r.site_id, day: r.day, doneText: r.done_text, workers: r.workers, problems: JSON.parse(r.problems), problemText: r.problem_text,
    authorName: nameOf(r.author_id), updatedAt: r.updated_at, locked: r.day !== today(),
    photos: db.prepare('SELECT id FROM photos WHERE report_id = ? ORDER BY id').all(r.id).map(x => x.id),
  });

  function presentSite(s) {
    const t = today();
    const c = db.prepare(`SELECT
      SUM(status <> 'done') AS open, SUM(status = 'done') AS done,
      SUM(status <> 'done' AND due_date IS NOT NULL AND due_date < ?) AS overdue, COUNT(*) AS total FROM tasks WHERE site_id = ?`).get(t, s.id);
    const report = db.prepare('SELECT * FROM reports WHERE site_id = ? AND day = ?').get(s.id, t);
    const fixes = db.prepare("SELECT COUNT(*) AS n FROM qc_items WHERE site_id = ? AND state = 'fix'").get(s.id).n;
    return {
      id: s.id, name: s.name, address: s.address, startDate: s.start_date, endDate: s.end_date, status: s.status,
      managerId: s.manager_id, managerName: nameOf(s.manager_id), foremanId: s.foreman_id, foremanName: nameOf(s.foreman_id),
      openTasks: c.open ?? 0, doneTasks: c.done ?? 0, totalTasks: c.total, overdueTasks: c.overdue ?? 0, fixes,
      reportToday: !!report,
      // Отчёт ждут к вечеру и только с действующих объектов.
      reportMissing: s.status === 'active' && !report && hourNow() >= REPORT_DUE_HOUR,
      problemsToday: report ? [...JSON.parse(report.problems).map(p => PROBLEM_LABEL[p]), ...(report.problem_text ? [report.problem_text] : [])] : [],
    };
  }

  const visibleSites = u => {
    if (u.role === 'director') return db.prepare('SELECT * FROM sites ORDER BY id').all();
    if (u.role === 'manager') return db.prepare('SELECT * FROM sites WHERE manager_id = ? ORDER BY id').all(u.id);
    if (u.role === 'foreman') return db.prepare('SELECT * FROM sites WHERE foreman_id = ? ORDER BY id').all(u.id);
    return [];
  };

  // ---------- Сводка и объекты ----------

  route('GET', '/api/v1/sites', ctx => ({ today: today(), sites: visibleSites(ctx.user).map(presentSite) }));

  const readSite = (b, s) => {
    const out = {};
    if ('name' in b) out.name = text(b.name, 'Название', { min: 1, max: 120 });
    if ('address' in b) out.address = text(b.address, 'Адрес', { max: 200 });
    if ('startDate' in b) out.start_date = optDate(b.startDate, 'Начало');
    if ('endDate' in b) out.end_date = optDate(b.endDate, 'Окончание');
    if ('status' in b) out.status = oneOf(b.status, SITE_STATUS, 'Статус');
    const start = out.start_date ?? s?.start_date; const end = out.end_date ?? s?.end_date;
    if (start && end && end < start) invalid('Окончание раньше начала');
    if ('foremanId' in b) {
      out.foreman_id = b.foremanId ? activeUser(b.foremanId).id : null;
      if (out.foreman_id && activeUser(out.foreman_id).role !== 'foreman') invalid('Ответственным на объекте может быть только прораб');
    }
    if ('managerId' in b) {
      out.manager_id = b.managerId ? activeUser(b.managerId).id : null;
      if (out.manager_id && activeUser(out.manager_id).role !== 'manager') invalid('Выберите менеджера проектов');
    }
    return out;
  };

  route('POST', '/api/v1/sites', ctx => {
    const u = ctx.user;
    if (!['director', 'manager'].includes(u.role)) forbid('Объекты создаёт руководство');
    if (demo && db.prepare('SELECT COUNT(*) AS n FROM sites').get().n >= 30) forbid('В демо достигнут предел объектов, данные обновятся ночью');
    const f = readSite(ctx.body);
    if (!f.name) invalid('Заполните поле «Название»');
    if (u.role === 'manager') f.manager_id = u.id;
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO sites (name, address, start_date, end_date, status, manager_id, foreman_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(f.name, f.address ?? '', f.start_date ?? null, f.end_date ?? null, f.status ?? 'active', f.manager_id ?? null, f.foreman_id ?? null, now());
      const siteId = Number(r.lastInsertRowid);
      addChecklists(siteId);
      return siteId;
    });
    ctx.status = 201;
    return { site: presentSite(site(id)) };
  });

  function addChecklists(siteId) {
    const add = db.prepare('INSERT INTO qc_items (site_id, kind, position, label) VALUES (?, ?, ?, ?)');
    for (const kind of QC_KINDS) QC_TEMPLATE[kind].forEach((label, i) => add.run(siteId, kind, i, label));
  }

  route('GET', '/api/v1/sites/:id', ctx => {
    const s = siteFor(ctx.user, ctx.params.id);
    const tasks = db.prepare("SELECT * FROM tasks WHERE site_id = ? ORDER BY status = 'done', COALESCE(due_date, '9999'), id").all(s.id).map(presentTask);
    const reports = db.prepare('SELECT * FROM reports WHERE site_id = ? ORDER BY day DESC LIMIT 60').all(s.id).map(presentReport);
    const photos = db.prepare('SELECT id, day, author_id, report_id, task_id, qc_item_id FROM photos WHERE site_id = ? ORDER BY id DESC LIMIT 200').all(s.id)
      .map(p => ({ id: p.id, day: p.day, authorName: nameOf(p.author_id), reportId: p.report_id, taskId: p.task_id, qcItemId: p.qc_item_id }));
    return { site: presentSite(s), tasks, reports, photos, qc: qcOf(s) };
  });

  route('PATCH', '/api/v1/sites/:id', ctx => {
    const u = ctx.user;
    const s = siteFor(u, ctx.params.id);
    if (u.role === 'foreman') forbid('Объект меняет руководство');
    const f = readSite(ctx.body, s);
    if (u.role === 'manager' && 'manager_id' in f) forbid('Менеджера объекта назначает директор');
    const columns = Object.keys(f);
    if (columns.length) db.prepare(`UPDATE sites SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...columns.map(c => f[c]), s.id);
    return { site: presentSite(site(s.id)) };
  });

  // ---------- Задачи ----------

  route('GET', '/api/v1/my-tasks', ctx => {
    const rows = db.prepare("SELECT * FROM tasks WHERE assignee_id = ? ORDER BY status = 'done', COALESCE(due_date, '9999'), id LIMIT 200").all(ctx.user.id);
    return { tasks: rows.map(presentTask) };
  });

  function createTask(u, s, b) {
    if (demo && db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n >= 400) forbid('В демо достигнут предел задач, данные обновятся ночью');
    const title = text(b.title, 'Что сделать', { min: 1, max: 200 });
    const assignee = b.assigneeId ? activeUser(b.assigneeId) : null;
    const due = optDate(b.dueDate, 'Срок');
    const r = db.prepare('INSERT INTO tasks (site_id, title, assignee_id, due_date, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, title, assignee?.id ?? null, due, u.id, now(), now());
    const id = Number(r.lastInsertRowid);
    if (assignee) notify([assignee.id], 'task', `Новая задача на объекте «${s.name}»: ${title}`, '#/tasks', u.id);
    return taskRow(id);
  }

  route('POST', '/api/v1/sites/:id/tasks', ctx => {
    const s = siteFor(ctx.user, ctx.params.id);
    const t = tx(db, () => createTask(ctx.user, s, ctx.body));
    ctx.status = 201;
    return { task: presentTask(t) };
  });

  route('PATCH', '/api/v1/tasks/:id', ctx => {
    const u = ctx.user;
    const t = taskFor(u, ctx.params.id);
    const s = site(t.site_id);
    const lead = leads(u, s);
    const b = ctx.body;
    if (!lead && Object.keys(b).some(k => k !== 'status')) forbid('Рабочий меняет только статус своей задачи');
    tx(db, () => {
      if ('title' in b) db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(text(b.title, 'Что сделать', { min: 1, max: 200 }), t.id);
      if ('dueDate' in b) db.prepare('UPDATE tasks SET due_date = ? WHERE id = ?').run(optDate(b.dueDate, 'Срок'), t.id);
      if ('assigneeId' in b) {
        const a = b.assigneeId ? activeUser(b.assigneeId) : null;
        db.prepare('UPDATE tasks SET assignee_id = ? WHERE id = ?').run(a?.id ?? null, t.id);
        if (a && a.id !== t.assignee_id) notify([a.id], 'task', `Новая задача на объекте «${s.name}»: ${t.title}`, '#/tasks', u.id);
      }
      if ('status' in b) {
        const status = oneOf(b.status, TASK_STATUS, 'Статус');
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, t.id);
        if (status === 'done' && t.status !== 'done') notify([s.foreman_id], 'task', `Выполнено на объекте «${s.name}»: ${t.title}`, `#/site/${s.id}/tasks`, u.id);
      }
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), t.id);
    });
    return { task: presentTask(taskRow(t.id)) };
  });

  route('DELETE', '/api/v1/tasks/:id', ctx => {
    const t = taskFor(ctx.user, ctx.params.id);
    if (!leads(ctx.user, site(t.site_id))) forbid('Удалять задачи может руководство');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    return { ok: true };
  });

  // ---------- Ежедневный отчёт ----------

  const canWriteReport = (u, s) => u.role === 'foreman' && s.foreman_id === u.id;

  route('GET', '/api/v1/sites/:id/reports/:day', ctx => {
    const s = siteFor(ctx.user, ctx.params.id);
    if (!realDate(ctx.params.day)) invalid('Недопустимая дата');
    const r = db.prepare('SELECT * FROM reports WHERE site_id = ? AND day = ?').get(s.id, ctx.params.day);
    return { report: r ? presentReport(r) : null, today: today(), canEdit: canWriteReport(ctx.user, s) && ctx.params.day === today() };
  });

  route('PUT', '/api/v1/sites/:id/reports/:day', ctx => {
    const u = ctx.user;
    const s = siteFor(u, ctx.params.id);
    if (!canWriteReport(u, s)) forbid('Отчёт заполняет прораб объекта');
    if (ctx.params.day !== today()) forbid('Отчёт можно заполнить и поправить только в тот же день');
    const b = ctx.body;
    const doneText = text(b.doneText, 'Что сделано', { min: 1, max: 2000 });
    const workers = Number(b.workers);
    if (!Number.isInteger(workers) || workers < 0 || workers > 500) invalid('Укажите, сколько человек работало');
    const problems = Array.isArray(b.problems) ? [...new Set(b.problems)] : [];
    if (problems.some(p => !PROBLEMS.includes(p))) invalid('Неизвестная проблема');
    const problemText = text(b.problemText, 'Проблема', { max: 500 });
    const day = today();
    const had = db.prepare('SELECT * FROM reports WHERE site_id = ? AND day = ?').get(s.id, day);
    tx(db, () => {
      db.prepare(`INSERT INTO reports (site_id, day, author_id, done_text, workers, problems, problem_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(site_id, day) DO UPDATE SET done_text = excluded.done_text, workers = excluded.workers,
          problems = excluded.problems, problem_text = excluded.problem_text, updated_at = excluded.updated_at`)
        .run(s.id, day, u.id, doneText, workers, JSON.stringify(problems), problemText, now(), now());
      const link = `#/report/${s.id}/${day}`;
      if (!had) notify(leadership(s), 'report', `Отчёт за сегодня: ${s.name}`, link, u.id);
      const newProblems = problems.filter(p => !(had ? JSON.parse(had.problems) : []).includes(p)).map(p => PROBLEM_LABEL[p]);
      if (problemText && problemText !== had?.problem_text) newProblems.push(problemText);
      if (newProblems.length) notify(leadership(s), 'problem', `Проблема на объекте «${s.name}»: ${newProblems.join(', ')}`, link, u.id);
    });
    if (!had) ctx.status = 201;
    return { report: presentReport(db.prepare('SELECT * FROM reports WHERE site_id = ? AND day = ?').get(s.id, day)) };
  });

  // ---------- Контроль качества ----------

  function qcOf(s) {
    const rows = db.prepare('SELECT * FROM qc_items WHERE site_id = ? ORDER BY kind, position').all(s.id);
    return QC_KINDS.map(kind => ({
      kind, name: QC_NAME[kind],
      items: rows.filter(r => r.kind === kind).map(r => ({
        id: r.id, label: r.label, state: r.state, note: r.note, taskId: r.task_id,
        checkedBy: nameOf(r.checked_by), checkedAt: r.checked_at,
        photos: db.prepare('SELECT id FROM photos WHERE qc_item_id = ? ORDER BY id').all(r.id).map(x => x.id),
      })),
    }));
  }

  const qcItem = (u, id) => {
    const item = db.prepare('SELECT * FROM qc_items WHERE id = ?').get(intId(id, 'Пункт'));
    if (!item) notFound('Пункт не найден');
    return { item, s: siteFor(u, item.site_id) };
  };

  route('PATCH', '/api/v1/qc/:id', ctx => {
    const u = ctx.user;
    const { item, s } = qcItem(u, ctx.params.id);
    const state = ctx.body.state === null ? null : oneOf(ctx.body.state, ['ok', 'fix'], 'Оценка');
    const note = 'note' in ctx.body ? text(ctx.body.note, 'Примечание', { max: 500 }) : item.note;
    tx(db, () => {
      db.prepare('UPDATE qc_items SET state = ?, note = ?, checked_by = ?, checked_at = ? WHERE id = ?').run(state, note, u.id, now(), item.id);
      if (state === 'fix' && item.state !== 'fix') {
        notify([...leadership(s), s.foreman_id], 'problem', `Нужно исправить на объекте «${s.name}»: ${item.label}`, `#/site/${s.id}/qc`, u.id);
      }
    });
    return { qc: qcOf(s) };
  });

  // Задача на исправление создаётся из дефекта один раз.
  route('POST', '/api/v1/qc/:id/task', ctx => {
    const u = ctx.user;
    const { item, s } = qcItem(u, ctx.params.id);
    if (item.state !== 'fix') invalid('Задачу создаём только для пункта «нужно исправить»');
    if (item.task_id) invalid('Задача по этому пункту уже создана');
    const t = tx(db, () => {
      const task = createTask(u, s, { title: `Исправить: ${item.label}`, assigneeId: ctx.body.assigneeId, dueDate: ctx.body.dueDate });
      db.prepare('UPDATE qc_items SET task_id = ? WHERE id = ?').run(task.id, item.id);
      db.prepare('UPDATE photos SET task_id = ? WHERE qc_item_id = ? AND task_id IS NULL').run(task.id, item.id);
      return task;
    });
    ctx.status = 201;
    return { task: presentTask(t), qc: qcOf(s) };
  });

  // ---------- Фото ----------

  route('POST', '/api/v1/sites/:id/photos', ctx => {
    const u = ctx.user;
    const q = ctx.query;
    const s = site(ctx.params.id);
    if (!s) notFound('Объект не найден');
    const lead = leads(u, s);
    let taskId = null;
    if (q.get('task')) {
      const t = taskFor(u, q.get('task'));
      if (t.site_id !== s.id) invalid('Задача с другого объекта');
      taskId = t.id;
    } else if (!lead) notFound('Объект не найден');
    let reportId = null;
    if (q.get('report')) {
      if (!lead) forbid('Недостаточно прав');
      const r = db.prepare('SELECT * FROM reports WHERE id = ? AND site_id = ?').get(intId(q.get('report'), 'Отчёт'), s.id);
      if (!r) invalid('Отчёт не найден');
      if (r.day !== today()) forbid('Отчёт за прошлый день закрыт');
      reportId = r.id;
    }
    let qcItemId = null;
    if (q.get('qc')) {
      if (!lead) forbid('Недостаточно прав');
      const it = db.prepare('SELECT id FROM qc_items WHERE id = ? AND site_id = ?').get(intId(q.get('qc'), 'Пункт'), s.id);
      if (!it) invalid('Пункт не найден');
      qcItemId = it.id;
    }
    if (!isImage(ctx.file, ctx.fileType)) invalid('Это не изображение');
    if (demo && db.prepare('SELECT COUNT(*) AS n FROM photos WHERE seeded = 0').get().n >= DEMO_MAX_UPLOADS) forbid('В демо достигнут предел фото, данные обновятся ночью');
    const file = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(photosDir, { recursive: true });
    fs.writeFileSync(path.join(photosDir, file), ctx.file);
    const r = db.prepare('INSERT INTO photos (site_id, author_id, file, type, size, day, report_id, task_id, qc_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, u.id, file, ctx.fileType, ctx.file.length, today(), reportId, taskId, qcItemId, now());
    ctx.status = 201;
    return { photo: { id: Number(r.lastInsertRowid), day: today(), authorName: u.name } };
  }, { upload: { types: IMAGE_TYPES, maxBytes: MAX_PHOTO } });

  const photoFor = (u, id) => {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(intId(id, 'Фото'));
    if (!p) notFound('Фото не найдено');
    const allowed = leads(u, site(p.site_id)) || (p.task_id && db.prepare('SELECT 1 FROM tasks WHERE id = ? AND assignee_id = ?').get(p.task_id, u.id));
    if (!allowed) notFound('Фото не найдено');
    return p;
  };

  route('GET', '/api/v1/photos/:id', ctx => {
    const p = photoFor(ctx.user, ctx.params.id);
    ctx.sendFile = { path: path.join(p.seeded ? seedDir : photosDir, path.basename(p.file)), type: p.type };
  });

  route('DELETE', '/api/v1/photos/:id', ctx => {
    const u = ctx.user;
    const p = photoFor(u, ctx.params.id);
    if (!(u.role === 'director' || p.author_id === u.id)) forbid('Удалить фото может автор или директор');
    db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    if (!p.seeded) fs.rmSync(path.join(photosDir, path.basename(p.file)), { force: true });
    return { ok: true };
  });

  // ---------- Сотрудники ----------

  route('GET', '/api/v1/team', ctx => {
    const u = ctx.user;
    if (u.role === 'worker') forbid('Недостаточно прав');
    const director = u.role === 'director';
    const rows = db.prepare(`SELECT id, login, name, role, active FROM users WHERE active = 1 OR ? = 1 ORDER BY active DESC, name`).all(director ? 1 : 0);
    return { members: rows.map(r => ({ id: r.id, name: r.name, role: r.role, active: !!r.active, ...(director ? { login: r.login } : {}) })) };
  });

  const directorOnly = u => { if (u.role !== 'director') forbid('Сотрудниками управляет директор'); };

  route('POST', '/api/v1/team/invites', ctx => {
    directorOnly(ctx.user);
    if (demo) forbid('В демо новых сотрудников не приглашаем');
    const name = text(ctx.body.name, 'Имя', { min: 1, max: 80 });
    const role = oneOf(ctx.body.role, ROLES, 'Роль');
    ctx.status = 201;
    return { token: createInvite(db, { name, role, createdBy: ctx.user.id }) };
  });

  route('PATCH', '/api/v1/team/:id', ctx => {
    directorOnly(ctx.user);
    if (demo) forbid('В демо состав не меняется');
    const id = intId(ctx.params.id, 'Сотрудник');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) notFound('Сотрудник не найден');
    const role = 'role' in ctx.body ? oneOf(ctx.body.role, ROLES, 'Роль') : target.role;
    const active = 'active' in ctx.body ? (ctx.body.active ? 1 : 0) : target.active;
    const leaving = target.role === 'director' && target.active === 1 && (role !== 'director' || !active);
    if (leaving && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'director' AND active = 1").get().n <= 1) invalid('Должен остаться хотя бы один директор');
    tx(db, () => {
      db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(role, active, id);
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    });
    return { ok: true };
  });

  // ---------- Уведомления ----------

  route('GET', '/api/v1/notifications', ctx => {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(ctx.user.id);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(ctx.user.id).n;
    return { unread, notifications: rows.map(n => ({ id: n.id, kind: n.kind, text: n.text, link: n.link, read: !!n.read_at, createdAt: n.created_at })) };
  });

  route('POST', '/api/v1/notifications/read', ctx => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), ctx.user.id);
    return { ok: true };
  });

  return { addChecklists, today };
}

module.exports = { register, ROLES, QC_KINDS, QC_TEMPLATE };
