import { h, clear, api, guard, toast, openDialog, confirmDialog, field, select, ApiError } from '/shared/ui.js';
import { chart, COLORS } from '/chart.js';

const root = document.getElementById('app');
const ROLE = { client: 'Клиент', doctor: 'Врач', nutritionist: 'Нутрициолог', trainer: 'Тренер', admin: 'Администратор' };
const ROLE_HINT = {
  client: 'Анна: дневник, графики, анализы, запись к тренеру',
  doctor: 'Разбор анализов по запросам клиентов',
  nutritionist: 'Меню по запросам клиентов',
  trainer: 'Расписание и запись на тренировки',
  admin: 'Бесплатные материалы и пользователи',
};
const STATUS = { new: 'Новый', work: 'В работе', done: 'Готово', rejected: 'Отклонён', cancelled: 'Отменён' };
const KIND = { menu: 'Меню', labs: 'Разбор анализов' };
const MAT_KIND = { menu: 'Пробное меню', lesson: 'Урок', article: 'Статья' };
const SECTION = { food: 'Питание', training: 'Тренировки', sleep: 'Сон', general: 'Общее' };
const WEEK = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SPECIALISTS = ['doctor', 'nutritionist', 'trainer'];
const MENU_TEMPLATE = '## День 1\n- Завтрак: \n- Обед: \n- Ужин: \n\n## День 2\n- Завтрак: \n- Обед: \n- Ужин: \n\n## День 3\n- Завтрак: \n- Обед: \n- Ужин: \n';

const S = { user: null, meta: null, unread: 0 };

// ---------- Форматирование ----------

const nf = (v, d = 1) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: d }).format(v));
const utc = iso => new Date(`${iso}T00:00:00Z`);
const dateLong = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utc(iso));
const dateShort = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(utc(iso));
const dateWeek = iso => new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utc(iso));
const capital = t => t.charAt(0).toUpperCase() + t.slice(1);
const stamp = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const shift = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);

function fmtValue(metric, v) {
  if (!v) return '—';
  const def = S.meta.metrics[metric];
  if (metric === 'pressure') return `${nf(v.v1, 0)}/${nf(v.v2, 0)}`;
  if (metric === 'activity') return `${nf(v.v1, 0)}${v.v2 ? ` · ${nf(v.v2, 0)} мин` : ''}`;
  if (metric === 'sleep') return `${nf(v.v1)} ч${v.v2 ? ` · сон ${v.v2}/5` : ''}`;
  if (metric === 'stress') return `${nf(v.v1, 0)} из 10`;
  return `${nf(v.v1)} ${def.unit}`;
}

function fmtChange(metric, c) {
  if (!c) return { text: '—', dir: '', empty: true };
  const digits = metric === 'activity' ? 0 : 1;
  const sign = v => (v > 0 ? '+' : '') + nf(v, digits);
  const text = metric === 'pressure' ? `${sign(c.v1)}/${sign(c.v2 ?? 0)}` : sign(c.v1);
  return { text: c.v1 === 0 ? 'без изменений' : text, dir: c.v1 > 0 ? 'up' : c.v1 < 0 ? 'down' : '' };
}

// Текст материалов: пустая строка делит абзацы, «## » подзаголовок, «- » пункт списка. Всё как текст, не как разметка.
function rich(body) {
  const out = [];
  let list = null;
  let para = [];
  const flush = () => { if (para.length) { out.push(h('p', null, para.join(' '))); para = []; } };
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) {
      flush();
      if (!list) { list = h('ul'); out.push(list); }
      list.append(h('li', null, line.slice(2)));
      continue;
    }
    list = null;
    if (!line) { flush(); continue; }
    if (line.startsWith('## ')) { flush(); out.push(h('h3', null, line.slice(3))); continue; }
    para.push(line);
  }
  flush();
  return h('div', { class: 'rich' }, out);
}

// ---------- Значки нижнего меню ----------

const ICONS = {
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  chart: 'M4 19h16M6 15l4-5 3 3 5-7',
  tube: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 3.5 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  inbox: 'M4 13l2.5-8h11L20 13v6H4zM4 13h5l1 2h4l1-2h5',
  doc: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5',
  calendar: 'M5 5h14v15H5zM5 9h14M9 3v4M15 3v4',
};
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

function navItems() {
  const role = S.user.role;
  if (role === 'client') return [['today', 'Сегодня', 'heart'], ['charts', 'Графики', 'chart'], ['labs', 'Анализы', 'tube'], ['experts', 'Эксперты', 'people'], ['more', 'Ещё', 'more']];
  if (role === 'trainer') return [['schedule', 'Расписание', 'calendar'], ['clients', 'Клиенты', 'people'], ['articles', 'Статьи', 'doc'], ['more', 'Ещё', 'more']];
  if (role === 'admin') return [['people', 'Люди', 'people'], ['articles', 'Материалы', 'doc'], ['more', 'Ещё', 'more']];
  return [['requests', 'Запросы', 'inbox'], ['clients', 'Клиенты', 'people'], ['articles', 'Статьи', 'doc'], ['more', 'Ещё', 'more']];
}

const homeOf = role => ({ client: 'today', trainer: 'schedule', admin: 'people' })[role] || 'requests';

function shell(active, content) {
  const nav = navItems();
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Разделы' }, nav.map(([key, label, ic]) =>
    h('a', { class: `tab ${active === key ? 'active' : ''}`, href: `#/${key}`, 'data-tab': key, 'aria-current': active === key ? 'page' : null }, icon(ic), label)));
  tabs.style.setProperty('--tabs', nav.length);
  return h('div', { class: 'shell' },
    h('header', { class: 'top' },
      h('a', { class: 'brand', href: `#/${homeOf(S.user.role)}` }, h('img', { src: '/favicon.svg', alt: '', width: 30, height: 30 }), 'Тонус'),
      h('a', { class: 'bell', href: '#/notifications', id: 'bell', 'aria-label': `Уведомления: ${S.unread}` }, 'Уведомления', S.unread ? h('span', { class: 'badge' }, S.unread) : null)),
    h('main', { class: 'page-in' }, content),
    tabs);
}

const demoNote = () => (S.meta.demo ? h('p', { class: 'note', 'data-demo-note': '' }, 'Демо с выдуманными людьми. Не вводите настоящие данные о здоровье: записи видят все посетители, они стираются раз в сутки.') : null);
const statusChip = st => h('span', { class: `chip status-${st}`, 'data-status': st }, STATUS[st]);
// Кнопки создаются раньше самого окна, поэтому «Отмена» ищет своё окно в момент нажатия.
const dialogButtons = label => h('div', { class: 'row end' },
  h('button', { class: 'btn', type: 'button', onclick: e => e.currentTarget.closest('dialog')?.close() }, 'Отмена'),
  h('button', { class: 'btn btn-primary', type: 'submit' }, label));
const checkbox = (name, label) => {
  const input = h('input', { type: 'checkbox', name });
  return { input, el: h('label', { class: 'check' }, input, h('span', null, label)) };
};

// ---------- Клиент: сегодня ----------

function numInput(name, unit, value, label) {
  const shown = value === null || value === undefined ? '' : String(value).replace('.', ',');
  const input = h('input', { name, inputmode: 'decimal', autocomplete: 'off', value: shown, 'aria-label': label, placeholder: '—' });
  return { input, el: h('div', { class: `unit-input ${unit ? 'with-unit' : ''}` }, input, unit ? h('span', { class: 'unit' }, unit) : null) };
}

