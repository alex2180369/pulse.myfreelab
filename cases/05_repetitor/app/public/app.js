import { h, clear, api, guard, toast, openDialog, confirmDialog, field, select, ApiError, initials } from '/shared/ui.js';

const root = document.getElementById('app');
const ROLE = { tutor: 'Репетитор', student: 'Ученик', parent: 'Родитель' };
const ROLE_HINT = {
  tutor: 'Ольга: журнал, конструктор заданий, проверка, расписание',
  student: 'Даня, 9 класс: задания, прогресс, расписание',
  parent: 'Мама Дани: оценки, статистика и расписание ребёнка',
};
const STATUS = { issued: 'Выдано', draft: 'Черновик', submitted: 'Ждёт проверки', checked: 'Проверено', overdue: 'Просрочено' };
const LESSON = { planned: 'Запланировано', done: 'Проведено', missed: 'Пропуск', cancelled: 'Отменено' };
const ACCESS = { public: 'Всем', students: 'Всем ученикам', selected: 'Выбранным ученикам' };
const FORMAT = { online: 'Онлайн', offline: 'Очно' };
const KIND = { single: 'Один ответ', multi: 'Несколько ответов', short: 'Короткий ответ', long: 'Развёрнутый ответ' };
const DOC_TYPES = {
  'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
};

const S = { user: null, meta: null, unread: 0, children: [], child: null };

// ---------- Форматирование ----------

const utc = iso => new Date(`${iso}T00:00:00Z`);
const dateLong = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utc(iso));
const dateShort = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(utc(iso));
const dateWeek = iso => { const t = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utc(iso)); return t[0].toUpperCase() + t.slice(1); };
const dm = iso => `${iso.slice(8)}.${iso.slice(5, 7)}`;
const stamp = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const shift = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);
const relDay = day => (day === S.meta.today ? 'Сегодня' : day === shift(S.meta.today, 1) ? 'Завтра' : dateWeek(day));
const pctClass = p => (p === null || p === undefined ? '' : p >= 80 ? 'pct-hi' : p >= 60 ? 'pct-mid' : 'pct-lo');
const pct = p => h('span', { class: `pct ${pctClass(p)}` }, p === null || p === undefined ? '—' : `${p}%`);
const statusChip = st => h('span', { class: `chip st-${st}`, 'data-status': st }, STATUS[st]);
const pq = (sep = '?') => (S.user?.role === 'parent' && S.child ? `${sep}student=${S.child}` : '');
const fileUrl = id => `/api/v1/files/${id}`;
const isTutor = () => S.user?.role === 'tutor';

function rich(body) {
  const out = [];
  let list = null;
  let para = [];
  const flush = () => { if (para.length) { out.push(h('p', null, para.join(' '))); para = []; } };
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) { flush(); if (!list) { list = h('ul'); out.push(list); } list.append(h('li', null, line.slice(2))); continue; }
    list = null;
    if (!line) { flush(); continue; }
    para.push(line);
  }
  flush();
  return h('div', { class: 'rich' }, out);
}

// ---------- Значки ----------

const ICONS = {
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6',
  chart: 'M4 19h16M6 15l4-5 3 3 5-7',
  calendar: 'M5 5h14v15H5zM5 9h14M9 3v4M15 3v4',
  doc: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 3.5 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
};
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': name === 'more' ? '3' : '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', width: 22, height: 22 })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

function navItems() {
  if (isTutor()) return [['journal', 'Журнал', 'table'], ['tasks', 'Задания', 'book'], ['schedule', 'Занятия', 'calendar'], ['students', 'Ученики', 'people'], ['more', 'Ещё', 'more']];
  return [['today', 'Сегодня', 'home'], ['tasks', 'Задания', 'book'], ['progress', 'Прогресс', 'chart'], ['schedule', 'Занятия', 'calendar'], ['materials', 'Материалы', 'doc']];
}
const homeOf = role => (role === 'tutor' ? 'journal' : 'today');

function shell(active, content) {
  const nav = navItems();
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Разделы' }, nav.map(([key, label, ic]) =>
    h('a', { class: `tab ${active === key ? 'active' : ''}`, href: `#/${key}`, 'data-tab': key, 'aria-current': active === key ? 'page' : null }, icon(ic), label)));
  tabs.style.setProperty('--tabs', nav.length);
  const childPick = S.user.role === 'parent' && S.children.length > 1
    ? select(S.children.map(c => [c.id, c.name]), S.child, { 'aria-label': 'Ребёнок', id: 'child-pick', onchange: e => { S.child = Number(e.target.value); render(); } }) : null;
  return h('div', { class: 'shell' },
    h('header', { class: 'top' },
      h('a', { class: 'brand', href: `#/${homeOf(S.user.role)}` }, h('img', { src: '/favicon.svg', alt: '', width: 30, height: 30 }), 'Зачёт'),
      h('div', { class: 'top-actions' }, childPick,
        h('a', { class: 'bell', href: '#/notifications', id: 'bell', 'aria-label': `Уведомления: ${S.unread}` }, icon('bell'), S.unread ? h('span', { class: 'badge' }, S.unread) : null),
        h('a', { class: `avatar avatar-${S.user.id % 5}`, href: '#/profile', id: 'to-profile', 'aria-label': 'Профиль', title: S.user.name }, initials(S.user.name)))),
    h('main', { class: 'page-in' }, content),
    tabs);
}

const demoNote = text => (S.meta.demo ? h('p', { class: 'note note-calm', 'data-demo-note': '' }, text) : null);
const dialogButtons = label => h('div', { class: 'row end' },
  h('button', { class: 'btn', type: 'button', onclick: e => e.currentTarget.closest('dialog')?.close() }, 'Отмена'),
  h('button', { class: 'btn btn-primary', type: 'submit' }, label));
const checkbox = (name, label, checked = false, attrs = {}) => {
  const input = h('input', { type: 'checkbox', name, checked, ...attrs });
  return { input, el: h('label', { class: 'check' }, input, h('span', null, label)) };
};

