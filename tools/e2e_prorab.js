// «Прораб» в настоящем браузере на телефоне: роли, отчёт, загрузка файла, контроль качества.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/e2e_prorab.js <out_dir>
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const outDir = process.argv.at(-1);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', '/tmp/tr_e2e_p_' + process.pid);
app.disableHardwareAcceleration();
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
const check = (ok, name) => { results.push(!!ok); console.log(ok ? 'ok  ' : 'FAIL', name); };

const PORT = 18810, DEMO = `http://127.0.0.1:${PORT}/`;
const WORK_PORT = 18811, WORK = `http://127.0.0.1:${WORK_PORT}/`;
const dir = fs.mkdtempSync('/tmp/tr_p_e2e_');
const dbFile = path.join(dir, 'p.sqlite');
const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
const servers = [
  spawn('node', ['--disable-warning=ExperimentalWarning', 'cases/03_stroyka/app/server.js'], { env: { ...nodeEnv, PORT, DB_FILE: dbFile, DEMO: '1' }, stdio: 'inherit' }),
  spawn('node', ['--disable-warning=ExperimentalWarning', 'cases/03_stroyka/app/server.js'], { env: { ...nodeEnv, PORT: WORK_PORT, DB_FILE: path.join(dir, 'w.sqlite'), DEMO: '', ADMIN_LOGIN: 'boss', ADMIN_PASSWORD: 'adminpass1' }, stdio: 'inherit' }),
];
const dbRows = (q, ...a) => { const d = new DatabaseSync(dbFile, { readOnly: true }); const r = d.prepare(q).all(...a); d.close(); return r; };