function picker(name, n, value, label) {
  let cur = value ?? null;
  const buttons = [];
  const paint = () => buttons.forEach(b => { const on = Number(b.dataset.v) === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  const el = h('div', { class: 'picker', role: 'group', 'aria-label': label, 'data-picker': name }, Array.from({ length: n }, (_, i) => {
    const b = h('button', { type: 'button', 'data-v': i + 1, onclick: () => { cur = cur === i + 1 ? null : i + 1; paint(); } }, i + 1);
    buttons.push(b);
    return b;
  }));
  paint();
  return { el, get: () => cur };
}

const row = (label, control) => h('div', { class: 'entry-row' }, h('span', { class: 'field-label' }, label), control);

function entryForm(day, today, values, onSaved) {
  const v = m => values[m] || {};
  const weight = numInput('weight', 'кг', v('weight').v1, 'Вес');
  const sys = numInput('sys', '', v('pressure').v1, 'Давление, верхнее');
  const dia = numInput('dia', '', v('pressure').v2, 'Давление, нижнее');
  sys.input.placeholder = '120';
  dia.input.placeholder = '80';
  const pulse = numInput('pulse', 'уд/мин', v('pulse').v1, 'Пульс');
  const steps = numInput('steps', 'шагов', v('activity').v1, 'Шаги');
  const sleep = numInput('sleep', 'ч', v('sleep').v1, 'Сон, часов');
  const quality = picker('quality', 5, v('sleep').v2, 'Качество сна');
  const stress = picker('stress', 10, v('stress').v1, 'Стресс');
  const waist = numInput('waist', 'см', v('waist').v1, 'Талия');
  const minutes = numInput('minutes', 'мин', v('activity').v2, 'Минут тренировки');
  const dayInput = h('input', { type: 'date', name: 'entry-day', value: day, max: today, min: shift(today, -365), 'aria-label': 'День записи' });
  dayInput.addEventListener('change', () => guard(async () => {
    if (!dayInput.value) return;
    const r = await api('GET', `/day/${dayInput.value}`);
    form.replaceWith(entryForm(r.day, today, r.values, onSaved));
  }));

  const raw = input => input.value.trim().replace(',', '.');
  function collect() {
    const out = {};
    const pack = (metric, a, b = '') => {
      if (a === '' && (b === '' || b === null)) { if (values[metric]) out[metric] = null; return; }
      out[metric] = { v1: a, v2: b === '' ? null : b };
    };
    pack('weight', raw(weight.input));
    pack('pressure', raw(sys.input), raw(dia.input));
    pack('pulse', raw(pulse.input));
    if (raw(steps.input) === '' && raw(minutes.input) !== '') throw new ApiError(400, 'invalid', 'Укажите шаги за день, минуты тренировки записываются вместе с ними');
    pack('activity', raw(steps.input), raw(minutes.input));
    if (raw(sleep.input) === '' && quality.get()) throw new ApiError(400, 'invalid', 'Укажите, сколько часов вы спали');
    pack('sleep', raw(sleep.input), quality.get() ?? '');
    pack('stress', stress.get() ?? '');
    pack('waist', raw(waist.input));
    return out;
  }

  const form = h('form', {
    class: 'card entry', id: 'entry',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const values = collect();
        if (!Object.keys(values).length) { toast('Заполните хотя бы один показатель'); return; }
        const r = await api('PUT', `/day/${dayInput.value}`, { values });
        toast('Сохранено', 'ok');
        for (const ev of r.events) toast(ev, 'ok');
        onSaved();
      });
    },
  },
  h('div', { class: 'row between' }, h('h2', null, day === today ? 'Дневник за сегодня' : `Дневник за ${dateLong(day)}`), dayInput),
  row('Вес', weight.el),
  row('Давление', h('div', { class: 'entry-pair' }, sys.el, h('span', { class: 'sep' }, '/'), dia.el)),
  row('Пульс', pulse.el),
  row('Шаги', steps.el),
  row('Сон', sleep.el),
  row('Качество сна', quality.el),
  h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Стресс, 1 — спокойно, 10 — очень тяжело'), stress.el),
  h('details', { class: 'more-fields', open: values.waist || values.activity?.v2 ? true : null }, h('summary', null, 'Ещё: талия, тренировка'),
    h('div', { class: 'entry' }, row('Талия', waist.el), row('Тренировка', minutes.el))),
  h('button', { class: 'btn btn-primary wide', type: 'submit', id: 'save-entry' }, 'Сохранить'));
  return form;
}

function goalRow(g) {
  const digits = g.metric === 'activity' ? 0 : 1;
  const current = g.current === null ? 'нет записей' : `${g.mode === 'average' ? 'в среднем ' : ''}${nf(g.current, digits)} ${g.unit}`;
  const bar = h('div', { class: 'bar' }, h('i'));
  bar.firstChild.style.setProperty('--p', g.progress);
  return h('div', { class: `goal ${g.reached ? 'reached' : ''}`, 'data-goal': g.metric },
    h('div', { class: 'row between' }, h('strong', null, g.name), g.reached ? h('span', { class: 'chip chip-ok' }, 'Достигнута') : h('span', { class: 'muted small' }, `цель ${nf(g.target, digits)} ${g.unit}`)),
    bar,
    h('p', { class: 'muted small' }, `Сейчас: ${current}${g.dueDay ? `. Срок: ${dateLong(g.dueDay)}` : ''}`));
}

function doseRow(d, reload) {
  return h('div', { class: 'dose', 'data-dose': `${d.medId}-${d.time}` },
    h('span', { class: 'dose-time' }, d.time),
    h('div', null, h('p', { class: 'dose-name' }, d.name), d.dose ? h('p', { class: 'muted small' }, d.dose) : null),
    h('button', {
      class: `btn take ${d.taken ? 'done' : ''}`, type: 'button', 'aria-pressed': d.taken ? 'true' : 'false',
      onclick: () => guard(async () => { await api('POST', `/meds/${d.medId}/take`, { time: d.time, taken: !d.taken }); await reload(); }),
    }, d.taken ? 'Принято ✓' : 'Отметить'));
}

async function viewToday(page) {
  const reload = () => guard(() => viewToday(page));
  const o = await api('GET', '/overview');
  const vals = o.values;
  const stepsGoal = o.goals.find(g => g.metric === 'activity');
  clear(page,
    h('div', null, h('h1', null, 'Сегодня'), h('p', { class: 'muted' }, dateWeek(o.today))),
    demoNote(),
    o.answered ? h('a', { class: 'note note-calm plain', href: '#/experts', id: 'answered' }, 'Специалист ответил на ваш запрос. Открыть') : null,
    h('div', { class: 'tiles' },
      h('a', { class: 'tile', href: '#/charts/weight', 'data-tile': 'weight' }, h('span', null, 'Вес'), h('b', null, o.weight ? nf(o.weight) : '—'),
        h('small', null, o.bmi ? `ИМТ ${nf(o.bmi)}, ${o.bmiLabel}` : 'укажите рост')),
      h('a', { class: 'tile', href: '#/charts/activity', 'data-tile': 'steps' }, h('span', null, 'Шаги'), h('b', null, vals.activity ? nf(vals.activity.v1, 0) : '—'),
        h('small', null, stepsGoal ? `цель ${nf(stepsGoal.target, 0)}` : 'за сегодня')),
      h('a', { class: 'tile', href: '#/charts/sleep', 'data-tile': 'sleep' }, h('span', null, 'Сон'), h('b', null, vals.sleep ? `${nf(vals.sleep.v1)} ч` : '—'),
        h('small', null, vals.sleep?.v2 ? `качество ${vals.sleep.v2}/5` : 'прошлой ночью'))),
    entryForm(o.today, o.today, vals, reload),
    o.doses.length ? h('section', { class: 'card', id: 'doses' }, h('h2', null, 'Лекарства сегодня'), h('div', null, o.doses.map(d => doseRow(d, reload)))) : null,
    o.goals.length ? h('section', { class: 'card', id: 'goals' }, h('div', { class: 'row between' }, h('h2', null, 'Цели'), h('a', { class: 'small', href: '#/more/goals' }, 'Изменить')), o.goals.map(goalRow))
      : h('a', { class: 'card plain', href: '#/more/goals' }, h('h2', null, 'Поставьте цель'), h('p', { class: 'muted' }, 'Вес, шаги или сон. Тонус сообщит, когда цель будет достигнута.')),
    o.bookings.length ? h('section', { class: 'card', id: 'bookings' }, h('h2', null, 'Ближайшие тренировки'),
      o.bookings.map(b => h('p', null, h('strong', null, `${dateShort(b.day)}, ${b.time}`), ` · ${b.kind}, тренер ${b.trainerName}`))) : null);
}

// ---------- Клиент и специалист: графики ----------

function compareTiles(metric, d) {
  const ch = fmtChange(metric, d.change);
  return h('div', { class: 'compare', 'data-compare': metric },
    h('div', { class: 'tile' }, h('span', null, 'Последнее'), h('b', null, d.last ? fmtValue(metric, d.last) : '—'), h('small', null, d.last ? dateShort(d.last.day) : 'нет записей')),
    h('div', { class: 'tile', 'data-avg': '' }, h('span', null, `Среднее за ${d.days} дн.`), h('b', null, d.avg ? fmtValue(metric, d.avg) : '—'), h('small', null, `с ${dateShort(d.from)}`)),
    h('div', { class: 'tile' }, h('span', null, `Прошлые ${d.days} дн.`), h('b', null, d.prevAvg ? fmtValue(metric, d.prevAvg) : '—'), h('small', null, 'среднее')),
    h('div', { class: 'tile', 'data-change': '' }, h('span', null, 'Изменение'), h('b', { class: `trend ${ch.dir}` }, ch.text), h('small', null, ch.empty ? 'не с чем сравнить' : 'по средним')));
}

function legend(metric) {
  if (metric !== 'pressure') return null;
  const item = (color, label) => { const i = h('i'); i.style.setProperty('background', color); return h('span', null, i, label); };
  return h('div', { class: 'legend' }, item(COLORS.pressure[0], 'верхнее'), item(COLORS.pressure[1], 'нижнее'), h('span', null, 'пунктир — 140/90'));
}

