import { h, clear, api, guard, toast, openDialog, confirmDialog, field, select, ApiError } from '/shared/ui.js';

const root = document.getElementById('app');
const ROLE = { director: 'Директор', manager: 'Менеджер проектов', foreman: 'Прораб', worker: 'Рабочий' };
const SITE_STATUS = { active: 'В работе', hold: 'Приостановлен', done: 'Завершён' };
const TASK_STATUS = { todo: 'Сделать', doing: 'В процессе', done: 'Готово' };
const PROBLEMS = { materials: 'Нет материалов', power: 'Нет электричества', people: 'Не хватает людей', weather: 'Погода' };
const SITE_TABS = { tasks: 'Задачи', reports: 'Отчёты', photos: 'Фото', qc: 'Качество' };

const S = { user: null, demo: false, unread: 0, team: [] };
const isLead = () => S.user.role !== 'worker';

const dateRu = iso => (iso ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : '');
const shortDate = iso => (iso ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : '');

function parseRoute() {
  const parts = (location.hash.slice(1) || '/home').split('/').filter(Boolean);
  return { view: parts[0] || 'home', a: parts[1], b: parts[2] };
}

function navItems() {
  const role = S.user.role;
  if (role === 'worker') return [['tasks', 'Задачи'], ['profile', 'Профиль']];
  const home = role === 'foreman' ? 'Объекты' : 'Сводка';
  const items = [['home', home], ['tasks', 'Задачи']];
  if (role === 'director') items.push(['team', 'Люди']);
  items.push(['profile', 'Профиль']);
  return items;
}

function shell(active, content) {
  const nav = navItems();
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Разделы' }, nav.map(([key, label]) =>
    h('a', { class: `tab ${active === key ? 'active' : ''}`, href: `#/${key}`, 'aria-current': active === key ? 'page' : null }, label)));
  tabs.style.setProperty('--tabs', nav.length);
  return h('div', { class: 'shell' },
    h('header', { class: 'top' },
      h('a', { class: 'brand', href: '#/home' }, h('img', { src: '/favicon.svg', alt: '', width: 28, height: 28 }), 'Прораб'),
      h('a', { class: 'bell', href: '#/notifications', 'aria-label': `Уведомления: ${S.unread}`, id: 'bell' },
        'Уведомления', S.unread ? h('span', { class: 'badge' }, S.unread) : null)),
    h('main', { class: 'page' }, content),
    tabs);
}

// ---------- Фото ----------

// Уменьшаем в браузере: на стройке связь слабая, а снимок с телефона весит несколько мегабайт.
async function compress(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new ApiError(400, 'bad', 'Не получилось открыть этот файл как изображение'); }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