function viewImage(src, alt) {
  const dlg = openDialog(h('div', { class: 'stack' }, h('img', { class: 'photo-full', src, alt }),
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Закрыть'))), { className: 'dialog-photo' });
}

// ---------- Загрузка файлов ----------

// Фото решения с телефона весит несколько мегабайт: уменьшаем в браузере до 1600 пикселей.
async function compress(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new ApiError(400, 'bad', 'Не получилось открыть этот файл как изображение'); }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

async function upload(url, body, type) {
  let res;
  try { res = await fetch(`/api/v1${url}`, { method: 'POST', headers: { 'Content-Type': type }, body, credentials: 'same-origin' }); }
  catch { throw new ApiError(0, 'network', 'Нет связи. Файл не отправлен, попробуйте ещё раз.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error?.code, data.error?.message || 'Не удалось загрузить файл');
  return data;
}

function fileButton(label, accept, onFile, attrs = {}) {
  const input = h('input', {
    type: 'file', accept, hidden: true, ...attrs,
    onchange: async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await guard(() => onFile(f)); },
  });
  return h('label', { class: 'btn' }, input, label);
}

// ---------- Ученик и родитель: сегодня ----------

function lessonLine(l, { showStudent = false } = {}) {
  return h('article', { class: `card lesson ${l.status}`, 'data-lesson': l.id },
    h('span', { class: 'lesson-time' }, l.time),
    h('div', { class: 'lesson-body' },
      h('strong', null, showStudent ? l.studentName : `${relDay(l.day)}${l.day === S.meta.today || l.day === shift(S.meta.today, 1) ? `, ${dateShort(l.day)}` : ''}`),
      h('p', { class: 'muted small' }, `${l.minutes} мин · ${FORMAT[l.format]}`),
      l.movedFrom ? h('span', { class: 'chip chip-marker' }, `Перенесено с ${dm(l.movedFrom.slice(0, 10))} ${l.movedFrom.slice(11)}`) : null,
      l.status !== 'planned' ? h('span', { class: `chip ${l.status === 'done' ? 'chip-ok' : l.status === 'missed' ? 'chip-bad' : ''}` }, LESSON[l.status]) : null,
      l.link && l.status === 'planned' ? h('a', { class: 'btn', href: l.link, target: '_blank', rel: 'noopener noreferrer' }, 'Подключиться к звонку') : null));
}

async function viewToday(page) {
  const o = await api('GET', `/overview${pq()}`);
  const first = o.student.name.split(' ')[0];
  clear(page,
    h('h1', null, S.user.role === 'student' ? h('span', { class: 'marker' }, `Привет, ${first}!`) : o.student.name),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile', 'data-tile': 'average' }, h('span', null, 'Средний результат'), h('b', null, pct(o.average)), h('small', null, 'по проверенным')),
      h('div', { class: 'tile', 'data-tile': 'todo' }, h('span', null, 'К сдаче'), h('b', null, o.todo.length), h('small', null, 'заданий')),
      h('div', { class: 'tile' }, h('span', null, 'Посещаемость'), h('b', null, o.attendance === null ? '—' : `${o.attendance}%`), h('small', null, 'занятий')),
      h('div', { class: `tile ${o.weak.length ? 'bad' : ''}` }, h('span', null, 'Слабые темы'), h('b', null, o.weak.length), h('small', null, o.weak.length ? 'см. прогресс' : 'нет'))),
    h('h2', { class: 'section-title' }, 'Ближайшие занятия'),
    o.lessons.length ? h('div', { class: 'list', id: 'next-lessons' }, o.lessons.map(l => lessonLine(l))) : h('p', { class: 'muted' }, 'Занятий не запланировано.'),
    h('h2', { class: 'section-title' }, 'К сдаче'),
    o.todo.length ? h('div', { class: 'list', id: 'todo' }, o.todo.map(t => h('a', { class: 'card plain', href: `#/task/${t.id}`, 'data-task': t.id },
      h('div', { class: 'row between top-row' }, h('strong', null, t.title), statusChip(t.status)),
      h('p', { class: 'muted small' }, `Срок: ${dateLong(t.dueDay)}`))))
      : h('p', { class: 'muted' }, 'Всё сдано.'),
    o.recent.length ? [h('h2', { class: 'section-title' }, 'Последние оценки'), h('div', { class: 'list' }, o.recent.map(r => h('a', { class: 'card plain', href: `#/task/${r.assignmentId}` },
      h('div', { class: 'row between top-row' }, h('strong', null, r.title), pct(r.percent)),
      h('p', { class: 'muted small' }, `${r.score} из ${r.max}${r.comment ? `. ${r.comment}` : ''}`))))] : null);
}

// ---------- Задания: ученик и родитель ----------

async function viewTasks(page) {
  if (isTutor()) return viewTasksTutor(page);
  const { assignments } = await api('GET', `/assignments${pq()}`);
  const todo = assignments.filter(a => ['issued', 'draft', 'overdue'].includes(a.status));
  const done = assignments.filter(a => !['issued', 'draft', 'overdue'].includes(a.status));
  const card = a => h('a', { class: 'card plain', href: `#/task/${a.id}`, 'data-task': a.id },
    h('div', { class: 'row between top-row' }, h('strong', null, a.title), statusChip(a.status)),
    h('div', { class: 'row between' }, h('span', { class: 'muted small' }, `Срок: ${dateLong(a.dueDay)}${a.submission?.late ? ', сдано с опозданием' : ''}`), a.submission?.percent !== null && a.submission?.percent !== undefined ? pct(a.submission.percent) : null));
  clear(page,
    h('h1', null, 'Задания'),
    h('h2', { class: 'section-title' }, 'Сделать'),
    todo.length ? h('div', { class: 'list', id: 'tasks-todo' }, todo.map(card)) : h('p', { class: 'muted' }, 'Новых заданий нет.'),
    h('h2', { class: 'section-title' }, 'Сдано'),
    done.length ? h('div', { class: 'list', id: 'tasks-done' }, done.map(card)) : h('p', { class: 'muted' }, 'Пока ничего не сдано.'));
}

function questionHead(q, i) {
  return [h('div', { class: 'q-head' }, h('span', { class: 'q-num' }, `Вопрос ${i + 1}`), h('span', { class: 'muted small' }, `${KIND[q.kind]} · ${q.points} б.`)),
    h('p', { class: 'q-text' }, q.text),
    q.imageId ? h('button', { class: 'img-btn', type: 'button', 'aria-label': 'Увеличить рисунок', onclick: () => viewImage(fileUrl(q.imageId), 'Рисунок к вопросу') }, h('img', { class: 'q-img', src: fileUrl(q.imageId), alt: 'Рисунок к вопросу' })) : null];
}

function answerForm(a, page) {
  const sub = a.submission;
  const answers = { ...(sub?.answers || {}) };
  const reload = () => guard(() => viewTask(page, a.id));
  const files = q => (sub?.files || []).filter(f => f.questionId === q.id);
  const saveDraft = () => api('PUT', `/assignments/${a.id}/answers`, { answers });
  const blocks = a.questions.map((q, i) => {
    let control;
    if (q.kind === 'single') {
      control = h('div', { class: 'options', role: 'radiogroup' }, q.options.map((o, k) => h('label', { class: 'option' },
        h('input', { type: 'radio', name: `q${q.id}`, value: k, checked: answers[q.id] === k, onchange: () => { answers[q.id] = k; } }), h('span', null, o))));
    } else if (q.kind === 'multi') {
      const set = new Set(answers[q.id] || []);
      control = h('div', { class: 'options' }, q.options.map((o, k) => h('label', { class: 'option' },
        h('input', { type: 'checkbox', name: `q${q.id}`, value: k, checked: set.has(k), onchange: e => { if (e.target.checked) set.add(k); else set.delete(k); answers[q.id] = [...set]; } }), h('span', null, o))));
    } else if (q.kind === 'short') {
      control = h('input', { name: `q${q.id}`, value: answers[q.id] || '', maxlength: 200, placeholder: 'Ваш ответ', autocomplete: 'off', oninput: e => { answers[q.id] = e.target.value; } });
    } else {
      control = [h('textarea', { name: `q${q.id}`, rows: 5, maxlength: 5000, value: answers[q.id] || '', placeholder: 'Решение. Можно приложить фото тетради', oninput: e => { answers[q.id] = e.target.value; } }),
        files(q).length ? h('div', { class: 'thumbs' }, files(q).map(f => h('div', { class: 'stack' },
          h('button', { class: 'thumb', type: 'button', onclick: () => viewImage(fileUrl(f.id), 'Фото решения') }, h('img', { src: fileUrl(f.id), alt: 'Фото решения' })),
          h('button', { class: 'btn btn-ghost small', type: 'button', 'data-remove-file': f.id, onclick: () => guard(async () => { await saveDraft(); await api('DELETE', `/answer-files/${f.id}`); await reload(); }) }, 'Убрать')))) : null,
        fileButton('Приложить фото решения', 'image/*', async file => {
          await saveDraft();
          toast('Загружаем фото…');
          await upload(`/assignments/${a.id}/files?question=${q.id}`, await compress(file), 'image/jpeg');
          toast('Фото приложено', 'ok');
          await reload();
        }, { 'data-photo-input': q.id })];
    }
    return h('section', { class: 'card question', 'data-question': q.id }, questionHead(q, i), control);
  });
  return [
    ...blocks,
    h('div', { class: 'sticky-actions' },
      h('button', { class: 'btn', type: 'button', id: 'save-draft', onclick: () => guard(async () => { await saveDraft(); toast('Черновик сохранён', 'ok'); }) }, 'Сохранить'),
      h('button', {
        class: 'btn btn-primary', type: 'button', id: 'submit-task',
        onclick: async () => {
          const empty = a.questions.filter(q => answers[q.id] === undefined || answers[q.id] === '' || (Array.isArray(answers[q.id]) && !answers[q.id].length)).length;
          const msg = `${empty ? `Без ответа вопросов: ${empty}. ` : ''}После сдачи ответы изменить нельзя. Сдать работу?`;
          if (!await confirmDialog(msg, 'Сдать')) return;
          await guard(async () => {
            const r = await api('POST', `/assignments/${a.id}/submit`, { answers });
            toast(r.pending ? 'Сдано. Развёрнутые ответы проверит репетитор' : 'Сдано и проверено', 'ok');
            await reload();
          });
        },
      }, 'Сдать работу')),
  ];
}

function shownAnswer(q, value) {
  if (value === undefined || value === null || value === '') return 'нет ответа';
  if (q.kind === 'single') return q.options[value];
  if (q.kind === 'multi') return value.map(k => q.options[k]).join('; ');
  return String(value);
}

function resultView(a, sub) {
  const res = sub.results;
  const head = h('section', { class: 'card', id: 'result' },
    sub.status === 'checked'
      ? [h('p', { class: 'muted small' }, 'Результат'), h('div', { class: 'row' }, h('span', { class: 'score-big' }, `${sub.score} из ${sub.max}`), pct(sub.percent))]
      : [h('p', { class: 'muted small' }, 'Сдано, ждёт проверки репетитора'), h('p', null, `Автоматически проверено: ${sub.score} из ${sub.max} баллов. Развёрнутые ответы оценит репетитор.`)],
    sub.late ? h('span', { class: 'chip chip-bad' }, 'Сдано с опозданием') : null,
    sub.comment ? h('div', { class: 'answer-box' }, `Комментарий репетитора: ${sub.comment}`) : null,
    !a.showAnswers ? h('p', { class: 'muted small' }, 'Репетитор не открыл правильные ответы для этого задания.') : null);
  const items = a.questions.map((q, i) => {
    const r = res?.[q.id];
    const given = sub.answers[q.id];
    let body;
    if ((q.kind === 'single' || q.kind === 'multi') && res) {
      const chosen = new Set(q.kind === 'single' ? (given === undefined ? [] : [given]) : given || []);
      const right = new Set(q.kind === 'single' ? [q.correct] : q.correct || []);
      body = h('div', { class: 'options' }, q.options.map((o, k) => h('div', { class: `option ${right.has(k) ? 'right' : chosen.has(k) ? 'wrong' : ''}` },
        h('span', null, `${chosen.has(k) ? '● ' : '○ '}${o}${right.has(k) ? ' — верно' : ''}`))));
    } else {
      body = [h('div', { class: 'answer-box' }, `Ответ: ${shownAnswer(q, given)}`),
        q.kind === 'short' && q.correct ? h('p', { class: 'small' }, `Верный ответ: ${q.correct.join(' или ')}`) : null,
        q.kind === 'long' ? h('div', { class: 'thumbs' }, sub.files.filter(f => f.questionId === q.id).map(f => h('button', { class: 'thumb', type: 'button', onclick: () => viewImage(fileUrl(f.id), 'Фото решения') }, h('img', { src: fileUrl(f.id), alt: 'Фото решения' })))) : null];
    }
    const mark = !r ? null : r.points === null ? h('span', { class: 'chip st-submitted' }, 'ждёт проверки')
      : h('span', { class: `chip ${r.points === q.points ? 'chip-ok' : r.points ? 'chip-warn' : 'chip-bad'}`, 'data-points': r.points }, `${r.points} из ${q.points}`);
    return h('section', { class: 'card question', 'data-question': q.id }, questionHead(q, i), body, mark ? h('div', { class: 'result' }, mark) : null);
  });
  return [head, ...items];
}

async function viewTask(page, id) {
  if (isTutor()) return viewTaskTutor(page, id);
  const { assignment: a, readOnly, student } = await api('GET', `/assignments/${id}${pq()}`);
  const sub = a.submission;
  const done = sub && sub.status !== 'draft';
  clear(page,
    h('a', { class: 'back', href: '#/tasks' }, '← К заданиям'),
    h('div', { class: 'row between top-row' }, h('h1', null, a.title), statusChip(a.status)),
    h('p', { class: 'muted' }, `Срок: ${dateLong(a.dueDay)} · ${a.questions.length} вопр. · ${a.maxScore} б.${readOnly ? ` · ${student.name}` : ''}`),
    a.description ? h('p', null, a.description) : null,
    a.status === 'overdue' && !readOnly ? h('p', { class: 'note' }, 'Срок прошёл. Сдать можно, работа будет помечена «с опозданием».') : null,
    done ? resultView(a, sub)
      : readOnly ? [h('p', { class: 'note note-calm' }, sub ? 'Ребёнок начал задание, но ещё не сдал.' : 'Задание ещё не начато.'),
        ...a.questions.map((q, i) => h('section', { class: 'card question' }, questionHead(q, i)))]
        : answerForm(a, page));
}

// ---------- Прогресс ----------

function lineChart(series) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = Math.round(Math.min(700, Math.max(300, window.innerWidth - 64)));
  const H = 200; const m = { l: 34, r: 12, t: 18, b: 24 };
  const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Результаты по заданиям' });
  if (!series.length) { svg.append(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'Проверенных работ пока нет')); return svg; }
  const pw = W - m.l - m.r; const ph = H - m.t - m.b;
  const x = i => m.l + (series.length === 1 ? pw / 2 : (i * pw) / (series.length - 1));
  const y = v => m.t + ph - (v / 100) * ph;
  for (const t of [0, 50, 100]) { svg.append(el('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) })); svg.append(el('text', { x: m.l - 6, y: y(t) + 3, 'text-anchor': 'end' }, `${t}%`)); }
  svg.append(el('line', { class: 'ref', x1: m.l, x2: W - m.r, y1: y(60), y2: y(60) }));
  svg.append(el('polyline', { class: 'line', points: series.map((s, i) => `${x(i)},${y(s.percent)}`).join(' ') }));
  series.forEach((s, i) => {
    const c = el('circle', { class: 'dot', cx: x(i), cy: y(s.percent), r: 4 });
    c.append(el('title', {}, `${s.title}: ${s.percent}%`));
    svg.append(c);
    if (series.length <= 10) svg.append(el('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 && series.length > 1 ? 'start' : i === series.length - 1 && series.length > 1 ? 'end' : 'middle' }, dm(s.day)));
  });
  return svg;
}

function statsBlock(st) {
  return [
    h('div', { class: 'tiles' },
      h('div', { class: 'tile', 'data-tile': 'average' }, h('span', null, 'Средний результат'), h('b', null, pct(st.average)), h('small', null, `проверено ${st.checked}`)),
      h('div', { class: 'tile' }, h('span', null, 'Сдано вовремя'), h('b', null, st.onTime === null ? '—' : `${st.onTime}%`), h('small', null, `с опозданием ${st.late}`)),
      h('div', { class: 'tile' }, h('span', null, 'Посещаемость'), h('b', null, st.attendance === null ? '—' : `${st.attendance}%`), h('small', null, `пропусков ${st.lessonsMissed}`)),
      h('div', { class: `tile ${st.overdue ? 'bad' : ''}`, 'data-tile': 'overdue' }, h('span', null, 'Просрочено'), h('b', null, st.overdue), h('small', null, `из ${st.issued} заданий`))),
    h('section', { class: 'card', id: 'progress-chart' }, h('h2', null, 'Результаты по заданиям'), lineChart(st.series), h('p', { class: 'muted small' }, 'Пунктир — 60%, ниже этой отметки тема считается слабой.')),
    h('section', { class: 'card', id: 'topics' }, h('h2', null, 'Темы'),
      st.topics.length ? st.topics.map(t => {
        const bar = h('div', { class: 'bar' }, h('i'));
        bar.firstChild.style.setProperty('--p', t.percent);
        return h('div', { class: `topic ${t.percent < 60 ? 'weak' : ''}`, 'data-topic': t.topic },
          h('div', { class: 'row between' }, h('span', null, t.topic), h('span', { class: 'small' }, pct(t.percent), ` · ${t.score} из ${t.max} б.`)), bar);
      }) : h('p', { class: 'muted' }, 'Появятся после первых проверенных работ.')),
  ];
}

async function viewProgress(page) {
  const { stats: st, student } = await api('GET', `/stats${pq()}`);
  clear(page,
    h('h1', null, 'Прогресс'),
    S.user.role === 'parent' ? h('p', { class: 'muted' }, student.name) : null,
    st.weak.length ? h('p', { class: 'note', id: 'weak' }, `Слабые темы: ${st.weak.map(t => t.topic).join(', ')}. Их стоит повторить.`) : null,
    statsBlock(st));
}

// ---------- Расписание ----------

const mondayOf = day => { const wd = utc(day).getUTCDay(); return shift(day, wd === 0 ? -6 : 1 - wd); };

function lessonDialog(students, reload, lesson) {
  const who = lesson ? null : select(students.filter(s => s.active).map(s => [s.id, s.name]), students[0]?.id, { name: 'lesson-student' });
  const day = h('input', { type: 'date', name: 'lesson-day', value: lesson?.day || S.meta.today, required: true });
  const time = h('input', { type: 'time', name: 'lesson-time', value: lesson?.time || '17:00', required: true });
  const minutes = select([[45, '45 мин'], [60, '60 мин'], [90, '90 мин'], [120, '120 мин']], lesson?.minutes || 60, { name: 'lesson-minutes' });
  const format = select(Object.entries(FORMAT), lesson?.format || 'online', { name: 'lesson-format' });
  const link = h('input', { name: 'lesson-link', value: lesson?.link || '', placeholder: 'https://…', maxlength: 300 });
  const repeat = select([[0, 'Один раз'], [4, 'Каждую неделю, 1 месяц'], [12, 'Каждую неделю, 3 месяца'], [26, 'Каждую неделю, полгода']], 0, { name: 'lesson-repeat' });
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const body = { day: day.value, time: time.value, minutes: Number(minutes.value), format: format.value, link: link.value };
        if (lesson) await api('PATCH', `/lessons/${lesson.id}`, body);
        else await api('POST', '/lessons', { ...body, studentId: Number(who.value), repeatWeeks: Number(repeat.value) });
        dlg.close();
        toast(lesson ? 'Занятие перенесено, ученик получит уведомление' : 'Занятие добавлено', 'ok');
        await reload();
      });
    },
  }, h('h2', null, lesson ? `Перенести: ${lesson.studentName}` : 'Новое занятие'),
  who ? field('Ученик', who) : null, h('div', { class: 'two' }, field('Дата', day), field('Время', time)),
  h('div', { class: 'two' }, field('Длительность', minutes), field('Формат', format)), field('Ссылка на звонок', link, 'Для онлайн-занятий'),
  lesson ? null : field('Повтор', repeat, 'Перенос или отмена одного занятия не меняет остальные'),
  dialogButtons(lesson ? 'Перенести' : 'Добавить')));
}

