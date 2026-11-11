import { h, clear, api, setBearer, guard, toast, openDialog, confirmDialog, formatDue, formatDateTime, toLocalInput, fromLocalInput, avatar, field, select, dayDiff, ApiError } from '/shared/ui.js';
import { renderBoard } from '/board.js';
import { telegram, telegramReady } from '/shared/telegram.js';

export const STATUS = { new: 'Новая', progress: 'В работе', review: 'На проверке', done: 'Готово' };
export const PRIORITY = { low: 'Низкий', normal: 'Обычный', high: 'Высокий' };
const ROLE = { admin: 'Администратор', lead: 'Руководитель', member: 'Сотрудник' };

export const state = { user: null, demo: false, roles: [], team: [], projects: [] };
const root = document.getElementById('app');

export const isManager = () => state.user && state.user.role !== 'member';
const isAdmin = () => state.user?.role === 'admin';

const icon = (paths) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
};

const NAV = [
  ['mine', 'Мои задачи', ['M4 6h16M4 12h16M4 18h10'], 'Задачи'],
  ['board', 'Доска', ['M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v12h-4z']],
  ['projects', 'Проекты', ['M3 7h7l2 3h9v9H3z']],
  ['team', 'Команда', ['M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-4 3-6 6-6s6 2 6 6M16 11a3 3 0 1 0 0-6M17 14c3 0 5 2 5 6']],
  ['settings', 'Настройки', ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1']],
];

function parseRoute() {
  const [path, qs] = (location.hash.slice(1) || '/mine').split('?');
  const parts = path.split('/').filter(Boolean);
  return { view: parts[0] || 'mine', id: parts[1], query: new URLSearchParams(qs || '') };
}

export const go = path => { location.hash = path; };

function brand() {
  return h('a', { class: 'brand', href: '#/mine' },
    h('img', { src: '/favicon.svg', alt: '', width: 28, height: 28 }), h('span', null, 'Пульс задач'));
}

function shell(active, content) {
  return h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      brand(),
      h('nav', { class: 'nav', 'aria-label': 'Разделы' }, NAV.map(([key, label, paths, short]) =>
        h('a', { class: `nav-item ${active === key ? 'active' : ''}`, href: `#/${key}`, 'aria-label': label, 'aria-current': active === key ? 'page' : null },
          icon(paths), h('span', { class: short ? 'wide-only' : null }, label), short && h('span', { class: 'narrow-only' }, short)))),
      h('div', { class: 'whoami' }, avatar(state.user.name, state.user.id),
        h('div', null, h('div', { class: 'whoami-name' }, state.user.name), h('div', { class: 'muted small' }, ROLE[state.user.role]))),
    ),
    h('main', { class: 'main' }, content));
}

async function loadShared() {
  const [team, projects] = await Promise.all([api('GET', '/team'), api('GET', '/projects')]);
  state.team = team.members;
  state.projects = projects.projects;
}

let renderToken = 0;

// Вход из Telegram делается один раз за открытие приложения.
let telegramTried = false;
async function loginFromTelegram() {
  if (telegramTried || !telegram.initData) return;
  telegramTried = true;
  try {
    const r = await api('POST', '/auth/telegram', { initData: telegram.initData });
    setBearer(r.token);
  } catch (e) {
    if (e.code !== 'not_linked') toast(e.message, 'error');
  }
}

export async function render() {
  const token = ++renderToken;
  const route = parseRoute();
  if (route.view === 'invite') return renderInvite(route.id);
  await loginFromTelegram();
  telegramReady();
  if (!state.user) {
    try {
      const me = await api('GET', '/me');
      state.user = me.user;
      state.demo = me.demo;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return renderLogin();
      return clear(root, h('div', { class: 'empty full' }, h('strong', null, 'Сервер недоступен'), e.message));
    }
  }
  const content = h('div', { class: 'page' });
  const showTaskPanel = route.view === 'task';
  const base = showTaskPanel ? 'mine' : route.view;
  const views = { mine: renderMine, board: renderBoard, projects: renderProjects, team: renderTeam, settings: renderSettings };
  const view = views[base] || renderMine;
  try {
    await loadShared();
    await view(content, route);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { state.user = null; return renderLogin(); }
    clear(content, h('div', { class: 'empty' }, h('strong', null, 'Не удалось загрузить данные'), e.message,
      h('button', { class: 'btn', onclick: render }, 'Повторить')));
  }
  if (token !== renderToken) return;
  clear(root, shell(base, content));
  if (showTaskPanel) openTask(Number(route.id));
}