async function viewCharts(page, metricArg, daysArg) {
  const metric = S.meta.metrics[metricArg] ? metricArg : 'weight';
  const days = S.meta.periods.includes(Number(daysArg)) ? Number(daysArg) : 30;
  const d = await api('GET', `/metrics/${metric}?days=${days}`);
  const def = S.meta.metrics[metric];
  clear(page,
    h('h1', null, 'Графики'),
    h('nav', { class: 'metric-chips', 'aria-label': 'Показатель' }, Object.entries(S.meta.metrics).map(([k, m]) =>
      h('a', { class: k === metric ? 'active' : '', href: `#/charts/${k}/${days}`, 'data-metric': k }, m.name))),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Период' }, S.meta.periods.map(p =>
      h('a', { class: p === days ? 'active' : '', href: `#/charts/${metric}/${p}`, 'data-days': p }, `${p} дней`))),
    h('section', { class: 'card', id: 'chart' }, h('div', { class: 'row between' }, h('h2', null, `${def.name}, ${def.unit}`), d.goal !== null ? h('span', { class: 'chip chip-ok' }, `цель ${nf(d.goal, metric === 'activity' ? 0 : 1)}`) : null),
      legend(metric), chart({ metric, def, points: d.points, from: d.from, days, goal: d.goal })),
    compareTiles(metric, d),
    d.points.length ? h('section', { class: 'card' }, h('h2', null, 'Записи'), h('div', { class: 'history' }, d.points.slice().reverse().slice(0, 14).map(p =>
      h('div', { class: 'history-row' }, h('span', { class: 'muted' }, dateLong(p.day)), h('strong', null, fmtValue(metric, p)))))) : null);
}

// ---------- Анализы ----------

function fileLink(f) {
  const url = `/api/v1/files/${f.id}`;
  if (f.type === 'application/pdf') return h('a', { class: 'file-link', href: url, download: f.name, 'data-file': f.id }, `PDF: ${f.name}`);
  return h('button', {
    class: 'file-link', type: 'button', 'data-file': f.id,
    onclick: () => {
      const dlg = openDialog(h('div', { class: 'stack' }, h('img', { class: 'photo-full', src: url, alt: f.name }),
        h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Закрыть'))), { className: 'dialog-photo' });
    },
  }, f.example ? 'Бланк анализа (пример)' : f.name);
}

async function uploadFile(labId, input, reload) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) { toast('Подходят только PDF, JPG и PNG', 'error'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Файл больше 5 МБ', 'error'); return; }
  await guard(async () => {
    let res;
    try {
      res = await fetch(`/api/v1/labs/${labId}/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file, credentials: 'same-origin' });
    } catch { throw new ApiError(0, 'network', 'Нет связи. Файл не отправлен, попробуйте ещё раз.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error?.code, data.error?.message || 'Не удалось загрузить файл');
    toast('Файл приложен', 'ok');
    await reload();
  });
}

const labNum = (code, v) => {
  const digits = S.meta.labs[code]?.step < 1 ? 1 : 0;
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
};

function labValue(v) {
  return h('div', { class: 'lab-value', 'data-code': v.code },
    h('div', { class: 'lab-head' }, h('span', { class: 'field-label' }, v.name),
      v.verdict ? h('span', { class: `chip chip-${v.verdict.level}`, 'data-level': v.verdict.level }, v.verdict.label) : null),
    h('div', { class: 'row' }, h('span', { class: 'lab-num' }, labNum(v.code, v.value)), h('span', { class: 'muted' }, v.unit),
      v.prev !== null && v.prev !== v.value ? h('span', { class: 'muted small' }, `было ${labNum(v.code, v.prev)}`) : null),
    v.verdict ? h('p', { class: 'lab-text' }, v.verdict.text) : null);
}

function labCard(l, { own = false, uploads = false, reload } = {}) {
  let control = null;
  if (own && uploads) {
    const input = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png', hidden: true, 'data-file-input': l.id, onchange: e => uploadFile(l.id, e.target, reload) });
    control = h('label', { class: 'btn' }, input, 'Приложить файл');
  } else if (own && !l.files.length) {
    control = h('p', { class: 'muted small' }, 'В демо файлы не прикладываются: настоящие медицинские документы на демо-сервер не отправляем.');
  }
  return h('article', { class: 'card', 'data-lab': l.id },
    h('div', { class: 'row between top-row' }, h('h2', null, `Анализ от ${dateLong(l.day)}`),
      own ? h('button', {
        class: 'btn btn-ghost', type: 'button', 'data-delete-lab': l.id,
        onclick: async () => {
          if (!await confirmDialog('Удалить этот анализ вместе с файлами?', 'Удалить')) return;
          await guard(async () => { await api('DELETE', `/labs/${l.id}`); await reload(); });
        },
      }, 'Удалить') : null),
    l.note ? h('p', { class: 'muted small' }, l.note) : null,
    h('div', null, l.values.map(labValue)),
    l.files.length ? h('div', { class: 'files' }, l.files.map(fileLink)) : null,
    control);
}

function labDialog(reload) {
  const day = h('input', { type: 'date', name: 'lab-day', value: S.meta.today, max: S.meta.today, required: true });
  const inputs = Object.entries(S.meta.labs).map(([code, t]) => [code, t, h('input', { name: `lab-${code}`, inputmode: 'decimal', autocomplete: 'off', placeholder: '—' })]);
  const note = h('input', { name: 'lab-note', maxlength: 300, placeholder: 'Например: сдавала в клинике у дома' });
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const values = {};
        for (const [code, , input] of inputs) if (input.value.trim()) values[code] = input.value.trim().replace(',', '.');
        await api('POST', '/labs', { day: day.value, values, note: note.value });
        dlg.close();
        toast('Анализ сохранён, подсказки готовы', 'ok');
        await reload();
      });
    },
  }, h('h2', null, 'Новый анализ'), h('p', { class: 'muted small' }, 'Перенесите цифры из бланка. Можно внести не все три.'), demoNote(),
  field('Дата сдачи', day), inputs.map(([, t, input]) => field(`${t.name}, ${t.unit}`, input)), field('Комментарий', note),
  dialogButtons('Сохранить')));
}

async function viewLabs(page) {
  const reload = () => guard(() => viewLabs(page));
  const d = await api('GET', '/labs');
  const needSex = !d.sex && d.labs.some(l => l.values.some(v => v.verdict?.level === 'unknown'));
  clear(page,
    h('div', { class: 'row between' }, h('h1', null, 'Анализы'), h('button', { class: 'btn btn-primary', type: 'button', id: 'new-lab', onclick: () => labDialog(reload) }, 'Внести анализ')),
    h('p', { class: 'disclaimer' }, d.disclaimer),
    needSex ? h('a', { class: 'note plain', href: '#/more/profile' }, 'Укажите пол в профиле: от него зависит норма гемоглобина.') : null,
    d.labs.length ? h('div', { class: 'list' }, d.labs.map(l => labCard(l, { own: true, uploads: d.uploads, reload })))
      : h('div', { class: 'empty' }, h('strong', null, 'Анализов пока нет'), 'Внесите глюкозу, холестерин и гемоглобин из бланка, и программа подскажет, что они значат.'));
}

// ---------- Клиент: специалисты, запросы, тренировки ----------

function requestCard(r, viewer, reload) {
  const forClient = viewer === 'client';
  const head = forClient ? `${KIND[r.kind]}: ${r.specialist.name}` : `${KIND[r.kind]}: ${r.client.name}`;
  const card = h(forClient ? 'article' : 'a', { class: `card ${forClient ? '' : 'plain'}`, 'data-request': r.id, href: forClient ? null : `#/request/${r.id}` },
    h('div', { class: 'row between top-row' }, h('h2', null, head), statusChip(r.status)),
    h('p', { class: `muted small ${forClient ? '' : 'clamp'}` }, `${stamp(r.createdAt)}. ${r.message}`),
    forClient && r.answer ? h('div', { class: 'answer' }, rich(r.answer)) : null,
    forClient && ['new', 'work'].includes(r.status) ? h('button', {
      class: 'btn btn-ghost', type: 'button', 'data-cancel-request': r.id,
      onclick: async () => {
        if (!await confirmDialog('Отменить запрос?', 'Отменить запрос')) return;
        await guard(async () => { await api('PATCH', `/requests/${r.id}`, { status: 'cancelled' }); await reload(); });
      },
    }, 'Отменить запрос') : null);
  return card;
}

function askDialog(role, specialists, reload) {
  const list = specialists.filter(s => s.role === role);
  if (!list.length) { toast('Сейчас нет свободных специалистов', 'error'); return; }
  const who = select(list.map(s => [s.id, s.title ? `${s.name}, ${s.title.toLowerCase()}` : s.name]), list[0].id, { name: 'ask-who' });
  const message = h('textarea', {
    name: 'ask-message', maxlength: 1000, rows: 4, required: true,
    placeholder: role === 'nutritionist' ? 'Цель, ограничения в еде, аллергии, сколько раз в день удобно есть' : 'Что беспокоит, какие анализы посмотреть',
  });
  const consent = checkbox('ask-consent', 'Открываю специалисту свои показатели, анализы и файлы анализов. Доступ можно закрыть в любой момент.');
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        await api('POST', '/requests', { specialistId: Number(who.value), message: message.value, consent: consent.input.checked });
        dlg.close();
        toast('Запрос отправлен', 'ok');
        await reload();
      });
    },
  }, h('h2', null, role === 'nutritionist' ? 'Меню от нутрициолога' : 'Врач посмотрит анализы'),
  field(ROLE[role], who), field('Сообщение', message), consent.el, dialogButtons('Отправить')));
}