function tutorLessonActions(l, students, reload) {
  const started = l.day < S.meta.today || (l.day === S.meta.today && l.time <= new Date().toTimeString().slice(0, 5));
  const set = (status, msg) => guard(async () => { await api('PATCH', `/lessons/${l.id}`, { status }); toast(msg, 'ok'); await reload(); });
  return h('div', { class: 'row' },
    l.status === 'planned' ? h('button', { class: 'btn btn-ghost', type: 'button', 'data-move': l.id, onclick: () => lessonDialog(students, reload, l) }, 'Перенести') : null,
    l.status === 'planned' ? h('button', { class: 'btn btn-ghost', type: 'button', 'data-cancel': l.id, onclick: async () => { if (await confirmDialog(`Отменить занятие ${dm(l.day)} в ${l.time}? Ученик и родители получат уведомление.`, 'Отменить занятие')) set('cancelled', 'Занятие отменено'); } }, 'Отменить') : null,
    started && l.status !== 'cancelled' ? h('button', { class: `btn ${l.status === 'done' ? 'btn-primary' : ''}`, type: 'button', 'data-done': l.id, onclick: () => set('done', 'Отмечено: занятие было') }, 'Было') : null,
    started && l.status !== 'cancelled' ? h('button', { class: `btn ${l.status === 'missed' ? 'btn-danger' : ''}`, type: 'button', 'data-missed': l.id, onclick: () => set('missed', 'Отмечен пропуск') }, 'Пропуск') : null,
    l.status === 'cancelled' ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => set('planned', 'Занятие возвращено') }, 'Вернуть') : null,
    h('button', {
      class: 'btn btn-ghost', type: 'button', 'data-delete-lesson': l.id,
      onclick: async () => {
        if (!await confirmDialog(l.seriesId ? 'Удалить это занятие? Остальные занятия серии останутся.' : 'Удалить занятие?', 'Удалить')) return;
        await guard(async () => { await api('DELETE', `/lessons/${l.id}`); toast('Удалено'); await reload(); });
      },
    }, 'Удалить'));
}