app.whenReady().then(async () => {
  await wait(2000);
  const win = new BrowserWindow({ show: true, width: 420, height: 860 });
  const wc = win.webContents;
  wc.on('console-message', e => { if (e.level === 'error') consoleErrors.push(e.message); });
  wc.debugger.attach('1.3');
  const js = c => wc.executeJavaScript(c);
  const q = (s, expr = 'el') => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); return el ? (${expr}) : null; })()`);
  const click = async (s, ms = 600) => { await js(`document.querySelector(${JSON.stringify(s)}).click()`); await wait(ms); };
  const clickText = async (sel, t, ms = 600) => { await js(`[...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.innerText.includes(${JSON.stringify(t)})).click()`); await wait(ms); };
  const type = (s, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); const p = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const choose = (s, text) => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); el.value = [...el.options].find(o => o.text.includes(${JSON.stringify(text)})).value; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const body = () => js('document.body.innerText');
  const shot = async n => { await wait(350); fs.writeFileSync(path.join(outDir, n + '.png'), (await wc.capturePage()).toPNG()); };
  const go = async h => { await js(`location.hash = ${JSON.stringify(h)}`); await wait(800); };
  const noOverflow = () => js('document.documentElement.scrollWidth <= window.innerWidth');
  const count = s => js(`document.querySelectorAll(${JSON.stringify(s)}).length`);
  // Сдвиг страницы и обрезанный текст: подпись может вылезти из ячейки, не сдвинув страницу.
  const clipped = () => js(`[...document.querySelectorAll('.metric span, .metric b, .segmented button, .tab, .site-tabs a, .chip, .pick, .btn, .qc-label, h1, h2')].filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map(e => e.innerText.slice(0, 24))`);
  const fine = async name => {
    check(await noOverflow(), `телефон: без сдвига, ${name}`);
    const bad = await clipped();
    check(!bad.length, `телефон: текст не вылезает, ${name}${bad.length ? ': ' + bad.join(' | ') : ''}`);
  };
  const logout = async () => { await go('/profile'); await click('#logout', 900); };
  const role = async r => { await click(`[data-role=${r}]`, 1300); };
  // Настоящий файл через поле выбора: как если бы человек снял фото 4000×3000.
  const pickPhoto = (selector, width = 4000, height = 3000) => js(`(async () => {
    const c = document.createElement('canvas'); c.width = ${width}; c.height = ${height};
    const g = c.getContext('2d'); g.fillStyle = '#7a8'; g.fillRect(0, 0, ${width}, ${height});
    for (let i = 0; i < 4000; i++) { g.fillStyle = 'hsl(' + (i % 360) + ',60%,50%)'; g.fillRect(Math.random() * ${width}, Math.random() * ${height}, 60, 60); }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const input = document.querySelector(${JSON.stringify(selector)});
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return blob.size;
  })()`);
  const pickBadFile = selector => js(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const dt = new DataTransfer(); dt.items.add(new File(['это не картинка'], 'virus.jpg', { type: 'image/jpeg' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  try {
    await win.loadURL(DEMO);
    await wait(900);
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
    await js('location.reload()');
    await wait(1200);
    await shot('10_login');
    await fine('вход');

    // ---------- Директор ----------
    await role('director');
    check((await q('h1', 'el.innerText')) === 'Сводка', 'директор попал на сводку');
    check((await q('[data-metric=active] b', 'el.innerText')) === '2', 'в работе 2 объекта');
    check(/Проблема: нет материалов/.test(await body()), 'проблема дня видна на сводке');
    await shot('11_summary');
    await fine('сводка');
    await click('[data-filter=hold]');
    check((await count('.site-card')) === 1 && /Сосновке/.test(await body()), 'фильтр по статусу');
    await click('[data-filter=all]');
    check((await count('.site-card')) === 4, 'фильтр «все»');
    check((await q('.badge', 'el.innerText')) === '2', 'колокольчик показывает непрочитанные');
    await go('/notifications');
    check(/нет материалов/.test(await body()), 'уведомление о проблеме');
    await wait(300);
    check(!(await q('.badge', '!!el')), 'уведомления прочитаны');
    await fine('уведомления');

    await go('/home');
    await click('[data-filter=all]', 300);
    await js(`document.querySelector('.site-card').click()`); await wait(900);
    await click('[data-tab=photos]', 1200);
    const shown = await count('.gallery .thumb');
    check(shown >= 5, `галерея показывает фото: ${shown}`);
    const broken = await js(`[...document.querySelectorAll('.gallery img')].filter(i => i.complete && i.naturalWidth === 0).length`);
    check(broken === 0, `фото загрузились, битых: ${broken}`);
    await shot('12_photos');
    await click('.gallery .thumb', 500);
    check((await q('.photo-full', '!!el')), 'фото открывается крупно');
    await js(`document.querySelector('dialog').close()`); await wait(300);
    await click('[data-tab=reports]', 900);
    await fine('отчёты');
    await click('.report-card', 900);
    check(/Что сделано/.test(await body()) && !(await q('#save-report', '!!el')), 'директор читает отчёт, а не пишет');
    await shot('13_report_read');

    await go('/home');
    await click('#new-site');
    await type('.dialog input[name=name]', 'Новый объект из проверки');
    await type('.dialog input[name=address]', '<img src=x onerror="window.__xss=1">');
    await choose('.dialog select[name=foreman]', 'Панин');
    await click('.dialog button[type=submit]', 1200);
    check((await q('h1', 'el.innerText')) === 'Новый объект из проверки', 'объект создан');
    check(!(await js('window.__xss')), 'разметка в адресе не выполнилась');
    await click('[data-tab=qc]', 900);
    check((await count('.qc-item')) === 12, 'контрольные списки созданы вместе с объектом');
    await go('/team');
    check((await count('.person')) === 7, 'директор видит людей');
    check(await js(`[...document.querySelectorAll('nav .tab')].every(t => t.offsetHeight < 62)`), 'подписи меню в одну строку');
    await fine('люди');
    await logout();

    // ---------- Прораб: отчёт с телефона ----------
    await role('foreman');
    check((await q('h1', 'el.innerText')) === 'Мои объекты', 'прораб попал на свои объекты');
    await shot('14_foreman');
    await fine('объекты прораба');
    check(/Заполнить отчёт за сегодня/.test(await body()), 'видно, что отчёт ещё не сдан');
    await clickText('.btn-primary', 'Заполнить отчёт', 900);
    await type('textarea[name=done]', 'Монтаж потолка, разметка перегородок');
    for (let i = 0; i < 4; i++) await click('#workers-plus', 40);
    await click('[data-problem=power]', 100);
    await type('input[name=problem-text]', 'Отключили свет на этаже');
    await shot('15_report_form');
    await fine('форма отчёта');
    await click('#save-report', 1100);
    check(/Отчёт за сегодня/.test(await body()), 'отчёт сохранён');
    const site = await js(`location.hash.split('/')[2]`);
    const saved = dbRows('SELECT workers, problems FROM reports WHERE site_id = ? ORDER BY id DESC LIMIT 1', Number(site))[0];
    check(saved.workers === 4 && saved.problems.includes('power'), 'в базе то, что ввели');
    await pickPhoto('[data-photo-input^="?report"]');
    await wait(2200);
    check((await count('.thumbs .thumb')) === 1, 'фото добавлено к отчёту');
    const photo = dbRows('SELECT size, type FROM photos WHERE seeded = 0 ORDER BY id DESC LIMIT 1')[0];
    check(photo.type === 'image/jpeg' && photo.size < 1500000, `снимок 4000×3000 уменьшен перед отправкой: ${Math.round(photo.size / 1024)} КБ`);
    const dims = await js(`(async () => { const i = document.querySelector('.thumbs img'); await i.decode(); return [i.naturalWidth, i.naturalHeight]; })()`);
    check(dims[0] === 1600 && dims[1] === 1200, `размер ${dims.join('×')}, пропорции сохранены`);
    await pickBadFile('[data-photo-input^="?report"]');
    await wait(900);
    check(/Не получилось открыть/.test(await body()), 'не картинка отклонена с понятным сообщением');
    await shot('16_report_saved');
    await click('#workers-plus', 40);
    await click('#save-report', 1000);
    check(dbRows('SELECT COUNT(*) AS n FROM reports WHERE site_id = ?', Number(site))[0].n >= 1 && dbRows('SELECT workers FROM reports WHERE site_id = ? ORDER BY id DESC LIMIT 1', Number(site))[0].workers === 5, 'правка в тот же день сохранилась');

    await go(`/site/${site}/tasks`);
    await type('input[name=task-title]', 'Задача из проверки');
    await choose('select[name=task-who]', 'Зуев');
    await click('.add-task button[type=submit]', 1000);
    check(/Задача из проверки/.test(await body()), 'задача создана');
    await fine('задачи объекта');
    await shot('17_site_tasks');
    await click('[data-tab=qc]', 900);
    await shot('18_qc');
    await fine('контроль качества');
    await click('[data-qc-kind=paint] .qc-item:nth-of-type(1) [data-state=fix]', 900);
    check((await count('[data-make-task]')) >= 1, 'дефект: появилась кнопка задачи');
    await logout();

    // ---------- Рабочий ----------
    await role('worker');
    check((await q('h1', 'el.innerText')) === 'Мои задачи', 'рабочий попал на свои задачи');
    check((await js(`[...document.querySelectorAll('nav .tab')].length`)) === 2, 'у рабочего только задачи и профиль');
    check(/Задача из проверки/.test(await body()), 'задача от прораба пришла');
    check((await q('.badge', '!!el')) === true, 'уведомление о новой задаче');
    await shot('19_worker');
    await fine('задачи рабочего');
    await click('.task-card [data-status=doing]', 800);
    await js(`[...document.querySelectorAll('.task-card')].find(c => c.innerText.includes('Задача из проверки')).querySelector('[data-status=done]').click()`);
    await wait(900);
    check(dbRows("SELECT status FROM tasks WHERE title = 'Задача из проверки'")[0].status === 'done', 'рабочий закрыл задачу');
    await go(`/site/${site}/tasks`);
    check(/Не найдено/.test(await body()), 'чужой объект рабочему не открывается');
    await go('/team');
    check(!/Люди/.test(await q('h1', 'el.innerText')), 'раздел людей рабочему закрыт');
    await logout();

    // ---------- Менеджер ----------
    await role('manager');
    check((await q('h1', 'el.innerText')) === 'Сводка', 'менеджер попал на сводку');
    check(!(await js(`[...document.querySelectorAll('nav .tab')].some(t => t.innerText === 'Люди')`)), 'раздела людей у менеджера нет');
    await logout();

    // ---------- Рабочий режим ----------
    await win.loadURL(WORK);
    await wait(1000);
    check(!(await q('[data-role]', '!!el')), 'в рабочем режиме нет демо-кнопок');
    await type('input[name=login]', 'boss');
    await type('input[name=password]', 'adminpass1');
    await click('form button[type=submit]', 1200);
    check(/Создайте первый объект/.test(await body()), 'пустое состояние понятно');
    await go('/team');
    await click('#invite');
    await type('.dialog input[name=name]', 'Новый Рабочий');
    await click('.dialog button[type=submit]', 700);
    const link = await q('.dialog input[readonly]', 'el.value');
    check(/#\/invite\//.test(link || ''), 'приглашение создано');
    await clickText('.dialog button', 'Готово');
    await logout();
    await js(`location.href = ${JSON.stringify(link)}`);
    await wait(900);
    await type('input[name=new-login]', 'novichok');
    await type('input[name=new-password]', 'password123');
    await click('.auth-card button[type=submit]', 1200);
    check((await q('h1', 'el.innerText')) === 'Мои задачи', 'рабочий вошёл по приглашению');
    await go('/profile');
    await type('input[name=old]', 'password123');
    await type('input[name=new]', 'password456');
    await js(`document.querySelectorAll('form')[1].querySelector('button').click()`);
    await wait(800);
    check(/Пароль изменён/.test(await body()), 'пароль меняется');
  } catch (e) {
    check(false, 'сценарий оборвался: ' + e.message);
  }
  console.log('console errors:', JSON.stringify([...new Set(consoleErrors)].filter(m => !/status of 4/.test(m))));
  const failed = results.filter(x => !x).length;
  console.log(`ИТОГ: ${results.length - failed} из ${results.length}`);
  servers.forEach(s => s.kill());
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); app.exit(2); });