async function uploadPhoto(siteId, file, query = '') {
  const blob = await compress(file);
  let res;
  try {
    res = await fetch(`/api/v1/sites/${siteId}/photos${query}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob, credentials: 'same-origin' });
  } catch { throw new ApiError(0, 'network', 'Нет связи. Фото не отправлено, попробуйте ещё раз.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error?.code, data.error?.message || 'Не удалось загрузить фото');
  return data.photo;
}

function photoButton(siteId, query, label, onDone) {
  const input = h('input', {
    type: 'file', accept: 'image/*', hidden: true, 'data-photo-input': query || 'site',
    onchange: async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      await guard(async () => {
        toast('Загружаем фото…');
        await uploadPhoto(siteId, file, query);
        toast('Фото добавлено', 'ok');
        onDone?.();
      });
    },
  });
  return h('label', { class: 'btn photo-btn' }, input, label);
}

const photoUrl = id => `/api/v1/photos/${id}`;

function thumbs(ids) {
  if (!ids?.length) return null;
  return h('div', { class: 'thumbs' }, ids.map(id => h('button', { class: 'thumb', type: 'button', 'aria-label': 'Открыть фото', onclick: () => viewPhoto(id) },
    h('img', { src: photoUrl(id), alt: 'Фото с объекта', loading: 'lazy' }))));
}

function viewPhoto(id) {
  const dlg = openDialog(h('div', { class: 'stack' }, h('img', { class: 'photo-full', src: photoUrl(id), alt: 'Фото с объекта' }),
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Закрыть'))), { className: 'dialog-photo' });
}

// ---------- Главные экраны ----------

const statusChip = st => h('span', { class: `chip chip-${st}` }, SITE_STATUS[st]);

function reportChip(s) {
  if (s.status !== 'active') return null;
  if (s.problemsToday.length) return h('span', { class: 'chip chip-bad' }, `Проблема: ${s.problemsToday.join(', ')}`);
  if (s.reportToday) return h('span', { class: 'chip chip-ok' }, 'Отчёт есть');
  if (s.reportMissing) return h('span', { class: 'chip chip-bad' }, 'Нет отчёта');
  return h('span', { class: 'chip' }, 'Отчёт ждём');
}

function siteCard(s) {
  return h('a', { class: 'card site-card', href: `#/site/${s.id}/tasks`, 'data-site': s.id },
    h('div', { class: 'row between top-row' }, h('h2', null, s.name), statusChip(s.status)),
    h('p', { class: 'muted small' }, s.address || 'Адрес не указан'),
    h('div', { class: 'row chips' }, reportChip(s),
      s.overdueTasks ? h('span', { class: 'chip chip-bad' }, `Просрочено: ${s.overdueTasks}`) : null,
      s.fixes ? h('span', { class: 'chip chip-warn' }, `Исправить: ${s.fixes}`) : null),
    h('p', { class: 'small' }, `Задач открыто: ${s.openTasks}. Прораб: ${s.foremanName || 'не назначен'}.`));
}

async function viewSummary(page, filter = 'active') {
  const { sites } = await api('GET', '/sites');
  const active = sites.filter(s => s.status === 'active');
  const noReport = active.filter(s => s.reportMissing).length;
  const withProblem = active.filter(s => s.problemsToday.length).length;
  const overdue = sites.reduce((n, s) => n + s.overdueTasks, 0);
  const metric = (value, label, bad, id) => h('div', { class: `metric ${bad && value ? 'bad' : ''}`, 'data-metric': id }, h('b', null, value), h('span', null, label));
  const list = filter === 'all' ? sites : sites.filter(s => s.status === filter);
  const filters = { all: 'Все', active: 'В работе', hold: 'Пауза', done: 'Завершён' };
  clear(page,
    h('div', { class: 'row between' }, h('h1', null, 'Сводка'),
      h('button', { class: 'btn btn-primary', type: 'button', id: 'new-site', onclick: () => siteDialog() }, 'Новый объект')),
    h('div', { class: 'metrics' }, metric(active.length, 'в работе', false, 'active'), metric(noReport, 'без отчёта', true, 'noreport'),
      metric(withProblem, 'с проблемами', true, 'problems'), metric(overdue, 'просрочено', true, 'overdue')),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Статус объекта' }, Object.entries(filters).map(([key, label]) =>
      h('button', { class: key === filter ? 'active' : '', type: 'button', 'data-filter': key, onclick: () => guard(() => viewSummary(page, key)) }, label))),
    list.length ? h('div', { class: 'list' }, list.map(siteCard))
      : h('div', { class: 'empty' }, h('strong', null, 'Здесь пусто'), sites.length ? 'С таким статусом объектов нет.' : 'Создайте первый объект.'));
}

async function viewForeman(page) {
  const { sites, today } = await api('GET', '/sites');
  const active = sites.filter(s => s.status === 'active');
  const rest = sites.filter(s => s.status !== 'active');
  clear(page,
    h('h1', null, 'Мои объекты'),
    h('p', { class: 'muted' }, `Сегодня ${dateRu(today)}`),
    active.length ? h('div', { class: 'list' }, active.map(s => h('article', { class: 'card', 'data-site': s.id },
      h('a', { class: 'plain', href: `#/site/${s.id}/tasks` }, h('h2', null, s.name), h('p', { class: 'muted small' }, s.address)),
      h('div', { class: 'row chips' }, reportChip(s)),
      h('a', { class: `btn wide ${s.reportToday ? '' : 'btn-primary'}`, href: `#/report/${s.id}/${today}`, 'data-report': s.id },
        s.reportToday ? 'Отчёт сдан. Изменить' : 'Заполнить отчёт за сегодня'))))
      : h('div', { class: 'empty' }, h('strong', null, 'Активных объектов нет'), 'Руководитель назначит вас на объект.'),
    rest.length ? [h('h2', null, 'Остальные'), h('div', { class: 'list' }, rest.map(siteCard))] : null);
}