async function viewSchedule(page, offsetArg) {
  const offset = Number(offsetArg) || 0;
  const reload = () => guard(() => viewSchedule(page, offset));
  const from = shift(mondayOf(S.meta.today), offset * 7);
  const [{ lessons }, students] = await Promise.all([api('GET', `/lessons?from=${from}&days=7${pq('&')}`), isTutor() ? api('GET', '/students').then(r => r.students) : []]);
  const days = [...new Set(lessons.map(l => l.day))];
  const several = isTutor() || (S.user.role === 'parent' && S.children.length > 1);
  clear(page,
    h('div', { class: 'row between' }, h('h1', null, 'Расписание'), isTutor() ? h('button', { class: 'btn btn-primary', type: 'button', id: 'new-lesson', onclick: () => lessonDialog(students, reload) }, 'Добавить') : null),
    h('div', { class: 'week-nav' },
      h('a', { class: 'btn', href: `#/schedule/${offset - 1}`, 'aria-label': 'Прошлая неделя', id: 'week-prev' }, '←'),
      h('span', null, `${dateShort(from)} — ${dateShort(shift(from, 6))}`),
      h('a', { class: 'btn', href: `#/schedule/${offset + 1}`, 'aria-label': 'Следующая неделя', id: 'week-next' }, '→')),
    days.length ? h('div', { class: 'list', id: 'lessons' }, days.map(day => [
      h('p', { class: `day-head ${day === S.meta.today ? 'today' : ''}` }, relDay(day) === 'Сегодня' ? `Сегодня, ${dateLong(day)}` : relDay(day) === 'Завтра' ? `Завтра, ${dateLong(day)}` : dateWeek(day)),
      lessons.filter(l => l.day === day).map(l => {
        const card = lessonLine(l, { showStudent: several });
        if (isTutor()) card.querySelector('.lesson-body').append(tutorLessonActions(l, students, reload));
        return card;
      })]))
      : h('div', { class: 'empty' }, h('strong', null, 'На этой неделе занятий нет'), isTutor() ? 'Добавьте занятие или повторяющуюся серию.' : null));
}

// ---------- Материалы ----------

function docOpen(m) {
  const url = fileUrl(m.fileId);
  if (m.type.startsWith('image/')) return h('button', { class: 'btn', type: 'button', 'data-open': m.id, onclick: () => viewImage(url, m.title) }, 'Открыть');
  if (m.type === 'application/pdf') return h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener', 'data-open': m.id }, 'Открыть');
  return h('a', { class: 'btn', href: url, download: m.fileName, 'data-open': m.id }, 'Скачать');
}

async function materialDialog(students, reload, { file, material }) {
  const base = material || { title: file.name.replace(/\.[^.]+$/, ''), topic: '', access: 'students', studentIds: [] };
  const title = h('input', { name: 'mat-title', value: base.title, maxlength: 150, required: true });
  const topic = h('input', { name: 'mat-topic', value: base.topic, maxlength: 80, placeholder: 'Например: Алгебра' });
  const access = select(Object.entries(ACCESS), base.access, { name: 'mat-access' });
  const chosen = new Set(base.studentIds || []);
  const picks = h('div', { class: 'pick-list', hidden: base.access !== 'selected' }, students.filter(s => s.active).map(s => checkbox(`mat-student-${s.id}`, s.name, chosen.has(s.id),
    { onchange: e => { if (e.target.checked) chosen.add(s.id); else chosen.delete(s.id); } }).el));
  access.addEventListener('change', () => { picks.hidden = access.value !== 'selected'; });
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        if (material) await api('PATCH', `/materials/${material.id}`, { title: title.value, topic: topic.value, access: access.value, studentIds: [...chosen] });
        else {
          const q = new URLSearchParams({ name: file.name, title: title.value, topic: topic.value, access: access.value, students: [...chosen].join(',') });
          toast('Загружаем…');
          await upload(`/materials?${q}`, file, file.type);
        }
        dlg.close();
        toast('Сохранено', 'ok');
        await reload();
      });
    },
  }, h('h2', null, material ? 'Изменить материал' : 'Новый материал'), material ? null : h('p', { class: 'muted small' }, file.name),
  field('Название', title), field('Тема', topic), field('Кому открыт', access), picks,
  material ? field('Постоянная ссылка', h('input', { readonly: true, value: `${location.origin}${fileUrl(material.fileId)}`, name: 'mat-link' }), material.access === 'public' ? 'Открывается без входа' : 'Откроется только тем, кому открыт') : null,
  dialogButtons('Сохранить')));
}

async function viewMaterials(page) {
  const reload = () => guard(() => viewMaterials(page));
  const [{ materials }, students] = await Promise.all([api('GET', '/materials'), isTutor() ? api('GET', '/students').then(r => r.students) : []]);
  const topics = [...new Set(materials.map(m => m.topic || 'Без темы'))];
  const accept = Object.keys(DOC_TYPES).join(',');
  clear(page,
    h('div', { class: 'row between' }, h('h1', null, 'Материалы'),
      isTutor() ? fileButton('Загрузить', accept, async file => {
        if (!DOC_TYPES[file.type]) { toast('Подходят PDF, Word, Excel, PowerPoint, JPG и PNG', 'error'); return; }
        if (file.size > 10 * 1024 * 1024) { toast('Файл больше 10 МБ', 'error'); return; }
        await materialDialog(students, reload, { file });
      }, { 'data-material-input': '' }) : null),
    isTutor() ? demoNote('В демо загруженные файлы удаляются ночью. Не загружайте личные документы.') : null,
    materials.length ? topics.map(t => [h('h2', { class: 'section-title' }, t), h('div', { class: 'list' }, materials.filter(m => (m.topic || 'Без темы') === t).map(m =>
      h('article', { class: 'card doc', 'data-material': m.id },
        h('span', { class: 'doc-icon' }, DOC_TYPES[m.type] || 'ФАЙЛ'),
        h('div', { class: 'doc-body' }, h('strong', null, m.title),
          h('p', { class: 'muted small' }, `${m.fileName}${m.size ? ` · ${Math.max(1, Math.round(m.size / 1024))} КБ` : ''}`),
          isTutor() ? h('span', { class: `chip ${m.access === 'public' ? 'chip-marker' : 'chip-accent'}` }, ACCESS[m.access]) : null,
          h('div', { class: 'row' }, docOpen(m),
            isTutor() ? h('button', { class: 'btn btn-ghost', type: 'button', 'data-edit-material': m.id, onclick: () => materialDialog(students, reload, { material: m }) }, 'Изменить') : null,
            isTutor() ? h('button', {
              class: 'btn btn-ghost', type: 'button', 'data-delete-material': m.id,
              onclick: async () => { if (await confirmDialog(`Удалить «${m.title}»?`, 'Удалить')) await guard(async () => { await api('DELETE', `/materials/${m.id}`); await reload(); }); },
            }, 'Удалить') : null)))))])
      : h('div', { class: 'empty' }, h('strong', null, 'Материалов пока нет'), isTutor() ? 'Загрузите конспект или шпаргалку.' : 'Репетитор ещё ничего не выложил.'));
}

// ---------- Репетитор: журнал и проверка ----------

function journalCell(c) {
  if (!c) return h('td', { class: 'cell-none' }, '');
  if (c.status === 'checked') return h('td', null, h('a', { href: `#/check/${c.submissionId}`, class: pctClass(c.percent) }, `${c.percent}%`), c.late ? h('sup', { title: 'с опозданием' }, '*') : null);
  if (c.status === 'submitted') return h('td', null, h('a', { href: `#/check/${c.submissionId}`, class: 'cell-wait' }, 'проверить'));
  if (c.status === 'overdue') return h('td', { class: 'cell-overdue', title: 'Не сдано в срок' }, 'нет');
  return h('td', { class: 'cell-none', title: STATUS[c.status] }, c.status === 'draft' ? 'черн.' : '—');
}

async function viewJournal(page) {
  const [j, { queue }] = await Promise.all([api('GET', '/journal'), api('GET', '/review')]);
  clear(page,
    h('h1', null, h('span', { class: 'marker' }, 'Журнал')),
    queue.length ? h('section', { class: 'card', id: 'review' }, h('h2', null, `Ждут проверки: ${queue.length}`),
      queue.map(q => h('a', { class: 'row between plain', href: `#/check/${q.id}`, 'data-review': q.id },
        h('span', null, h('strong', null, q.student), ` · ${q.title}`), q.late ? h('span', { class: 'chip chip-bad' }, 'опоздание') : h('span', { class: 'muted small' }, stamp(q.submittedAt)))))
      : h('p', { class: 'note note-calm' }, 'Все сданные работы проверены.'),
    j.students.length && j.assignments.length ? h('div', { class: 'table-wrap', id: 'journal' }, h('table', { class: 'journal' },
      h('thead', null, h('tr', null, h('th', null, 'Ученик'), j.assignments.map(a => h('th', null, h('a', { class: 'plain', href: `#/task/${a.id}` }, h('span', null, a.title)), h('span', null, `до ${dm(a.dueDay)}`))))),
      h('tbody', null, j.students.map(s => h('tr', { 'data-row': s.id },
        h('td', null, h('a', { class: 'plain', href: `#/student/${s.id}` }, h('strong', null, s.name)), s.grade ? h('div', { class: 'muted small' }, s.grade) : null),
        j.assignments.map(a => journalCell(j.cells[`${s.id}:${a.id}`])))))))
      : h('div', { class: 'empty' }, h('strong', null, 'Журнал пуст'), 'Добавьте учеников и выдайте первое задание.'),
    h('p', { class: 'muted small' }, 'Процент — проверено, «проверить» — ждёт вас, «нет» — не сдано в срок, * — сдано с опозданием, пусто — задание не выдано.'));
}

