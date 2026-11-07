// «Серия» в настоящем браузере: телефон, режим без сети, остановка сервера, смена пользователя.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/e2e_privychki.js <out_dir>
const { app, BrowserWindow, session } = require('electron');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const outDir = process.argv.at(-1);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', '/tmp/tr_e2e_h_' + process.pid);
app.disableHardwareAcceleration();
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
const check = (ok, name) => { results.push(!!ok); console.log(ok ? 'ok  ' : 'FAIL', name); };

const PORT = 18808, URL_BASE = `http://127.0.0.1:${PORT}/`;
const dir = fs.mkdtempSync('/tmp/tr_h_e2e_');
const dbFile = path.join(dir, 'h.sqlite');
let server;
function startServer() {
  server = spawn('node', ['--disable-warning=ExperimentalWarning', 'cases/02_privychki/app/server.js'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PORT, DB_FILE: dbFile, SANDBOX: '1' }, stdio: 'ignore',
  });
  return wait(1500);
}
const stopServer = () => new Promise(r => { server.once('exit', r); server.kill(); });
const dbRows = (q, ...a) => { const d = new DatabaseSync(dbFile, { readOnly: true }); const r = d.prepare(q).all(...a); d.close(); return r; };

app.whenReady().then(async () => {
  await startServer();
  const win = new BrowserWindow({ show: true, width: 420, height: 860 });
  const wc = win.webContents;
  wc.on('console-message', e => { if (e.level === 'error') consoleErrors.push(e.message); });
  wc.debugger.attach('1.3');
  const cdp = (m, p) => wc.debugger.sendCommand(m, p);
  const js = c => wc.executeJavaScript(c);
  const q = (s, expr = 'el') => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); return el ? (${expr}) : null; })()`);
  const click = async (s, ms = 500) => { await js(`document.querySelector(${JSON.stringify(s)}).click()`); await wait(ms); };
  const type = (s, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); const p = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const body = () => js('document.body.innerText');
  const shot = async n => { await wait(350); fs.writeFileSync(path.join(outDir, n + '.png'), (await wc.capturePage()).toPNG()); };
  const go = async h => { await js(`location.hash = ${JSON.stringify(h)}`); await wait(500); };
  const reload = async () => { await js('location.reload()'); await wait(1500); };
  const noOverflow = () => js('document.documentElement.scrollWidth <= window.innerWidth');
  const pressed = n => js(`document.querySelectorAll('.mark')[${n}].getAttribute('aria-pressed')`);
  const metaOf = n => js(`document.querySelectorAll('.habit-meta')[${n}].innerText`);
  const num = s => Number(/\d+/.exec(s)?.[0] ?? 0);
  const serverChecks = () => dbRows('SELECT COUNT(*) AS n FROM checks c JOIN habits h ON h.id = c.habit_id WHERE c.done = 1')[0].n;

  try {
    await win.loadURL(URL_BASE);
    await wait(900);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
    await reload();
    await shot('10_login');
    check(await noOverflow(), 'телефон: вход без сдвига');

    await click('#sandbox', 1500);
    check((await js(`document.querySelectorAll('.habit').length`)) === 4, 'песочница открылась с примером');
    check(await q('.ring-value', 'false') === null, 'при нуле кольцо без точки');
    await shot('11_today');

    const start = num(await metaOf(0));
    await click('.mark');
    check((await pressed(0)) === 'true', 'отметка поставлена');
    check(num(await metaOf(0)) === start + 1, `серия выросла: ${start} → ${start + 1}`);
    check((await q('.ring-text b', 'el.innerText')) === '1', 'кольцо показывает 1');
    await reload();
    check((await pressed(0)) === 'true', 'отметка сохранилась после перезагрузки');

    await js(`navigator.serviceWorker.ready.then(() => new Promise(r => { if (navigator.serviceWorker.controller) r(); else navigator.serviceWorker.addEventListener('controllerchange', r); }))`);
    await wait(500);
    check(await js('!!navigator.serviceWorker.controller'), 'сервис-воркер управляет страницей');
    await reload();

    // ---------- Настоящий режим без сети ----------
    const onServer = await serverChecks();
    await cdp('Network.enable');
    await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await wait(300);
    check(!(await js('navigator.onLine')), 'браузер считает, что сети нет');
    await reload();
    check((await js(`document.querySelectorAll('.habit').length`)) === 4, 'без сети приложение открылось с данными');
    check(/Нет связи/.test(await body()), 'статус «нет сети» виден');
    await click('.habit:nth-child(2) .mark');
    check((await pressed(1)) === 'true', 'без сети отметка поставлена');
    check(/Отметок на устройстве: 1/.test(await body()), 'видно, что отметка ждёт отправки');
    await shot('12_offline');
    check((await serverChecks()) === onServer, 'на сервер ещё ничего не ушло');
    await reload();
    check((await pressed(1)) === 'true', 'без сети отметка пережила перезагрузку');
    await click('#add-habit');
    check(/когда вернётся связь/.test(await body()), 'новую привычку без сети не создаём, объяснено');

    await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await wait(1800);
    check((await serverChecks()) === onServer + 1, 'сеть вернулась: отметка дошла до сервера');
    check(!/Нет связи/.test(await body()), 'статус «нет сети» исчез');

    // ---------- Сервер упал, а сеть есть: браузер этого не знает ----------
    await stopServer();
    await click('.habit:nth-child(3) .mark', 900);
    check((await pressed(2)) === 'true', 'сервер лежит: отметка поставлена');
    check(/Нет связи/.test(await body()), 'сервер лежит: статус виден');
    await reload();
    check((await js(`document.querySelectorAll('.habit').length`)) === 4, 'сервер лежит: приложение открывается');
    check((await pressed(2)) === 'true', 'сервер лежит: отметка на месте');
    const before = await serverChecks();
    await startServer();
    await js(`window.dispatchEvent(new Event('online'))`);
    await wait(1500);
    check((await serverChecks()) === before + 1, 'сервер вернулся: отметка дошла');

    // ---------- Календарь ----------
    await js(`document.querySelector('.habit:nth-child(4) .habit-main').click()`);
    await wait(600);
    await shot('13_habit');
    const yesterday = await js(`document.querySelector('.day.today').dataset.day`);
    check(await js(`[...document.querySelectorAll('.day:not(.blank)')].filter(d => d.dataset.day > ${JSON.stringify(yesterday)}).every(d => d.disabled)`), 'будущие дни закрыты');
    const cur0 = await q('[data-metric=current] b', 'el.innerText');
    await click('.day.today');
    check(Number(await q('[data-metric=current] b', 'el.innerText')) === Number(cur0) + 1, 'отметка в календаре меняет серию');
    await click('#prev-month');
    check((await js(`document.querySelectorAll('.day.on').length`)) > 0, 'прошлый месяц показывает историю');
    check(await noOverflow(), 'телефон: календарь без сдвига');
    await js(`location.hash='/stats'`); await wait(500);
    check((await js(`document.querySelectorAll('.week-title').length`)) === 4, 'статистика показывает привычки');
    check(await noOverflow(), 'телефон: статистика без сдвига');
    await shot('14_stats');

    // ---------- Создание, вредный текст, изменение, удаление ----------
    await go('/today');
    await click('#add-habit');
    await type('.dialog input[name=title]', '<img src=x onerror="window.__xss=1">Йога');
    await click('.dialog [data-color=sky]', 100);
    await type('.dialog input[name=remind]', '08:15');
    await shot('15_new');
    await click('.dialog button[type=submit]', 700);
    check((await js(`document.querySelectorAll('.habit').length`)) === 5, 'привычка создана');
    check(await js(`[...document.querySelectorAll('.habit-title')].some(t => t.textContent.startsWith('<img'))`), 'разметка показана как текст');
    check(!(await js('window.__xss')), 'разметка не выполнилась');
    await js(`document.querySelector('.habit:nth-child(5) .habit-main').click()`); await wait(500);
    await click('#edit-habit');
    check((await q('.dialog input[name=remind]', 'el.value')) === '08:15', 'время напоминания сохранилось');
    await type('.dialog input[name=title]', 'Йога утром');
    await click('.dialog button[type=submit]', 700);
    check((await q('.habit-hero h1', 'el.innerText')) === 'Йога утром', 'изменение сохранилось');
    await click('#edit-habit');
    await click('#delete-habit');
    await js(`[...document.querySelectorAll('.dialog-small button')].find(b => b.innerText === 'Удалить').click()`);
    await wait(900);
    check((await js(`document.querySelectorAll('.habit').length`)) === 4, 'привычка удалена с подтверждением');

    await go('/settings');
    await shot('16_settings');
    check(await noOverflow(), 'телефон: настройки без сдвига');
    check(/песочница/i.test(await body()), 'песочница объяснена');
    check(await q('#push-on', '!!el'), 'кнопка напоминаний есть');

    // ---------- Истекшая сессия: отметки не теряются ----------
    await click('#logout', 900);
    check(await q('#sandbox', '!!el'), 'выход работает');
    await click('#auth-toggle', 100);
    await type('input[name=login]', 'tester');
    await type('input[name=password]', 'password123');
    await click('form button[type=submit]', 1200);
    check((await js(`document.querySelectorAll('.habit').length`)) === 0, 'новый пользователь не видит данные прошлого на этом устройстве');
    check(/Привычек пока нет/.test(await body()), 'пустое состояние понятно');
    await click('#add-habit');
    await type('.dialog input[name=title]', 'Своя');
    await click('.dialog button[type=submit]', 700);

    const countBefore = await serverChecks();
    { const d = new DatabaseSync(dbFile); d.exec('PRAGMA busy_timeout=3000; DELETE FROM sessions'); d.close(); }
    await click('.mark', 900);
    check(await q('input[name=login]', '!!el'), 'сессия истекла: показан вход');
    await type('input[name=login]', 'tester');
    await type('input[name=password]', 'password123');
    await click('form button[type=submit]', 1500);
    check((await serverChecks()) === countBefore + 1, 'после входа отметка дошла, а не потерялась');

    // ---------- Профиль, пароль, удаление ----------
    await go('/settings');
    await type('input[name=name]', 'Тестер');
    await js(`document.querySelectorAll('.settings, form')[0].querySelector('button[type=submit]').click()`);
    await wait(600);
    check(dbRows("SELECT name FROM users WHERE login = 'tester'")[0].name === 'Тестер', 'имя меняется');
    await type('input[name=old]', 'password123');
    await type('input[name=new]', 'password456');
    await js(`document.querySelectorAll('form')[1].querySelector('button[type=submit]').click()`);
    await wait(800);
    check(/Пароль изменён/.test(await body()), 'пароль меняется');
    await click('#delete-account', 400);
    await type('.dialog input[name=confirm-password]', 'password456');
    await click('#confirm-delete', 1200);
    check(await q('#sandbox', '!!el'), 'аккаунт удалён, показан вход');
    check(dbRows("SELECT COUNT(*) AS n FROM users WHERE login = 'tester'")[0].n === 0, 'аккаунта на сервере нет');
  } catch (e) {
    check(false, 'сценарий оборвался: ' + e.message);
  }
  console.log('console errors:', JSON.stringify([...new Set(consoleErrors)].filter(m => !/status of (4|5)|ERR_|Failed to fetch|net::/.test(m))));
  const failed = results.filter(x => !x).length;
  console.log(`ИТОГ: ${results.length - failed} из ${results.length}`);
  server.kill();
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); app.exit(2); });