// ---------- Задачи ----------

function statusButtons(task, reload) {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': 'Статус задачи' }, Object.entries(TASK_STATUS).map(([key, label]) =>
    h('button', {
      class: key === task.status ? 'active' : '', type: 'button', 'data-status': key, 'aria-pressed': key === task.status ? 'true' : 'false',
      onclick: () => key !== task.status && guard(async () => { await api('PATCH', `/tasks/${task.id}`, { status: key }); await reload(); }),
    }, label)));
}

function taskCard(task, { reload, showSite, lead }) {
  return h('article', { class: `card task-card ${task.status === 'done' ? 'task-done' : ''}`, 'data-task': task.id },
    h('p', { class: 'task-title' }, task.title),
    h('p', { class: 'muted small' }, [showSite ? task.siteName : task.assigneeName, task.dueDate ? `до ${shortDate(task.dueDate)}` : null].filter(Boolean).join(' · ')),
    task.overdue ? h('p', { class: 'late small' }, 'Срок прошёл') : null,
    statusButtons(task, reload),
    thumbs(task.photos),
    h('div', { class: 'row between' }, photoButton(task.siteId, `?task=${task.id}`, 'Добавить фото', reload),
      lead ? h('button', {
        class: 'btn btn-ghost', type: 'button', 'data-delete-task': task.id,
        onclick: async () => {
          if (!await confirmDialog(`Удалить задачу «${task.title}»?`, 'Удалить')) return;
          await guard(async () => { await api('DELETE', `/tasks/${task.id}`); await reload(); });
        },
      }, 'Удалить') : null));
}

async function viewMyTasks(page) {
  const reload = () => guard(() => viewMyTasks(page));
  const { tasks } = await api('GET', '/my-tasks');
  const open = tasks.filter(t => t.status !== 'done');
  const done = tasks.filter(t => t.status === 'done');
  clear(page,
    h('h1', null, 'Мои задачи'),
    h('p', { class: 'muted' }, open.length ? `Открыто: ${open.length}` : 'Открытых задач нет'),
    open.length ? h('div', { class: 'list' }, open.map(t => taskCard(t, { reload, showSite: true }))) : h('div', { class: 'empty' }, h('strong', null, 'Всё сделано'), 'Новые задачи появятся здесь.'),
    done.length ? [h('h2', null, 'Сделано'), h('div', { class: 'list' }, done.slice(0, 10).map(t => taskCard(t, { reload, showSite: true })))] : null);
}

// ---------- Объект ----------

function siteDialog(site) {
  const people = S.team.filter(u => u.active);
  const name = h('input', { name: 'name', required: true, maxlength: 120, value: site?.name || '' });
  const address = h('input', { name: 'address', maxlength: 200, value: site?.address || '' });
  const start = h('input', { name: 'start', type: 'date', value: site?.startDate || '' });
  const end = h('input', { name: 'end', type: 'date', value: site?.endDate || '' });
  const status = select(Object.entries(SITE_STATUS), site?.status || 'active', { name: 'status' });
  const foreman = select([['', 'Не назначен'], ...people.filter(u => u.role === 'foreman').map(u => [u.id, u.name])], site?.foremanId, { name: 'foreman' });
  const manager = select([['', 'Не назначен'], ...people.filter(u => u.role === 'manager').map(u => [u.id, u.name])], site?.managerId, { name: 'manager' });
  const director = S.user.role === 'director';
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const body = { name: name.value, address: address.value, startDate: start.value || null, endDate: end.value || null, status: status.value, foremanId: foreman.value ? Number(foreman.value) : null };
        if (director) body.managerId = manager.value ? Number(manager.value) : null;
        const r = site ? await api('PATCH', `/sites/${site.id}`, body) : await api('POST', '/sites', body);
        dlg.close();
        location.hash = `/site/${r.site.id}/tasks`;
        render();
      });
    },
  }, h('h2', null, site ? 'Изменить объект' : 'Новый объект'), field('Название', name), field('Адрес', address),
  h('div', { class: 'two' }, field('Начало', start), field('Окончание', end)), field('Статус', status), field('Прораб', foreman),
  director ? field('Менеджер проектов', manager) : null,
  h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить'))));
}

