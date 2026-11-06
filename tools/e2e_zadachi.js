// Сквозная проверка интерфейса «Пульса задач» в настоящем браузере.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/e2e_zadachi.js <demo_url> <work_url> <out_dir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const [demoUrl, workUrl, outDir] = process.argv.slice(-3);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', '/tmp/tr_e2e_' + process.pid);
app.disableHardwareAcceleration();

const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
const check = (ok, name) => { results.push([!!ok, name]); console.log(ok ? 'ok  ' : 'FAIL', name); };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1366, height: 860 });
  const wc = win.webContents;
  wc.on('console-message', e => { if (e.level === 'error') consoleErrors.push(e.message); });
  wc.debugger.attach('1.3');
  const cdp = (m, p) => wc.debugger.sendCommand(m, p);
  const js = c => wc.executeJavaScript(c);
  const q = (s, expr = 'el') => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); return el ? (${expr}) : null; })()`);
  const text = s => q(s, 'el.innerText');
  const click = async s => { await js(`document.querySelector(${JSON.stringify(s)}).click()`); await wait(450); };
  const clickText = async (sel, t) => { await js(`[...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.innerText.includes(${JSON.stringify(t)})).click()`); await wait(450); };
  const type = async (s, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); const p = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const shot = async n => { await wait(350); fs.writeFileSync(path.join(outDir, n + '.png'), (await wc.capturePage()).toPNG()); };
  const go = async h => { await js(`location.hash = ${JSON.stringify(h)}`); await wait(600); };
  const center = s => js(`(() => { const r = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const noOverflow = () => js(`document.documentElement.scrollWidth <= window.innerWidth`);
  const logoutDemo = async () => { await go('/settings'); await click('#logout'); await wait(300); };

  const mouseDrag = async (from, to) => {
    wc.focus();
    wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
    wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    await wait(60);
    for (let i = 1; i <= 8; i++) {
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * i / 8), y: Math.round(from.y + (to.y - from.y) * i / 8), button: 'left', modifiers: ['leftButtonDown'] });
      await wait(25);
    }
    wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await wait(800);
  };

  const touch = (type, p) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y }] });

  try {
    // ---------- Демо, компьютер ----------
    await win.loadURL(demoUrl);
    await wait(900);
    check(await q('[data-role=lead]', '!!el'), 'на входе есть демо-кнопки');
    await click('[data-role=lead]');
    await wait(600);
    check((await text('h1')) === 'Мои задачи', 'вход в роли руководителя');
    check(/просрочено/i.test(await js('document.body.innerText')), 'просрочки видны на главном экране');
    await shot('10_mine');

    await type('#quick-title', '<img src=x onerror="window.__xss=1">Проверка');
    await click('.quick-add button');
    await wait(500);
    check(await js(`[...document.querySelectorAll('.task-row-title')].some(x => x.textContent.startsWith('<img'))`), 'разметка в названии показана как текст');
    check(!(await js('window.__xss')), 'разметка из названия не выполнилась');

    await clickText('.task-row', 'Проверка');
    check(await q('.dialog-side', '!!el'), 'карточка задачи открылась');
    await type('#comment-input', 'Комментарий из проверки');
    await click('.task-panel form button[type=submit]');
    await wait(500);
    check((await text('.comments')).includes('Комментарий из проверки'), 'комментарий появился');
    await click('.segmented [data-status=progress]');
    await wait(500);
    check((await text('.history')).includes('В работе'), 'смена статуса попала в историю');
    await js(`(() => { const s = document.querySelector('.task-panel select[name=assignee]'); s.value = [...s.options].find(o => o.text.includes('Дарья')).value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(600);
    check((await text('.history')).includes('Дарья'), 'смена ответственного попала в историю');
    await shot('11_task');
    await clickText('.panel-top button', 'Закрыть');
    await wait(500);
    check(!(await q('.dialog-side', '!!el')), 'карточка закрылась');

    const dupes = await js(`(() => { const ids = [...document.querySelectorAll('.task-row')].map(x => x.dataset.task); return ids.length - new Set(ids).size; })()`);
    check(dupes === 0, 'на главном экране задачи не дублируются');
    const someId = await js(`document.querySelector('.task-row').dataset.task`);
    await go('/task/' + someId);
    await wait(500);
    check(await q('.dialog-side', '!!el'), 'карточка открывается по прямой ссылке');
    const oldTitle = await q('.title-input', 'el.value');
    await type('.title-input', '   ');
    await wait(700);
    check((await q('.title-input', 'el.value')) === oldTitle, 'пустое название не остаётся в поле');
    check((await js('document.body.innerText')).includes('Заполните поле'), 'ошибка пустого названия показана');
    await js(`document.querySelector('.dialog-side').close()`);
    await wait(500);
    check((await js('location.hash')) === '#/mine', 'после закрытия ссылка возвращается на главную');
    await go('/board');
    const before = await js(`document.querySelector('.column-new .card .card-title').innerText`);
    const id = await js(`document.querySelector('.column-new .card').dataset.task`);
    await shot('12_board');
    await mouseDrag(await center('.column-new .card'), await center('.column-review .column-cards'));
    await wait(400);
    check(await js(`!!document.querySelector('.column-review [data-task="${id}"]')`), `мышью: «${before}» перенесена на проверку`);
    await js('location.reload()');
    await wait(1200);
    check(await js(`!!document.querySelector('.column-review [data-task="${id}"]')`), 'после перезагрузки статус сохранился');
    check(!(await q('.dialog-side', '!!el')), 'перетаскивание не открыло карточку');

    await click('.page-head .btn-primary');
    await type('.dialog input[name=title]', 'Создана с доски');
    await click('.dialog button[type=submit]');
    await wait(600);
    check(await js(`document.querySelector('.board').innerText.includes('Создана с доски')`), 'новая задача появилась на доске');

    await js(`(() => { const s = document.querySelector('select[name=filter-assignee]'); s.value = [...s.options].find(o => o.text.includes('София')).value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(800);
    const names = await js(`[...document.querySelectorAll('.card .avatar')].map(a => a.title)`);
    check(names.length > 0 && names.every(n => n.includes('София')), 'фильтр по исполнителю работает');

    await go('/projects');
    await shot('13_projects');
    await click('.page-head .btn-primary');
    await type('.dialog input[name=name]', 'Проект из проверки');
    await js(`[...document.querySelectorAll('.dialog .check')].find(x => x.innerText.includes('Илья')).querySelector('input').click()`);
    await click('.dialog button[type=submit]');
    await wait(600);
    check((await js('document.body.innerText')).includes('Проект из проверки'), 'проект создан');
    await js(`document.querySelector('.project-open').click()`);
    await wait(900);
    check((await js('location.hash')).includes('project='), 'из проекта открывается доска с фильтром');

    await go('/team');
    await shot('14_team');
    check((await text('.members')).includes('в работе'), 'руководитель видит загрузку команды');

    await go('/settings');
    await shot('15_settings');
    await click('[data-setting=digest]');
    await wait(500);
    await js('location.reload()');
    await wait(1100);
    check(await q('[data-setting=digest]', '!el.checked'), 'настройка напоминаний сохранилась');
    await click('[data-setting=digest]');
    await wait(300);
    await logoutDemo();
    check(await q('[data-role=member]', '!!el'), 'выход работает');

    // ---------- Демо, сотрудник ----------
    await click('[data-role=member]');
    await wait(600);
    await go('/board');
    const ownCard = await js(`[...document.querySelectorAll('.column-progress .card.draggable, .column-new .card.draggable')][0]?.dataset.task`);
    check(!!ownCard, 'сотрудник может двигать свою задачу');
    await mouseDrag(await center(`[data-task="${ownCard}"]`), await center('.column-done .column-cards'));
    check(await js(`!document.querySelector('.column-done [data-task="${ownCard}"]')`), 'сотрудник не перетащит задачу в «Готово»');
    check(/принимает руководитель/.test(await js('document.body.innerText')), 'отказ объяснён сообщением');
    const cards = await js(`[...document.querySelectorAll('.card')].map(c => c.innerText)`);
    check(cards.length > 0, `сотрудник видит задачи своих проектов: ${cards.length}`);
    check(!(await js('document.querySelector(".board").innerText')).includes('Продлить домен'), 'чужой проект сотруднику не виден');
    await go('/team');
    check(!(await text('.members')).includes('в работе'), 'сотрудник не видит загрузку коллег');
    await go('/mine');
    await js(`document.querySelector('.task-row').click()`);
    await wait(700);
    check(await q('.segmented [data-status=done]', 'el.disabled'), 'кнопка «Готово» для сотрудника закрыта');
    check(!(await js(`document.querySelector('.task-panel').innerText`)).includes('Удалить задачу'), 'удаления у сотрудника нет');
    check(!(await q('.task-panel select[name=assignee]', '!!el')), 'выбор ответственного скрыт');
    await shot('16_task_member');
    await js(`document.querySelector('.dialog-side').close()`);
    await wait(300);
    await logoutDemo();

    // ---------- Телефон 360 ----------
    await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
    await js('location.reload()');
    await wait(1100);
    await shot('20_m_login');
    await click('[data-role=lead]');
    await wait(700);
    for (const [h, n] of [['/mine', 'mine'], ['/board', 'board'], ['/projects', 'projects'], ['/team', 'team'], ['/settings', 'settings']]) {
      await go(h);
      check(await noOverflow(), `телефон: нет сдвига вбок, ${n}`);
      await shot(`21_m_${n}`);
    }
    await go('/mine');
    check(await js(`[...document.querySelectorAll('.task-row-title')].every(t => t.getBoundingClientRect().width > 250)`), 'телефон: названию хватает ширины');
    check(await js(`[...document.querySelectorAll('.nav-item')].every(n => n.offsetHeight < 56)`), 'телефон: подписи меню в одну строку');
    await go('/board');
    check(await js(`getComputedStyle(document.querySelector('.sidebar')).position === 'fixed'`), 'телефон: нижнее меню');
    const mId = await js(`document.querySelector('.column-progress .card').dataset.task`);
    await js(`document.querySelector('.board').scrollLeft = 0`);
    const from = await center('.column-new .card');
    const tid = await js(`document.querySelector('.column-new .card').dataset.task`);
    await touch('touchStart', from);
    await wait(450); // удержание
    const edge = { x: 345, y: from.y };
    for (let i = 1; i <= 6; i++) { await touch('touchMove', { x: from.x + (edge.x - from.x) * i / 6, y: from.y }); await wait(30); }
    // Держим палец у края, пока нужная колонка не окажется посреди экрана.
    let reached = false;
    for (let i = 0; i < 120 && !reached; i++) {
      reached = await js(`document.elementFromPoint(180, ${from.y})?.closest('.column')?.dataset.status === 'progress'`);
      await wait(16);
    }
    check(reached, 'пальцем: у края экрана доска сама доехала до соседней колонки');
    // Как человек: увёл палец от края, доска остановилась, отпустил над колонкой.
    await touch('touchMove', { x: 180, y: from.y });
    await wait(150);
    const stopped = await js(`(async () => { const b = document.querySelector('.board'); const a = b.scrollLeft; await new Promise(r => setTimeout(r, 120)); return a === b.scrollLeft; })()`);
    check(stopped, 'пальцем: вдали от края доска не едет');
    const landed = await js(`document.elementFromPoint(180, ${from.y})?.closest('.column')?.dataset.status`);
    await shot('22_m_drag');
    await touch('touchEnd');
    await wait(900);
    check(landed && landed !== 'new', `пальцем: под пальцем другая колонка (${landed})`);
    check(await js(`!!document.querySelector('.column-${landed} [data-task="${tid}"]')`), 'пальцем: карточка легла туда, где отпустили');
    check(await js(`getComputedStyle(document.querySelector('.board')).scrollSnapType.includes('x')`), 'пальцем: прилипание колонок вернулось');
    await js(`document.querySelector('.board').scrollLeft = 0`);
    const quick = await center('.column-new .card');
    const scrollBefore = await js(`document.querySelector('.board').scrollLeft`);
    await touch('touchStart', quick);
    await wait(40);
    await touch('touchEnd');
    await wait(500);
    check(await q('.dialog-side', '!!el'), 'короткое касание открывает карточку, а не перетаскивает');
    check(await q('.dialog-side', "!['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName)"), 'телефон: клавиатура не выскакивает при открытии');
    await js(`document.querySelector('.dialog-side').close()`);
    void scrollBefore;
    await wait(300);
    await js(`document.querySelector('.column-progress .card').click()`);
    await wait(700);
    check(await noOverflow(), 'телефон: карточка задачи без сдвига');
    check(await js(`(() => { const r = document.querySelector('.dialog-side').getBoundingClientRect(); return r.left === 0 && r.width === 360; })()`), 'телефон: карточка на весь экран');
    await shot('23_m_task');
    await js(`document.querySelector('.dialog-side').close()`);
    void mId;
    await cdp('Emulation.clearDeviceMetricsOverride');
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: false });

    // ---------- Рабочий режим: вход, приглашение, профиль, пароль ----------
    await win.loadURL(workUrl);
    await wait(900);
    check(await q('input[name=login]', '!!el'), 'в рабочем режиме форма входа');
    check(!(await q('[data-role]', '!!el')), 'демо-кнопок в рабочем режиме нет');
    await type('input[name=login]', 'boss');
    await type('input[name=password]', 'неверный');
    await click('form button[type=submit]');
    await wait(500);
    check((await js('document.body.innerText')).includes('Неверный логин'), 'ошибка входа понятна');
    await type('input[name=password]', 'adminpass1');
    await click('form button[type=submit]');
    await wait(900);
    check((await text('h1')) === 'Мои задачи', 'вход администратора');
    check((await js('document.body.innerText')).includes('Всё сделано'), 'пустое состояние понятно');
    await shot('30_empty');

    await go('/team');
    await click('.page-head .btn-primary');
    await type('.dialog input[name=name]', 'Новый Сотрудник');
    await click('.dialog button[type=submit]');
    await wait(600);
    const link = await q('.dialog input[readonly]', 'el.value');
    check(/#\/invite\//.test(link || ''), 'ссылка-приглашение создана');
    await shot('31_invite');
    await clickText('.dialog button', 'Готово');
    await go('/settings');
    await click('#logout');
    await wait(400);

    await js(`location.href = ${JSON.stringify(link)}`);
    await wait(900);
    check((await js('document.body.innerText')).includes('Новый Сотрудник, добро пожаловать'), 'страница приглашения');
    await type('.auth-card input[autocomplete=username]', 'novichok');
    await type('.auth-card input[autocomplete=new-password]', 'password123');
    await click('.auth-card button[type=submit]');
    await wait(1000);
    check((await text('h1')) === 'Мои задачи', 'новый участник вошёл по приглашению');

    await go('/settings');
    await type('input[name=name]', 'Сотрудник Изменённый');
    await click('.settings form button[type=submit]');
    await wait(800);
    check((await text('.whoami-name')) === 'Сотрудник Изменённый', 'имя меняется и показывается сразу');
    await type('input[name=old]', 'password123');
    await type('input[name=new]', 'password456');
    await js(`document.querySelectorAll('.settings form')[1].querySelector('button').click()`);
    await wait(800);
    check((await js('document.body.innerText')).includes('Пароль изменён'), 'пароль меняется через интерфейс');
    await click('#logout');
    await wait(500);
    await type('input[name=login]', 'novichok');
    await type('input[name=password]', 'password456');
    await click('form button[type=submit]');
    await wait(900);
    check((await text('h1')) === 'Мои задачи', 'вход с новым паролем');

    await win.loadURL(workUrl + '#/invite/ненастоящая-ссылка');
    await wait(900);
    check((await js('document.body.innerText')).includes('не работает'), 'неверное приглашение объяснено');
  } catch (e) {
    check(false, 'сценарий оборвался: ' + e.message);
  }
  console.log('console errors:', JSON.stringify(consoleErrors.filter(m => !m.includes('status of 40')), null, 0));
  const failed = results.filter(r => !r[0]).length;
  console.log(`ИТОГ: ${results.length - failed} из ${results.length}`);
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); app.exit(2); });
