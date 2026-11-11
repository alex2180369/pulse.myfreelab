// Обход всех пяти демо: каждая роль, экраны по ссылкам, три ширины. Ищет обрезанный текст и сдвиг страницы.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/sweep_layout.js <out_dir> [кейсы через запятую]
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs'), path = require('path');
const self = process.argv.findIndex(a => a.endsWith('sweep_layout.js'));
const [outDir = '/tmp/sweep', onlyArg = null] = process.argv.slice(self + 1);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', '/tmp/tr_sweep_' + process.pid);
app.disableHardwareAcceleration();
const wait = ms => new Promise(r => setTimeout(r, ms));
const dir = fs.mkdtempSync('/tmp/tr_sweep_db_');
const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
const WIDTHS = [[1536, 864, false], [1024, 768, false], [390, 844, true]];

// Ненастоящий Telegram: бот «Пульса» узнаёт своё имя и получает пустые обновления.
const tg = http.createServer((req, res) => {
  const method = req.url.split('/').pop();
  const reply = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (method === 'getMe') return reply({ ok: true, result: { id: 1, is_bot: true, first_name: 'Пульс', username: 'task_pulse_treker_bot' } });
  if (method === 'getUpdates') return setTimeout(() => reply({ ok: true, result: [] }), 1000);
  return reply({ ok: true, result: true });
}).listen(18879);

const CASES = [
  { key: '01_zadachi', port: 18870, env: { DEMO: '1', BOT_TOKEN: '1:test', PUBLIC_URL: 'http://127.0.0.1:18870', TELEGRAM_API: 'http://127.0.0.1:18879', BOT_POLL_TIMEOUT: '1' } },
  { key: '02_privychki', port: 18871, env: { SANDBOX: '1' }, sandbox: true },
  { key: '03_stroyka', port: 18872, env: { DEMO: '1' } },
  { key: '04_zdorovie', port: 18873, env: { DEMO: '1' } },
  { key: '05_repetitor', port: 18874, env: { DEMO: '1' } },
].filter(c => !onlyArg || onlyArg.split(',').some(k => c.key.startsWith(k)));

const servers = CASES.map(c => spawn('node', ['--disable-warning=ExperimentalWarning', `cases/${c.key}/app/server.js`], {
  env: { ...nodeEnv, PORT: c.port, DB_FILE: path.join(dir, `${c.key}.sqlite`), ...c.env }, stdio: ['ignore', 'ignore', 'inherit'],
}));

// Ищем самый вложенный элемент, содержимое которого шире его самого: обрезанный текст
// или кнопка, вылезшая за край карточки. Блоки с прокруткой вбок не считаем: там это задумано.
const CHECK = `(() => {
  const issues = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth + 1) issues.push('страница шире экрана: ' + doc.scrollWidth + ' > ' + window.innerWidth);
  const scrollBox = el => { const ox = getComputedStyle(el).overflowX; return ox === 'auto' || ox === 'scroll'; };
  const inScroll = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrollBox(p)) return true; return false; };
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('dialog:not([open])') || el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    if (['inline', 'contents', 'none'].includes(cs.display) || !el.clientWidth) continue;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'IMG', 'CANVAS'].includes(el.tagName)) continue;
    if (cs.textOverflow === 'ellipsis' || scrollBox(el) || inScroll(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1) bad.push(el);
  }
  for (const el of bad.filter(el => !bad.some(o => o !== el && el.contains(o)))) {
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    issues.push(el.tagName.toLowerCase() + cls + ': «' + el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60) + '» ' + el.scrollWidth + ' > ' + el.clientWidth);
  }
  return issues.slice(0, 15);
})()`;

const report = [];
app.whenReady().then(async () => {
  await wait(2500);
  const win = new BrowserWindow({ show: true, width: 1536, height: 864 });
  const wc = win.webContents;
  wc.debugger.attach('1.3');
  const js = c => wc.executeJavaScript(c);
  const size = ([w, h, mobile]) => wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  let shots = 0;

  for (const c of CASES) try {
    const base = `http://127.0.0.1:${c.port}/`;
    await wc.session.clearStorageData();
    await win.loadURL(base);
    await size(WIDTHS[0]);
    await wait(1500);
    const roles = c.sandbox ? ['sandbox'] : await js(`[...new Set([...document.querySelectorAll('[data-role]')].map(b => b.dataset.role))]`);
    console.log(`\n== ${c.key}: роли ${roles.join(', ')}`);
    const visit = async (route, who) => {
      for (const w of WIDTHS) {
        await size(w);
        await wait(400);
        const issues = await js(CHECK);
        if (issues.length) {
          report.push({ case: c.key, role: who, route, width: w[0], issues });
          console.log(`  [${w[0]}] ${who} ${route}\n    ${issues.join('\n    ')}`);
          if (shots < 60) fs.writeFileSync(path.join(outDir, `${c.key}_${who}_${route.replace(/[^\w]+/g, '_')}_${w[0]}.png`), (await wc.capturePage()).toPNG());
          shots++;
        }
      }
      await size(WIDTHS[0]);
    };
    // Страница без входа тоже экран: главная, вход.
    await visit('#/', 'гость');
    for (const role of roles) {
      await wc.session.clearStorageData();
      await win.loadURL(base);
      await size(WIDTHS[0]);
      await wait(1300);
      if (c.sandbox) await js(`document.querySelector('#sandbox').click()`);
      else await js(`document.querySelector('[data-role="${role}"]').click()`);
      await wait(1800);
      const seen = new Set();
      const shapes = {};
      const queue = [await js('location.hash || "#/"')];
      let count = 0;
      while (queue.length && count < 16) {
        const route = queue.shift();
        if (seen.has(route)) continue;
        seen.add(route);
        const shape = route.replace(/\d+/g, 'N');
        shapes[shape] = (shapes[shape] || 0) + 1;
        if (shapes[shape] > 2) continue;
        await js(`location.hash = ${JSON.stringify(route)}`);
        await wait(1100);
        count++;
        await visit(route, role);
        const links = await js(`[...document.querySelectorAll('a[href^="#/"]')].map(a => a.getAttribute('href')).filter(h => !/invite|logout/.test(h))`);
        for (const l of links) if (!seen.has(l)) queue.push(l);
      }
      console.log(`  ${role}: экранов ${count}`);
    }
  } catch (e) {
    console.log(`  ${c.key}: обход прерван: ${e.message}`);
    report.push({ case: c.key, error: e.message });
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`\nИтого мест с замечаниями: ${report.length}`);
  for (const s of servers) s.kill();
  tg.close();
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
// Сторож: зависший обход не должен висеть больше 12 минут.
setTimeout(() => { fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1)); console.log('Сторож: время вышло'); app.exit(2); }, 12 * 60e3).unref();