function bookDialog(slot, reload) {
  const consent = checkbox('book-consent', `Тренер ${slot.trainer.name} увидит мои шаги, вес и пульс. Доступ можно закрыть в любой момент.`);
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        await api('POST', `/slots/${slot.id}/book`, { consent: consent.input.checked });
        dlg.close();
        toast('Вы записаны', 'ok');
        await reload();
      });
    },
  }, h('h2', null, slot.kind), h('p', null, `${dateWeek(slot.day)}, ${slot.time}, ${slot.minutes} мин`), consent.el, dialogButtons('Записаться')), { className: 'dialog-small' });
}

function groupByDay(slots) {
  const out = [];
  for (const s of slots) {
    let g = out.at(-1);
    if (!g || g.day !== s.day) { g = { day: s.day, slots: [] }; out.push(g); }
    g.slots.push(s);
  }
  return out;
}

function clientSlot(s, reload) {
  let action;
  if (s.mine) {
    action = h('button', {
      class: 'btn', type: 'button', 'data-unbook': s.id,
      onclick: async () => {
        if (!await confirmDialog(`Отменить запись: ${s.kind}, ${dateShort(s.day)} в ${s.time}?`, 'Отменить запись')) return;
        await guard(async () => { await api('DELETE', `/slots/${s.id}/book`); toast('Запись отменена'); await reload(); });
      },
    }, 'Отменить запись');
  } else if (!s.free) action = h('span', { class: 'chip' }, 'Мест нет');
  else action = h('button', { class: 'btn btn-primary', type: 'button', 'data-book': s.id, onclick: () => bookDialog(s, reload) }, 'Записаться');
  return h('article', { class: `card slot ${!s.free && !s.mine ? 'slot-full' : ''}`, 'data-slot': s.id },
    h('span', { class: 'slot-time' }, s.time),
    h('div', { class: 'slot-body' }, h('strong', null, s.kind), h('p', { class: 'muted small' }, `${s.minutes} мин · ${s.trainer.name} · свободно ${s.free} из ${s.capacity}`),
      s.mine ? h('span', { class: 'chip chip-ok' }, 'Вы записаны') : null, h('div', { class: 'row' }, action)));
}

async function viewExperts(page) {
  const reload = () => guard(() => viewExperts(page));
  const [{ requests }, { specialists }, { slots }, { access }] = await Promise.all([
    api('GET', '/requests'), api('GET', '/specialists'), api('GET', '/slots'), api('GET', '/access'),
  ]);
  const scopeText = a => (a.scope.labs ? 'видит показатели и анализы' : 'видит шаги, вес и пульс');
  clear(page,
    h('h1', null, 'Эксперты'),
    h('div', { class: 'two' },
      h('button', { class: 'btn', type: 'button', 'data-ask': 'nutritionist', onclick: () => askDialog('nutritionist', specialists, reload) }, 'Меню от нутрициолога'),
      h('button', { class: 'btn', type: 'button', 'data-ask': 'doctor', onclick: () => askDialog('doctor', specialists, reload) }, 'Врач посмотрит анализы')),
    h('h2', { class: 'section-title' }, 'Мои запросы'),
    requests.length ? h('div', { class: 'list', id: 'my-requests' }, requests.map(r => requestCard(r, 'client', reload)))
      : h('p', { class: 'muted' }, 'Запросов пока нет. Специалист увидит ваши данные только после вашего запроса.'),
    h('h2', { class: 'section-title' }, 'Запись к тренеру'),
    slots.length ? h('div', { class: 'list', id: 'slots' }, groupByDay(slots).map(g => [h('p', { class: 'day-head' }, capital(dateWeek(g.day))), g.slots.map(s => clientSlot(s, reload))]))
      : h('p', { class: 'muted' }, 'Ближайших тренировок нет.'),
    h('h2', { class: 'section-title' }, 'Кому открыт доступ'),
    access.length ? h('section', { class: 'card', id: 'access' }, access.map(a => h('div', { class: 'person', 'data-access': a.id },
      h('div', null, h('strong', null, a.name), h('p', { class: 'muted small' }, `${ROLE[a.role]}, ${scopeText(a)}`)),
      h('button', {
        class: 'btn btn-ghost', type: 'button', 'data-revoke': a.id,
        onclick: async () => {
          if (!await confirmDialog(`Закрыть доступ для ${a.name}? Специалист больше не увидит ваши данные, открытые запросы к нему отменятся.`, 'Закрыть доступ')) return;
          await guard(async () => { await api('DELETE', `/access/${a.id}`); toast('Доступ закрыт'); await reload(); });
        },
      }, 'Закрыть доступ'))))
      : h('p', { class: 'muted' }, 'Ваши данные не видит никто, кроме вас.'));
}

// ---------- Специалист ----------

async function clientData(clientId) {
  const d = await api('GET', `/clients/${clientId}`);
  const c = d.client;
  const facts = [c.sex ? (c.sex === 'f' ? 'женщина' : 'мужчина') : null, c.age ? `${c.age} лет` : null, c.heightCm ? `рост ${nf(c.heightCm, 0)} см` : null,
    c.bmi ? `ИМТ ${nf(c.bmi)}, ${c.bmiLabel}` : null].filter(Boolean).join(', ');
  return h('div', { class: 'stack', 'data-client-data': c.id },
    h('section', { class: 'card' }, h('h2', null, c.name), h('p', { class: 'muted' }, facts || 'Профиль не заполнен'),
      h('p', { class: 'muted small' }, d.scope.labs ? 'Клиент открыл вам показатели и анализы.' : 'Клиент открыл вам шаги, вес и пульс.')),
    d.labs ? [h('h2', { class: 'section-title' }, 'Анализы'), h('p', { class: 'disclaimer' }, d.disclaimer),
      d.labs.length ? h('div', { class: 'list' }, d.labs.map(l => labCard(l))) : h('p', { class: 'muted' }, 'Анализов нет.')] : null,
    h('h2', { class: 'section-title' }, 'Показатели за 30 дней'),
    h('div', { class: 'list' }, d.summaries.map(sm => {
      const def = S.meta.metrics[sm.metric];
      const ch = fmtChange(sm.metric, sm.change);
      return h('section', { class: 'card mini', 'data-summary': sm.metric },
        h('div', { class: 'row between' }, h('h3', null, def.name), h('span', { class: 'muted small' }, sm.last ? `последнее ${fmtValue(sm.metric, sm.last)}` : 'нет записей')),
        chart({ metric: sm.metric, def, points: sm.points, from: sm.from, days: 30, goal: sm.goal, mini: true }),
        h('p', { class: 'muted small' }, `Среднее ${sm.avg ? fmtValue(sm.metric, sm.avg) : '—'}, к прошлому месяцу: ${ch.text}`));
    })));
}

async function viewRequests(page, filter = 'new') {
  const { requests } = await api('GET', '/requests');
  const groups = { new: requests.filter(r => r.status === 'new'), work: requests.filter(r => r.status === 'work'), closed: requests.filter(r => !['new', 'work'].includes(r.status)) };
  const labels = { new: 'Новые', work: 'В работе', closed: 'Закрытые' };
  const list = groups[filter] || groups.new;
  clear(page,
    h('h1', null, 'Запросы'),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Статус' }, Object.entries(labels).map(([k, label]) =>
      h('a', { class: k === filter ? 'active' : '', href: `#/requests/${k}`, 'data-filter': k }, `${label} ${groups[k].length}`))),
    list.length ? h('div', { class: 'list' }, list.map(r => requestCard(r, 'specialist')))
      : h('div', { class: 'empty' }, h('strong', null, 'Здесь пусто'), filter === 'new' ? 'Новые запросы клиентов появятся здесь.' : 'Запросов с таким статусом нет.'));
}

function rejectDialog(r, reload) {
  const reason = h('textarea', { name: 'reject-reason', rows: 3, maxlength: 1000, placeholder: 'Например: нужен очный приём' });
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => { await api('PATCH', `/requests/${r.id}`, { status: 'rejected', answer: reason.value }); dlg.close(); toast('Запрос отклонён'); await reload(); });
    },
  }, h('h2', null, 'Отклонить запрос'), field('Причина для клиента', reason), dialogButtons('Отклонить')), { className: 'dialog-small' });
}

