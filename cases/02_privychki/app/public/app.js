import { h, clear, api, guard, toast, openDialog, confirmDialog, field, ApiError } from '/shared/ui.js';
import { data, loadLocal, setUser, refresh, mark, replaceHabit, removeHabit, clearLocal, onChange, localDay } from '/store.js';

const root = document.getElementById('app');
const COLORS = ['ember', 'sea', 'plum', 'moss', 'sky', 'rose'];
const COLOR_NAME = { ember: 'Огонь', sea: 'Море', plum: 'Слива', moss: 'Мох', sky: 'Небо', rose: 'Роза' };
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const SVG = 'http://www.w3.org/2000/svg';

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
};
const days = n => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
const shift = (day, by) => globalThis.Stats.shift(day, by);

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

const checkIcon = () => svg('svg', { viewBox: '0 0 24 24', class: 'check-icon', 'aria-hidden': 'true' }, svg('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }));

function ring(done, total) {
  const r = 34;
  const len = 2 * Math.PI * r;
  const part = total ? done / total : 0;
  return h('div', { class: 'ring', role: 'img', 'aria-label': `Сегодня выполнено ${done} из ${total}` },
    svg('svg', { viewBox: '0 0 80 80' },
      svg('circle', { cx: 40, cy: 40, r, class: 'ring-bg' }),
      // При нуле круг не рисуем: скруглённый конец линии дал бы точку.
      ...(done ? [svg('circle', { cx: 40, cy: 40, r, class: 'ring-value', 'stroke-dasharray': `${len * part} ${len}`, transform: 'rotate(-90 40 40)' })] : [])),
    h('div', { class: 'ring-text' }, h('b', null, done), h('span', null, `из ${total}`)));
}

function parseRoute() {
  const parts = (location.hash.slice(1) || '/today').split('/').filter(Boolean);
  return { view: parts[0] || 'today', id: Number(parts[1]) || null };
}

const NAV = [
  ['today', 'Сегодня', 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  ['stats', 'Статистика', 'M5 20V11M12 20V4M19 20v-6'],
  ['settings', 'Настройки', 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4'],
];

function shell(active, content) {
  return h('div', { class: 'shell' },
    data.offline && h('div', { class: 'offline', role: 'status' },
      `Нет связи с сервером. ${data.outbox.length ? `Отметок на устройстве: ${data.outbox.length}, отправим сами.` : 'Отметки сохраняются на устройстве.'}`),
    h('main', { class: 'page' }, content),
    h('nav', { class: 'tabs', 'aria-label': 'Разделы' }, NAV.map(([key, label, d]) =>
      h('a', { class: `tab ${active === key ? 'active' : ''}`, href: `#/${key}`, 'aria-current': active === key ? 'page' : null },
        svg('svg', { viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true' }, svg('path', { d })), h('span', null, label)))));
}

// ---------- Сегодня ----------

function habitRow(habit, day) {
  const done = habit.days.includes(day);
  return h('article', { class: `habit c-${habit.color} ${done ? 'done' : ''}`, 'data-habit': habit.id },
    h('a', { class: 'habit-main', href: `#/habit/${habit.id}` },
      h('span', { class: 'habit-title' }, habit.title),
      h('span', { class: 'habit-meta' }, habit.current ? `Серия: ${days(habit.current)}` : 'Серия ещё не начата')),
    h('button', {
      class: 'mark', type: 'button', 'aria-pressed': done ? 'true' : 'false', 'aria-label': `${habit.title}: ${done ? 'снять отметку' : 'отметить выполнение'}`,
      onclick: () => mark(habit.id, day, !done),
    }, checkIcon()));
}

function viewToday(page) {
  const today = localDay();
  const list = data.habits;
  const done = list.filter(x => x.days.includes(today)).length;
  const label = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  clear(page,
    h('header', { class: 'today-head' },
      h('div', null, h('p', { class: 'muted date' }, label), h('h1', null, list.length && done === list.length ? 'Всё отмечено' : 'Сегодня')),
      list.length ? ring(done, list.length) : null),
    list.length ? h('div', { class: 'habits' }, list.map(x => habitRow(x, today)))
      : h('div', { class: 'empty' }, h('strong', null, 'Привычек пока нет'), 'Начните с одной, самой простой.'),
    h('button', { class: 'btn btn-primary wide', type: 'button', id: 'add-habit', onclick: () => habitDialog() }, 'Добавить привычку'));
}

// ---------- Привычка ----------

let monthShown = null;

function calendar(habit) {
  const today = localDay();
  const key = monthShown?.id === habit.id ? monthShown : { id: habit.id, y: +today.slice(0, 4), m: +today.slice(5, 7) };
  const first = new Date(Date.UTC(key.y, key.m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(key.y, key.m, 0)).getUTCDate();
  const set = new Set(habit.days);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'day blank' }));
  for (let d = 1; d <= count; d++) {
    const iso = `${key.y}-${String(key.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const on = set.has(iso);
    cells.push(h('button', {
      class: `day ${on ? 'on' : ''} ${iso === today ? 'today' : ''}`, type: 'button', 'data-day': iso, disabled: iso > today,
      'aria-pressed': on ? 'true' : 'false', 'aria-label': `${d} ${MONTHS[key.m - 1]}`,
      onclick: () => mark(habit.id, iso, !on),
    }, d));
  }
  const move = by => {
    const t = new Date(Date.UTC(key.y, key.m - 1 + by, 1));
    monthShown = { id: habit.id, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 };
    render();
  };
  const isCurrent = key.y === +today.slice(0, 4) && key.m === +today.slice(5, 7);
  return h('section', { class: 'panel' },
    h('div', { class: 'month-head' },
      h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Предыдущий месяц', id: 'prev-month', onclick: () => move(-1) }, '←'),
      h('h2', null, `${MONTHS[key.m - 1]} ${key.y}`),
      h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Следующий месяц', disabled: isCurrent, onclick: () => move(1) }, '→')),
    h('div', { class: 'grid' }, WEEK.map(w => h('span', { class: 'weekday' }, w)), cells));
}

function viewHabit(page, id) {
  const habit = data.habits.find(x => x.id === id);
  if (!habit) {
    clear(page, h('div', { class: 'empty' }, h('strong', null, 'Привычка не найдена'), h('a', { class: 'btn', href: '#/today' }, 'На главный экран')));
    return;
  }
  clear(page,
    h('header', { class: 'habit-head' },
      h('a', { class: 'btn btn-ghost', href: '#/today' }, '← Назад'),
      h('button', { class: 'btn', type: 'button', id: 'edit-habit', onclick: () => habitDialog(habit) }, 'Изменить')),
    h('div', { class: `habit-hero c-${habit.color}` }, h('h1', null, habit.title), habit.description && h('p', { class: 'muted' }, habit.description)),
    h('div', { class: 'metrics' },
      metric(habit.current, plural(habit.current, 'день подряд', 'дня подряд', 'дней подряд'), 'current'),
      metric(habit.best, 'лучшая серия', 'best'),
      metric(`${habit.percent30}%`, 'за 30 дней', 'percent')),
    h('div', { class: `c-${habit.color}` }, calendar(habit)));
}

const metric = (value, label, id) => h('div', { class: 'metric', 'data-metric': id }, h('b', null, value), h('span', null, label));

function habitDialog(habit) {
  if (data.offline && !habit) { toast('Новую привычку можно добавить, когда вернётся связь', 'error'); return; }
  const title = h('input', { name: 'title', required: true, maxlength: 80, value: habit?.title || '', placeholder: 'Например, прогулка 30 минут' });
  const description = h('textarea', { name: 'description', rows: 2, maxlength: 500, value: habit?.description || '' });
  const remind = h('input', { name: 'remind', type: 'time', value: habit?.remindAt || '' });
  let color = habit?.color || 'ember';
  const swatches = COLORS.map(c => h('button', {
    class: `swatch c-${c} ${c === color ? 'active' : ''}`, type: 'button', title: COLOR_NAME[c], 'aria-label': COLOR_NAME[c], 'data-color': c,
    onclick: e => { color = c; swatches.forEach(s => s.classList.remove('active')); e.currentTarget.classList.add('active'); },
  }));
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        const body = { title: title.value, description: description.value, color, remindAt: remind.value || null };
        const r = habit ? await api('PATCH', `/habits/${habit.id}`, body) : await api('POST', '/habits', body);
        await replaceHabit(r.habit);
        dlg.close();
      });
    },
  }, h('h2', null, habit ? 'Изменить привычку' : 'Новая привычка'),
  field('Название', title), field('Описание', description),
  h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Цвет'), h('div', { class: 'swatches' }, swatches)),
  field('Напоминание', remind, 'Оставьте пустым, если не нужно. Включите уведомления в настройках.'),
  h('div', { class: 'row between' },
    habit ? h('button', {
      class: 'btn btn-danger', type: 'button', id: 'delete-habit',
      onclick: async () => {
        if (!await confirmDialog(`Удалить привычку «${habit.title}» и всю её историю?`, 'Удалить')) return;
        await guard(async () => {
          await api('DELETE', `/habits/${habit.id}`);
          await removeHabit(habit.id);
          dlg.close();
          location.hash = '/today';
        });
      },
    }, 'Удалить') : h('span'),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить')))), { onClose: render });
}

// ---------- Статистика ----------

function viewStats(page) {
  const today = localDay();
  const week = Array.from({ length: 7 }, (_, i) => shift(today, i - 6));
  const label = iso => WEEK[(new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7];
  const list = data.habits;
  const average = list.length ? Math.round(list.reduce((s, x) => s + x.percent30, 0) / list.length) : 0;
  const bestNow = list.reduce((m, x) => (x.current > (m?.current ?? 0) ? x : m), null);
  clear(page,
    h('header', { class: 'page-head' }, h('h1', null, 'Статистика')),
    list.length ? [
      h('div', { class: 'metrics' }, metric(`${average}%`, 'в среднем за 30 дней', 'average'),
        metric(bestNow ? bestNow.current : 0, bestNow ? bestNow.title : 'серии нет', 'top')),
      h('section', { class: 'panel' }, h('h2', null, 'Последние 7 дней'),
        h('div', { class: 'week' },
          h('span'), week.map(d => h('span', { class: `weekday ${d === today ? 'now' : ''}` }, label(d))), h('span', { class: 'weekday' }, '30 дн.'),
          list.map(x => [
            h('a', { class: 'week-title', href: `#/habit/${x.id}` }, x.title),
            week.map(d => h('span', { class: `dot c-${x.color} ${x.days.includes(d) ? 'on' : ''}`, title: d })),
            h('b', { class: 'week-percent' }, `${x.percent30}%`),
          ]))),
    ] : h('div', { class: 'empty' }, h('strong', null, 'Пока нечего считать'), 'Добавьте привычку на главном экране.'));
}

// ---------- Настройки ----------

let installEvent = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; if (parseRoute().view === 'settings') render(); });
window.addEventListener('appinstalled', () => { installEvent = null; toast('Приложение установлено', 'ok'); });

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

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { toast('Уведомления запрещены в настройках браузера', 'error'); return; }
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('GET', '/push/key');
  let sub;
  try {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(key) });
  } catch {
    toast('Этот браузер не смог подключить уведомления', 'error');
    return;
  }
  await api('POST', '/push/subscribe', sub.toJSON());
  toast('Напоминания включены на этом устройстве', 'ok');
  render();
}

