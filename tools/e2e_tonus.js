// «Тонус» в настоящем браузере на телефоне: все роли, дневник, графики, анализы, запросы, запись, материалы.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/e2e_tonus.js <out_dir>
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const outDir = process.argv.at(-1);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', '/tmp/tr_e2e_t_' + process.pid);
app.disableHardwareAcceleration();
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
const check = (ok, name) => { results.push(!!ok); console.log(ok ? 'ok  ' : 'FAIL', name); };

const PORT = 18843, DEMO = `http://127.0.0.1:${PORT}/`;
const WORK_PORT = 18844, WORK = `http://127.0.0.1:${WORK_PORT}/`;
const dir = fs.mkdtempSync('/tmp/tr_t_e2e_');
const dbFile = path.join(dir, 't.sqlite');
const workDb = path.join(dir, 'w.sqlite');
const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
const servers = [
  spawn('node', ['--disable-warning=ExperimentalWarning', 'cases/04_zdorovie/app/server.js'], { env: { ...nodeEnv, PORT, DB_FILE: dbFile, DEMO: '1' }, stdio: 'inherit' }),
  spawn('node', ['--disable-warning=ExperimentalWarning', 'cases/04_zdorovie/app/server.js'], { env: { ...nodeEnv, PORT: WORK_PORT, DB_FILE: workDb, DEMO: '', ADMIN_LOGIN: 'boss', ADMIN_PASSWORD: 'adminpass1' }, stdio: 'inherit' }),
];
const rows = (file, q, ...a) => { const d = new DatabaseSync(file, { readOnly: true }); const r = d.prepare(q).all(...a); d.close(); return r; };
const dbRows = (q, ...a) => rows(dbFile, q, ...a);
const one = (q, ...a) => dbRows(q, ...a)[0];

