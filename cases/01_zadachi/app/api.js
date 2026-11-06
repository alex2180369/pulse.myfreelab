'use strict';
// Логика «Пульса задач». Все права проверяются здесь, интерфейс только скрывает лишние кнопки.
const { forbid, notFound, invalid, tx, now, text, oneOf, intId, isoDate, createInvite } = require('../../../core');

const ROLES = ['admin', 'lead', 'member'];
const STATUSES = ['new', 'progress', 'review', 'done'];
const PRIORITIES = ['low', 'normal', 'high'];
const DEFAULT_SETTINGS = { before24h: true, before3h: true, atDue: true, overdue: true, digest: true };

const isManager = u => u.role === 'admin' || u.role === 'lead';

function register(app, db, { demo }) {
  const { route } = app;

  const taskRow = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  const isMember = (projectId, userId) => !!db.prepare(
    'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);

  const canSeeTask = (u, t) => isManager(u) || t.assignee_id === u.id
    || t.creator_id === u.id || (t.project_id && isMember(t.project_id, u.id));

  const getVisibleTask = (u, id) => {
    const t = taskRow(intId(id, 'Задача'));
    // Чужая задача для сотрудника выглядит как несуществующая: номера не перебрать.
    if (!t || !canSeeTask(u, t)) notFound('Задача не найдена');
    return t;
  };

  const isOverdue = t => !!t.due_at && t.status !== 'done' && t.due_at < now();

  const presentTask = t => ({
    id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority,
    projectId: t.project_id, projectName: t.project_name ?? null,
    assigneeId: t.assignee_id, assigneeName: t.assignee_name ?? null,
    creatorId: t.creator_id, dueAt: t.due_at, doneAt: t.done_at, position: t.position,
    createdAt: t.created_at, updatedAt: t.updated_at, overdue: isOverdue(t),
    commentCount: t.comment_count ?? 0,
  });

  const LIST_SELECT = `
    SELECT t.*, p.name AS project_name, a.name AS assignee_name,
      (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN users a ON a.id = t.assignee_id`;

  const VISIBLE_SQL = `(t.assignee_id = ? OR t.creator_id = ? OR t.project_id IN
    (SELECT project_id FROM project_members WHERE user_id = ?))`;

  const addHistory = (taskId, userId, action, from, to) => db.prepare(
    'INSERT INTO task_history (task_id, user_id, action, from_value, to_value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(taskId, userId, action, from === undefined ? null : from, to === undefined ? null : to, now());

  const activeUser = id => {
    const row = db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(intId(id, 'Ответственный'));
    if (!row) invalid('Ответственный не найден');
    return row;
  };

  const checkProject = (u, id) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ? AND archived = 0').get(intId(id, 'Проект'));
    if (!p) invalid('Проект не найден');
    if (!isManager(u) && !isMember(p.id, u.id)) forbid('Вы не участник этого проекта');
    return p;
  };

  const nextPosition = (status, projectId) => {
    const row = db.prepare('SELECT MAX(position) AS m FROM tasks WHERE status = ? AND project_id IS ?').get(status, projectId);
    return (row.m ?? 0) + 1;
  };

  // Кто и на какой статус может перевести задачу.
  function checkStatusChange(u, t, to) {
    if (isManager(u)) return;
    if (t.assignee_id !== u.id) forbid('Менять статус можно только у своей задачи');
    if (t.status === 'done') forbid('Готовую задачу возвращает в работу руководитель');
    if (to === 'done') forbid('Задачу принимает руководитель: отправьте её на проверку');
  }

  const applyStatus = (u, t, status) => {
    db.prepare('UPDATE tasks SET status = ?, done_at = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'done' ? now() : null, now(), t.id);
    addHistory(t.id, u.id, 'status', t.status, status);
  };

  // ---------- Задачи ----------

  route('GET', '/api/v1/tasks', ctx => {
    const u = ctx.user;
    const where = [];
    const args = [];
    if (!isManager(u)) { where.push(VISIBLE_SQL); args.push(u.id, u.id, u.id); }
    if (ctx.query.get('mine') === '1') { where.push('t.assignee_id = ?'); args.push(u.id); }
    if (ctx.query.get('open') === '1') where.push("t.status <> 'done'");
    const status = ctx.query.get('status');
    if (status) { where.push('t.status = ?'); args.push(oneOf(status, STATUSES, 'Статус')); }
    const project = ctx.query.get('project');
    if (project === 'none') where.push('t.project_id IS NULL');
    else if (project) { where.push('t.project_id = ?'); args.push(intId(project, 'Проект')); }
    const assignee = ctx.query.get('assignee');
    if (assignee) { where.push('t.assignee_id = ?'); args.push(intId(assignee, 'Ответственный')); }
    const sql = `${LIST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.position, t.id LIMIT 1000`;
    return { tasks: db.prepare(sql).all(...args).map(presentTask) };
  });

  route('POST', '/api/v1/tasks', ctx => {
    const u = ctx.user;
    const b = ctx.body;
    if (demo && db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n >= 400) forbid('В демо достигнут предел задач, данные обновятся ночью');
    const title = text(b.title, 'Название', { min: 1, max: 200 });
    const description = text(b.description, 'Описание', { max: 5000 });
    const priority = oneOf(b.priority ?? 'normal', PRIORITIES, 'Приоритет');
    const projectId = b.projectId ? checkProject(u, b.projectId).id : null;
    let assigneeId = u.id;
    let dueAt = isoDate(b.dueAt, 'Срок');
    if (isManager(u)) {
      if (b.assigneeId) assigneeId = activeUser(b.assigneeId).id;
    } else {
      if (b.assigneeId && Number(b.assigneeId) !== u.id) forbid('Сотрудник ставит задачи только себе');
      if (dueAt) forbid('Срок назначает руководитель');
      dueAt = null;
    }
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO tasks
        (project_id, title, description, priority, assignee_id, creator_id, due_at, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectId, title, description, priority, assigneeId, u.id, dueAt, nextPosition('new', projectId), now(), now());
      const taskId = Number(r.lastInsertRowid);
      addHistory(taskId, u.id, 'created');
      return taskId;
    });
    ctx.status = 201;
    return { task: presentTask(db.prepare(`${LIST_SELECT} WHERE t.id = ?`).get(id)) };
  });

  route('GET', '/api/v1/tasks/:id', ctx => {
    const t = getVisibleTask(ctx.user, ctx.params.id);
    const full = db.prepare(`${LIST_SELECT} WHERE t.id = ?`).get(t.id);
    const comments = db.prepare(`
      SELECT c.id, c.body, c.created_at AS createdAt, c.user_id AS userId, u.name AS userName
      FROM comments c JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id`).all(t.id);
    const history = db.prepare(`
      SELECT h.id, h.action, h.from_value AS fromValue, h.to_value AS toValue, h.created_at AS createdAt, u.name AS userName
      FROM task_history h JOIN users u ON u.id = h.user_id WHERE h.task_id = ? ORDER BY h.id DESC`).all(t.id);
    return { task: presentTask(full), comments, history };
  });

  route('PATCH', '/api/v1/tasks/:id', ctx => {
    const u = ctx.user;
    const t = getVisibleTask(u, ctx.params.id);
    const b = ctx.body;
    const manager = isManager(u);
    const ownDraft = t.creator_id === u.id && t.assignee_id === u.id;

    tx(db, () => {
      const set = (column, action, value, from, to) => {
        db.prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value, now(), t.id);
        addHistory(t.id, u.id, action, from, to);
      };
      if ('title' in b) {
        if (!manager && !ownDraft) forbid('Название меняет руководитель');
        const title = text(b.title, 'Название', { min: 1, max: 200 });
        if (title !== t.title) set('title', 'title', title, t.title, title);
      }
      if ('description' in b) {
        if (!manager && !ownDraft) forbid('Описание меняет руководитель');
        const description = text(b.description, 'Описание', { max: 5000 });
        if (description !== t.description) set('description', 'description', description);
      }
      if ('priority' in b) {
        if (!manager && !ownDraft) forbid('Приоритет меняет руководитель');
        const priority = oneOf(b.priority, PRIORITIES, 'Приоритет');
        if (priority !== t.priority) set('priority', 'priority', priority, t.priority, priority);
      }
      if ('projectId' in b) {
        if (!manager) forbid('Проект меняет руководитель');
        const projectId = b.projectId ? checkProject(u, b.projectId).id : null;
        if (projectId !== t.project_id) set('project_id', 'project', projectId);
      }
      if ('assigneeId' in b) {
        if (!manager) forbid('Ответственного назначает руководитель');
        const a = b.assigneeId ? activeUser(b.assigneeId) : null;
        const id = a ? a.id : null;
        if (id !== t.assignee_id) {
          const old = t.assignee_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(t.assignee_id)?.name : null;
          set('assignee_id', 'assignee', id, old, a ? a.name : null);
        }
      }
      if ('dueAt' in b) {
        if (!manager) forbid('Срок назначает руководитель');
        const dueAt = isoDate(b.dueAt, 'Срок');
        if (dueAt !== t.due_at) set('due_at', 'due', dueAt, t.due_at, dueAt);
      }
      if ('status' in b) {
        const status = oneOf(b.status, STATUSES, 'Статус');
        if (status !== t.status) {
          checkStatusChange(u, t, status);
          applyStatus(u, t, status);
        }
      }
    });
    return { task: presentTask(db.prepare(`${LIST_SELECT} WHERE t.id = ?`).get(t.id)) };
  });

  // Перенос карточки на доске: новый статус и место в колонке.
  route('POST', '/api/v1/tasks/:id/move', ctx => {
    const u = ctx.user;
    const t = getVisibleTask(u, ctx.params.id);
    const status = oneOf(ctx.body.status, STATUSES, 'Статус');
    if (status !== t.status) checkStatusChange(u, t, status);
    else if (!isManager(u) && t.assignee_id !== u.id) forbid('Двигать можно только свою задачу');
    tx(db, () => {
      const before = ctx.body.beforeId ? taskRow(intId(ctx.body.beforeId, 'Задача')) : null;
      let position;
      if (before && before.status === status && before.id !== t.id) {
        const prev = db.prepare('SELECT MAX(position) AS m FROM tasks WHERE status = ? AND position < ? AND id <> ?')
          .get(status, before.position, t.id).m;
        position = prev === null ? before.position - 1 : (prev + before.position) / 2;
      } else {
        const last = db.prepare('SELECT MAX(position) AS m FROM tasks WHERE status = ? AND id <> ?').get(status, t.id).m;
        position = (last ?? 0) + 1;
      }
      db.prepare('UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?').run(position, now(), t.id);
      if (status !== t.status) applyStatus(u, t, status);
    });
    return { task: presentTask(db.prepare(`${LIST_SELECT} WHERE t.id = ?`).get(t.id)) };
  });

  route('DELETE', '/api/v1/tasks/:id', ctx => {
    const u = ctx.user;
    const t = getVisibleTask(u, ctx.params.id);
    if (u.role === 'member') forbid('Удалять задачи может руководитель');
    if (u.role === 'lead') {
      const project = t.project_id ? db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(t.project_id) : null;
      const own = project ? project.owner_id === u.id : t.creator_id === u.id;
      if (!own) forbid('Руководитель удаляет задачи только своих проектов');
    }
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    return { ok: true };
  });

  route('POST', '/api/v1/tasks/:id/comments', ctx => {
    const t = getVisibleTask(ctx.user, ctx.params.id);
    const body = text(ctx.body.body, 'Комментарий', { min: 1, max: 2000 });
    if (demo && db.prepare('SELECT COUNT(*) AS n FROM comments').get().n >= 1000) forbid('В демо достигнут предел комментариев, данные обновятся ночью');
    const id = tx(db, () => {
      const r = db.prepare('INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(t.id, ctx.user.id, body, now());
      addHistory(t.id, ctx.user.id, 'comment');
      return Number(r.lastInsertRowid);
    });
    ctx.status = 201;
    return { comment: { id, body, createdAt: now(), userId: ctx.user.id, userName: ctx.user.name } };
  });

  // ---------- Проекты ----------

  const projectStats = `
    SELECT p.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done' AND t.due_at < ?) AS overdue
    FROM projects p JOIN users u ON u.id = p.owner_id`;

  const presentProject = p => ({
    id: p.id, name: p.name, description: p.description, ownerId: p.owner_id, ownerName: p.owner_name,
    archived: !!p.archived, total: p.total, done: p.done, overdue: p.overdue,
    memberIds: db.prepare('SELECT user_id AS id FROM project_members WHERE project_id = ?').all(p.id).map(x => x.id),
  });

  route('GET', '/api/v1/projects', ctx => {
    const u = ctx.user;
    const rows = isManager(u)
      ? db.prepare(`${projectStats} WHERE p.archived = 0 ORDER BY p.id`).all(now())
      : db.prepare(`${projectStats} WHERE p.archived = 0 AND p.id IN
          (SELECT project_id FROM project_members WHERE user_id = ?) ORDER BY p.id`).all(now(), u.id);
    return { projects: rows.map(presentProject) };
  });

  const setMembers = (projectId, ids) => {
    db.prepare('DELETE FROM project_members WHERE project_id = ?').run(projectId);
    const add = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)');
    for (const id of ids) add.run(projectId, activeUser(id).id);
  };

  route('POST', '/api/v1/projects', ctx => {
    const u = ctx.user;
    if (!isManager(u)) forbid('Проекты создаёт руководитель');
    if (demo && db.prepare('SELECT COUNT(*) AS n FROM projects').get().n >= 30) forbid('В демо достигнут предел проектов, данные обновятся ночью');
    const name = text(ctx.body.name, 'Название', { min: 1, max: 120 });
    const description = text(ctx.body.description, 'Описание', { max: 1000 });
    const ids = Array.isArray(ctx.body.memberIds) ? ctx.body.memberIds : [];
    const id = tx(db, () => {
      const r = db.prepare('INSERT INTO projects (name, description, owner_id, created_at) VALUES (?, ?, ?, ?)')
        .run(name, description, u.id, now());
      const projectId = Number(r.lastInsertRowid);
      setMembers(projectId, [...new Set([u.id, ...ids])]);
      return projectId;
    });
    ctx.status = 201;
    return { project: presentProject(db.prepare(`${projectStats} WHERE p.id = ?`).get(now(), id)) };
  });

  route('PATCH', '/api/v1/projects/:id', ctx => {
    const u = ctx.user;
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(intId(ctx.params.id, 'Проект'));
    if (!p) notFound('Проект не найден');
    if (!(u.role === 'admin' || (u.role === 'lead' && p.owner_id === u.id))) forbid('Проект меняет его владелец или администратор');
    const name = 'name' in ctx.body ? text(ctx.body.name, 'Название', { min: 1, max: 120 }) : p.name;
    const description = 'description' in ctx.body ? text(ctx.body.description, 'Описание', { max: 1000 }) : p.description;
    const archived = 'archived' in ctx.body ? (ctx.body.archived ? 1 : 0) : p.archived;
    tx(db, () => {
      db.prepare('UPDATE projects SET name = ?, description = ?, archived = ? WHERE id = ?').run(name, description, archived, p.id);
      if (Array.isArray(ctx.body.memberIds)) setMembers(p.id, [...new Set([p.owner_id, ...ctx.body.memberIds])]);
    });
    return { project: presentProject(db.prepare(`${projectStats} WHERE p.id = ?`).get(now(), p.id)) };
  });

  // ---------- Команда ----------

  route('GET', '/api/v1/team', ctx => {
    const manager = isManager(ctx.user);
    const rows = db.prepare(`
      SELECT u.id, u.login, u.name, u.role, u.active,
        (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status = 'progress') AS in_progress,
        (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status <> 'done') AS open,
        (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status <> 'done' AND t.due_at < ?) AS overdue
      FROM users u WHERE u.active = 1 OR ? = 1 ORDER BY u.active DESC, u.name`).all(now(), ctx.user.role === 'admin' ? 1 : 0);
    return {
      members: rows.map(r => manager
        ? { id: r.id, login: r.login, name: r.name, role: r.role, active: !!r.active, inProgress: r.in_progress, open: r.open, overdue: r.overdue }
        : { id: r.id, name: r.name, role: r.role, active: !!r.active }),
    };
  });

  const adminOnly = u => { if (u.role !== 'admin') forbid('Командой управляет администратор'); };

  route('POST', '/api/v1/team/invites', ctx => {
    adminOnly(ctx.user);
    if (demo) forbid('В демо новых участников не приглашаем');
    const name = text(ctx.body.name, 'Имя', { min: 1, max: 80 });
    const role = oneOf(ctx.body.role, ROLES, 'Роль');
    const token = createInvite(db, { name, role, createdBy: ctx.user.id });
    ctx.status = 201;
    return { token };
  });

  route('PATCH', '/api/v1/team/:id', ctx => {
    adminOnly(ctx.user);
    if (demo) forbid('В демо состав команды не меняется');
    const id = intId(ctx.params.id, 'Участник');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) notFound('Участник не найден');
    const role = 'role' in ctx.body ? oneOf(ctx.body.role, ROLES, 'Роль') : target.role;
    const active = 'active' in ctx.body ? (ctx.body.active ? 1 : 0) : target.active;
    const leavesAdmins = target.role === 'admin' && target.active === 1 && (role !== 'admin' || !active);
    if (leavesAdmins && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n <= 1) {
      invalid('В команде должен остаться хотя бы один администратор');
    }
    tx(db, () => {
      db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(role, active, id);
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    });
    return { ok: true };
  });

  // ---------- Настройки напоминаний ----------

  const readSettings = id => {
    const row = db.prepare('SELECT data FROM user_settings WHERE user_id = ?').get(id);
    return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.data) : {}) };
  };

  route('GET', '/api/v1/settings', ctx => ({ settings: readSettings(ctx.user.id) }));

  route('PUT', '/api/v1/settings', ctx => {
    const next = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) next[key] = key in ctx.body ? !!ctx.body[key] : readSettings(ctx.user.id)[key];
    db.prepare('INSERT INTO user_settings (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data')
      .run(ctx.user.id, JSON.stringify(next));
    return { settings: next };
  });
}

module.exports = { register, ROLES, STATUSES, PRIORITIES };