// ---------- Вход ----------

function renderLogin() {
  const login = h('input', { name: 'login', autocomplete: 'username', required: true });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const demoBox = h('div', { class: 'stack', hidden: true });
  const form = h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const r = await api('POST', '/auth/login', { login: login.value, password: password.value, bearer: !!telegram.initData });
        if (r.token) setBearer(r.token);
        state.user = r.user;
        render();
      });
    },
  }, field('Логин', login), field('Пароль', password), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти'));

  clear(root, h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, brand(),
    h('p', { class: 'muted' }, 'Задачи команды в одном месте: кто делает, что делает и к какому сроку.'), form, demoBox)));

  guard(async () => {
    const cfg = await api('GET', '/auth/config');
    state.roles = cfg.roles;
    if (!cfg.demo) return;
    form.hidden = true;
    demoBox.hidden = false;
    clear(demoBox, h('p', { class: 'field-label' }, 'Демо с выдуманной командой. Войдите в одной из ролей:'),
      cfg.roles.map(role => h('button', {
        class: 'btn', type: 'button', 'data-role': role,
        onclick: () => guard(async () => {
          const r = await api('POST', '/auth/demo', { role, bearer: !!telegram.initData });
          if (r.token) setBearer(r.token);
          state.user = r.user;
          state.demo = true;
          render();
        }),
      }, ROLE[role])),
      h('p', { class: 'muted small' }, 'Изменения видны всем посетителям и сбрасываются раз в сутки.'));
  });
}