async function viewRequest(page, id) {
  const reload = () => guard(() => viewRequest(page, id));
  const { request: r } = await api('GET', `/requests/${id}`);
  const open = ['new', 'work'].includes(r.status);
  let actions = null;
  if (open && r.access) {
    const answer = h('textarea', { name: 'answer', rows: r.kind === 'menu' ? 14 : 6, maxlength: 5000, value: r.kind === 'menu' ? MENU_TEMPLATE : '', placeholder: 'Ответ клиенту' });
    actions = h('form', {
      class: 'card stack', id: 'answer-form',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => { await api('PATCH', `/requests/${r.id}`, { status: 'done', answer: answer.value }); toast('Ответ отправлен клиенту', 'ok'); await reload(); });
      },
    }, h('h2', null, r.kind === 'menu' ? 'Меню для клиента' : 'Заключение'),
    r.kind === 'menu' ? h('p', { class: 'muted small' }, '«## » начинает подзаголовок, «- » пункт списка.') : null,
    answer,
    h('div', { class: 'row' },
      r.status === 'new' ? h('button', {
        class: 'btn', type: 'button', id: 'take-request',
        onclick: () => guard(async () => { await api('PATCH', `/requests/${r.id}`, { status: 'work' }); toast('Запрос в работе'); await reload(); }),
      }, 'Взять в работу') : null,
      h('button', { class: 'btn btn-primary', type: 'submit', id: 'send-answer' }, 'Отправить ответ'),
      h('button', { class: 'btn btn-ghost', type: 'button', id: 'reject-request', onclick: () => rejectDialog(r, reload) }, 'Отклонить')));
  }
  clear(page,
    h('a', { class: 'back', href: '#/requests' }, '← К запросам'),
    h('div', { class: 'row between top-row' }, h('h1', null, `${KIND[r.kind]}: ${r.client.name}`), statusChip(r.status)),
    h('section', { class: 'card' }, h('p', { class: 'muted small' }, `Запрос от ${stamp(r.createdAt)}`), h('p', { class: 'pre' }, r.message)),
    !r.access ? h('p', { class: 'note', id: 'no-access' }, 'Клиент закрыл доступ к своим данным. Ответить на запрос нельзя.') : null,
    r.answer ? h('section', { class: 'card' }, h('h2', null, r.status === 'rejected' ? 'Причина отказа' : 'Ваш ответ'), rich(r.answer)) : null,
    actions,
    r.access ? await clientData(r.client.id) : null);
}

async function viewClients(page) {
  const { clients } = await api('GET', '/clients');
  clear(page,
    h('h1', null, 'Клиенты'),
    h('p', { class: 'muted' }, S.user.role === 'trainer' ? 'Те, кто записался к вам на тренировку. Вы видите их шаги, вес и пульс.' : 'Те, кто открыл вам данные через запрос.'),
    clients.length ? h('div', { class: 'list' }, clients.map(c => h('a', { class: 'card plain', href: `#/client/${c.id}`, 'data-client': c.id },
      h('div', { class: 'row between top-row' }, h('h2', null, c.name), c.openRequests ? h('span', { class: 'chip chip-accent' }, `Открытых запросов: ${c.openRequests}`) : null),
      h('p', { class: 'muted small' }, [c.sex ? (c.sex === 'f' ? 'женщина' : 'мужчина') : null, c.age ? `${c.age} лет` : null, `доступ с ${stamp(c.grantedAt)}`].filter(Boolean).join(', ')))))
      : h('div', { class: 'empty' }, h('strong', null, 'Клиентов пока нет'), 'Клиент появится здесь, когда откроет вам доступ.'));
}

async function viewClient(page, id) {
  const data = await clientData(id);
  clear(page, h('a', { class: 'back', href: '#/clients' }, '← К клиентам'), data);
}

function slotDialog(reload) {
  const day = h('input', { type: 'date', name: 'slot-day', value: shift(S.meta.today, 1), min: S.meta.today, required: true });
  const time = h('input', { type: 'time', name: 'slot-time', value: '19:00', required: true });
  const minutes = h('input', { name: 'slot-minutes', inputmode: 'numeric', value: '60' });
  const capacity = h('input', { name: 'slot-capacity', inputmode: 'numeric', value: '6' });
  const kind = h('input', { name: 'slot-kind', maxlength: 60, required: true, list: 'slot-kinds', placeholder: 'Например: Йога для спины' });
  const kinds = h('datalist', { id: 'slot-kinds' }, ['Функциональная тренировка', 'Йога для спины', 'Силовая в мини-группе', 'Растяжка', 'Персональная тренировка'].map(k => h('option', { value: k })));
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        await api('POST', '/slots', { day: day.value, time: time.value, minutes: Number(minutes.value), capacity: Number(capacity.value), kind: kind.value });
        dlg.close();
        toast('Тренировка добавлена', 'ok');
        await reload();
      });
    },
  }, h('h2', null, 'Новая тренировка'), field('Тренировка', kind), kinds, h('div', { class: 'two' }, field('Дата', day), field('Время', time)),
  h('div', { class: 'two' }, field('Минут', minutes), field('Мест', capacity)), dialogButtons('Добавить')));
}

async function viewSchedule(page) {
  const reload = () => guard(() => viewSchedule(page));
  const { slots } = await api('GET', '/slots');
  clear(page,
    h('div', { class: 'row between' }, h('h1', null, 'Расписание'), h('button', { class: 'btn btn-primary', type: 'button', id: 'new-slot', onclick: () => slotDialog(reload) }, 'Добавить')),
    slots.length ? h('div', { class: 'list' }, groupByDay(slots).map(g => [h('p', { class: 'day-head' }, capital(dateWeek(g.day))), g.slots.map(s =>
      h('article', { class: 'card slot', 'data-slot': s.id },
        h('span', { class: 'slot-time' }, s.time),
        h('div', { class: 'slot-body' }, h('strong', null, s.kind),
          h('p', { class: 'muted small' }, `${s.minutes} мин · записано ${s.taken} из ${s.capacity}`),
          s.taken ? h('div', { class: 'row chips' }, s.clients.map(c => h('a', { class: 'chip chip-accent plain', href: `#/client/${c.id}` }, c.name))) : null,
          h('div', { class: 'row' }, h('button', {
            class: 'btn btn-ghost', type: 'button', 'data-cancel-slot': s.id,
            onclick: async () => {
              if (!await confirmDialog(`Отменить «${s.kind}» ${dateShort(s.day)} в ${s.time}?${s.taken ? ' Записанные клиенты получат уведомление.' : ''}`, 'Отменить тренировку')) return;
              await guard(async () => { await api('DELETE', `/slots/${s.id}`); toast('Тренировка отменена'); await reload(); });
            },
          }, 'Отменить')))))]))
      : h('div', { class: 'empty' }, h('strong', null, 'Расписание пустое'), 'Добавьте тренировку, и клиенты смогут записаться.'));
}

// ---------- Материалы и статьи ----------

function materialCard(m, { editor = false } = {}) {
  return h('a', { class: 'card plain mat', href: `#/m/${m.id}`, 'data-material': m.id },
    h('span', { class: 'kind' }, m.kind === 'article' ? SECTION[m.section] : MAT_KIND[m.kind]),
    h('h3', null, m.title),
    m.summary ? h('p', { class: 'muted small clamp' }, m.summary) : null,
    editor && !m.published ? h('span', { class: 'chip' }, 'Черновик') : null,
    m.authorName && m.kind === 'article' ? h('p', { class: 'muted small' }, m.authorName) : null);
}

function materialsBlock(materials) {
  const by = f => materials.filter(f);
  const block = (title, list, id) => (list.length ? [h('h2', { class: 'section-title', id }, title), h('div', { class: 'mat-grid' }, list.map(m => materialCard(m)))] : null);
  return [
    block('Пробное меню', by(m => m.kind === 'menu'), 'free-menu'),
    block('Уроки по питанию', by(m => m.kind === 'lesson' && m.section === 'food'), 'free-food'),
    block('Уроки по тренировкам', by(m => m.kind === 'lesson' && m.section === 'training'), 'free-training'),
    block('Статьи', by(m => m.kind === 'article'), 'free-articles'),
  ];
}

async function viewMaterials(page) {
  const { materials } = await api('GET', '/public/materials');
  clear(page, h('h1', null, 'Бесплатные материалы'), h('p', { class: 'muted' }, 'Открыты всем, без регистрации.'), materialsBlock(materials));
}