function taskForm(siteId, reload) {
  const people = S.team.filter(u => u.active);
  const title = h('input', { name: 'task-title', maxlength: 200, placeholder: 'Что нужно сделать', 'aria-label': 'Что нужно сделать', required: true });
  const who = select([['', 'Кому'], ...people.filter(u => ['worker', 'foreman'].includes(u.role)).map(u => [u.id, u.name])], '', { name: 'task-who', 'aria-label': 'Ответственный' });
  const due = h('input', { name: 'task-due', type: 'date', 'aria-label': 'Срок' });
  return h('form', {
    class: 'card stack add-task',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        await api('POST', `/sites/${siteId}/tasks`, { title: title.value, assigneeId: who.value ? Number(who.value) : null, dueDate: due.value || null });
        toast('Задача создана', 'ok');
        await reload();
      });
    },
  }, title, h('div', { class: 'two' }, who, due), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Добавить задачу'));
}

function reportCard(r) {
  return h('a', { class: 'card plain report-card', href: `#/report/${r.siteId}/${r.day}`, 'data-report-day': r.day },
    h('div', { class: 'row between' }, h('h2', null, dateRu(r.day)), h('span', { class: 'muted small' }, `Людей: ${r.workers}`)),
    h('p', { class: 'clamp' }, r.doneText),
    r.problems.length || r.problemText ? h('div', { class: 'row chips' }, r.problems.map(p => h('span', { class: 'chip chip-bad' }, PROBLEMS[p])),
      r.problemText ? h('span', { class: 'chip chip-bad' }, r.problemText) : null) : null,
    r.photos.length ? h('p', { class: 'muted small' }, `Фото: ${r.photos.length}`) : null);
}

function qcItem(item, site, today, reload) {
  const set = state => guard(async () => { await api('PATCH', `/qc/${item.id}`, { state, note: item.note }); await reload(); });
  const note = h('input', {
    'aria-label': 'Примечание', maxlength: 500, placeholder: 'Что не так', value: item.note, name: 'qc-note',
    onchange: e => guard(async () => { await api('PATCH', `/qc/${item.id}`, { state: item.state, note: e.target.value }); }),
  });
  return h('div', { class: `qc-item ${item.state === 'fix' ? 'qc-fix' : ''}`, 'data-qc': item.id },
    h('p', { class: 'qc-label' }, item.label),
    h('div', { class: 'qc-buttons' },
      h('button', { class: `btn ${item.state === 'ok' ? 'on-ok' : ''}`, type: 'button', 'data-state': 'ok', 'aria-pressed': item.state === 'ok' ? 'true' : 'false', onclick: () => set(item.state === 'ok' ? null : 'ok') }, 'Хорошо'),
      h('button', { class: `btn ${item.state === 'fix' ? 'on-fix' : ''}`, type: 'button', 'data-state': 'fix', 'aria-pressed': item.state === 'fix' ? 'true' : 'false', onclick: () => set(item.state === 'fix' ? null : 'fix') }, 'Исправить')),
    item.state === 'fix' ? [note, thumbs(item.photos),
      h('div', { class: 'row' }, photoButton(site.id, `?qc=${item.id}`, 'Фото дефекта', reload),
        item.taskId ? h('a', { class: 'btn btn-ghost', href: `#/site/${site.id}/tasks` }, 'Задача создана')
          : h('button', { class: 'btn', type: 'button', 'data-make-task': item.id, onclick: () => fixDialog(item, reload) }, 'Создать задачу'))] : null);
}