async function renderInvite(token) {
  const info = await api('GET', `/auth/invite/${encodeURIComponent(token)}`).catch(e => e);
  if (info instanceof Error) {
    clear(root, h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, brand(), h('h2', null, 'Приглашение не работает'),
      h('p', { class: 'muted' }, info.message), h('a', { class: 'btn', href: '#/mine' }, 'На страницу входа'))));
    return;
  }
  const login = h('input', { autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  clear(root, h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, brand(),
    h('h2', null, `${info.name}, добро пожаловать`),
    h('p', { class: 'muted' }, `Вас пригласили в команду. Роль: ${ROLE[info.role]}.`),
    h('form', {
      class: 'stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => {
          const r = await api('POST', `/auth/invite/${encodeURIComponent(token)}`, { login: login.value, password: password.value });
          state.user = r.user;
          location.hash = '/mine';
        });
      },
    }, field('Придумайте логин', login, 'Латиница и цифры'), field('Придумайте пароль', password, 'Минимум 8 символов'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти в команду')))));
}

// ---------- Общие элементы задачи ----------

export function dueBadge(task) {
  if (!task.dueAt) return null;
  const cls = task.overdue ? 'due due-late' : (dayDiff(task.dueAt) === 0 && task.status !== 'done' ? 'due due-today' : 'due');
  return h('span', { class: cls }, task.overdue ? `просрочено: ${formatDue(task.dueAt)}` : formatDue(task.dueAt));
}

export const priorityMark = p => h('span', { class: `prio prio-${p}`, title: `Приоритет: ${PRIORITY[p].toLowerCase()}` });

function taskRow(task) {
  return h('button', { class: 'task-row', type: 'button', 'data-task': task.id, onclick: () => openTask(task.id) },
    priorityMark(task.priority),
    h('span', { class: 'task-row-main' }, h('span', { class: 'task-row-title' }, task.title),
      h('span', { class: 'task-row-meta' }, task.projectName || 'Без проекта', task.assigneeId !== state.user.id && task.assigneeName ? ` · ${task.assigneeName}` : '')),
    h('span', { class: `status status-${task.status}` }, STATUS[task.status]),
    dueBadge(task));
}

// ---------- Мои задачи ----------

async function renderMine(page) {
  const [{ tasks }, review] = await Promise.all([
    api('GET', '/tasks?mine=1&open=1'),
    isManager() ? api('GET', '/tasks?status=review') : Promise.resolve({ tasks: [] }),
  ]);
  const groups = { overdue: [], today: [], soon: [], later: [] };
  for (const t of tasks) {
    if (t.overdue) groups.overdue.push(t);
    else if (t.dueAt && dayDiff(t.dueAt) === 0) groups.today.push(t);
    else if (t.dueAt && dayDiff(t.dueAt) <= 7) groups.soon.push(t);
    else groups.later.push(t);
  }
  const byDue = (a, b) => (a.dueAt || '9').localeCompare(b.dueAt || '9');
  Object.values(groups).forEach(g => g.sort(byDue));

  const input = h('input', { placeholder: 'Что нужно сделать?', 'aria-label': 'Название новой задачи', maxlength: 200, id: 'quick-title' });
  const quick = h('form', {
    class: 'quick-add',
    onsubmit: async e => {
      e.preventDefault();
      if (!input.value.trim()) return;
      await guard(async () => {
        await api('POST', '/tasks', { title: input.value });
        toast('Задача создана', 'ok');
        render();
      });
    },
  }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Добавить'));

  const section = (title, list, cls = '') => list.length ? h('section', { class: `group ${cls}` },
    h('h2', null, title, h('span', { class: 'count' }, list.length)), h('div', { class: 'task-list' }, list.map(taskRow))) : null;

  const nothing = !tasks.length && !review.tasks.some(t => t.assigneeId !== state.user.id);
  clear(page,
    h('header', { class: 'page-head' }, h('h1', null, 'Мои задачи'),
      h('p', { class: 'muted' }, tasks.length ? `Открыто: ${tasks.length}. Просрочено: ${groups.overdue.length}.` : 'Открытых задач нет')),
    quick,
    section('Просрочено', groups.overdue, 'group-late'),
    section('Сегодня', groups.today),
    section('Ждут проверки', review.tasks.filter(t => t.assigneeId !== state.user.id)),
    section('На этой неделе', groups.soon),
    section('Позже', groups.later),
    nothing && h('div', { class: 'empty' }, h('strong', null, 'Всё сделано'), 'Добавьте задачу в поле выше или загляните на доску.'));
}

// ---------- Карточка задачи ----------

export async function openTask(id) {
  const data = await guard(() => api('GET', `/tasks/${id}`));
  if (!data) { if (parseRoute().view === 'task') go('/mine'); return; }
  const body = h('div', { class: 'task-panel' });
  let changed = false;

  const redraw = async () => {
    const fresh = await guard(() => api('GET', `/tasks/${id}`));
    if (fresh) drawTask(body, fresh, () => { changed = true; redraw(); }, () => dlg.close());
  };
  const dlg = openDialog(body, {
    className: 'dialog-side',
    onClose: () => {
      if (parseRoute().view === 'task') go('/mine');
      else if (changed) render();
    },
  });
  drawTask(body, data, () => { changed = true; redraw(); }, () => dlg.close());
}

const HISTORY = {
  created: () => 'создал(а) задачу',
  status: h => `статус: ${STATUS[h.fromValue] || h.fromValue} → ${STATUS[h.toValue] || h.toValue}`,
  assignee: h => `ответственный: ${h.toValue || 'не назначен'}`,
  due: h => (h.toValue ? `срок: ${formatDateTime(h.toValue)}` : 'срок убран'),
  priority: h => `приоритет: ${PRIORITY[h.toValue]}`,
  title: () => 'изменил(а) название',
  description: () => 'изменил(а) описание',
  project: () => 'сменил(а) проект',
  comment: () => 'оставил(а) комментарий',
};

function drawTask(body, { task, comments, history }, onChange, close) {
  const me = state.user;
  const manager = isManager();
  const canEditText = manager || (task.creatorId === me.id && task.assigneeId === me.id);
  const mine = task.assigneeId === me.id;
  const canDelete = me.role === 'admin' || (me.role === 'lead' && (
    task.projectId ? state.projects.find(p => p.id === task.projectId)?.ownerId === me.id : task.creatorId === me.id));

  const patch = async data => {
    await guard(() => api('PATCH', `/tasks/${task.id}`, data));
    onChange();
  };

  const allowed = s => manager || (mine && task.status !== 'done' && s !== 'done');
  const statusBar = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Статус' }, Object.entries(STATUS).map(([key, label]) =>
    h('button', {
      class: key === task.status ? 'active' : '', type: 'button', disabled: key !== task.status && !allowed(key), 'data-status': key,
      'aria-pressed': key === task.status ? 'true' : 'false',
      onclick: () => key !== task.status && patch({ status: key }),
    }, label)));

  const title = canEditText
    ? h('textarea', { class: 'title-input', rows: 2, maxlength: 200, 'aria-label': 'Название', value: task.title, onchange: e => patch({ title: e.target.value }) })
    : h('h2', { class: 'task-title' }, task.title);

  const description = canEditText
    ? h('textarea', { rows: 4, maxlength: 5000, placeholder: 'Подробности задачи', value: task.description, onchange: e => patch({ description: e.target.value }) })
    : h('p', { class: 'description' }, task.description || 'Описания нет');

  const projectName = task.projectName || 'Без проекта';
  const props = manager
    ? [
      field('Ответственный', select([['', 'Не назначен'], ...state.team.filter(u => u.active).map(u => [u.id, u.name])], task.assigneeId,
        { name: 'assignee', onchange: e => patch({ assigneeId: e.target.value ? Number(e.target.value) : null }) })),
      field('Срок', h('input', { type: 'datetime-local', name: 'due', value: toLocalInput(task.dueAt), onchange: e => patch({ dueAt: fromLocalInput(e.target.value) }) })),
      field('Приоритет', select(Object.entries(PRIORITY), task.priority, { name: 'priority', onchange: e => patch({ priority: e.target.value }) })),
      field('Проект', select([['', 'Без проекта'], ...state.projects.map(p => [p.id, p.name])], task.projectId,
        { name: 'project', onchange: e => patch({ projectId: e.target.value ? Number(e.target.value) : null }) })),
    ]
    : [
      field('Ответственный', h('div', { class: 'value' }, avatar(task.assigneeName, task.assigneeId), task.assigneeName || 'Не назначен')),
      field('Срок', h('div', { class: 'value' }, dueBadge(task) || 'Не задан')),
      canEditText
        ? field('Приоритет', select(Object.entries(PRIORITY), task.priority, { name: 'priority', onchange: e => patch({ priority: e.target.value }) }))
        : field('Приоритет', h('div', { class: 'value' }, priorityMark(task.priority), PRIORITY[task.priority])),
      field('Проект', h('div', { class: 'value' }, projectName)),
    ];

  const commentInput = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Написать комментарий', 'aria-label': 'Комментарий', id: 'comment-input' });

  clear(body,
    h('div', { class: 'row between panel-top' },
      h('span', { class: 'muted small' }, `Задача №${task.id}`, task.overdue ? ' · просрочена' : ''),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Закрыть')),
    title, statusBar,
    !manager && mine && task.status === 'review' && h('p', { class: 'muted small' }, 'Задача на проверке. Её примет руководитель.'),
    h('div', { class: 'props' }, props),
    field('Описание', description),
    h('section', { class: 'stack' }, h('h2', null, 'Комментарии', h('span', { class: 'count' }, comments.length)),
      comments.length ? h('div', { class: 'comments' }, comments.map(c => h('div', { class: 'comment' }, avatar(c.userName, c.userId),
        h('div', null, h('div', { class: 'comment-head' }, h('b', null, c.userName), h('span', { class: 'muted small' }, formatDateTime(c.createdAt))),
          h('p', { class: 'comment-body' }, c.body))))) : h('p', { class: 'muted' }, 'Пока никто не писал.'),
      h('form', {
        class: 'stack',
        onsubmit: async e => {
          e.preventDefault();
          if (!commentInput.value.trim()) return;
          await guard(async () => { await api('POST', `/tasks/${task.id}/comments`, { body: commentInput.value }); onChange(); });
        },
      }, commentInput, h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'submit' }, 'Отправить')))),
    h('section', { class: 'stack' }, h('h2', null, 'История'),
      h('ol', { class: 'history' }, history.map(x => h('li', null, h('b', null, x.userName), ' ', HISTORY[x.action]?.(x) ?? x.action,
        h('span', { class: 'muted small' }, ` · ${formatDateTime(x.createdAt)}`))))),
    canDelete && h('div', { class: 'row end' }, h('button', {
      class: 'btn btn-danger', type: 'button',
      onclick: async () => {
        if (!await confirmDialog(`Удалить задачу «${task.title}»? Вернуть её будет нельзя.`, 'Удалить')) return;
        await guard(async () => { await api('DELETE', `/tasks/${task.id}`); close(); render(); toast('Задача удалена'); });
      },
    }, 'Удалить задачу')));
}

