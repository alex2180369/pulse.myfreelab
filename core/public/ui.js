// Общие помощники интерфейса. Текст всегда попадает в страницу как текст, а не как разметка.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'selected' || key === 'disabled') el[key] = !!value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Внутри Telegram вход держится на токене: во фрейме веб-клиента куки не работают.
let bearer = sessionStorage.getItem('bearer');
export const setBearer = t => { bearer = t; if (t) sessionStorage.setItem('bearer', t); else sessionStorage.removeItem('bearer'); };
export const hasBearer = () => !!bearer;

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api/v1' + path, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером. Проверьте интернет.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error?.code, data.error?.message || 'Что-то пошло не так');
  return data;
}

export function toast(message, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const item = h('div', { class: `toast toast-${kind}` }, message);
  box.append(item);
  setTimeout(() => item.remove(), 4200);
}

// Запускает действие и показывает ошибку всплывающим сообщением.
export async function guard(fn) {
  try { return await fn(); }
  catch (e) {
    toast(e instanceof ApiError ? e.message : 'Что-то пошло не так', 'error');
    if (!(e instanceof ApiError)) console.error(e);
    return undefined;
  }
}

export function openDialog(content, { className = '', onClose } = {}) {
  const dlg = h('dialog', { class: `dialog ${className}` }, content);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  return dlg;
}

export function confirmDialog(question, actionLabel) {
  return new Promise(resolve => {
    let result = false;
    const dlg = openDialog(h('div', { class: 'stack' },
      h('p', { class: 'confirm-text' }, question),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
        h('button', { class: 'btn btn-danger', type: 'button', onclick: () => { result = true; dlg.close(); } }, actionLabel))),
    { className: 'dialog-small', onClose: () => resolve(result) });
  });
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function dayDiff(date, base = new Date()) {
  return Math.round((startOfDay(new Date(date)) - startOfDay(base)) / 864e5);
}

// Понятный срок: «сегодня, 15:00», «завтра», «12 нояб.»
export function formatDue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = dayDiff(d);
  const time = timeFmt.format(d);
  if (diff === 0) return `сегодня, ${time}`;
  if (diff === 1) return `завтра, ${time}`;
  if (diff === -1) return `вчера, ${time}`;
  return dateFmt.format(d);
}

export const formatDateTime = iso => `${dateFmt.format(new Date(iso))}, ${timeFmt.format(new Date(iso))}`;

// Значение для поля datetime-local в местном времени.
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fromLocalInput = v => (v ? new Date(v).toISOString() : null);

export const initials = name => String(name || '?').split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();

export function avatar(name, id = 0) {
  return h('span', { class: `avatar avatar-${(id || 0) % 5}`, title: name || 'Не назначен' }, name ? initials(name) : '—');
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'field-hint' }, hint));
}

export function select(options, value, attrs = {}) {
  return h('select', attrs, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)));
}