function fixDialog(item, reload) {
  const who = select([['', 'Кому'], ...S.team.filter(u => u.active && ['worker', 'foreman'].includes(u.role)).map(u => [u.id, u.name])], '', { name: 'fix-who' });
  const due = h('input', { type: 'date', name: 'fix-due' });
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        await api('POST', `/qc/${item.id}/task`, { assigneeId: who.value ? Number(who.value) : null, dueDate: due.value || null });
        dlg.close();
        toast('Задача создана', 'ok');
        await reload();
      });
    },
  }, h('h2', null, 'Задача на исправление'), h('p', null, item.label), field('Кому', who), field('Срок', due),
  h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Создать'))), { className: 'dialog-small' });
}

async function viewSite(page, id, tab = 'tasks') {
  const reload = () => guard(() => viewSite(page, id, tab));
  const data = await api('GET', `/sites/${id}`);
  const { site } = data;
  const canEditSite = S.user.role !== 'foreman';
  const today = new Date().toISOString().slice(0, 10);
  let bodyEl;
  if (tab === 'tasks') {
    bodyEl = h('div', { class: 'stack' }, taskForm(site.id, reload),
      data.tasks.length ? h('div', { class: 'list' }, data.tasks.map(t => taskCard(t, { reload, lead: true }))) : h('div', { class: 'empty' }, h('strong', null, 'Задач нет'), 'Добавьте первую задачу.'));
  } else if (tab === 'reports') {
    bodyEl = data.reports.length ? h('div', { class: 'list' }, data.reports.map(reportCard)) : h('div', { class: 'empty' }, h('strong', null, 'Отчётов нет'), 'Прораб заполняет отчёт в конце дня.');
  } else if (tab === 'photos') {
    bodyEl = h('div', { class: 'stack' }, photoButton(site.id, '', 'Добавить фото', reload),
      data.photos.length ? h('div', { class: 'gallery' }, data.photos.map(p => h('button', { class: 'thumb', type: 'button', 'data-photo': p.id, onclick: () => viewPhoto(p.id) },
        h('img', { src: photoUrl(p.id), alt: `Фото от ${shortDate(p.day)}`, loading: 'lazy' }), h('span', { class: 'thumb-date' }, shortDate(p.day)))))
        : h('div', { class: 'empty' }, h('strong', null, 'Фото нет'), 'Снимки с объекта появятся здесь.'));
  } else {
    bodyEl = h('div', { class: 'stack' }, data.qc.map(list => h('section', { class: 'card stack', 'data-qc-kind': list.kind }, h('h2', null, list.name),
      list.items.map(item => qcItem(item, site, today, reload)))));
  }
  clear(page,
    h('a', { class: 'back', href: '#/home' }, '← К объектам'),
    h('div', { class: 'row between top-row' }, h('h1', null, site.name), statusChip(site.status)),
    h('p', { class: 'muted small' }, [site.address, site.endDate ? `до ${dateRu(site.endDate)}` : null].filter(Boolean).join(' · ')),
    h('p', { class: 'small' }, `Прораб: ${site.foremanName || 'не назначен'}. Менеджер: ${site.managerName || 'не назначен'}.`),
    canEditSite ? h('button', { class: 'btn', type: 'button', id: 'edit-site', onclick: () => siteDialog(site) }, 'Изменить объект') : null,
    h('nav', { class: 'site-tabs', 'aria-label': 'Разделы объекта' }, Object.entries(SITE_TABS).map(([key, label]) =>
      h('a', { class: key === tab ? 'active' : '', href: `#/site/${id}/${key}`, 'data-tab': key }, label))),
    bodyEl);
}

// ---------- Отчёт ----------