async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
}

async function pushBlock() {
  if (isIos() && !standalone()) return h('p', { class: 'muted small' }, 'На iPhone напоминания работают после установки: «Поделиться» → «На экран Домой».');
  if (!('PushManager' in window) || !('Notification' in window)) return h('p', { class: 'muted small' }, 'Этот браузер не поддерживает напоминания.');
  const sub = await currentSubscription();
  if (sub) {
    return [h('p', { class: 'small' }, 'Напоминания включены на этом устройстве.'), h('button', {
      class: 'btn', type: 'button', id: 'push-off',
      onclick: () => guard(async () => { await disablePush(); toast('Напоминания выключены'); render(); }),
    }, 'Выключить')];
  }
  return [h('p', { class: 'muted small' }, 'Придут в выбранное у привычки время, если она ещё не отмечена.'), h('button', {
    class: 'btn', type: 'button', id: 'push-on', onclick: () => guard(enablePush),
  }, 'Включить напоминания')];
}

async function viewSettings(page) {
  const me = data.user;
  const name = h('input', { name: 'name', value: me.name, maxlength: 80 });
  const oldPass = h('input', { name: 'old', type: 'password', autocomplete: 'current-password' });
  const newPass = h('input', { name: 'new', type: 'password', autocomplete: 'new-password', minlength: 8 });
  const push = await pushBlock();
  clear(page,
    h('header', { class: 'page-head' }, h('h1', null, 'Настройки')),
    me.sandbox && h('p', { class: 'note' }, 'Это песочница. Она и все отметки удалятся через 7 дней.'),
    h('div', { class: 'stack' },
      h('section', { class: 'panel stack' }, h('h2', null, 'Напоминания'), push),
      !standalone() && (installEvent || isIos()) && h('section', { class: 'panel stack' }, h('h2', null, 'Установка'),
        installEvent ? h('button', {
          class: 'btn', type: 'button', id: 'install',
          onclick: async () => { installEvent.prompt(); await installEvent.userChoice; installEvent = null; render(); },
        }, 'Установить на устройство') : h('p', { class: 'muted small' }, 'В Safari нажмите «Поделиться» → «На экран Домой».')),
      !me.sandbox && h('form', {
        class: 'panel stack',
        onsubmit: async e => {
          e.preventDefault();
          await guard(async () => {
            const r = await api('PATCH', '/me', { name: name.value });
            await setUser({ ...me, name: r.user.name });
            toast('Имя сохранено', 'ok');
          });
        },
      }, h('h2', null, 'Профиль'), field('Имя', name), field('Логин', h('input', { value: me.login, disabled: true })), h('button', { class: 'btn', type: 'submit' }, 'Сохранить')),
      !me.sandbox && h('form', {
        class: 'panel stack',
        onsubmit: async e => {
          e.preventDefault();
          await guard(async () => {
            await api('POST', '/me/password', { old: oldPass.value, new: newPass.value });
            oldPass.value = ''; newPass.value = '';
            toast('Пароль изменён', 'ok');
          });
        },
      }, h('h2', null, 'Смена пароля'), field('Текущий пароль', oldPass), field('Новый пароль', newPass, 'Минимум 8 символов'), h('button', { class: 'btn', type: 'submit' }, 'Изменить пароль')),
      h('section', { class: 'panel stack' }, h('h2', null, 'Аккаунт'),
        h('button', { class: 'btn', type: 'button', id: 'logout', onclick: () => guard(logout) }, 'Выйти'),
        me.sandbox && h('p', { class: 'muted small' }, 'У песочницы нет пароля: после выхода вернуться в неё будет нельзя.'),
        h('button', { class: 'btn btn-danger', type: 'button', id: 'delete-account', onclick: deleteAccount }, 'Удалить аккаунт'))));
}