export function newTaskDialog(defaults = {}) {
  const manager = isManager();
  const title = h('input', { required: true, maxlength: 200, name: 'title' });
  const description = h('textarea', { rows: 3, maxlength: 5000, name: 'description' });
  const project = select([['', 'Без проекта'], ...state.projects.map(p => [p.id, p.name])], defaults.projectId, { name: 'project' });
  const assignee = select(state.team.filter(u => u.active).map(u => [u.id, u.name]), state.user.id, { name: 'assignee' });
  const due = h('input', { type: 'datetime-local', name: 'due' });
  const priority = select(Object.entries(PRIORITY), 'normal', { name: 'priority' });
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const data = { title: title.value, description: description.value, priority: priority.value, projectId: project.value ? Number(project.value) : null };
        if (manager) { data.assigneeId = Number(assignee.value); data.dueAt = fromLocalInput(due.value); }
        await api('POST', '/tasks', data);
        dlg.close();
        toast('Задача создана', 'ok');
        render();
      });
    },
  }, h('h2', null, 'Новая задача'), field('Название', title), field('Описание', description), field('Проект', project),
  manager && field('Ответственный', assignee), manager && field('Срок', due), field('Приоритет', priority),
  !manager && h('p', { class: 'muted small' }, 'Задача будет назначена вам. Срок задаёт руководитель.'),
  h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Создать'))));
}