async function viewReport(page, siteId, day) {
  const data = await api('GET', `/sites/${siteId}/reports/${day}`);
  const { site } = await api('GET', `/sites/${siteId}`);
  const reload = () => guard(() => viewReport(page, siteId, day));
  const r = data.report;
  if (!data.canEdit) {
    clear(page, h('a', { class: 'back', href: `#/site/${siteId}/reports` }, '← К отчётам'), h('h1', null, `Отчёт за ${dateRu(day)}`), h('p', { class: 'muted' }, site.name),
      r ? h('div', { class: 'stack' },
        h('section', { class: 'card stack' }, h('h2', null, 'Что сделано'), h('p', { class: 'pre' }, r.doneText)),
        h('div', { class: 'metrics' }, h('div', { class: 'metric', 'data-metric': 'workers' }, h('b', null, r.workers), h('span', null, 'человек работало'))),
        r.problems.length || r.problemText ? h('section', { class: 'card stack' }, h('h2', null, 'Проблемы'),
          h('div', { class: 'row chips' }, r.problems.map(p => h('span', { class: 'chip chip-bad' }, PROBLEMS[p]))), r.problemText ? h('p', { class: 'pre' }, r.problemText) : null) : null,
        thumbs(r.photos), h('p', { class: 'muted small' }, `Заполнил: ${r.authorName}`))
        : h('div', { class: 'empty' }, h('strong', null, 'Отчёта нет'), 'За этот день отчёт не заполнен.'));
    return;
  }
  const doneText = h('textarea', { name: 'done', required: true, rows: 4, maxlength: 2000, value: r?.doneText || '', placeholder: 'Например: штукатурка на втором этаже, разводка кабеля' });
  let workers = r?.workers ?? 0;
  const count = h('output', { class: 'stepper-value', id: 'workers' }, workers);
  const step = by => { workers = Math.max(0, Math.min(500, workers + by)); count.textContent = workers; };
  const chosen = new Set(r?.problems || []);
  const chips = Object.entries(PROBLEMS).map(([key, label]) => h('button', {
    class: `pick ${chosen.has(key) ? 'on' : ''}`, type: 'button', 'data-problem': key, 'aria-pressed': chosen.has(key) ? 'true' : 'false',
    onclick: e => {
      const on = !chosen.has(key);
      if (on) chosen.add(key); else chosen.delete(key);
      e.currentTarget.classList.toggle('on', on);
      e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
  }, label));
  const other = h('input', { name: 'problem-text', maxlength: 500, value: r?.problemText || '', placeholder: 'Другая проблема' });
  clear(page,
    h('a', { class: 'back', href: '#/home' }, '← К объектам'),
    h('h1', null, r ? 'Отчёт за сегодня' : 'Новый отчёт'),
    h('p', { class: 'muted' }, `${site.name}, ${dateRu(day)}`),
    h('form', {
      class: 'stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => {
          await api('PUT', `/sites/${siteId}/reports/${day}`, { doneText: doneText.value, workers, problems: [...chosen], problemText: other.value });
          toast('Отчёт сохранён', 'ok');
          await reload();
        });
      },
    },
    field('Что сделано', doneText),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Сколько человек работало'),
      h('div', { class: 'stepper' }, h('button', { class: 'btn', type: 'button', id: 'workers-minus', 'aria-label': 'Меньше', onclick: () => step(-1) }, '−'), count,
        h('button', { class: 'btn', type: 'button', id: 'workers-plus', 'aria-label': 'Больше', onclick: () => step(1) }, '+'))),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Проблемы'), h('div', { class: 'picks' }, chips), other),
    h('button', { class: 'btn btn-primary wide', type: 'submit', id: 'save-report' }, r ? 'Сохранить изменения' : 'Сохранить отчёт')),
    r ? h('section', { class: 'stack' }, h('h2', null, 'Фото к отчёту'), thumbs(r.photos), photoButton(Number(siteId), `?report=${r.id}`, 'Добавить фото', reload))
      : h('p', { class: 'muted small' }, 'Фото можно добавить сразу после сохранения.'));
}

// ---------- Люди, уведомления, профиль ----------

function inviteDialog() {
  const name = h('input', { name: 'name', required: true, maxlength: 80 });
  const role = select(Object.entries(ROLE), 'worker', { name: 'role' });
  const box = h('div', { class: 'stack', hidden: true });
  const form = h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const r = await api('POST', '/team/invites', { name: name.value, role: role.value });
        const link = `${location.origin}/#/invite/${r.token}`;
        form.hidden = true;
        box.hidden = false;
        clear(box, h('h2', null, 'Ссылка готова'), h('p', { class: 'muted' }, 'Отправьте её сотруднику. Работает один раз, 7 дней.'),
          h('input', { readonly: true, value: link, 'aria-label': 'Ссылка-приглашение' }),
          h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); render(); } }, 'Готово')));
      });
    },
  }, h('h2', null, 'Пригласить сотрудника'), field('Имя и фамилия', name), field('Роль', role),
  h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Создать ссылку')));
  const dlg = openDialog(h('div', null, form, box));
}

