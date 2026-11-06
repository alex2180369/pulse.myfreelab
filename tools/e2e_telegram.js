// Веб-приложение внутри Telegram: браузер открывает адрес так же, как клиент Telegram.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/e2e_telegram.js <out_dir>
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto'), fs = require('fs'), http = require('http'), path = require('path');
const outDir = process.argv.at(-1);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', '/tmp/tr_e2e_tg_' + process.pid);
app.disableHardwareAcceleration();
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
const check = (ok, name) => { results.push(!!ok); console.log(ok ? 'ok  ' : 'FAIL', name); };

const TOKEN = '123456:TEST', PORT = 18804, TG = 18805, BASE = `http://127.0.0.1:${PORT}`;
const updates = []; let nextId = 1;
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    const method = req.url.split('/').pop();
    let result = true;
    if (method === 'getMe') result = { id: 1, is_bot: true, username: 'puls_test_bot' };
    if (method === 'sendMessage') result = { message_id: 1 };
    if (method === 'getUpdates') { await wait(150); result = updates.splice(0); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});

function sign(user) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA', user: JSON.stringify(user) });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
const theme = JSON.stringify({ bg_color: '#17212b', secondary_bg_color: '#0e1621', text_color: '#f5f5f5', hint_color: '#708499', button_color: '#5288c1', button_text_color: '#ffffff' });
const launchUrl = (user, query = '') => `${BASE}/${query}#tgWebAppData=${encodeURIComponent(sign(user))}&tgWebAppVersion=8.0&tgWebAppPlatform=android&tgWebAppThemeParams=${encodeURIComponent(theme)}`;

app.whenReady().then(async () => {
  await new Promise(r => mock.listen(TG, '127.0.0.1', r));
  const dir = fs.mkdtempSync('/tmp/tr_tg_');
  const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'cases/01_zadachi/app/server.js'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PORT, DB_FILE: path.join(dir, 't.sqlite'), DEMO: '1', BOT_TOKEN: TOKEN, TELEGRAM_API: `http://127.0.0.1:${TG}`, PUBLIC_URL: BASE, BOT_TICK_MS: '500' },
    stdio: 'inherit',
  });
  await wait(2000);

  const win = new BrowserWindow({ show: true, width: 420, height: 800 });
  const wc = win.webContents;
  wc.on('console-message', e => { if (e.level === 'error') consoleErrors.push(e.message); });
  const js = c => wc.executeJavaScript(c);
  const shot = async n => { await wait(300); fs.writeFileSync(path.join(outDir, n + '.png'), (await wc.capturePage()).toPNG()); };
  try {
    // Незнакомец открывает приложение из меню бота: видит демо-вход, а не ошибку.
    await win.loadURL(launchUrl({ id: 7001 }));
    await wait(1300);
    check((await js(`document.body.innerText`)).includes('Демо'), 'не подключён: показан вход');
    await js(`sessionStorage.clear()`);

    // Подключаем человека через бота.
    updates.push({ update_id: nextId++, message: { message_id: 1, from: { id: 7002, username: 'demo_user' }, chat: { id: 7002, type: 'private' }, text: '/start' } });
    updates.push({ update_id: nextId++, callback_query: { id: '1', from: { id: 7002 }, data: 'd:lead', message: { message_id: 2, chat: { id: 7002, type: 'private' } } } });
    await wait(900);

    await win.loadURL('about:blank');
    await win.loadURL(launchUrl({ id: 7002 }));
    await wait(1500);
    check((await js(`document.querySelector('h1')?.innerText`)) === 'Мои задачи', 'вход без пароля');
    check(!(await js(`location.hash`)).includes('tgWebAppData'), 'данные входа убраны из адреса');
    check((await js(`getComputedStyle(document.body).backgroundColor`)) === 'rgb(14, 22, 33)', 'цвета темы Telegram применены');
    check((await js(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`)) === 'rgb(82, 136, 193)', 'кнопки в цвете темы');
    await shot('tg_01_mine');
    await js(`location.hash='/board'`); await wait(900);
    await shot('tg_02_board');
    await js(`location.reload()`); await wait(1300);
    check((await js(`document.querySelector('h1')?.innerText`)) === 'Доска', 'обновление страницы не выкидывает из аккаунта');
    await js(`location.hash='/settings'`); await wait(900);
    check((await js(`document.getElementById('telegram-panel').innerText`)).includes('Подключено к @puls_test_bot'), 'в настройках виден подключённый бот');
    await shot('tg_03_settings');

    // Кнопка «Открыть» из сообщения бота ведёт сразу в задачу.
    await js(`sessionStorage.clear()`);
    await win.loadURL('about:blank');
    await win.loadURL(launchUrl({ id: 7002 }, '?task=3'));
    await wait(1700);
    check(await js(`!!document.querySelector('.dialog-side')`), 'ссылка из бота открывает нужную задачу');
    check((await js(`document.querySelector('.panel-top')?.innerText`) || '').includes('№3'), 'открыта именно задача №3');
    await shot('tg_04_task');
    await js(`document.querySelector('.dialog-side').close()`); await wait(600);
    check((await js(`location.search`)) === '', 'после закрытия адрес чистый');

    // Подделка адреса не даёт входа.
    await js(`sessionStorage.clear()`);
    await wc.session.clearStorageData({ storages: ['cookies'] });
    await win.loadURL('about:blank');
    await win.loadURL(`${BASE}/#tgWebAppData=${encodeURIComponent('user=%7B%22id%22%3A7002%7D&auth_date=1&hash=abcd')}`);
    await wait(1300);
    check(!(await js(`document.querySelector('.shell')`)), 'поддельные данные не открывают приложение');
  } catch (e) {
    check(false, 'сценарий оборвался: ' + e.message);
  }
  console.log('console errors:', JSON.stringify(consoleErrors.filter(m => !/status of 4/.test(m))));
  const failed = results.filter(x => !x).length;
  console.log(`ИТОГ: ${results.length - failed} из ${results.length}`);
  server.kill();
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); app.exit(2); });