async function logout() {
  await disablePush().catch(() => {});
  await api('POST', '/auth/logout');
  await clearLocal();
  data.user = null; data.habits = []; data.outbox = [];
  location.hash = '/today';
  await viewAuth();
}

function deleteAccount() {
  const me = data.user;
  const password = h('input', { type: 'password', name: 'confirm-password', autocomplete: 'current-password' });
  const dlg = openDialog(h('form', {
    class: 'stack',
    onsubmit: async e => {
      e.preventDefault();
      await guard(async () => {
        await disablePush().catch(() => {});
        await api('POST', '/account/delete', { password: password.value });
        await clearLocal();
        data.user = null; data.habits = []; data.outbox = [];
        dlg.close();
        location.hash = '/today';
        await viewAuth();
      });
    },
  }, h('h2', null, 'Удалить аккаунт?'), h('p', null, 'Привычки и отметки удалятся навсегда.'),
  !me.sandbox && field('Пароль для подтверждения', password),
  h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
    h('button', { class: 'btn btn-danger', type: 'submit', id: 'confirm-delete' }, 'Удалить'))), { className: 'dialog-small' });
}

// ---------- Вход ----------

const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

async function viewAuth() {
  const cfg = await api('GET', '/app/config').catch(() => ({ sandbox: false }));
  let mode = 'login';
  const login = h('input', { name: 'login', autocomplete: 'username', required: true });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const title = h('h2', null, 'Вход');
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти');
  const toggle = h('button', { class: 'btn btn-ghost', type: 'button', id: 'auth-toggle', onclick: () => {
    mode = mode === 'login' ? 'register' : 'login';
    title.textContent = mode === 'login' ? 'Вход' : 'Регистрация';
    submit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    toggle.textContent = mode === 'login' ? 'Создать аккаунт' : 'Уже есть аккаунт';
  } }, 'Создать аккаунт');

  const enter = async r => { await setUser(r.user); await start(); };
  clear(root, h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('div', { class: 'logo' }, h('img', { src: '/favicon.svg', alt: '', width: 40, height: 40 }), h('span', null, 'Серия')),
    h('p', { class: 'muted' }, 'Отмечайте привычки каждый день и не прерывайте серию.'),
    cfg.sandbox && h('button', {
      class: 'btn btn-primary wide', type: 'button', id: 'sandbox',
      onclick: () => guard(async () => enter(await api('POST', '/auth/sandbox', { tz: deviceTz() }))),
    }, 'Попробовать без регистрации'),
    cfg.sandbox && h('p', { class: 'muted small' }, 'Откроем пример с вашей личной историей. Он удалится через 7 дней. Это демо: не вводите настоящие данные.'),
    h('form', {
      class: 'stack',
      onsubmit: async e => {
        e.preventDefault();
        await guard(async () => {
          if (mode === 'register') return enter(await api('POST', '/auth/register', { login: login.value, password: password.value, tz: deviceTz() }));
          await api('POST', '/auth/login', { login: login.value, password: password.value });
          const r = await api('GET', '/account');
          return enter(r);
        });
      },
    }, title, field('Логин', login), field('Пароль', password), submit, toggle))));
}

