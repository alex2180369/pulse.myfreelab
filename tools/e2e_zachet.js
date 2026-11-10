// «Зачёт» в настоящем браузере на телефоне: главная, ученик, родитель, репетитор, рабочий режим с приглашениями.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/e2e_zachet.js <out_dir>
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const outDir = process.argv.at(-1);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', '/tmp/tr_e2e_z_' + process.pid);
app.disableHardwareAcceleration();
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const consoleErrors = [];
const check = (ok, name) => { results.push(!!ok); console.log(ok ? 'ok  ' : 'FAIL', name); };

const PORT = 18853, DEMO = `http://127.0.0.1:${PORT}/`;
const WORK_PORT = 18854, WORK = `http://127.0.0.1:${WORK_PORT}/`;
const dir = fs.mkdtempSync('/tmp/tr_z_e2e_');
const dbFile = path.join(dir, 'z.sqlite');
const workDb = path.join(dir, 'w.sqlite');
const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
const servers = [
  spawn('node', ['--disable-warning=ExperimentalWarning', 'cases/05_repetitor/app/server.js'], { env: { ...nodeEnv, PORT, DB_FILE: dbFile, DEMO: '1' }, stdio: 'inherit' }),
  spawn('node', ['--disable-warning=ExperimentalWarning', 'cases/05_repetitor/app/server.js'], { env: { ...nodeEnv, PORT: WORK_PORT, DB_FILE: workDb, DEMO: '', ADMIN_LOGIN: 'olga', ADMIN_PASSWORD: 'adminpass1', ADMIN_NAME: 'Ольга' }, stdio: 'inherit' }),
];
const rowsOf = (file, q, ...a) => { const d = new DatabaseSync(file, { readOnly: true }); const r = d.prepare(q).all(...a); d.close(); return r; };
const one = (q, ...a) => rowsOf(dbFile, q, ...a)[0];
const uid = login => one('SELECT id FROM users WHERE login = ?', login).id;

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
  // Обрезанный текст и узкие поля: таблица журнала листается внутри себя, её не считаем.
  const clipped = () => js(`[...document.querySelectorAll('.tab, .chip, .btn, .tile > span, .tile b, .tile small, .q-num, .q-text, .option, .lesson-time, .doc-icon, .day-head, .week-nav span, h1, h2, h3')]
    .filter(e => e.offsetParent && !e.closest('.table-wrap') && (e.scrollWidth > e.clientWidth + 1)).map(e => e.innerText.slice(0, 24))`);
  const fine = async name => {
    check(await noOverflow(), `телефон: без сдвига, ${name}`);
    const bad = await clipped();
    check(!bad.length, `телефон: текст не вылезает, ${name}${bad.length ? ': ' + bad.join(' | ') : ''}`);
  };
  const phone = () => wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 2, mobile: true });
  const desktop = () => wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const logout = async () => { await go('/profile'); await click('#logout', 1100); };
  const role = async r => { await click(`[data-role=${r}]`, 1500); };
  const pickImage = (selector, w = 2400, h = 1800) => js(`(async () => {
    const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, ${w}, ${h}); g.fillStyle = '#2340a8'; g.font = '120px sans-serif'; g.fillText('x = 2ab', 200, 400);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const input = document.querySelector(${JSON.stringify(selector)});
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const pickFile = (selector, name, type, content) => js(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  try {
    await win.loadURL(DEMO);
    await wait(900);
    await phone();
    await js('location.reload()');
    await wait(1500);

    // ---------- Главная без входа ----------
    check((await body()).includes('Ольга Петрова'), 'главная репетитора открывается без входа');
    check(await count('[data-block]') === 5 && await count('[data-role]') === 3, 'блоки главной и три роли демо');
    check(await count('#public-materials [data-material]') === 1, 'без входа виден только открытый материал');
    const pdfStatus = await js(`fetch(document.querySelector('#public-materials a[data-open]').href).then(r => r.status + ' ' + r.headers.get('content-type'))`);
    check(pdfStatus === '200 application/pdf', `открытый PDF по ссылке без входа: ${pdfStatus}`);
    await shot('10_landing');
    await fine('главная');
    await type('[name=lead-name]', 'Посетитель');
    await type('[name=lead-contact]', '+7 900 000-00-00');
    await click('#send-lead', 900);
    check((await toastText()).includes('согласие'), 'заявка без согласия не уходит');
    await js(`document.querySelector('[name=lead-consent]').click()`);
    await click('#send-lead', 1000);
    check((await q('#lead-done', 'el.innerText')).includes('демо'), 'заявка принята, в демо не сохраняется');
    check(one('SELECT COUNT(*) AS n FROM leads').n === 0, 'контакты посетителя не сохранены');

    // ---------- Ученик ----------
    await role('student');
    check((await body()).includes('Привет, Даня'), 'ученик попадает на «Сегодня»');
    check(await count('#next-lessons [data-lesson]') >= 1 && (await body()).includes('Перенесено с'), 'ближайшие занятия и перенос видны');
    await shot('11_student_today');
    await fine('сегодня ученика');
    const powers = one("SELECT id FROM assignments WHERE title = 'Степени'").id;
    await go(`/task/${powers}`);
    check(await count('[data-question]') === 5 && await count('#submit-task') === 1, 'задание открыто для выполнения');
    const qs = rowsOf(dbFile, 'SELECT id, kind FROM questions WHERE assignment_id = ? ORDER BY position', powers);
    check(!(await js('document.body.innerHTML')).includes('верно'), 'до сдачи правильные ответы не показаны');
    await type(`[name=q${qs[0].id}]`, ' 32 ');
    await js(`document.querySelector('[name=q${qs[1].id}][value="0"]').click()`);
    await type(`[name=q${qs[2].id}]`, '81');
    await js(`document.querySelector('[name=q${qs[3].id}][value="0"]').click(); document.querySelector('[name=q${qs[3].id}][value="2"]').click()`);
    await type(`[name=q${qs[4].id}]`, '(2a²b)³ = 8a⁶b³, делим на 4a⁵b², получаем 2ab');
    await shot('12_task_form');
    await fine('выполнение задания');
    await pickImage(`[data-photo-input="${qs[4].id}"]`);
    await wait(2000);
    const photo = one("SELECT f.size FROM files f WHERE f.kind = 'answer' ORDER BY id DESC");
    check(photo && photo.size < 900 * 1024, `фото решения уменьшено и приложено: ${photo?.size} байт`);
    check(await count(`[data-question="${qs[4].id}"] .thumb`) === 1, 'миниатюра фото видна');
    check((await q(`[name=q${qs[0].id}]`, 'el.value')) === '32' && (await q(`[name=q${qs[4].id}]`, 'el.value')).includes('2ab'), 'набранные ответы не потерялись после загрузки фото (сервер убирает пробелы по краям)');
    const draft = one('SELECT status, answers FROM submissions WHERE assignment_id = ? AND student_id = ?', powers, uid('danya'));
    check(draft?.status === 'draft' && JSON.parse(draft.answers)[qs[2].id] === '81', 'черновик сохранён в базе');
    await click('#submit-task', 600);
    await clickText('dialog button', 'Сдать', 1500);
    const sub = one('SELECT status, score, max_score FROM submissions WHERE assignment_id = ? AND student_id = ?', powers, uid('danya'));
    check(sub.status === 'submitted' && sub.score === 5 && sub.max_score === 8, `сдано, автопроверка 5 из 8, развёрнутый ждёт: ${JSON.stringify(sub)}`);
    check(await count('#result') === 1 && await count('#submit-task') === 0, 'после сдачи только результат');
    check(await count('.option.right') >= 3, 'правильные варианты показаны после сдачи');
    await shot('13_task_result');
    await fine('результат');
    const linear = one("SELECT id FROM assignments WHERE title = 'Линейные уравнения'").id;
    await go(`/task/${linear}`);
    check(await q('.score-big', 'el.innerText.includes("из")') && await count('[data-points]') >= 4, 'проверенная работа: баллы по вопросам');
    await go('/progress');
    check(await count('#progress-chart polyline') === 1 && await count('[data-topic]') >= 4, 'прогресс: график и темы');
    check(await count('.topic.weak') >= 1 && await count('#weak') === 1, 'слабые темы отмечены');
    await shot('14_progress');
    await fine('прогресс');
    await go('/schedule');
    check(await count('[data-lesson]') >= 1, 'расписание недели');
    await click('#week-next', 900);
    check(await count('[data-lesson]') >= 2, 'следующая неделя листается');
    await fine('расписание ученика');
    await go('/materials');
    check(await count('[data-material]') === 3, 'ученику видны открытые, общие и выданные ему материалы');
    await click('button[data-open]', 900);
    check(await q('.dialog-photo img', 'el.complete && el.naturalWidth > 0'), 'картинка открывается в приложении');
    await js(`document.querySelector('dialog').close()`);
    await fine('материалы');
    await logout();

    // ---------- Родитель ----------
    await role('parent');
    check((await body()).includes('Даня Смирнов'), 'родитель видит ребёнка');
    await go(`/task/${powers}`);
    check(await count('#submit-task') === 0 && await count('#result') === 1, 'родитель видит результат, но не сдаёт');
    await go('/progress');
    check(await count('#progress-chart polyline') === 1, 'родитель видит прогресс');
    await shot('20_parent_progress');
    await fine('прогресс родителя');
    await go('/tasks');
    await fine('задания родителя');
    await logout();

    // ---------- Репетитор ----------
    await role('tutor');
    check(await count('#journal tbody tr') === 5, 'журнал: пять учеников');
    check(await count('[data-review]') === 3, 'ждут проверки три работы, включая новую');
    await shot('30_journal');
    await fine('журнал');
    const dSub = one('SELECT id FROM submissions WHERE assignment_id = ? AND student_id = ?', powers, uid('danya')).id;
    await click(`[data-review="${dSub}"]`, 1200);
    check(await count('.thumb') === 1, 'репетитор видит фото решения');
    await type(`[name=score-${qs[4].id}]`, '5');
    await click('#save-check', 900);
    check((await toastText()).includes('от 0 до 3'), 'больше максимума не поставить');
    await type(`[name=score-${qs[4].id}]`, '3');
    await type('[name=check-comment]', 'Отлично, всё верно');
    await shot('31_check');
    await click('#save-check', 1300);
    const checked = one('SELECT status, score, comment FROM submissions WHERE id = ?', dSub);
    check(checked.status === 'checked' && checked.score === 8 && checked.comment === 'Отлично, всё верно', `проверено: ${JSON.stringify(checked)}`);
    check(['danya', 'smirnova'].every(l => one("SELECT 1 AS x FROM notifications WHERE user_id = ? AND kind = 'checked' AND text LIKE '%Степени%'", uid(l))), 'ученик и мама получили оценку');
    await fine('проверка');

    await go('/edit/new');
    await type('[name=task-title]', 'Корни');
    await js(`document.querySelector('[name=task-student-${uid('anya')}]').click()`);
    await click('#save-task', 900);
    check((await toastText()).includes('Вопрос 1') && !one("SELECT 1 AS x FROM assignments WHERE title = 'Корни'"), 'пустой вопрос не сохраняется, ошибка понятна');
    await type('[name=q-text-0]', 'Чему равен √49?');
    await type('[name=q-opt-0-0]', '7');
    await type('[name=q-opt-0-1]', '49');
    await click('[data-add-q=short]', 300);
    await click('[data-add-q=multi]', 300);
    await click('[data-add-q=long]', 300);
    await js(`document.querySelector('[name="q-correct-0"]').click()`);
    await type('[name=q-text-1]', 'Вычислите √0,25');
    await type('[name=q-short-1]', '0,5\n1/2');
    await type('[name=q-text-2]', 'Какие числа — точные квадраты?');
    await type('[name=q-opt-2-0]', '16');
    await type('[name=q-opt-2-1]', '18');
    await click('[data-add-option="2"]', 300);
    await type('[name=q-opt-2-2]', '25');
    await js(`document.querySelectorAll('[name="q-correct-2"]')[0].click(); document.querySelectorAll('[name="q-correct-2"]')[2].click()`);
    await type('[name=q-text-3]', 'Докажите, что √2 — иррациональное число');
    await pickImage('[data-q-image="0"]', 800, 600);
    await wait(1500);
    check(await count('[data-q-edit="0"] .q-img') === 1, 'рисунок к вопросу загружен');
    await shot('32_editor');
    await fine('конструктор');
    await click('#save-task', 1300);
    const roots = one("SELECT id FROM assignments WHERE title = 'Корни'");
    const rq = roots ? rowsOf(dbFile, 'SELECT kind, correct, image_id FROM questions WHERE assignment_id = ? ORDER BY position', roots.id) : [];
    check(rq.map(x => x.kind).join() === 'single,short,multi,long' && rq[0].correct === '0' && rq[1].correct === '["0,5","1/2"]' && rq[2].correct === '[0,2]' && rq[0].image_id, `задание собрано: ${JSON.stringify(rq)}`);
    check(!!one("SELECT 1 AS x FROM notifications WHERE user_id = ? AND text LIKE 'Новое задание: Корни%'", uid('anya')), 'Ане пришло задание');
    await fine('карточка задания');

    await go('/schedule');
    const before = one('SELECT COUNT(*) AS n FROM lessons').n;
    await click('#new-lesson', 600);
    await choose('[name=lesson-student]', uid('misha'));
    await type('[name=lesson-time]', '12:30');
    await choose('[name=lesson-repeat]', 4);
    await clickText('dialog button', 'Добавить', 1200);
    check(one('SELECT COUNT(*) AS n FROM lessons').n === before + 5, 'серия из 5 занятий добавлена');
    const mishaLesson = one("SELECT id, day FROM lessons WHERE student_id = ? AND time = '12:30' ORDER BY day", uid('misha'));
    await click(`[data-move="${mishaLesson.id}"]`, 600);
    await type('[name=lesson-time]', '14:00');
    await clickText('dialog button', 'Перенести', 1200);
    const series = rowsOf(dbFile, "SELECT time, moved_from FROM lessons WHERE student_id = ? AND (time = '12:30' OR time = '14:00') ORDER BY day", uid('misha'));
    check(series[0].time === '14:00' && series[0].moved_from && series.slice(1).every(l => l.time === '12:30'), 'перенос одного не сдвинул остальные');
    await shot('33_schedule');
    await fine('расписание репетитора');
    await click('#week-prev', 900);
    const past = await q('[data-missed]', 'el.dataset.missed');
    if (past) {
      await click(`[data-missed="${past}"]`, 1000);
      check(one('SELECT status FROM lessons WHERE id = ?', Number(past)).status === 'missed', 'пропуск отмечен');
    } else check(false, 'на прошлой неделе есть занятие для отметки');

    await go('/students');
    await fine('ученики');
    await click(`[data-student="${uid('liza')}"]`, 1200);
    await type('[name=goal]', 'ЕГЭ 85+');
    await js(`document.querySelector('#student-form button[type=submit]').click()`);
    await wait(800);
    check(one('SELECT goal FROM students WHERE user_id = ?', uid('liza')).goal === 'ЕГЭ 85+', 'цель ученика сохранена');
    await choose('[name=add-parent]', uid('smirnova'));
    await wait(1000);
    check(!!one('SELECT 1 AS x FROM parent_links WHERE parent_id = ? AND student_id = ?', uid('smirnova'), uid('liza')), 'родитель привязан ко второму ребёнку');
    await fine('карточка ученика');

    await go('/materials');
    await pickFile('[data-material-input]', 'Конспект.pdf', 'application/pdf', '%PDF-1.4\n% конспект\n');
    await wait(700);
    await choose('[name=mat-access]', 'selected');
    await js(`document.querySelector('[name=mat-student-${uid('liza')}]').click()`);
    await clickText('dialog button', 'Сохранить', 1300);
    const mat = one("SELECT m.id, m.access FROM materials m WHERE m.title = 'Конспект'");
    check(mat?.access === 'selected' && !!one('SELECT 1 AS x FROM material_access WHERE material_id = ? AND student_id = ?', mat.id, uid('liza')), 'материал загружен и открыт только Лизе');
    await pickFile('[data-material-input]', 'virus.pdf', 'application/pdf', 'это не pdf');
    await wait(600);
    await clickText('dialog button', 'Сохранить', 1100);
    check((await toastText()).includes('не похож'), 'поддельный PDF отклонён');
    await js(`document.querySelector('dialog')?.close()`);
    await fine('материалы репетитора');

    await go('/page');
    await click('[data-edit-block="about"]', 600);
    await type('[name=page-about]', 'Новый текст о себе для проверки.');
    await clickText('dialog button', 'Сохранить', 1000);
    check((await body()).includes('Новый текст о себе'), 'блок главной изменён');
    await fine('редактор главной');
    await go('/leads');
    check((await body()).includes('не сохраняются'), 'в демо заявки не копятся');
    await logout();
    check((await body()).includes('Новый текст о себе'), 'посетитель сразу видит правку главной');

    // ---------- Рабочий режим: приглашения ----------
    await win.loadURL(WORK);
    await wait(1200);
    check(await count('[data-role]') === 0, 'рабочий режим без демо-ролей');
    await go('/login');
    await type('[name=login]', 'olga');
    await type('[name=password]', 'adminpass1');
    await clickText('button', 'Войти', 1300);
    check((await body()).includes('Журнал'), 'репетитор вошёл');
    await go('/students');
    await click('#invite-student', 500);
    await type('[name=invite-name]', 'Пётр Новиков');
    await clickText('dialog button', 'Создать ссылку', 900);
    const link = await q('dialog input[readonly]', 'el.value');
    check(/#\/invite\/[\w-]{20,}$/.test(link || ''), 'ссылка-приглашение создана');
    await js(`document.querySelector('dialog').close()`);
    await go('/profile');
    await click('#logout', 1000);
    await win.loadURL(link);
    await wait(1200);
    await type('[name=new-login]', 'petr');
    await type('[name=new-password]', 'password123');
    await clickText('button', 'Войти', 1500);
    check((await body()).includes('Привет, Пётр'), 'ученик зарегистрировался по приглашению');
    check(rowsOf(workDb, "SELECT role FROM users WHERE login = 'petr'")[0]?.role === 'student', 'роль ученика');
    await fine('новый ученик');

    // ---------- Снимки для тетради ----------
    await win.loadURL(DEMO);
    await desktop();
    await js('location.reload()');
    await wait(1300);
    await shot('final_01_landing');
    await role('tutor');
    await shot('final_02_journal');
    await go('/edit/new');
    await shot('final_03_editor');
    await logout();
    await role('student');
    await go(`/task/${linear}`);
    await shot('final_04_result');
    await go('/progress');
    await shot('final_05_progress');
    await phone();
    await go('/today');
    await shot('final_06_phone_today');
    await go('/tasks');
    await shot('final_07_phone_tasks');
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
