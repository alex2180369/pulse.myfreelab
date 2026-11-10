// Файлы демо «Зачёта»: два PDF с материалами, таблица квадратов, чертёж трапеции к задаче, обложка главной.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/make_zachet_files.js <папка>
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const dir = process.argv.at(-1);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', '/tmp/tr_zf_' + process.pid);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const wait = ms => new Promise(r => setTimeout(r, ms));

const BASE = `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; overflow: hidden; } body { font: 16px/1.5 'DejaVu Sans', Arial, sans-serif; color: #1c2541; background: #fff; }
.page { box-sizing: border-box; padding: 40px 48px; }
h1 { font-size: 26px; color: #2340a8; margin: 0 0 6px; } .sub { color: #5b6380; margin: 0 0 24px; }
table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #c9d0e6; padding: 8px 12px; text-align: left; }
th { background: #eef1fb; } .f { font-size: 20px; } mark { background: #ffe066; padding: 0 4px; }
ol li { margin-bottom: 8px; } .note { margin-top: 24px; color: #5b6380; font-size: 13px; }
</style>`;

const FORMULAS = `${BASE}<div class="page"><h1>Формулы сокращённого умножения</h1><p class="sub">Шпаргалка к урокам алгебры, 7–9 класс</p>
<table><tr><th>Название</th><th>Формула</th></tr>
<tr><td>Квадрат суммы</td><td class="f">(a + b)² = a² + 2ab + b²</td></tr>
<tr><td>Квадрат разности</td><td class="f">(a − b)² = a² − 2ab + b²</td></tr>
<tr><td>Разность квадратов</td><td class="f">a² − b² = (a − b)(a + b)</td></tr>
<tr><td>Куб суммы</td><td class="f">(a + b)³ = a³ + 3a²b + 3ab² + b³</td></tr>
<tr><td>Куб разности</td><td class="f">(a − b)³ = a³ − 3a²b + 3ab² − b³</td></tr>
<tr><td>Сумма кубов</td><td class="f">a³ + b³ = (a + b)(a² − ab + b²)</td></tr>
<tr><td>Разность кубов</td><td class="f">a³ − b³ = (a − b)(a² + ab + b²)</td></tr></table>
<p>Совет: <mark>читайте формулы справа налево</mark> — так они помогают раскладывать на множители.</p>
<p class="note">Демо-материал MyFreeLab, учебный кейс «Зачёт».</p></div>`;

const PLAN = `${BASE}<div class="page"><h1>План подготовки к ОГЭ по математике</h1><p class="sub">8 недель до пробного экзамена</p>
<ol><li><b>Недели 1–2.</b> Вычисления, дроби, проценты. Задания 6–8.</li>
<li><b>Недели 3–4.</b> Уравнения и неравенства. Задания 9, 13, 20.</li>
<li><b>Неделя 5.</b> Функции и графики. Задание 11.</li>
<li><b>Неделя 6.</b> Геометрия: площади и углы. Задания 15–18.</li>
<li><b>Неделя 7.</b> Практические задачи первой части. Задания 1–5.</li>
<li><b>Неделя 8.</b> Пробный вариант с разбором ошибок.</li></ol>
<p>Каждую неделю: 2 занятия, 1 домашнее задание в кабинете, разбор слабых тем по статистике.</p>
<p class="note">Демо-материал MyFreeLab, учебный кейс «Зачёт».</p></div>`;

const SQUARES = (() => {
  let rows = '';
  for (let t = 1; t <= 9; t++) {
    rows += `<tr><th>${t}</th>${Array.from({ length: 10 }, (_, u) => `<td>${(t * 10 + u) ** 2}</td>`).join('')}</tr>`;
  }
  return `${BASE}<div class="page" style="width:900px"><h1>Таблица квадратов от 10 до 99</h1><p class="sub">Десятки — по строкам, единицы — по столбцам</p>
<table style="text-align:center"><tr><th></th>${Array.from({ length: 10 }, (_, u) => `<th>${u}</th>`).join('')}</tr>${rows}</table></div>`;
})();

const TRAPEZOID = `${BASE}<div class="page" style="width:560px;padding:20px">
<svg viewBox="0 0 520 260" width="520" height="260" font-family="DejaVu Sans, Arial" font-size="20">
<polygon points="60,220 460,220 330,70 160,70" fill="#eef1fb" stroke="#2340a8" stroke-width="3"/>
<line x1="160" y1="70" x2="160" y2="220" stroke="#c0392b" stroke-width="2" stroke-dasharray="6 5"/>
<text x="232" y="58">5</text><text x="250" y="250">13</text><text x="168" y="152" fill="#c0392b">4</text>
</svg></div>`;

const COVER = `${BASE}<div class="page" style="width:800px;height:520px;padding:0;background:#2340a8;position:relative;overflow:hidden">
<div style="position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.08) 1px,transparent 1px);background-size:32px 32px"></div>
<div style="position:absolute;left:60px;top:70px;color:#fff;font-size:64px;font-weight:700;line-height:1.15">a² + b² = c²</div>
<div style="position:absolute;left:60px;top:170px;color:#ffe066;font-size:40px">∫ π √x Σ</div>
<div style="position:absolute;right:70px;top:150px;width:200px;height:200px;border-radius:50%;background:#ffe066;opacity:.9;display:grid;place-items:center;color:#2340a8;font-size:88px;font-weight:700">5</div>
<div style="position:absolute;left:60px;bottom:60px;color:#fff;font-size:24px">Математика с понятными объяснениями</div></div>`;

async function render(win, html, width, height) {
  win.setContentSize(width, height);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await wait(500);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, useContentSize: true, width: 900, height: 700, frame: false });
  for (const [name, html] of [['formulas.pdf', FORMULAS], ['oge_plan.pdf', PLAN]]) {
    await render(win, html, 900, 700);
    fs.writeFileSync(path.join(dir, name), await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
    console.log('ok', name);
  }
  for (const [name, html, w, h] of [['squares.png', SQUARES, 900, 600], ['trapezoid.png', TRAPEZOID, 560, 300], ['cover.png', COVER, 800, 520]]) {
    await render(win, html, w, h);
    fs.writeFileSync(path.join(dir, name), (await win.webContents.capturePage()).toPNG());
    console.log('ok', name);
  }
  app.quit();
});