async function viewMaterial(page, id) {
  const { material: m, canEdit } = await api('GET', `/public/materials/${id}`);
  clear(page,
    h('a', { class: 'back', href: S.user ? '#/materials' : '#/' }, '← Ко всем материалам'),
    h('article', { class: 'card', 'data-material-page': m.id },
      h('span', { class: 'kind' }, m.kind === 'article' ? `Статья · ${SECTION[m.section]}` : MAT_KIND[m.kind]),
      h('h1', null, m.title),
      m.summary ? h('p', { class: 'muted' }, m.summary) : null,
      m.authorName && m.kind === 'article' ? h('p', { class: 'small' }, `Автор: ${m.authorName}`) : null,
      !m.published ? h('p', { class: 'note' }, 'Черновик: посетители его не видят.') : null,
      rich(m.body),
      m.videoUrl ? h('a', { class: 'btn', href: m.videoUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Смотреть видео') : null,
      canEdit ? h('a', { class: 'btn', href: `#/article/${m.id}`, id: 'edit-material' }, 'Изменить') : null));
}

async function viewArticles(page) {
  const { materials } = await api('GET', '/materials/mine');
  const admin = S.user.role === 'admin';
  const group = (title, list) => (list.length ? [h('h2', { class: 'section-title' }, title), h('div', { class: 'list' }, list.map(m => materialCard(m, { editor: true })))] : null);
  clear(page,
    h('div', { class: 'row between' }, h('h1', null, admin ? 'Материалы' : 'Мои статьи'), h('a', { class: 'btn btn-primary', href: '#/article/new', id: 'new-article' }, admin ? 'Добавить' : 'Новая статья')),
    admin ? h('p', { class: 'muted' }, 'Пробное меню, уроки и статьи. Всё опубликованное открыто без регистрации.') : h('p', { class: 'muted' }, 'Опубликованные статьи видят все посетители сайта.'),
    materials.length ? (admin
      ? [group('Пробное меню', materials.filter(m => m.kind === 'menu')), group('Уроки', materials.filter(m => m.kind === 'lesson')), group('Статьи', materials.filter(m => m.kind === 'article'))]
      : h('div', { class: 'list' }, materials.map(m => materialCard(m, { editor: true }))))
      : h('div', { class: 'empty' }, h('strong', null, 'Статей пока нет'), 'Напишите первую: клиенты увидят её без регистрации.'));
}

async function viewEditor(page, id) {
  const admin = S.user.role === 'admin';
  const m = id && id !== 'new' ? (await api('GET', `/public/materials/${id}`)).material : null;
  const kind = select(Object.entries(MAT_KIND), m?.kind || 'article', { name: 'mat-kind' });
  const section = select(Object.entries(SECTION), m?.section || 'general', { name: 'mat-section' });
  const title = h('input', { name: 'mat-title', maxlength: 150, required: true, value: m?.title || '' });
  const summary = h('input', { name: 'mat-summary', maxlength: 300, value: m?.summary || '' });
  const body = h('textarea', { name: 'mat-body', rows: 14, maxlength: 20000, required: true, value: m?.body || '' });
  const video = h('input', { name: 'mat-video', maxlength: 300, value: m?.videoUrl || '', placeholder: 'https://…' });
  const published = checkbox('mat-published', 'Опубликовать: видно всем без регистрации');
  published.input.checked = m ? m.published : true;
  clear(page,
    h('a', { class: 'back', href: '#/articles' }, '← Назад'),
    h('h1', null, m ? 'Изменить материал' : admin ? 'Новый материал' : 'Новая статья'),
    h('form', {
      class: 'card stack', id: 'editor',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => {
          const b = { section: section.value, title: title.value, summary: summary.value, body: body.value, videoUrl: video.value, published: published.input.checked };
          if (admin) b.kind = kind.value;
          const r = m ? await api('PATCH', `/materials/${m.id}`, b) : await api('POST', '/materials', b);
          toast('Сохранено', 'ok');
          location.hash = `/m/${r.material.id}`;
        });
      },
    },
    admin ? field('Тип', kind) : null, field('Раздел', section), field('Заголовок', title), field('Кратко', summary, 'Одно-два предложения для карточки'),
    field('Текст', body, 'Пустая строка — новый абзац. «## » — подзаголовок. «- » — пункт списка.'), field('Видео', video, 'Ссылка на ролик во внешнем сервисе, необязательно'),
    published.el,
    h('div', { class: 'row between' },
      m ? h('button', {
        class: 'btn btn-danger', type: 'button', id: 'delete-material',
        onclick: async () => {
          if (!await confirmDialog(`Удалить «${m.title}»?`, 'Удалить')) return;
          await guard(async () => { await api('DELETE', `/materials/${m.id}`); toast('Удалено'); location.hash = '/articles'; });
        },
      }, 'Удалить') : h('span'),
      h('button', { class: 'btn btn-primary', type: 'submit', id: 'save-material' }, 'Сохранить'))));
}

// ---------- Администратор ----------

function inviteDialog() {
  const name = h('input', { name: 'name', required: true, maxlength: 80 });
  const role = select(['doctor', 'nutritionist', 'trainer', 'admin'].map(r => [r, ROLE[r]]), 'doctor', { name: 'role' });
  const box = h('div', { class: 'stack', hidden: true });
  const form = h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const r = await api('POST', '/people/invites', { name: name.value, role: role.value });
        form.hidden = true;
        box.hidden = false;
        clear(box, h('h2', null, 'Ссылка готова'), h('p', { class: 'muted' }, 'Отправьте её специалисту. Работает один раз, 7 дней.'),
          h('input', { readonly: true, value: `${location.origin}/#/invite/${r.token}`, 'aria-label': 'Ссылка-приглашение' }),
          h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); render(); } }, 'Готово')));
      });
    },
  }, h('h2', null, 'Пригласить специалиста'), field('Имя и фамилия', name), field('Роль', role),
  h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Создать ссылку')));
  const dlg = openDialog(h('div', null, form, box));
}

async function viewPeople(page) {
  const { people } = await api('GET', '/people');
  const change = (p, active) => guard(async () => { await api('PATCH', `/people/${p.id}`, { active }); toast('Сохранено', 'ok'); render(); });
  clear(page,
    h('div', { class: 'row between' }, h('h1', null, 'Люди'), S.meta.demo ? null : h('button', { class: 'btn btn-primary', type: 'button', id: 'invite', onclick: inviteDialog }, 'Пригласить')),
    h('p', { class: 'muted' }, 'Администратор видит учётные записи, но не данные о здоровье клиентов.'),
    S.meta.demo ? h('p', { class: 'note note-calm' }, 'В демо состав не меняется.') : null,
    h('div', { class: 'list' }, people.map(p => h('article', { class: `card person ${p.active ? '' : 'off'}`, 'data-person': p.id },
      h('div', null, h('strong', null, p.name), h('p', { class: 'muted small' }, [ROLE[p.role], p.title, p.active ? null : 'отключён'].filter(Boolean).join(' · '))),
      S.meta.demo || p.id === S.user.id ? null : h('button', {
        class: 'btn btn-ghost', type: 'button',
        onclick: async () => {
          if (p.active && !await confirmDialog(`Отключить ${p.name}? Вход сразу перестанет работать.`, 'Отключить')) return;
          change(p, !p.active);
        },
      }, p.active ? 'Отключить' : 'Вернуть')))));
}

// ---------- Ещё: цели, лекарства, профиль ----------

async function viewMore(page) {
  const client = S.user.role === 'client';
  clear(page,
    h('section', { class: 'card' }, h('h1', null, S.user.name), h('p', { class: 'muted' }, ROLE[S.user.role])),
    h('nav', { class: 'card menu-list', 'aria-label': 'Ещё' },
      client ? h('a', { href: '#/more/goals', 'data-more': 'goals' }, 'Цели') : null,
      client ? h('a', { href: '#/more/meds', 'data-more': 'meds' }, 'Лекарства и напоминания') : null,
      h('a', { href: '#/materials', 'data-more': 'materials' }, 'Бесплатные материалы'),
      h('a', { href: '#/notifications', 'data-more': 'notifications' }, 'Уведомления'),
      h('a', { href: '#/more/profile', 'data-more': 'profile' }, 'Профиль')),
    h('button', {
      class: 'btn wide', type: 'button', id: 'logout',
      onclick: () => guard(async () => { await api('POST', '/auth/logout'); S.user = false; location.hash = '/'; render(); }),
    }, 'Выйти'));
}

async function viewGoals(page) {
  const reload = () => guard(() => viewGoals(page));
  const { goals } = await api('GET', '/goals');
  clear(page,
    h('a', { class: 'back', href: '#/more' }, '← Ещё'),
    h('h1', null, 'Цели'),
    h('p', { class: 'muted' }, 'Вес считается по последнему взвешиванию, шаги и сон — по среднему за 7 дней. Когда цель достигнута, придёт уведомление.'),
    Object.entries(S.meta.goals).map(([metric, def]) => {
      const g = goals.find(x => x.metric === metric);
      const target = h('input', { name: `goal-${metric}`, inputmode: 'decimal', value: g ? String(g.target).replace('.', ',') : '', placeholder: metric === 'weight' ? '68' : metric === 'activity' ? '8000' : '7,5' });
      const due = metric === 'weight' ? h('input', { type: 'date', name: 'goal-due', min: shift(S.meta.today, 1), value: g?.dueDay || '' }) : null;
      return h('form', {
        class: 'card stack', 'data-goal-form': metric,
        onsubmit: async e => {
          e.preventDefault();
          await guard(async () => {
            const r = await api('PUT', `/goals/${metric}`, { target: target.value.trim().replace(',', '.'), dueDay: due?.value || null });
            toast('Цель сохранена', 'ok');
            for (const ev of r.events) toast(ev, 'ok');
            await reload();
          });
        },
      }, h('h2', null, def.name), g ? goalRow(g) : h('p', { class: 'muted small' }, 'Цель не задана'),
      h('div', { class: due ? 'two' : '' }, field(`Цель, ${def.unit}`, target), due ? field('К дате', due) : null),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, g ? 'Обновить' : 'Поставить цель'),
        g ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => guard(async () => { await api('DELETE', `/goals/${metric}`); await reload(); }) }, 'Убрать') : null));
    }));
}