async function viewTeam(page) {
  const change = (u, body) => guard(async () => { await api('PATCH', `/team/${u.id}`, body); toast('Сохранено', 'ok'); render(); });
  clear(page,
    h('div', { class: 'row between' }, h('h1', null, 'Люди'),
      S.demo ? null : h('button', { class: 'btn btn-primary', type: 'button', id: 'invite', onclick: inviteDialog }, 'Пригласить')),
    S.demo ? h('p', { class: 'note' }, 'В демо состав не меняется.') : null,
    h('div', { class: 'list' }, S.team.map(u => h('article', { class: `card person ${u.active ? '' : 'off'}`, 'data-person': u.id },
      h('div', null, h('h2', null, u.name), h('p', { class: 'muted small' }, ROLE[u.role], u.active ? '' : ' · отключён')),
      S.demo || u.id === S.user.id ? null : h('div', { class: 'row' },
        select(Object.entries(ROLE), u.role, { 'aria-label': `Роль: ${u.name}`, onchange: e => change(u, { role: e.target.value }) }),
        h('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: async () => {
            if (u.active && !await confirmDialog(`Отключить ${u.name}? Сотрудник сразу потеряет доступ.`, 'Отключить')) return;
            change(u, { active: !u.active });
          },
        }, u.active ? 'Отключить' : 'Вернуть'))))));
}

async function viewNotifications(page) {
  const { notifications, unread } = await api('GET', '/notifications');
  if (unread) { await api('POST', '/notifications/read'); S.unread = 0; document.querySelector('.badge')?.remove(); }
  clear(page, h('h1', null, 'Уведомления'),
    notifications.length ? h('div', { class: 'list' }, notifications.map(n => h('a', { class: `card plain notice ${n.read ? '' : 'unread'} notice-${n.kind}`, href: n.link || '#/home' },
      h('p', null, n.text), h('p', { class: 'muted small' }, new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(n.createdAt))))))
      : h('div', { class: 'empty' }, h('strong', null, 'Уведомлений нет'), 'О новых задачах, отчётах и проблемах сообщим здесь.'));
}

async function viewProfile(page) {
  const me = S.user;
  const name = h('input', { name: 'name', value: me.name, maxlength: 80, disabled: S.demo });
  const oldPass = h('input', { name: 'old', type: 'password', autocomplete: 'current-password', disabled: S.demo });
  const newPass = h('input', { name: 'new', type: 'password', autocomplete: 'new-password', minlength: 8, disabled: S.demo });
  clear(page, h('h1', null, me.name), h('p', { class: 'muted' }, ROLE[me.role]),
    S.demo ? h('p', { class: 'note' }, 'Демо с выдуманной компанией. Профиль здесь не меняется, данные и фото сбрасываются раз в сутки.') : null,
    h('form', {
      class: 'card stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => { const r = await api('PATCH', '/me', { name: name.value }); S.user = { ...me, name: r.user.name }; toast('Сохранено', 'ok'); render(); });
      },
    }, h('h2', null, 'Профиль'), field('Имя', name), h('button', { class: 'btn', type: 'submit', disabled: S.demo }, 'Сохранить')),
    h('form', {
      class: 'card stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => { await api('POST', '/me/password', { old: oldPass.value, new: newPass.value }); oldPass.value = ''; newPass.value = ''; toast('Пароль изменён', 'ok'); });
      },
    }, h('h2', null, 'Смена пароля'), field('Текущий пароль', oldPass), field('Новый пароль', newPass, 'Минимум 8 символов'),
    h('button', { class: 'btn', type: 'submit', disabled: S.demo }, 'Изменить пароль')),
    h('button', {
      class: 'btn wide', type: 'button', id: 'logout',
      onclick: () => guard(async () => { await api('POST', '/auth/logout'); S.user = null; location.hash = '/home'; render(); }),
    }, 'Выйти'));
}

// ---------- Вход ----------