// ---------- Проекты ----------

function projectDialog(project) {
  const name = h('input', { required: true, maxlength: 120, value: project?.name || '', name: 'name' });
  const description = h('textarea', { rows: 2, maxlength: 1000, value: project?.description || '', name: 'description' });
  const checks = state.team.filter(u => u.active).map(u => {
    const box = h('input', { type: 'checkbox', value: u.id, checked: project ? project.memberIds.includes(u.id) : u.id === state.user.id });
    return { box, row: h('label', { class: 'check' }, box, avatar(u.name, u.id), u.name) };
  });
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const memberIds = checks.filter(c => c.box.checked).map(c => Number(c.box.value));
        const data = { name: name.value, description: description.value, memberIds };
        if (project) await api('PATCH', `/projects/${project.id}`, data);
        else await api('POST', '/projects', data);
        dlg.close();
        render();
      });
    },
  }, h('h2', null, project ? 'Настройки проекта' : 'Новый проект'), field('Название', name), field('Описание', description),
  h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Участники'), h('div', { class: 'check-list' }, checks.map(c => c.row))),
  h('div', { class: 'row between' },
    project ? h('button', {
      class: 'btn btn-danger', type: 'button',
      onclick: async () => {
        if (!await confirmDialog(`Убрать проект «${project.name}» в архив?`, 'В архив')) return;
        await guard(async () => { await api('PATCH', `/projects/${project.id}`, { archived: true }); dlg.close(); render(); });
      },
    }, 'В архив') : h('span'),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить')))));
}

async function renderProjects(page) {
  const me = state.user;
  const cards = state.projects.map(p => {
    const percent = p.total ? Math.round(p.done / p.total * 100) : 0;
    const bar = h('span', { class: 'bar-fill' });
    bar.style.width = `${percent}%`;
    const canEdit = me.role === 'admin' || (me.role === 'lead' && p.ownerId === me.id);
    return h('article', { class: 'project-card' },
      h('a', { class: 'project-open', href: `#/board?project=${p.id}` }, h('h2', null, p.name), h('p', { class: 'muted' }, p.description || 'Без описания')),
      h('div', { class: 'bar', role: 'img', 'aria-label': `Готово ${percent}%` }, bar),
      h('div', { class: 'row between small' }, h('span', null, `Готово ${p.done} из ${p.total}`),
        p.overdue ? h('span', { class: 'due due-late' }, `просрочено: ${p.overdue}`) : h('span', { class: 'muted' }, 'без просрочек')),
      h('div', { class: 'row between' }, h('span', { class: 'muted small' }, `Владелец: ${p.ownerName}`),
        canEdit && h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => projectDialog(p) }, 'Настроить')));
  });
  clear(page,
    h('header', { class: 'page-head row between' }, h('h1', null, 'Проекты'),
      isManager() && h('button', { class: 'btn btn-primary', type: 'button', onclick: () => projectDialog() }, 'Новый проект')),
    cards.length ? h('div', { class: 'project-grid' }, cards)
      : h('div', { class: 'empty' }, h('strong', null, 'Проектов пока нет'), isManager() ? 'Создайте первый проект и добавьте в него команду.' : 'Руководитель добавит вас в проект.'));
}