function medDialog(med, reload) {
  const name = h('input', { name: 'med-name', maxlength: 80, required: true, value: med?.name || '' });
  const dose = h('input', { name: 'med-dose', maxlength: 60, value: med?.dose || '', placeholder: 'Например: 1 таблетка' });
  const times = h('div', { class: 'times' });
  const addTime = value => {
    if (times.children.length >= 6) return;
    const input = h('input', { type: 'time', value, required: true, 'aria-label': 'Время приёма', name: 'med-time' });
    const line = h('div', { class: 'time-row' }, input, h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Убрать время', onclick: () => { if (times.children.length > 1) line.remove(); } }, '×'));
    times.append(line);
  };
  (med?.times?.length ? med.times : ['09:00']).forEach(addTime);
  const chosen = new Set(med?.days || []);
  const days = h('div', { class: 'days-pick', role: 'group', 'aria-label': 'Дни недели' }, WEEK_ORDER.map(d => h('button', {
    type: 'button', class: chosen.has(d) ? 'on' : '', 'data-day': d, 'aria-pressed': chosen.has(d) ? 'true' : 'false',
    onclick: e => { if (chosen.has(d)) chosen.delete(d); else chosen.add(d); e.currentTarget.classList.toggle('on', chosen.has(d)); e.currentTarget.setAttribute('aria-pressed', chosen.has(d) ? 'true' : 'false'); },
  }, WEEK[d])));
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const body = { name: name.value, dose: dose.value, times: [...times.querySelectorAll('input')].map(i => i.value).filter(Boolean), days: [...chosen] };
        if (med) await api('PATCH', `/meds/${med.id}`, body); else await api('POST', '/meds', body);
        dlg.close();
        toast('Сохранено', 'ok');
        await reload();
      });
    },
  }, h('h2', null, med ? 'Изменить лекарство' : 'Новое лекарство'), field('Название', name), field('Доза', dose),
  h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Время приёма'), times, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => addTime('21:00') }, '+ ещё время')),
  h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Дни недели'), days, h('span', { class: 'field-hint' }, 'Ничего не выбрано — каждый день')),
  dialogButtons('Сохранить')));
}

// ---------- Push ----------

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const urlKey = s => {
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function enablePush(reload) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { toast('Уведомления запрещены в настройках браузера', 'error'); return; }
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('GET', '/push/key');
  let sub;
  try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(key) }); } catch { toast('Этот браузер не смог подключить уведомления', 'error'); return; }
  await api('POST', '/push/subscribe', sub.toJSON());
  toast('Напоминания включены на этом устройстве', 'ok');
  await reload();
}

async function pushBlock(reload) {
  if (isIos() && !standalone()) return h('p', { class: 'muted small' }, 'На iPhone уведомления работают после установки: «Поделиться» → «На экран Домой».');
  if (!('PushManager' in window) || !('Notification' in window)) return h('p', { class: 'muted small' }, 'Этот браузер не поддерживает уведомления. Напоминания будут в колокольчике.');
  const sub = await currentSubscription();
  if (sub) {
    return [h('p', { class: 'small' }, 'Уведомления включены на этом устройстве.'), h('button', {
      class: 'btn', type: 'button', id: 'push-off',
      onclick: () => guard(async () => { await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); toast('Уведомления выключены'); await reload(); }),
    }, 'Выключить')];
  }
  return [h('p', { class: 'muted small' }, S.meta.demo ? 'В демо в уведомлении только общий текст, без названий лекарств.' : 'Напоминания придут, даже если Тонус закрыт.'),
    h('button', { class: 'btn', type: 'button', id: 'push-on', onclick: () => guard(() => enablePush(reload)) }, 'Включить уведомления')];
}

async function viewMeds(page) {
  const reload = () => guard(() => viewMeds(page));
  const [{ meds }, { profile }] = await Promise.all([api('GET', '/meds'), api('GET', '/profile')]);
  const diary = h('input', { type: 'time', name: 'diary-time', value: profile.diaryRemindAt || '' });
  clear(page,
    h('a', { class: 'back', href: '#/more' }, '← Ещё'),
    h('div', { class: 'row between' }, h('h1', null, 'Лекарства'), h('button', { class: 'btn btn-primary', type: 'button', id: 'new-med', onclick: () => medDialog(null, reload) }, 'Добавить')),
    meds.length ? h('div', { class: 'list' }, meds.map(m => h('article', { class: 'card', 'data-med': m.id },
      h('h2', null, m.name),
      h('p', { class: 'muted small' }, [m.dose, m.times.join(', '), m.days.length ? WEEK_ORDER.filter(d => m.days.includes(d)).map(d => WEEK[d]).join(', ') : 'каждый день'].filter(Boolean).join(' · ')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', 'data-edit-med': m.id, onclick: () => medDialog(m, reload) }, 'Изменить'),
        h('button', {
          class: 'btn btn-ghost', type: 'button', 'data-delete-med': m.id,
          onclick: async () => {
            if (!await confirmDialog(`Удалить «${m.name}» и его напоминания?`, 'Удалить')) return;
            await guard(async () => { await api('DELETE', `/meds/${m.id}`); await reload(); });
          },
        }, 'Удалить')))))
      : h('div', { class: 'empty' }, h('strong', null, 'Лекарств нет'), 'Добавьте лекарство, и Тонус напомнит о приёме.'),
    h('form', {
      class: 'card stack', id: 'diary-remind',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => { await api('PATCH', '/profile', { diaryRemindAt: diary.value || null }); toast(diary.value ? `Напомним в ${diary.value}, если дневник пустой` : 'Напоминание выключено', 'ok'); });
      },
    }, h('h2', null, 'Напоминание о дневнике'), field('Время', diary, 'Придёт, только если за день ничего не внесено. Пустое поле — без напоминания.'),
    h('button', { class: 'btn', type: 'submit' }, 'Сохранить')),
    h('section', { class: 'card stack' }, h('h2', null, 'Уведомления на телефоне'), await pushBlock(reload)));
}

async function viewProfile(page) {
  const me = S.user;
  const { profile: p } = await api('GET', '/profile');
  const name = h('input', { name: 'name', value: me.name, maxlength: 80, disabled: S.meta.demo });
  const client = me.role === 'client';
  const sex = select([['', 'Не указан'], ['f', 'Женский'], ['m', 'Мужской']], p.sex || '', { name: 'sex' });
  const year = h('input', { name: 'birth-year', inputmode: 'numeric', value: p.birthYear || '', placeholder: '1990' });
  const height = h('input', { name: 'height', inputmode: 'decimal', value: p.heightCm || '', placeholder: '170' });
  const title = h('input', { name: 'title', maxlength: 120, value: p.title || '' });
  const oldPass = h('input', { name: 'old', type: 'password', autocomplete: 'current-password', disabled: S.meta.demo });
  const newPass = h('input', { name: 'new', type: 'password', autocomplete: 'new-password', minlength: 8, disabled: S.meta.demo });
  clear(page,
    h('a', { class: 'back', href: '#/more' }, '← Ещё'),
    h('h1', null, 'Профиль'),
    S.meta.demo ? h('p', { class: 'note note-calm' }, 'Демо: имя и пароль не меняются, остальное сбросится ночью.') : null,
    h('form', {
      class: 'card stack', id: 'profile-form',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => {
          if (!S.meta.demo && name.value !== me.name) { const r = await api('PATCH', '/me', { name: name.value }); S.user = { ...me, name: r.user.name }; }
          await api('PATCH', '/profile', client ? { sex: sex.value || null, birthYear: year.value || null, heightCm: height.value.replace(',', '.') || null } : { title: title.value });
          toast('Сохранено', 'ok');
        });
      },
    }, field('Имя', name),
    client ? [h('div', { class: 'two' }, field('Пол', sex, 'Нужен для нормы гемоглобина'), field('Год рождения', year)), field('Рост, см', height, 'Нужен для индекса массы тела')]
      : field('Специализация', title, 'Клиенты видят её при выборе специалиста'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить')),
    h('form', {
      class: 'card stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => { await api('POST', '/me/password', { old: oldPass.value, new: newPass.value }); oldPass.value = ''; newPass.value = ''; toast('Пароль изменён', 'ok'); });
      },
    }, h('h2', null, 'Смена пароля'), field('Текущий пароль', oldPass), field('Новый пароль', newPass, 'Минимум 8 символов'),
    h('button', { class: 'btn', type: 'submit', disabled: S.meta.demo }, 'Изменить пароль')),
    client && p.consentAt ? h('p', { class: 'muted small' }, `Согласие на обработку данных о здоровье дано ${stamp(p.consentAt)}.`) : null);
}