async function viewLogin() {
  const cfg = await api('GET', '/auth/config').catch(() => ({ demo: false, roles: [] }));
  const login = h('input', { name: 'login', autocomplete: 'username', required: true });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const enter = r => { S.user = r.user; render(); };
  clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' },
    h('div', { class: 'brand big' }, h('img', { src: '/favicon.svg', alt: '', width: 40, height: 40 }), 'Прораб'),
    h('p', { class: 'muted' }, 'Что происходит на каждом объекте, в одном месте.'),
    cfg.demo ? [h('p', { class: 'field-label' }, 'Демо с выдуманной компанией. Войдите в одной из ролей:'),
      cfg.roles.map(role => h('button', {
        class: 'btn wide', type: 'button', 'data-role': role,
        onclick: () => guard(async () => enter(await api('POST', '/auth/demo', { role }))),
      }, ROLE[role])),
      h('p', { class: 'muted small' }, 'Изменения видны всем посетителям и сбрасываются раз в сутки.')]
      : h('form', {
        class: 'stack',
        onsubmit: async e => { e.preventDefault(); await guard(async () => enter(await api('POST', '/auth/login', { login: login.value, password: password.value }))); },
      }, field('Логин', login), field('Пароль', password), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти')))));
}

async function viewInvite(token) {
  const info = await api('GET', `/auth/invite/${encodeURIComponent(token)}`).catch(e => e);
  if (info instanceof Error) {
    clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' }, h('h2', null, 'Приглашение не работает'),
      h('p', { class: 'muted' }, info.message), h('a', { class: 'btn', href: '#/home' }, 'На страницу входа'))));
    return;
  }
  const login = h('input', { autocomplete: 'username', required: true, name: 'new-login' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, name: 'new-password' });
  clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' }, h('h2', null, `${info.name}, добро пожаловать`), h('p', { class: 'muted' }, `Роль: ${ROLE[info.role]}`),
    h('form', {
      class: 'stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => {
          const r = await api('POST', `/auth/invite/${encodeURIComponent(token)}`, { login: login.value, password: password.value });
          S.user = r.user;
          location.hash = '/home';
        });
      },
    }, field('Придумайте логин', login, 'Латиница и цифры'), field('Придумайте пароль', password, 'Минимум 8 символов'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти')))));
}

// ---------- Маршруты ----------

let token = 0;

export async function render() {
  const mine = ++token;
  const route = parseRoute();
  if (route.view === 'invite') return viewInvite(route.a);
  if (!S.user) {
    try {
      const me = await api('GET', '/me');
      S.user = me.user;
      S.demo = me.demo;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return viewLogin();
      return clear(root, h('div', { class: 'auth' }, h('div', { class: 'empty' }, h('strong', null, 'Нет связи с сервером'), e.message, h('button', { class: 'btn', type: 'button', onclick: render }, 'Повторить'))));
    }
  }
  const page = h('div', { class: 'page-in' });
  let active = route.view;
  try {
    S.demo = S.demo || (await api('GET', '/me')).demo;
    if (isLead()) S.team = (await api('GET', '/team')).members;
    S.unread = (await api('GET', '/notifications')).unread;
    const role = S.user.role;
    if (route.view === 'site') { active = 'home'; await viewSite(page, route.a, route.b); }
    else if (route.view === 'report') { active = 'home'; await viewReport(page, route.a, route.b); }
    else if (route.view === 'tasks') await viewMyTasks(page);
    else if (route.view === 'team' && role === 'director') await viewTeam(page);
    else if (route.view === 'notifications') await viewNotifications(page);
    else if (route.view === 'profile') await viewProfile(page);
    else if (role === 'worker') { active = 'tasks'; await viewMyTasks(page); }
    else if (role === 'foreman') { active = 'home'; await viewForeman(page); }
    else { active = 'home'; await viewSummary(page); }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { S.user = null; return viewLogin(); }
    clear(page, h('div', { class: 'empty' }, h('strong', null, e.status === 404 ? 'Не найдено' : 'Не удалось загрузить'), e.message,
      h('a', { class: 'btn', href: '#/home' }, 'На главный экран')));
  }
  if (mine === token) clear(root, shell(active, page));
}

window.addEventListener('hashchange', render);
render();