async function viewCheck(page, id) {
  const d = await api('GET', `/submissions/${id}`);
  const sub = d.submission;
  const scores = {};
  const comment = h('textarea', { name: 'check-comment', rows: 3, maxlength: 2000, value: sub.comment, placeholder: 'Что получилось и над чем поработать' });
  clear(page,
    h('a', { class: 'back', href: '#/journal' }, '← К журналу'),
    h('h1', null, `${d.student.name}: ${d.assignment.title}`),
    h('div', { class: 'row' }, statusChip(sub.status), sub.late ? h('span', { class: 'chip chip-bad' }, 'с опозданием') : null, h('span', { class: 'muted small' }, `Сдано ${stamp(sub.submittedAt)}`)),
    h('section', { class: 'card' }, h('p', { class: 'muted small' }, 'Сейчас'), h('span', { class: 'score-big', id: 'check-score' }, `${sub.score} из ${sub.max}`)),
    d.questions.map((q, i) => {
      const r = sub.results[q.id];
      const given = sub.answers[q.id];
      let extra = null;
      if (q.kind === 'long') {
        const input = h('input', { name: `score-${q.id}`, inputmode: 'numeric', value: r?.points ?? '', placeholder: `0–${q.points}`, oninput: e => { scores[q.id] = e.target.value; } });
        if (r?.points !== null && r?.points !== undefined) scores[q.id] = r.points;
        extra = [h('div', { class: 'answer-box' }, given || 'Текста нет'),
          h('div', { class: 'thumbs' }, sub.files.filter(f => f.questionId === q.id).map(f => h('button', { class: 'thumb', type: 'button', onclick: () => viewImage(fileUrl(f.id), 'Фото решения') }, h('img', { src: fileUrl(f.id), alt: 'Фото решения' })))),
          q.kind === 'long' ? field(`Баллы из ${q.points}`, input) : null];
      } else {
        extra = [h('div', { class: 'answer-box' }, `Ответ: ${shownAnswer(q, given)}`),
          h('p', { class: 'small' }, `Верно: ${q.kind === 'short' ? q.correct.join(' или ') : shownAnswer(q, q.correct)}`),
          h('span', { class: `chip ${r?.correct ? 'chip-ok' : 'chip-bad'}` }, `${r?.points ?? 0} из ${q.points}, автоматически`)];
      }
      return h('section', { class: 'card question', 'data-question': q.id }, questionHead(q, i), extra);
    }),
    h('form', {
      class: 'card stack', id: 'check-form',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => {
          const body = { comment: comment.value, scores: Object.fromEntries(Object.entries(scores).filter(([, v]) => v !== '' && v !== null).map(([k, v]) => [k, Number(v)])) };
          const r = await api('PATCH', `/submissions/${id}`, body);
          toast(r.pending ? 'Сохранено. Остались непроверенные ответы' : 'Проверено, ученик и родители получат уведомление', 'ok');
          location.hash = '/journal';
        });
      },
    }, field('Комментарий ученику', comment), h('button', { class: 'btn btn-primary', type: 'submit', id: 'save-check' }, 'Сохранить проверку')));
}

// ---------- Репетитор: задания и конструктор ----------

async function viewTasksTutor(page) {
  const { assignments } = await api('GET', '/assignments');
  clear(page,
    h('div', { class: 'row between' }, h('h1', null, 'Задания'), h('a', { class: 'btn btn-primary', href: '#/edit/new', id: 'new-task' }, 'Новое задание')),
    assignments.length ? h('div', { class: 'list' }, assignments.map(a => {
      const done = a.students.filter(s => ['submitted', 'checked'].includes(s.status)).length;
      const wait = a.students.filter(s => s.status === 'submitted').length;
      return h('a', { class: 'card plain', href: `#/task/${a.id}`, 'data-task': a.id },
        h('div', { class: 'row between top-row' }, h('strong', null, a.title), h('span', { class: 'muted small' }, `до ${dateShort(a.dueDay)}`)),
        h('div', { class: 'row chips' }, h('span', { class: 'chip' }, `Сдали ${done} из ${a.students.length}`), wait ? h('span', { class: 'chip st-submitted' }, `Проверить: ${wait}`) : null,
          h('span', { class: 'chip' }, `${a.questionCount} вопр., ${a.maxScore} б.`)));
    })) : h('div', { class: 'empty' }, h('strong', null, 'Заданий пока нет'), 'Соберите первое в конструкторе.'));
}

async function viewTaskTutor(page, id) {
  const { assignment: a } = await api('GET', `/assignments/${id}`);
  clear(page,
    h('a', { class: 'back', href: '#/tasks' }, '← К заданиям'),
    h('h1', null, a.title),
    h('p', { class: 'muted' }, `Срок: ${dateLong(a.dueDay)} · ${a.questionCount} вопр. · ${a.maxScore} б. · ответы ${a.showAnswers ? 'открываются после сдачи' : 'скрыты'}`),
    a.description ? h('p', null, a.description) : null,
    h('div', { class: 'row' }, h('a', { class: 'btn', href: `#/edit/${a.id}`, id: 'edit-task' }, 'Изменить'),
      h('button', {
        class: 'btn btn-ghost', type: 'button', id: 'delete-task',
        onclick: async () => { if (await confirmDialog(`Удалить «${a.title}» вместе со сданными работами?`, 'Удалить')) await guard(async () => { await api('DELETE', `/assignments/${a.id}`); toast('Удалено'); location.hash = '/tasks'; }); },
      }, 'Удалить')),
    h('h2', { class: 'section-title' }, 'Ученики'),
    a.students.length ? h('section', { class: 'card' }, a.students.map(s => h('div', { class: 'person', 'data-student': s.id },
      h('a', { class: 'plain', href: s.submissionId ? `#/check/${s.submissionId}` : `#/student/${s.id}` }, h('strong', null, s.name)),
      h('div', { class: 'row' }, s.late ? h('span', { class: 'chip chip-bad' }, 'опоздание') : null, statusChip(s.status), s.percent !== null ? pct(s.percent) : null))))
      : h('p', { class: 'muted' }, 'Задание никому не выдано.'),
    h('h2', { class: 'section-title' }, 'Вопросы'),
    a.questions.map((q, i) => h('section', { class: 'card question' }, questionHead(q, i),
      q.kind === 'long' ? h('p', { class: 'muted small' }, 'Проверяете вы') : h('p', { class: 'small' }, `Верно: ${q.kind === 'short' ? q.correct.join(' или ') : shownAnswer(q, q.correct)}`),
      q.topic ? h('span', { class: 'chip chip-accent' }, q.topic) : null)));
}

const blankQuestion = kind => ({ kind, text: '', options: kind === 'single' || kind === 'multi' ? ['', ''] : [], correct: kind === 'single' ? 0 : kind === 'multi' ? [] : kind === 'short' ? [] : null, points: kind === 'long' ? 3 : 1, topic: '', imageId: null });