async function viewNotifications(page) {
  const { notifications, unread } = await api('GET', '/notifications');
  if (unread) { await api('POST', '/notifications/read'); S.unread = 0; }
  clear(page, h('h1', null, 'Уведомления'),
    notifications.length ? h('div', { class: 'list' }, notifications.map(n => h('a', { class: `card plain notice ${n.read ? '' : 'unread'} notice-${n.kind}`, href: n.link || '#/', 'data-notice': n.kind },
      h('p', null, n.text), h('p', { class: 'muted small' }, stamp(n.createdAt)))))
      : h('div', { class: 'empty' }, h('strong', null, 'Уведомлений нет'), 'Напоминания, ответы специалистов и достигнутые цели появятся здесь.'));
}

// ---------- Без входа: главная, вход, регистрация ----------

function publicShell(content) {
  clear(root, h('div', { class: 'landing' },
    h('header', { class: 'landing-top' }, h('a', { class: 'brand', href: '#/' }, h('img', { src: '/favicon.svg', alt: '', width: 30, height: 30 }), 'Тонус'),
      h('a', { class: 'btn', href: '#/login', id: 'to-login' }, 'Войти')),
    content,
    h('p', { class: 'footer' }, 'Тонус — учебный кейс MyFreeLab. Подсказки по анализам не заменяют консультацию врача.')));
}

function demoRoles() {
  return h('div', { class: 'roles', id: 'demo-roles' }, S.meta.demo ? ['client', 'doctor', 'nutritionist', 'trainer', 'admin'].map(role => h('button', {
    class: 'btn role-btn', type: 'button', 'data-role': role,
    onclick: () => guard(async () => { const r = await api('POST', '/auth/demo', { role }); S.user = r.user; location.hash = `/${homeOf(role)}`; await render(); }),
  }, h('span', null, ROLE[role]), h('small', null, ROLE_HINT[role]))) : null);
}

async function viewLanding() {
  const { materials } = await api('GET', '/public/materials');
  publicShell([
    h('section', { class: 'hero' },
      h('h1', null, 'Здоровье в цифрах и рядом специалисты'),
      h('p', null, 'Дневник показателей, графики, подсказки по анализам, напоминания о лекарствах. Врач, нутрициолог и тренер видят ваши данные только с вашего разрешения.'),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/login' }, S.meta.demo ? 'Открыть демо' : 'Войти'),
        S.meta.demo ? null : h('a', { class: 'btn btn-ghost-light', href: '#/register' }, 'Зарегистрироваться'))),
    S.meta.demo ? h('section', { class: 'stack' }, h('h2', null, 'Демо: войдите в одной из ролей'), h('p', { class: 'muted small' }, 'Люди выдуманные. Изменения видят все посетители, данные сбрасываются раз в сутки.'), demoRoles()) : null,
    h('p', { class: 'muted' }, 'Бесплатно и без регистрации:'),
    materialsBlock(materials),
  ]);
}

function viewLogin() {
  if (S.meta.demo) {
    clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' },
      h('div', { class: 'brand big' }, h('img', { src: '/favicon.svg', alt: '', width: 40, height: 40 }), 'Тонус'),
      h('p', { class: 'muted' }, 'Демо с выдуманными людьми. Войдите в одной из ролей:'), demoRoles(),
      h('a', { class: 'back', href: '#/' }, '← На главную'))));
    return;
  }
  const login = h('input', { name: 'login', autocomplete: 'username', required: true });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' },
    h('div', { class: 'brand big' }, h('img', { src: '/favicon.svg', alt: '', width: 40, height: 40 }), 'Тонус'),
    h('form', {
      class: 'stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => { const r = await api('POST', '/auth/login', { login: login.value, password: password.value }); S.user = r.user; location.hash = `/${homeOf(r.user.role)}`; await render(); });
      },
    }, field('Логин', login), field('Пароль', password), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти')),
    h('a', { class: 'btn btn-ghost', href: '#/register' }, 'Нет аккаунта? Зарегистрироваться'),
    h('a', { class: 'back', href: '#/' }, '← На главную'))));
}

function viewRegister() {
  if (S.meta.demo) { location.hash = '/login'; return; }
  const name = h('input', { name: 'reg-name', required: true, maxlength: 80, autocomplete: 'name' });
  const login = h('input', { name: 'reg-login', required: true, autocomplete: 'username' });
  const password = h('input', { name: 'reg-password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
  const sex = select([['', 'Не указан'], ['f', 'Женский'], ['m', 'Мужской']], '', { name: 'reg-sex' });
  const year = h('input', { name: 'reg-year', inputmode: 'numeric', placeholder: '1990' });
  const height = h('input', { name: 'reg-height', inputmode: 'decimal', placeholder: '170' });
  const consent = checkbox('reg-consent', 'Согласен(на) на обработку моих персональных данных, включая данные о здоровье, для работы дневника и подсказок.');
  clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' },
    h('h2', null, 'Регистрация'),
    h('form', {
      class: 'stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => {
          const r = await api('POST', '/auth/register', {
            name: name.value, login: login.value, password: password.value, sex: sex.value || null,
            birthYear: year.value || null, heightCm: height.value.replace(',', '.') || null, consent: consent.input.checked,
          });
          S.user = r.user;
          location.hash = '/today';
          await render();
        });
      },
    }, field('Имя', name), field('Логин', login, 'Латиница и цифры'), field('Пароль', password, 'Минимум 8 символов'),
    h('div', { class: 'two' }, field('Пол', sex), field('Год рождения', year)), field('Рост, см', height), consent.el,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Создать аккаунт')),
    h('a', { class: 'back', href: '#/login' }, '← Уже есть аккаунт'))));
}

async function viewInvite(token) {
  const info = await api('GET', `/auth/invite/${encodeURIComponent(token)}`).catch(e => e);
  if (info instanceof Error) {
    clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card stack' }, h('h2', null, 'Приглашение не работает'),
      h('p', { class: 'muted' }, info.message), h('a', { class: 'btn', href: '#/' }, 'На главную'))));
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
          location.hash = `/${homeOf(r.user.role)}`;
        });
      },
    }, field('Придумайте логин', login, 'Латиница и цифры'), field('Придумайте пароль', password, 'Минимум 8 символов'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти')))));
}

// ---------- Маршруты ----------

function parseRoute() {
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  return { view: parts[0] || '', a: parts[1], b: parts[2] };
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
    return clear(root, h('div', { class: 'auth' }, h('div', { class: 'empty' }, h('strong', null, 'Нет связи с сервером'), e.message,
      h('button', { class: 'btn', type: 'button', onclick: render }, 'Повторить'))));
  }

  if (!S.user) {
    if (r.view === 'login') return viewLogin();
    if (r.view === 'register') return viewRegister();
    try {
      if (r.view === 'm') { const page = h('div', { class: 'stack' }); await viewMaterial(page, r.a); return publicShell(page); }
      return await viewLanding();
    } catch (e) {
      return publicShell(h('div', { class: 'empty' }, h('strong', null, 'Не удалось загрузить'), e.message, h('a', { class: 'btn', href: '#/' }, 'На главную')));
    }
  }

  const role = S.user.role;
  const page = h('div', { class: 'stack' });
  let active = r.view;
  try {
    S.unread = (await api('GET', '/notifications')).unread;
    const v = r.view;
    if (v === 'notifications') await viewNotifications(page);
    else if (v === 'materials') { active = 'more'; await viewMaterials(page); }
    else if (v === 'm') { active = role === 'client' ? 'more' : 'articles'; await viewMaterial(page, r.a); }
    else if (v === 'more' && r.a === 'profile') { active = 'more'; await viewProfile(page); }
    else if (v === 'more' && r.a === 'goals' && role === 'client') { active = 'more'; await viewGoals(page); }
    else if (v === 'more' && r.a === 'meds' && role === 'client') { active = 'more'; await viewMeds(page); }
    else if (v === 'more') await viewMore(page);
    else if (role === 'client') {
      if (v === 'charts') await viewCharts(page, r.a, r.b);
      else if (v === 'labs') await viewLabs(page);
      else if (v === 'experts') await viewExperts(page);
      else { active = 'today'; await viewToday(page); }
    } else if (role === 'admin') {
      if (v === 'articles') await viewArticles(page);
      else if (v === 'article') { active = 'articles'; await viewEditor(page, r.a); }
      else { active = 'people'; await viewPeople(page); }
    } else {
      if (v === 'clients') await viewClients(page);
      else if (v === 'client') { active = 'clients'; await viewClient(page, r.a); }
      else if (v === 'articles') await viewArticles(page);
      else if (v === 'article') { active = 'articles'; await viewEditor(page, r.a); }
      else if (v === 'request' && role !== 'trainer') { active = 'requests'; await viewRequest(page, r.a); }
      else if (role === 'trainer') { active = 'schedule'; await viewSchedule(page); }
      else { active = 'requests'; await viewRequests(page, r.a); }
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { S.user = false; return render(); }
    clear(page, h('div', { class: 'empty' }, h('strong', null, e.status === 404 ? 'Не найдено' : 'Не удалось загрузить'), e.message,
      h('a', { class: 'btn', href: `#/${homeOf(role)}` }, 'На главный экран')));
  }
  if (mine === token) {
    clear(root, shell(active, page));
    window.scrollTo(0, 0);
  }
}

window.addEventListener('hashchange', render);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