// ---------- Запуск ----------

let rendering = false;
export async function render() {
  if (rendering) return;
  rendering = true;
  try {
    if (!data.user) return;
    const route = parseRoute();
    const page = h('div', null);
    if (route.view === 'habit') viewHabit(page, route.id);
    else if (route.view === 'stats') viewStats(page);
    else if (route.view === 'settings') await viewSettings(page);
    else viewToday(page);
    const active = route.view === 'habit' ? 'today' : (NAV.some(n => n[0] === route.view) ? route.view : 'today');
    clear(root, shell(active, page));
  } finally {
    rendering = false;
  }
}

async function start() {
  await loadLocal();
  let online = true;
  try {
    const r = await api('GET', '/account');
    await setUser(r.user);
    if (r.user.tz !== deviceTz()) api('PUT', '/account/tz', { tz: deviceTz() }).catch(() => {});
  } catch (e) {
    // Данные на устройстве не трогаем: в них могут быть неотправленные отметки.
    if (e instanceof ApiError && e.status === 401) { data.user = null; return viewAuth(); }
    online = false;
  }
  if (!data.user) {
    clear(root, h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, h('h2', null, 'Нужна связь'),
      h('p', { class: 'muted' }, 'Для первого входа нужен интернет. Потом приложение работает и без него.'),
      h('button', { class: 'btn', type: 'button', onclick: start }, 'Повторить'))));
    return;
  }
  data.offline = !online;
  await render();
  if (online) await refresh().catch(e => toast(e.message, 'error'));
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Диалоги живут поверх страницы: пока открыт диалог, экран не перерисовываем.
onChange(() => {
  if (data.sessionLost && data.user) { data.user = null; document.querySelector('dialog[open]')?.close(); viewAuth(); return; }
  if (!document.querySelector('dialog[open]')) render();
});
window.addEventListener('hashchange', () => { monthShown = null; render(); });
let lastDay = localDay();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && lastDay !== localDay()) { lastDay = localDay(); render(); }
});
start();