async function viewEditor(page, id) {
  const editing = id && id !== 'new';
  const [{ students }, existing] = await Promise.all([api('GET', '/students'), editing ? api('GET', `/assignments/${id}`).then(r => r.assignment) : null]);
  const locked = !!existing?.students.some(s => ['submitted', 'checked'].includes(s.status));
  const st = {
    title: existing?.title || '', description: existing?.description || '', dueDay: existing?.dueDay || shift(S.meta.today, 7), showAnswers: existing ? existing.showAnswers : true,
    studentIds: new Set(existing?.students.map(s => s.id) || []),
    questions: existing ? existing.questions.map(q => ({ ...q, options: [...q.options], correct: Array.isArray(q.correct) ? [...q.correct] : q.correct })) : [blankQuestion('single')],
  };
  const issued = new Set(existing?.students.map(s => s.id) || []);
  const box = h('div', { class: 'stack', id: 'questions' });

  function questionEditor(q, i) {
    const redraw = () => drawQuestions();
    const kind = select(Object.entries(KIND), q.kind, { name: `q-kind-${i}`, 'aria-label': 'Тип вопроса', onchange: e => { Object.assign(q, blankQuestion(e.target.value), { text: q.text, topic: q.topic, imageId: q.imageId }); redraw(); } });
    const textEl = h('textarea', { name: `q-text-${i}`, rows: 2, maxlength: 1000, value: q.text, placeholder: 'Текст вопроса', oninput: e => { q.text = e.target.value; } });
    const points = h('input', { name: `q-points-${i}`, inputmode: 'numeric', value: q.points, oninput: e => { q.points = Number(e.target.value) || e.target.value; } });
    const topic = h('input', { name: `q-topic-${i}`, maxlength: 60, value: q.topic, placeholder: 'Тема для статистики', oninput: e => { q.topic = e.target.value; } });
    let answers = null;
    if (q.kind === 'single' || q.kind === 'multi') {
      answers = h('div', { class: 'stack' }, h('span', { class: 'field-label' }, q.kind === 'single' ? 'Варианты, отметьте верный' : 'Варианты, отметьте все верные'),
        q.options.map((o, k) => h('div', { class: 'opt-row' },
          h('input', {
            type: q.kind === 'single' ? 'radio' : 'checkbox', name: `q-correct-${i}`, 'aria-label': `Вариант ${k + 1} верный`,
            checked: q.kind === 'single' ? q.correct === k : q.correct.includes(k),
            onchange: e => { if (q.kind === 'single') q.correct = k; else q.correct = e.target.checked ? [...new Set([...q.correct, k])] : q.correct.filter(x => x !== k); },
          }),
          h('input', { name: `q-opt-${i}-${k}`, value: o, maxlength: 200, placeholder: `Вариант ${k + 1}`, oninput: e => { q.options[k] = e.target.value; } }),
          h('button', {
            class: 'btn btn-ghost', type: 'button', 'aria-label': 'Убрать вариант', disabled: q.options.length <= 2,
            onclick: () => {
              q.options.splice(k, 1);
              if (q.kind === 'single') q.correct = q.correct === k ? 0 : q.correct > k ? q.correct - 1 : q.correct;
              else q.correct = q.correct.filter(x => x !== k).map(x => (x > k ? x - 1 : x));
              redraw();
            },
          }, '×'))),
        q.options.length < 8 ? h('button', { class: 'btn btn-ghost', type: 'button', 'data-add-option': i, onclick: () => { q.options.push(''); redraw(); } }, '+ вариант') : null);
    } else if (q.kind === 'short') {
      answers = field('Верные ответы, каждый с новой строки', h('textarea', { name: `q-short-${i}`, rows: 2, value: (q.correct || []).join('\n'), oninput: e => { q.correct = e.target.value.split('\n').map(x => x.trim()).filter(Boolean); } }),
        'Регистр, пробелы и запятая вместо точки не важны, 0,5 и 0.50 считаются одинаково');
    } else answers = h('p', { class: 'muted small' }, 'Ученик пишет решение или прикладывает фото. Баллы ставите вы при проверке.');
    return h('section', { class: 'card q-edit', 'data-q-edit': i },
      h('div', { class: 'row between' }, h('strong', null, `Вопрос ${i + 1}`),
        h('div', { class: 'row' },
          i > 0 ? h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Выше', onclick: () => { st.questions.splice(i - 1, 0, st.questions.splice(i, 1)[0]); redraw(); } }, '↑') : null,
          h('button', { class: 'btn btn-ghost', type: 'button', 'data-remove-q': i, disabled: st.questions.length <= 1, onclick: () => { st.questions.splice(i, 1); redraw(); } }, 'Удалить'))),
      field('Тип', kind), textEl,
      q.imageId ? h('div', { class: 'row' }, h('img', { class: 'q-img', src: fileUrl(q.imageId), alt: 'Рисунок' }), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { q.imageId = null; redraw(); } }, 'Убрать рисунок'))
        : fileButton('Добавить рисунок', 'image/*', async file => { const r = await upload('/question-images', await compress(file), 'image/jpeg'); q.imageId = r.imageId; redraw(); }, { 'data-q-image': i }),
      answers,
      h('div', { class: 'two' }, field('Баллы', points), field('Тема', topic)));
  }
  function drawQuestions() {
    clear(box, locked ? h('p', { class: 'note' }, 'Работы уже сдают: вопросы не меняются, чтобы оценки остались честными. Можно изменить срок, описание и выдать ещё ученикам.') : null,
      locked ? existing.questions.map((q, i) => h('section', { class: 'card question' }, questionHead(q, i))) : st.questions.map(questionEditor),
      locked ? null : h('div', { class: 'row' }, Object.entries(KIND).map(([k, label]) => h('button', { class: 'btn', type: 'button', 'data-add-q': k, onclick: () => { st.questions.push(blankQuestion(k)); drawQuestions(); } }, `+ ${label.toLowerCase()}`))));
  }
  drawQuestions();

  const title = h('input', { name: 'task-title', maxlength: 150, required: true, value: st.title, oninput: e => { st.title = e.target.value; } });
  const description = h('textarea', { name: 'task-description', rows: 2, maxlength: 2000, value: st.description, oninput: e => { st.description = e.target.value; } });
  const due = h('input', { type: 'date', name: 'task-due', value: st.dueDay, required: true, onchange: e => { st.dueDay = e.target.value; } });
  const showAnswers = checkbox('task-show', 'Показать ученику правильные ответы после сдачи', st.showAnswers, { onchange: e => { st.showAnswers = e.target.checked; } });
  const picks = h('div', { class: 'pick-list', id: 'task-students' }, students.filter(s => s.active).map(s => checkbox(`task-student-${s.id}`, `${s.name}${s.grade ? `, ${s.grade}` : ''}${issued.has(s.id) ? ' (выдано)' : ''}`, st.studentIds.has(s.id),
    { disabled: issued.has(s.id), onchange: e => { if (e.target.checked) st.studentIds.add(s.id); else st.studentIds.delete(s.id); } }).el));

  clear(page,
    h('a', { class: 'back', href: existing ? `#/task/${existing.id}` : '#/tasks' }, '← Назад'),
    h('h1', null, existing ? 'Изменить задание' : 'Новое задание'),
    h('section', { class: 'card stack' }, field('Название', title), field('Описание', description), h('div', { class: 'two' }, field('Срок сдачи', due), h('span')), showAnswers.el),
    h('section', { class: 'card stack' }, h('h2', null, 'Кому выдать'), picks, h('p', { class: 'muted small' }, 'Выданное задание забрать нельзя. Ученик и родители получат уведомление.')),
    box,
    h('button', {
      class: 'btn btn-primary wide', type: 'button', id: 'save-task',
      onclick: () => guard(async () => {
        const body = { title: st.title, description: st.description, dueDay: st.dueDay, showAnswers: st.showAnswers, studentIds: [...st.studentIds] };
        if (!locked) body.questions = st.questions.map(q => ({ ...q, points: Number(q.points) }));
        const r = existing ? await api('PATCH', `/assignments/${existing.id}`, body) : await api('POST', '/assignments', body);
        toast('Задание сохранено', 'ok');
        location.hash = `/task/${r.assignment.id}`;
      }),
    }, existing ? 'Сохранить' : 'Сохранить и выдать'));
}

// ---------- Репетитор: ученики ----------

function inviteDialog(role) {
  const name = h('input', { name: 'invite-name', required: true, maxlength: 80 });
  const box = h('div', { class: 'stack', hidden: true });
  const form = h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const r = await api('POST', '/people/invites', { name: name.value, role });
        form.hidden = true;
        box.hidden = false;
        clear(box, h('h2', null, 'Ссылка готова'), h('p', { class: 'muted' }, 'Отправьте её в мессенджере. Работает один раз, 7 дней.'),
          h('input', { readonly: true, value: `${location.origin}/#/invite/${r.token}`, 'aria-label': 'Ссылка-приглашение' }),
          h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: e => { e.currentTarget.closest('dialog').close(); render(); } }, 'Готово')));
      });
    },
  }, h('h2', null, role === 'student' ? 'Пригласить ученика' : 'Пригласить родителя'), field('Имя и фамилия', name), dialogButtons('Создать ссылку'));
  openDialog(h('div', null, form, box));
}

async function viewStudents(page) {
  const { students } = await api('GET', '/students');
  clear(page,
    h('h1', null, 'Ученики'),
    S.meta.demo ? h('p', { class: 'note note-calm' }, 'В демо состав не меняется.') : h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'button', id: 'invite-student', onclick: () => inviteDialog('student') }, 'Пригласить ученика'),
      h('button', { class: 'btn', type: 'button', id: 'invite-parent', onclick: () => inviteDialog('parent') }, 'Пригласить родителя')),
    students.length ? h('div', { class: 'list' }, students.map(s => h('a', { class: `card plain ${s.active ? '' : 'off'}`, href: `#/student/${s.id}`, 'data-student': s.id },
      h('div', { class: 'row between top-row' }, h('strong', null, s.name), pct(s.average)),
      h('p', { class: 'muted small' }, [s.grade, s.goal, s.attendance !== null ? `посещаемость ${s.attendance}%` : null].filter(Boolean).join(' · ')),
      h('div', { class: 'row chips' }, s.overdue ? h('span', { class: 'chip chip-bad' }, `Просрочено: ${s.overdue}`) : null, s.weak.map(t => h('span', { class: 'chip chip-warn' }, t))))))
      : h('div', { class: 'empty' }, h('strong', null, 'Учеников пока нет'), 'Пригласите первого по ссылке.'));
}

async function viewStudent(page, id) {
  const reload = () => guard(() => viewStudent(page, id));
  const [{ student: s, stats: st, assignments }, { people }] = await Promise.all([api('GET', `/students/${id}`), api('GET', '/people')]);
  const grade = h('input', { name: 'grade', value: s.grade, maxlength: 30 });
  const goal = h('input', { name: 'goal', value: s.goal, maxlength: 200 });
  const free = people.filter(p => p.role === 'parent' && p.active && !s.parents.some(x => x.id === p.id));
  const addParent = free.length ? select([['', 'Привязать родителя…'], ...free.map(p => [p.id, p.name])], '', {
    name: 'add-parent', onchange: e => e.target.value && guard(async () => { await api('POST', `/students/${s.id}/parents`, { parentId: Number(e.target.value) }); toast('Родитель привязан', 'ok'); await reload(); }),
  }) : null;
  clear(page,
    h('a', { class: 'back', href: '#/students' }, '← К ученикам'),
    h('h1', null, s.name),
    h('form', {
      class: 'card stack', id: 'student-form',
      onsubmit: async e => { e.preventDefault(); await guard(async () => { await api('PATCH', `/students/${s.id}`, { grade: grade.value, goal: goal.value }); toast('Сохранено', 'ok'); }); },
    }, h('div', { class: 'two' }, field('Класс', grade), field('Цель', goal)), h('button', { class: 'btn', type: 'submit' }, 'Сохранить')),
    h('section', { class: 'card stack', id: 'parents' }, h('h2', null, 'Родители'),
      s.parents.length ? s.parents.map(p => h('div', { class: 'person' }, h('span', null, p.name),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => guard(async () => { await api('DELETE', `/students/${s.id}/parents/${p.id}`); await reload(); }) }, 'Отвязать')))
        : h('p', { class: 'muted small' }, 'Родитель не привязан. Он увидит оценки и расписание ребёнка.'),
      addParent),
    statsBlock(st),
    h('h2', { class: 'section-title' }, 'Задания'),
    assignments.length ? h('section', { class: 'card' }, assignments.map(a => h('a', { class: 'person plain', href: a.submissionId ? `#/check/${a.submissionId}` : `#/task/${a.id}` },
      h('span', null, h('strong', null, a.title), h('span', { class: 'muted small' }, ` · до ${dm(a.dueDay)}`)),
      h('span', { class: 'row' }, statusChip(a.status), a.percent !== null ? pct(a.percent) : null))))
      : h('p', { class: 'muted' }, 'Заданий не выдавалось.'));
}