app.whenReady().then(async () => {
  await wait(2000);
  const win = new BrowserWindow({ show: true, width: 420, height: 860 });
  const wc = win.webContents;
  wc.on('console-message', e => { if (e.level === 'error') consoleErrors.push(e.message); });
  wc.debugger.attach('1.3');
  const js = c => wc.executeJavaScript(c);
  const q = (s, expr = 'el') => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); return el ? (${expr}) : null; })()`);
  const click = async (s, ms = 700) => { await js(`document.querySelector(${JSON.stringify(s)}).click()`); await wait(ms); };
  const clickText = async (sel, t, ms = 700) => { await js(`[...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.innerText.includes(${JSON.stringify(t)})).click()`); await wait(ms); };
  const type = (s, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); const p = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const choose = (s, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(s)}); el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const body = () => js('document.body.innerText');
  const shot = async n => { await wait(350); fs.writeFileSync(path.join(outDir, n + '.png'), (await wc.capturePage()).toPNG()); };
  const go = async hash => { await js(`location.hash = ${JSON.stringify(hash)}`); await wait(900); };
  const count = s => js(`document.querySelectorAll(${JSON.stringify(s)}).length`);
  const toastText = () => js(`[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')`);
  const noOverflow = () => js('document.documentElement.scrollWidth <= window.innerWidth');
  // Сдвиг страницы и обрезанный текст: подпись может вылезти из ячейки, не сдвинув страницу.
  const clipped = () => js(`[...document.querySelectorAll('.tab, .chip, .btn, .tile span, .tile b, .tile small, .segmented a, .segmented button, .picker button, .days-pick button, .field-label, .lab-num, .slot-time, .kind, h1, h2, h3')]
    .filter(e => e.offsetParent && (e.scrollWidth > e.clientWidth + 1)).map(e => e.innerText.slice(0, 24))`);
  const fine = async name => {
    check(await noOverflow(), `телефон: без сдвига, ${name}`);
    const bad = await clipped();
    check(!bad.length, `телефон: текст не вылезает, ${name}${bad.length ? ': ' + bad.join(' | ') : ''}`);
  };
  const phone = () => wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 2, mobile: true });
  const desktop = () => wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const logout = async () => { await go('/more'); await click('#logout', 1000); };
  const role = async r => { await click(`[data-role=${r}]`, 1500); };
  const pickFile = (selector, kind) => js(`(async () => {
    let file;
    if (${JSON.stringify(kind)} === 'pdf') file = new File(['%PDF-1.4\\n%настоящий pdf для проверки\\n'], 'анализ.pdf', { type: 'application/pdf' });
    else if (${JSON.stringify(kind)} === 'bad') file = new File(['это не картинка'], 'virus.png', { type: 'image/png' });
    else {
      const c = document.createElement('canvas'); c.width = 800; c.height = 600;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 800, 600); g.fillStyle = '#000'; g.fillText('Бланк', 40, 40);
      file = new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'бланк.png', { type: 'image/png' });
    }
    const input = document.querySelector(${JSON.stringify(selector)});
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  try {
    await win.loadURL(DEMO);
    await wait(900);
    await phone();
    await js('location.reload()');
    await wait(1400);

    // ---------- Без входа ----------
    check(await count('[data-role]') === 5, 'главная: пять ролей демо');
    check(await count('#free-menu, #free-food, #free-training, #free-articles') === 4, 'главная: меню, уроки, статьи без входа');
    await shot('10_landing');
    await fine('главная');
    await click('#free-menu ~ .mat-grid [data-material]', 1000);
    check((await body()).includes('День 1') && (await body()).includes('ккал'), 'пробное меню открывается без входа');
    await fine('материал без входа');
    await go('/');

    // ---------- Клиент ----------
    await role('client');
    check(await count('#entry') === 1 && (await body()).includes('Сегодня'), 'клиент попадает на «Сегодня»');
    check(await count('[data-demo-note]') === 1, 'предупреждение: не вводить настоящие данные');
    await shot('11_today');
    await fine('сегодня');
    // Поле может не вылезать за край, но быть таким узким, что цифры обрезаны: меряем место под текст.
    const room = s => q(s, 'el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight)');
    check(await room('[name=sys]') >= 32 && await room('[name=dia]') >= 32 && await room('[name=weight]') >= 40, `поля давления и веса вмещают цифры: ${await room('[name=sys]')}px`);
    await type('[name=weight]', '70,1');
    await type('[name=sys]', '124');
    await type('[name=dia]', '81');
    await type('[name=pulse]', '68');
    await type('[name=steps]', '10450');
    await click('[data-picker=stress] [data-v="3"]', 200);
    await click('#save-entry', 1300);
    const anna = one("SELECT id FROM users WHERE login = 'anna'").id;
    const today = one('SELECT MAX(day) AS d FROM measurements WHERE user_id = ?', anna).d;
    const saved = Object.fromEntries(dbRows('SELECT metric, v1, v2 FROM measurements WHERE user_id = ? AND day = ?', anna, today).map(r => [r.metric, [r.v1, r.v2]]));
    check(saved.weight?.[0] === 70.1 && saved.pressure?.[0] === 124 && saved.pressure?.[1] === 81 && saved.activity?.[0] === 10450 && saved.stress?.[0] === 3, `дневник сохранён в базе: ${JSON.stringify(saved)}`);
    check(await q('[data-tile=steps] b', 'el.innerText.replace(/\\s/g, " ")') === '10 450', 'плитка шагов обновилась');
    check(await q('[name=weight]', 'el.value') === '70,1', 'вес в поле с запятой');
    await type('[name=pulse]', '');
    await type('[name=sys]', '300');
    await click('#save-entry', 900);
    check((await toastText()).includes('Давление'), 'невозможное давление: понятная ошибка');
    check(one("SELECT v1 FROM measurements WHERE user_id = ? AND day = ? AND metric = 'pulse'", anna, today)?.v1 === 68, 'при ошибке ничего не удалено');
    await go('/charts');
    await go('/today');
    const dose = await q('[data-dose] .take:not(.done)', 'el.closest("[data-dose]").dataset.dose');
    if (dose) {
      await click(`[data-dose="${dose}"] .take`, 1000);
      const [medId, time] = dose.split('-');
      check(!!one('SELECT 1 AS x FROM med_intakes WHERE med_id = ? AND time = ?', Number(medId), time), 'приём лекарства отмечен');
    } else check(false, 'есть неотмеченный приём лекарства');

    await go('/charts/pressure/30');
    check(await count('#chart svg polyline') === 2, 'давление: две линии');
    check(await q('[data-change] b', 'el.innerText.length > 0'), 'сравнение с прошлым периодом показано');
    await shot('12_charts_pressure');
    await fine('графики давления');
    await go('/charts/activity/90');
    check(await count('#chart svg rect') > 40, 'шаги за 90 дней столбцами');
    await go('/charts/weight/7');
    check((await body()).includes('цель 68'), 'цель видна на графике веса');
    await fine('графики веса');

    await go('/labs');
    check(await count('[data-lab]') === 2, 'два анализа из демо');
    check((await body()).includes('В демо файлы не прикладываются') || await count('[data-file-input]') === 0, 'в демо загрузки файлов нет');
    await click('[data-file]', 900);
    check(await q('.dialog-photo img', 'el.complete && el.naturalWidth > 0'), 'пример бланка открывается');
    await js(`document.querySelector('dialog').close()`);
    await click('#new-lab', 600);
    await type('[name=lab-glucose]', '5,6');
    await type('[name=lab-cholesterol]', '6.2');
    await type('[name=lab-hemoglobin]', '119');
    await clickText('dialog button', 'Сохранить', 1300);
    const levels = await js(`[...document.querySelector('[data-lab]').querySelectorAll('[data-level]')].map(e => e.dataset.level).join(',')`);
    check(levels === 'warn,bad,warn', `подсказки на границах: ${levels}`);
    check((await body()).includes('не диагноз'), 'пометка: не диагноз');
    await shot('13_labs');
    await fine('анализы');

    await go('/experts');
    await shot('14_experts');
    await fine('эксперты');
    await click('[data-ask=nutritionist]', 600);
    await type('[name=ask-message]', 'Хочу меню на неделю');
    await clickText('dialog button', 'Отправить', 900);
    check((await toastText()).includes('согласие') || (await toastText()).includes('Нужно'), 'без согласия запрос не уходит');
    check(await count('dialog[open]') === 1, 'окно запроса осталось открытым');
    await js(`document.querySelector('[name=ask-consent]').click()`);
    await clickText('dialog button', 'Отправить', 1300);
    check((await toastText()).includes('Запрос отправлен') || !!one("SELECT 1 AS x FROM requests WHERE message = 'Хочу меню на неделю'"), 'запрос нутрициологу ушёл');
    const free = await q('[data-book]', 'el.dataset.book');
    await click(`[data-book="${free}"]`, 600);
    await js(`document.querySelector('[name=book-consent]').click()`);
    await clickText('dialog button', 'Записаться', 1300);
    check(!!one('SELECT 1 AS x FROM bookings WHERE slot_id = ? AND client_id = ?', Number(free), anna), 'запись на тренировку');
    check(await count('[data-unbook]') >= 2, 'отменить запись можно');
    check((await body()).includes('Мест нет') || (await body()).includes('Вы записаны'), 'полная группа видна');
    const doctorId = one("SELECT id FROM users WHERE login = 'morozova'").id;
    await click(`[data-revoke="${doctorId}"]`, 600);
    await clickText('dialog button', 'Закрыть доступ', 1300);
    check(!one('SELECT 1 AS x FROM access WHERE client_id = ? AND specialist_id = ?', anna, doctorId), 'доступ врача закрыт');
    check(one("SELECT status FROM requests WHERE client_id = ? AND specialist_id = ? AND kind = 'labs' ORDER BY id DESC", anna, doctorId).status === 'cancelled', 'открытый запрос врачу отменён');

    await go('/more');
    await fine('ещё');
    await click('[data-more=goals]', 900);
    await type('[name=goal-sleep]', '8');
    await js(`document.querySelector('[data-goal-form=sleep] button[type=submit]').click()`);
    await wait(1000);
    check(one("SELECT target FROM goals WHERE user_id = ? AND metric = 'sleep'", anna)?.target === 8, 'цель сна сохранена');
    await fine('цели');
    await go('/more/meds');
    await click('#new-med', 600);
    await type('[name=med-name]', 'Омега-3');
    await type('[name=med-dose]', '1 капсула');
    await clickText('dialog button', '+ ещё время', 300);
    await click('[data-day="1"]', 100);
    await click('[data-day="4"]', 100);
    await clickText('dialog button', 'Сохранить', 1100);
    const med = one("SELECT times, days FROM meds WHERE user_id = ? AND name = 'Омега-3'", anna);
    check(med && med.times === '["09:00","21:00"]' && med.days === '[1,4]', `лекарство с двумя приёмами по дням: ${JSON.stringify(med)}`);
    await shot('15_meds');
    await fine('лекарства');
    await go('/more/profile');
    await type('[name=height]', '165');
    await js(`document.querySelector('#profile-form button[type=submit]').click()`);
    await wait(900);
    await go('/today');
    check((await q('[data-tile=weight] small', 'el.innerText')).includes('25,7'), 'ИМТ пересчитан после смены роста');
    await go('/notifications');
    check(await count('[data-notice]') >= 1, 'уведомления клиента');
    await fine('уведомления');
    await logout();
    check(await count('[data-role]') === 5, 'после выхода снова главная');

    // ---------- Врач ----------
    await role('doctor');
    check((await body()).includes('Запросы'), 'врач попадает на запросы');
    await shot('20_doctor_requests');
    await fine('запросы врача');
    const igorReq = one("SELECT r.id FROM requests r JOIN users u ON u.id = r.client_id WHERE u.login = 'igor' AND r.status = 'new'").id;
    await click(`[data-request="${igorReq}"]`, 1300);
    check(await count('[data-client-data] [data-lab]') === 1, 'врач видит анализ клиента');
    check(await count('[data-summary] svg') >= 5, 'и показатели за 30 дней');
    await click('#take-request', 1100);
    check(one('SELECT status FROM requests WHERE id = ?', igorReq).status === 'work', 'запрос взят в работу');
    await type('[name=answer]', 'Холестерин повышен. Нужна липидограмма, приходите на приём.');
    await click('#send-answer', 1200);
    check(one('SELECT status FROM requests WHERE id = ?', igorReq).status === 'done', 'ответ отправлен');
    check(!!one("SELECT 1 AS x FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.login = 'igor' AND n.kind = 'answer'"), 'клиенту пришло уведомление');
    await shot('21_doctor_request');
    await fine('запрос врача');
    await go(`/client/${anna}`);
    check((await body()).includes('Не найдено'), 'после закрытия доступа Анна врачу не видна');
    await go('/articles');
    await click('#new-article', 900);
    await type('[name=mat-title]', 'Как подготовиться к анализу крови');
    await type('[name=mat-body]', 'Натощак, утром.\n\n- Без кофе\n- Без нагрузки');
    await click('#save-material', 1200);
    check((await body()).includes('Без кофе'), 'врач опубликовал статью');
    await logout();

    // ---------- Нутрициолог ----------
    await role('nutritionist');
    const menuReq = one("SELECT id FROM requests WHERE message = 'Хочу меню на неделю'").id;
    await go(`/request/${menuReq}`);
    check((await q('[name=answer]', 'el.value')).includes('## День 1'), 'шаблон меню подставлен');
    await type('[name=answer]', '## День 1\n- Завтрак: омлет\n- Обед: суп');
    await click('#send-answer', 1200);
    check(one('SELECT status FROM requests WHERE id = ?', menuReq).status === 'done', 'меню отправлено');
    await fine('запрос нутрициолога');
    await logout();

    // ---------- Тренер ----------
    await role('trainer');
    check((await body()).includes('Расписание'), 'тренер попадает на расписание');
    check(/^[А-Я][а-я]+, \d+ [а-я]+$/.test(await q('.day-head', 'el.innerText')), `день недели с заглавной, месяц со строчной: ${await q('.day-head', 'el.innerText')}`);
    await shot('30_trainer');
    await fine('расписание');
    const before = one('SELECT COUNT(*) AS n FROM slots').n;
    await click('#new-slot', 600);
    await type('[name=slot-kind]', 'Растяжка');
    await type('[name=slot-time]', '20:30');
    await clickText('dialog button', 'Добавить', 1200);
    check(one('SELECT COUNT(*) AS n FROM slots').n === before + 1, 'тренировка добавлена');
    const slot = one("SELECT id FROM slots WHERE kind = 'Растяжка'").id;
    await click(`[data-cancel-slot="${slot}"]`, 600);
    await clickText('dialog button', 'Отменить тренировку', 1100);
    check(!one('SELECT 1 AS x FROM slots WHERE id = ?', slot), 'тренировка отменена');
    await go(`/client/${anna}`);
    check(await count('[data-client-data] [data-lab]') === 0 && await count('[data-summary]') === 3, 'тренер видит только шаги, вес и пульс');
    await fine('клиент у тренера');
    await logout();

    // ---------- Администратор ----------
    await role('admin');
    check(await count('[data-person]') === 7, 'администратор видит людей');
    check(!(await body()).includes('70,1'), 'и не видит данные о здоровье');
    await fine('люди');
    await go('/articles');
    await click('#new-article', 900);
    await choose('[name=mat-kind]', 'lesson');
    await choose('[name=mat-section]', 'training');
    await type('[name=mat-title]', 'Урок 4. Растяжка после работы');
    await type('[name=mat-body]', 'Пять упражнений на 10 минут.');
    await type('[name=mat-video]', 'javascript:alert(1)');
    await click('#save-material', 900);
    check((await toastText()).includes('https'), 'опасная ссылка на видео отклонена');
    await type('[name=mat-video]', 'https://example.com/video');
    await click('#save-material', 1200);
    check(!!one("SELECT 1 AS x FROM materials WHERE kind = 'lesson' AND title = 'Урок 4. Растяжка после работы'"), 'урок добавлен');
    await shot('40_admin_material');
    await click('#edit-material', 900);
    await click('#delete-material', 600);
    await clickText('dialog button', 'Удалить', 1100);
    check(!one("SELECT 1 AS x FROM materials WHERE title = 'Урок 4. Растяжка после работы'"), 'урок удалён');
    await logout();

    // ---------- Рабочий режим: регистрация и настоящие файлы ----------
    await win.loadURL(WORK);
    await wait(1200);
    check(await count('[data-role]') === 0 && (await body()).includes('Зарегистрироваться'), 'рабочий режим: без демо-ролей');
    await go('/register');
    await type('[name=reg-name]', 'Пётр');
    await type('[name=reg-login]', 'petr');
    await type('[name=reg-password]', 'password123');
    await choose('[name=reg-sex]', 'm');
    await type('[name=reg-height]', '180');
    await clickText('button', 'Создать аккаунт', 900);
    check((await toastText()).includes('согласие'), 'без согласия регистрации нет');
    await js(`document.querySelector('[name=reg-consent]').click()`);
    await clickText('button', 'Создать аккаунт', 1500);
    check(await count('#entry') === 1, 'после регистрации — дневник');
    await fine('регистрация');
    await go('/labs');
    await click('#new-lab', 600);
    await type('[name=lab-hemoglobin]', '135');
    await clickText('dialog button', 'Сохранить', 1300);
    check(await q('[data-level]', 'el.dataset.level') === 'ok', 'гемоглобин 135 у мужчины в норме');
    await pickFile('[data-file-input]', 'pdf');
    await wait(1300);
    await pickFile('[data-file-input]', 'png');
    await wait(1300);
    await pickFile('[data-file-input]', 'bad');
    await wait(1200);
    check((await toastText()).includes('не похож'), 'поддельная картинка отклонена');
    const files = rows(workDb, 'SELECT name, type FROM lab_files');
    check(files.length === 2 && files.some(f => f.type === 'application/pdf') && files.some(f => f.type === 'image/png'), `приложены PDF и PNG: ${JSON.stringify(files)}`);
    check(await count('[data-file]') === 2, 'файлы видны в карточке');
    await click('button[data-file]', 900);
    check(await q('.dialog-photo img', 'el.complete && el.naturalWidth === 800'), 'картинка открывается целиком');
    await js(`document.querySelector('dialog').close()`);
    await shot('50_work_labs');
    await fine('анализы с файлами');

    // ---------- Снимки для тетради на компьютере ----------
    await win.loadURL(DEMO);
    await desktop();
    await js('location.reload()');
    await wait(1200);
    await shot('final_01_landing');
    await role('client');
    await shot('final_02_today');
    await go('/charts/weight/90');
    await shot('final_03_charts');
    await go('/labs');
    await shot('final_04_labs');
    await logout();
    await role('doctor');
    await go(`/request/${one("SELECT r.id FROM requests r JOIN users u ON u.id = r.client_id WHERE u.login = 'maria' AND r.kind = 'labs'").id}`);
    await shot('final_05_doctor');
    await phone();
    await logout();
    await role('client');
    await shot('final_06_phone_today');
    await go('/charts/pressure/30');
    await shot('final_07_phone_charts');
  } catch (e) {
    console.error(e);
    check(false, 'сценарий без исключений: ' + e.message);
  }
  check(consoleErrors.length === 0, `ошибок в консоли нет${consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''}`);
  const passed = results.filter(Boolean).length;
  console.log(`\nИтого: ${passed} из ${results.length}`);
  for (const s of servers) s.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(passed === results.length ? 0 : 1);
});