// ---------- Команда ----------

function inviteDialog() {
  const name = h('input', { required: true, maxlength: 80, name: 'name' });
  const role = select(Object.entries(ROLE), 'member', { name: 'role' });
  const result = h('div', { class: 'stack', hidden: true });
  const form = h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const r = await api('POST', '/team/invites', { name: name.value, role: role.value });
        const link = `${location.origin}/#/invite/${r.token}`;
        form.hidden = true;
        result.hidden = false;
        clear(result, h('h2', null, 'Ссылка готова'), h('p', { class: 'muted' }, 'Отправьте её участнику. Она работает один раз и действует 7 дней.'),
          h('input', { readonly: true, value: link, 'aria-label': 'Ссылка-приглашение', onfocus: ev => ev.target.select() }),
          h('div', { class: 'row end' }, h('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: async () => { await navigator.clipboard?.writeText(link); toast('Ссылка скопирована', 'ok'); },
          }, 'Скопировать'), h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); render(); } }, 'Готово')));
      });
    },
  }, h('h2', null, 'Пригласить участника'), field('Имя и фамилия', name), field('Роль', role),
  h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Создать ссылку')));
  const dlg = openDialog(h('div', null, form, result));
}

async function renderTeam(page) {
  const manager = isManager();
  const admin = isAdmin();
  const rows = state.team.map(u => {
    const change = data => guard(async () => { await api('PATCH', `/team/${u.id}`, data); toast('Сохранено', 'ok'); render(); });
    return h('article', { class: `member ${u.active ? '' : 'member-off'}`, 'data-member': u.id },
      avatar(u.name, u.id),
      h('div', { class: 'member-main' }, h('div', { class: 'member-name' }, u.name, !u.active && h('span', { class: 'muted small' }, ' · отключён')),
        admin && !state.demo
          ? select(Object.entries(ROLE), u.role, { 'aria-label': `Роль: ${u.name}`, class: 'compact', onchange: e => change({ role: e.target.value }) })
          : h('div', { class: 'muted small' }, ROLE[u.role])),
      manager && h('div', { class: 'member-load' },
        h('span', null, h('b', null, u.inProgress), ' в работе'), h('span', null, h('b', null, u.open), ' открыто'),
        h('span', { class: u.overdue ? 'late' : '' }, h('b', null, u.overdue), ' просрочено')),
      admin && !state.demo && u.id !== state.user.id && h('button', {
        class: 'btn btn-ghost', type: 'button',
        onclick: async () => {
          if (u.active && !await confirmDialog(`Отключить ${u.name}? Участник сразу потеряет доступ.`, 'Отключить')) return;
          change({ active: !u.active });
        },
      }, u.active ? 'Отключить' : 'Вернуть'));
  });
  clear(page,
    h('header', { class: 'page-head row between' }, h('div', null, h('h1', null, 'Команда'),
      h('p', { class: 'muted' }, manager ? 'Кто чем занят и где горят сроки.' : `Участников: ${state.team.length}`)),
    admin && !state.demo && h('button', { class: 'btn btn-primary', type: 'button', onclick: inviteDialog }, 'Пригласить')),
    state.demo && admin && h('p', { class: 'note' }, 'В демо состав команды не меняется.'),
    h('div', { class: 'members' }, rows));
}

// ---------- Настройки ----------