// ---------- Репетитор: главная страница, заявки, ещё ----------

const BLOCKS = [['about', 'О себе'], ['subjects', 'Предметы и форматы'], ['prices', 'Цены'], ['reviews', 'Отзывы'], ['contacts', 'Контакты']];

function blockDialog(key, label, value, reload) {
  const input = h(key === 'title' ? 'input' : 'textarea', { name: `page-${key}`, value, rows: 8, maxlength: 4000 });
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => { e.preventDefault(); await guard(async () => { await api('PATCH', '/page', { [key]: input.value }); dlg.close(); toast('Главная обновлена', 'ok'); await reload(); }); },
  }, h('h2', null, label), input, key === 'title' ? null : h('p', { class: 'muted small' }, 'Пустая строка — новый абзац, «- » в начале строки — пункт списка.'), dialogButtons('Сохранить')));
}

function pageContent(p, photoId, { edit = false, reload } = {}) {
  const editBtn = (key, label, value) => (edit ? h('button', { class: 'btn btn-ghost', type: 'button', 'data-edit-block': key, onclick: () => blockDialog(key, label, value, reload) }, 'Изменить') : null);
  return [
    h('section', { class: 'hero' },
      photoId ? h('img', { src: fileUrl(photoId), alt: 'Обложка' }) : null,
      h('div', { class: 'hero-body' },
        h('h1', null, p.title || 'Репетитор'), editBtn('title', 'Заголовок', p.title),
        p.subtitle ? h('p', { class: 'muted' }, p.subtitle) : null, editBtn('subtitle', 'Подзаголовок', p.subtitle),
        edit ? fileButton('Сменить обложку', 'image/*', async file => { await upload('/page/photo', await compress(file), 'image/jpeg'); toast('Обложка обновлена', 'ok'); await reload(); }, { 'data-cover-input': '' })
          : h('div', { class: 'row' }, h('a', { class: 'btn btn-primary', href: '#lead-form', onclick: e => { e.preventDefault(); document.getElementById('lead-form')?.scrollIntoView({ behavior: 'smooth' }); } }, 'Записаться на пробное'),
            h('a', { class: 'btn', href: '#/login' }, 'Войти в кабинет')))),
    BLOCKS.filter(([k]) => edit || p[k]).map(([k, label]) => h('section', { class: 'card block', 'data-block': k },
      h('div', { class: 'block-head' }, h('h2', null, label), editBtn(k, label, p[k])), p[k] ? rich(p[k]) : h('p', { class: 'muted' }, 'Пусто: посетители этот блок не увидят.'))),
  ];
}

async function viewPageEditor(page) {
  const reload = () => guard(() => viewPageEditor(page));
  const { page: p, photoId } = await api('GET', '/page');
  clear(page, h('a', { class: 'back', href: '#/more' }, '← Ещё'), h('h1', null, 'Главная страница'),
    h('p', { class: 'muted' }, 'Так её видят посетители. Изменения появляются сразу.'), h('a', { class: 'btn', href: '/', target: '_blank', rel: 'noopener' }, 'Открыть как посетитель'),
    pageContent(p, photoId, { edit: true, reload }));
}

async function viewLeads(page) {
  const reload = () => guard(() => viewLeads(page));
  const { leads } = await api('GET', '/leads');
  clear(page, h('a', { class: 'back', href: '#/more' }, '← Ещё'), h('h1', null, 'Заявки с главной'),
    S.meta.demo ? h('p', { class: 'note note-calm' }, 'В демо заявки посетителей не сохраняются: их контакты увидел бы любой, кто войдёт как репетитор.') : null,
    leads.length ? h('div', { class: 'list' }, leads.map(l => h('article', { class: `card ${l.done ? 'off' : ''}`, 'data-lead': l.id },
      h('div', { class: 'row between top-row' }, h('strong', null, l.name), h('span', { class: 'muted small' }, stamp(l.createdAt))),
      h('p', null, l.contact), l.message ? h('p', { class: 'muted pre' }, l.message) : null,
      h('button', { class: 'btn', type: 'button', onclick: () => guard(async () => { await api('PATCH', `/leads/${l.id}`, { done: !l.done }); await reload(); }) }, l.done ? 'Вернуть в работу' : 'Обработана'))))
      : h('div', { class: 'empty' }, h('strong', null, 'Заявок нет'), 'Заявки на пробное занятие с главной страницы появятся здесь.'));
}

async function viewMore(page) {
  clear(page,
    h('section', { class: 'card' }, h('h1', null, S.user.name), h('p', { class: 'muted' }, ROLE[S.user.role])),
    h('nav', { class: 'card menu-list', 'aria-label': 'Ещё' },
      h('a', { href: '#/materials', 'data-more': 'materials' }, 'Материалы'),
      h('a', { href: '#/page', 'data-more': 'page' }, 'Главная страница'),
      h('a', { href: '#/leads', 'data-more': 'leads' }, 'Заявки на пробное'),
      h('a', { href: '#/notifications', 'data-more': 'notifications' }, 'Уведомления'),
      h('a', { href: '#/profile', 'data-more': 'profile' }, 'Профиль')));
}

// ---------- Профиль, уведомления, push ----------

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const urlKey = s => { const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function pushBlock(reload) {
  if (isIos() && !standalone()) return h('p', { class: 'muted small' }, 'На iPhone уведомления работают после установки: «Поделиться» → «На экран Домой».');
  if (!('PushManager' in window) || !('Notification' in window)) return h('p', { class: 'muted small' }, 'Этот браузер не поддерживает уведомления. Они будут в колокольчике.');
  const sub = await currentSubscription();
  if (sub) {
    return [h('p', { class: 'small' }, 'Уведомления включены на этом устройстве.'), h('button', {
      class: 'btn', type: 'button', id: 'push-off',
      onclick: () => guard(async () => { await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); toast('Уведомления выключены'); await reload(); }),
    }, 'Выключить')];
  }
  return [h('p', { class: 'muted small' }, 'О занятии за 2 часа, о новых заданиях и оценках.'), h('button', {
    class: 'btn', type: 'button', id: 'push-on',
    onclick: () => guard(async () => {
      if (await Notification.requestPermission() !== 'granted') { toast('Уведомления запрещены в настройках браузера', 'error'); return; }
      const reg = await navigator.serviceWorker.ready;
      const { key } = await api('GET', '/push/key');
      let s;
      try { s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(key) }); } catch { toast('Этот браузер не смог подключить уведомления', 'error'); return; }
      await api('POST', '/push/subscribe', s.toJSON());
      toast('Уведомления включены', 'ok');
      await reload();
    }),
  }, 'Включить уведомления')];
}

async function viewProfile(page) {
  const reload = () => guard(() => viewProfile(page));
  const me = S.user;
  const name = h('input', { name: 'name', value: me.name, maxlength: 80, disabled: S.meta.demo });
  const oldPass = h('input', { name: 'old', type: 'password', autocomplete: 'current-password', disabled: S.meta.demo });
  const newPass = h('input', { name: 'new', type: 'password', autocomplete: 'new-password', minlength: 8, disabled: S.meta.demo });
  clear(page,
    h('h1', null, 'Профиль'),
    h('p', { class: 'muted' }, ROLE[me.role]),
    S.meta.demo ? h('p', { class: 'note note-calm' }, 'Демо: имя и пароль не меняются, всё остальное сбрасывается раз в сутки.') : null,
    me.role === 'parent' ? h('section', { class: 'card' }, h('h2', null, 'Дети'), S.children.length ? S.children.map(c => h('p', null, c.name)) : h('p', { class: 'muted' }, 'Попросите репетитора привязать ребёнка к вашему аккаунту.')) : null,
    h('form', {
      class: 'card stack',
      onsubmit: async e => { e.preventDefault(); await guard(async () => { const r = await api('PATCH', '/me', { name: name.value }); S.user = { ...me, name: r.user.name }; toast('Сохранено', 'ok'); }); },
    }, field('Имя', name), h('button', { class: 'btn', type: 'submit', disabled: S.meta.demo }, 'Сохранить')),
    h('form', {
      class: 'card stack',
      onsubmit: async e => { e.preventDefault(); await guard(async () => { await api('POST', '/me/password', { old: oldPass.value, new: newPass.value }); oldPass.value = ''; newPass.value = ''; toast('Пароль изменён', 'ok'); }); },
    }, h('h2', null, 'Смена пароля'), field('Текущий пароль', oldPass), field('Новый пароль', newPass, 'Минимум 8 символов'), h('button', { class: 'btn', type: 'submit', disabled: S.meta.demo }, 'Изменить пароль')),
    h('section', { class: 'card stack' }, h('h2', null, 'Уведомления на телефоне'), await pushBlock(reload)),
    h('button', {
      class: 'btn wide', type: 'button', id: 'logout',
      onclick: () => guard(async () => { await api('POST', '/auth/logout'); S.user = false; S.child = null; location.hash = '/'; render(); }),
    }, 'Выйти'));
}

