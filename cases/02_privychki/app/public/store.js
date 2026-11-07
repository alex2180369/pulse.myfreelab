// Данные на устройстве: снимок привычек и очередь отметок, которые ещё не дошли до сервера.
import { api, ApiError } from '/shared/ui.js';

const DB_NAME = 'seriya';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const dbReady = openDb();

async function tx(mode, fn) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const kvGet = key => tx('readonly', s => s.get(key));
const kvSet = (key, value) => tx('readwrite', s => s.put(value, key));
export const clearLocal = () => tx('readwrite', s => s.clear());

export const data = { user: null, habits: [], outbox: [], offline: !navigator.onLine, sessionLost: false };

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const emit = () => listeners.forEach(fn => fn());

const pad = n => String(n).padStart(2, '0');
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Серии всегда пересчитываются здесь, чтобы цифры были верны и без сети.
function recompute(h) {
  const today = localDay();
  const s = globalThis.Stats.streaks(h.days, today);
  h.current = s.current;
  h.best = s.best;
  h.percent30 = globalThis.Stats.percent(h.days, h.createdDay, today, 30);
}

function applyMark(h, day, done) {
  const has = h.days.includes(day);
  if (done && !has) h.days = [...h.days, day].sort();
  if (!done && has) h.days = h.days.filter(d => d !== day);
  recompute(h);
}

const save = () => Promise.all([kvSet('habits', data.habits), kvSet('outbox', data.outbox)]);

export async function loadLocal() {
  data.user = (await kvGet('user')) || null;
  data.habits = (await kvGet('habits')) || [];
  data.outbox = (await kvGet('outbox')) || [];
  data.habits.forEach(recompute);
}

// Сессия могла истечь, пока человек был без сети. Если вошёл он же, его отметки остаются в очереди.
// Если вошёл другой человек, чужие данные на устройстве стираются.
export async function setUser(user) {
  const previous = await kvGet('user');
  if (previous && previous.id !== user.id) {
    await clearLocal();
    data.habits = [];
    data.outbox = [];
  }
  data.user = user;
  data.sessionLost = false;
  await kvSet('user', user);
}

let flushing = null;
async function flushOnce() {
  while (data.outbox.length) {
    const batch = data.outbox.slice(0, 200);
    await api('POST', '/checks/sync', { items: batch });
    // За время отправки человек мог снова нажать: убираем только то, что ушло без изменений.
    data.outbox = data.outbox.filter(x => !batch.some(b => b.habitId === x.habitId && b.day === x.day && b.at === x.at));
    await save();
  }
}

export function flush() {
  if (!flushing) {
    flushing = flushOnce()
      .then(() => { data.offline = false; })
      .catch(e => {
        if (e instanceof ApiError && e.status === 401) { data.sessionLost = true; return; }
        // Сервер отказал по существу: такая отметка не пройдёт никогда, и очередь не должна застрять.
        if (e instanceof ApiError && e.status === 400) { data.outbox = []; return save(); }
        // Остальное считаем временным сбоем: очередь останется и уйдёт позже.
        data.offline = true;
      })
      .finally(() => { flushing = null; emit(); });
  }
  return flushing;
}

export async function refresh() {
  await flush();
  if (data.sessionLost) return;
  try {
    const r = await api('GET', '/habits');
    data.offline = false;
    data.habits = r.habits;
    for (const m of data.outbox) {
      const h = data.habits.find(x => x.id === m.habitId);
      if (h) applyMark(h, m.day, m.done);
    }
    data.habits.forEach(recompute);
    await save();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) data.sessionLost = true;
    else if (e instanceof ApiError && e.status === 0) data.offline = true;
    else throw e;
  }
  emit();
}

export async function mark(habitId, day, done) {
  const h = data.habits.find(x => x.id === habitId);
  if (!h) return;
  applyMark(h, day, done);
  data.outbox = data.outbox.filter(x => !(x.habitId === habitId && x.day === day));
  data.outbox.push({ habitId, day, done, at: new Date().toISOString() });
  await save();
  emit();
  flush();
}

export function replaceHabit(habit) {
  const i = data.habits.findIndex(x => x.id === habit.id);
  if (i >= 0) data.habits[i] = habit; else data.habits.push(habit);
  recompute(habit);
  return save().then(emit);
}

export function removeHabit(id) {
  data.habits = data.habits.filter(x => x.id !== id);
  data.outbox = data.outbox.filter(x => x.habitId !== id);
  return save().then(emit);
}

window.addEventListener('online', () => { refresh().catch(() => {}); });
window.addEventListener('offline', () => { data.offline = true; emit(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });
// Сеть могла вернуться без события: очередь проверяем сами.
setInterval(() => { if (data.outbox.length) flush(); }, 20000);