async function renderSettings(page) {
  const [{ settings }, tgStatus] = await Promise.all([api('GET', '/settings'), api('GET', '/telegram')]);
  const me = state.user;
  const name = h('input', { value: me.name, maxlength: 80, name: 'name', disabled: state.demo });
  const oldPass = h('input', { type: 'password', autocomplete: 'current-password', name: 'old', disabled: state.demo });
  const newPass = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, name: 'new', disabled: state.demo });

  const toggles = [
    ['before24h', 'За 24 часа до срока'], ['before3h', 'За 3 часа до срока'], ['atDue', 'В момент срока'],
    ['overdue', 'Когда задача просрочена'], ['digest', 'Утренняя сводка'],
  ].map(([key, label]) => h('label', { class: 'check' }, h('input', {
    type: 'checkbox', checked: settings[key], 'data-setting': key,
    onchange: e => guard(async () => { await api('PUT', '/settings', { [key]: e.target.checked }); toast('Сохранено', 'ok'); }),
  }), label));

  clear(page,
    h('header', { class: 'page-head' }, h('h1', null, 'Настройки')),
    state.demo && h('p', { class: 'note' }, 'Демо-режим: профиль и пароль здесь не меняются.'),
    h('div', { class: 'settings' },
      h('form', {
        class: 'panel stack',
        onsubmit: async e => {
          e.preventDefault();
          await guard(async () => {
            const r = await api('PATCH', '/me', { name: name.value });
            state.user = r.user;
            toast('Имя сохранено', 'ok');
            render();
          });
        },
      }, h('h2', null, 'Профиль'), field('Имя', name), field('Логин', h('input', { value: me.login, disabled: true })),
      h('button', { class: 'btn', type: 'submit', disabled: state.demo }, 'Сохранить')),
      h('form', {
        class: 'panel stack',
        onsubmit: async e => {
          e.preventDefault();
          await guard(async () => {
            await api('POST', '/me/password', { old: oldPass.value, new: newPass.value });
            oldPass.value = ''; newPass.value = '';
            toast('Пароль изменён', 'ok');
          });
        },
      }, h('h2', null, 'Смена пароля'), field('Текущий пароль', oldPass), field('Новый пароль', newPass, 'Минимум 8 символов'),
      h('button', { class: 'btn', type: 'submit', disabled: state.demo }, 'Изменить пароль')),
      h('section', { class: 'panel stack', id: 'telegram-panel' }, h('h2', null, 'Напоминания в Telegram'),
        telegramControls(tgStatus), toggles),
      h('section', { class: 'panel stack' }, h('h2', null, 'Выход'),
        h('button', {
          class: 'btn', type: 'button', id: 'logout',
          onclick: () => guard(async () => {
            await api('POST', '/auth/logout');
            setBearer(null);
            state.user = null;
            location.hash = '/mine';
            render();
          }),
        }, 'Выйти из аккаунта'))));
}

function telegramControls(status) {
  if (!status.enabled) return h('p', { class: 'muted small' }, 'Бот пока не настроен.');
  const bot = status.botUsername;
  if (status.linked) {
    return [
      h('p', { class: 'small' }, `Подключено к @${bot}.`),
      !state.demo && h('button', {
        class: 'btn', type: 'button', id: 'tg-unlink',
        onclick: () => guard(async () => { await api('DELETE', '/telegram/link'); toast('Telegram отключён'); render(); }),
      }, 'Отключить Telegram'),
    ];
  }
  if (state.demo) {
    return [
      h('p', { class: 'muted small' }, `Бот @${bot}: выберите в нём роль, и он пришлёт задачи и напоминания.`),
      h('a', { class: 'btn', href: `https://t.me/${bot}`, target: '_blank', rel: 'noopener', id: 'tg-open' }, 'Открыть бота в Telegram'),
    ];
  }
  return h('button', {
    class: 'btn', type: 'button', id: 'tg-link',
    onclick: () => guard(async () => {
      const r = await api('POST', '/telegram/link');
      location.href = r.url;
    }),
  }, 'Подключить Telegram');
}

// Ссылка из бота ведёт сразу в нужную задачу.
const startTask = new URLSearchParams(location.search).get('task');
if (/^\d+$/.test(startTask || '')) {
  history.replaceState(null, '', `${location.pathname}#/task/${startTask}`);
}

window.addEventListener('hashchange', render);
render();