async function viewNotifications(page) {
  const { notifications, unread } = await api('GET', '/notifications');
  if (unread) { await api('POST', '/notifications/read'); S.unread = 0; }
  clear(page, h('h1', null, 'Уведомления'),
    notifications.length ? h('div', { class: 'list' }, notifications.map(n => h('a', { class: `card plain notice ${n.read ? '' : 'unread'}`, href: n.link || '#/', 'data-notice': n.kind },
      h('p', null, n.text), h('p', { class: 'muted small' }, stamp(n.createdAt)))))
      : h('div', { class: 'empty' }, h('strong', null, 'Уведомлений нет'), 'Новые задания, оценки и изменения в расписании появятся здесь.'));
}

// ---------- Без входа ----------

function publicShell(content) {
  clear(root, h('div', { class: 'landing' },
    h('header', { class: 'landing-top' }, h('a', { class: 'brand', href: '#/' }, h('img', { src: '/favicon.svg', alt: '', width: 30, height: 30 }), 'Зачёт'),
      h('a', { class: 'btn', href: '#/login', id: 'to-login' }, 'Войти')),
    content,
    h('p', { class: 'footer' }, 'Зачёт — учебный кейс MyFreeLab. Репетитор и ученики в демо выдуманы.')));
}

function demoRoles() {
  return h('div', { class: 'roles', id: 'demo-roles' }, S.meta.demo ? ['tutor', 'student', 'parent'].map(role => h('button', {
    class: 'btn role-btn', type: 'button', 'data-role': role,
    onclick: () => guard(async () => { const r = await api('POST', '/auth/demo', { role }); S.user = r.user; location.hash = `/${homeOf(role)}`; await render(); }),
  }, h('span', null, ROLE[role]), h('small', null, ROLE_HINT[role]))) : null);
}

function leadForm() {
  const name = h('input', { name: 'lead-name', required: true, maxlength: 80, autocomplete: 'name' });
  const contact = h('input', { name: 'lead-contact', required: true, maxlength: 100, placeholder: 'Телефон, Telegram или почта' });
  const message = h('textarea', { name: 'lead-message', rows: 3, maxlength: 1000, placeholder: 'Класс, цель, удобное время' });
  const consent = checkbox('lead-consent', 'Согласен(на) на обработку персональных данных для связи со мной');
  const box = h('div', { class: 'stack', id: 'lead-done', hidden: true });
  const form = h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const r = await api('POST', '/leads', { name: name.value, contact: contact.value, message: message.value, consent: consent.input.checked });
        form.hidden = true;
        box.hidden = false;
        clear(box, h('h3', null, 'Спасибо, заявка отправлена'), h('p', { class: 'muted' }, r.demo ? 'Это демо: заявка не сохранена и никому не ушла.' : 'Репетитор свяжется с вами в течение дня.'));
      });
    },
  }, field('Имя', name), field('Как с вами связаться', contact), field('Сообщение', message), consent.el, h('button', { class: 'btn btn-primary', type: 'submit', id: 'send-lead' }, 'Записаться на пробное занятие'));
  return h('section', { class: 'card stack', id: 'lead-form' }, h('h2', null, 'Пробное занятие'), form, box);
}

async function viewLanding() {
  const { page: p, photoId } = await api('GET', '/page');
  const { materials } = await api('GET', '/materials');
  publicShell([
    pageContent(p, photoId),
    S.meta.demo ? h('section', { class: 'stack' }, h('h2', null, 'Демо: войдите в одной из ролей'), h('p', { class: 'muted small' }, 'Люди выдуманные. Изменения видят все посетители, данные сбрасываются раз в сутки.'), demoRoles()) : null,
    materials.length ? h('section', { class: 'card stack', id: 'public-materials' }, h('h2', null, 'Полезные материалы'),
      materials.map(m => h('div', { class: 'doc', 'data-material': m.id }, h('span', { class: 'doc-icon' }, DOC_TYPES[m.type] || 'ФАЙЛ'),
        h('div', { class: 'doc-body' }, h('strong', null, m.title), h('div', { class: 'row' }, docOpen(m)))))) : null,
    leadForm(),
  ]);
}

function viewLogin() {
  const login = h('input', { name: 'login', autocomplete: 'username', required: true });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' },
    h('div', { class: 'brand big' }, h('img', { src: '/favicon.svg', alt: '', width: 40, height: 40 }), 'Зачёт'),
    S.meta.demo ? [h('p', { class: 'muted' }, 'Демо с выдуманными людьми. Войдите в одной из ролей:'), demoRoles()]
      : [h('p', { class: 'muted' }, 'Кабинет ученика, родителя и репетитора. Доступ выдаёт репетитор по ссылке-приглашению.'),
        h('form', {
          class: 'stack',
          onsubmit: async e => { e.preventDefault(); await guard(async () => { const r = await api('POST', '/auth/login', { login: login.value, password: password.value }); S.user = r.user; location.hash = `/${homeOf(r.user.role)}`; await render(); }); },
        }, field('Логин', login), field('Пароль', password), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти'))],
    h('a', { class: 'back', href: '#/' }, '← На главную'))));
}

async function viewInvite(token) {
  const info = await api('GET', `/auth/invite/${encodeURIComponent(token)}`).catch(e => e);
  if (info instanceof Error) {
    clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' }, h('h2', null, 'Приглашение не работает'), h('p', { class: 'muted' }, info.message), h('a', { class: 'btn', href: '#/' }, 'На главную'))));
    return;
  }
  const login = h('input', { autocomplete: 'username', required: true, name: 'new-login' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, name: 'new-password' });
  clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' }, h('h2', null, `${info.name}, добро пожаловать`), h('p', { class: 'muted' }, `Роль: ${ROLE[info.role]}`),
    h('form', {
      class: 'stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => { const r = await api('POST', `/auth/invite/${encodeURIComponent(token)}`, { login: login.value, password: password.value }); S.user = r.user; location.hash = `/${homeOf(r.user.role)}`; });
      },
    }, field('Придумайте логин', login, 'Латиница и цифры'), field('Придумайте пароль', password, 'Минимум 8 символов'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти')))));
}

// ---------- Маршруты ----------

function parseRoute() {
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  return { view: parts[0] || '', a: parts[1] };
}

let token = 0;

export async function render() {
  const mine = ++token;
  const r = parseRoute();
  try {
    if (!S.meta) S.meta = await api('GET', '/meta');
    if (r.view === 'invite') return viewInvite(r.a);
    if (S.user === null) {
      try { S.user = (await api('GET', '/me')).user; } catch (e) { if (e instanceof ApiError && e.status === 401) S.user = false; else throw e; }
    }
  } catch (e) {
    return clear(root, h('div', { class: 'auth' }, h('div', { class: 'empty' }, h('strong', null, 'Нет связи с сервером'), e.message, h('button', { class: 'btn', type: 'button', onclick: render }, 'Повторить'))));
  }

  if (!S.user) {
    if (r.view === 'login') return viewLogin();
    try { return await viewLanding(); } catch (e) { return publicShell(h('div', { class: 'empty' }, h('strong', null, 'Не удалось загрузить'), e.message)); }
  }

  const page = h('div', { class: 'stack' });
  let active = r.view;
  try {
    S.unread = (await api('GET', '/notifications')).unread;
    if (S.user.role === 'parent') {
      S.children = (await api('GET', '/children')).children;
      if (!S.children.some(c => c.id === S.child)) S.child = S.children[0]?.id ?? null;
    }
    const v = r.view;
    if (v === 'notifications') await viewNotifications(page);
    else if (v === 'profile') { active = isTutor() ? 'more' : ''; await viewProfile(page); }
    else if (v === 'tasks') await viewTasks(page);
    else if (v === 'task') { active = 'tasks'; await viewTask(page, r.a); }
    else if (v === 'schedule') await viewSchedule(page, r.a);
    else if (v === 'materials') { active = isTutor() ? 'more' : 'materials'; await viewMaterials(page); }
    else if (isTutor()) {
      if (v === 'edit') { active = 'tasks'; await viewEditor(page, r.a); }
      else if (v === 'check') { active = 'journal'; await viewCheck(page, r.a); }
      else if (v === 'students') await viewStudents(page);
      else if (v === 'student') { active = 'students'; await viewStudent(page, r.a); }
      else if (v === 'page') { active = 'more'; await viewPageEditor(page); }
      else if (v === 'leads') { active = 'more'; await viewLeads(page); }
      else if (v === 'more') await viewMore(page);
      else { active = 'journal'; await viewJournal(page); }
    } else if (S.user.role === 'parent' && !S.children.length) {
      clear(page, h('div', { class: 'empty' }, h('strong', null, 'Ребёнок пока не привязан'), 'Попросите репетитора привязать вашего ребёнка к аккаунту.'));
    } else if (v === 'progress') await viewProgress(page);
    else { active = 'today'; await viewToday(page); }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { S.user = false; return render(); }
    clear(page, h('div', { class: 'empty' }, h('strong', null, e.status === 404 ? 'Не найдено' : 'Не удалось загрузить'), e.message,
      h('a', { class: 'btn', href: `#/${homeOf(S.user.role)}` }, 'На главный экран')));
  }
  if (mine === token) {
    clear(root, shell(active, page));
    window.scrollTo(0, 0);
  }
}

window.addEventListener('hashchange', render);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
