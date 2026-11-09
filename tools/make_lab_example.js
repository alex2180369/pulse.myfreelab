// Пример бланка анализа для демо «Тонуса»: выдуманная лаборатория и пациент.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/make_lab_example.js <файл.png>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const out = process.argv.at(-1);
app.setPath('userData', '/tmp/tr_lab_' + process.pid);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const html = `<!doctype html><meta charset="utf-8"><style>
html, body { overflow: hidden; } body { margin: 0; background: #fff; font: 15px/1.45 'DejaVu Sans', Arial, sans-serif; color: #1d2b33; }
.page { box-sizing: border-box; width: 760px; padding: 36px 44px; }
.head { display: flex; justify-content: space-between; border-bottom: 3px solid #2f6f9f; padding-bottom: 12px; }
.lab { font-size: 22px; font-weight: 700; color: #2f6f9f; }
.small { font-size: 12.5px; color: #5b6b75; }
h2 { font-size: 17px; margin: 22px 0 10px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #d8e0e5; }
th { font-size: 12.5px; color: #5b6b75; font-weight: 600; }
.stamp { margin-top: 26px; display: flex; justify-content: space-between; align-items: end; }
.mark { border: 2px solid #c0392b; color: #c0392b; padding: 6px 12px; transform: rotate(-4deg); font-weight: 700; }
</style><div class="page">
<div class="head"><div><div class="lab">Лаборатория «Пример»</div><div class="small">Демо-бланк для портфолио. Организация и пациент выдуманы.</div></div>
<div class="small" style="text-align:right">Заказ № 000-0000<br>Дата взятия: см. карточку анализа</div></div>
<p><b>Пациент:</b> Анна С., ж<br><b>Материал:</b> венозная кровь, натощак</p>
<h2>Результаты</h2>
<table><tr><th>Показатель</th><th>Результат</th><th>Ед. изм.</th><th>Референсный интервал</th></tr>
<tr><td>Глюкоза</td><td><b>5,2</b></td><td>ммоль/л</td><td>3,3–5,5</td></tr>
<tr><td>Холестерин общий</td><td><b>5,0</b></td><td>ммоль/л</td><td>до 5,2</td></tr>
<tr><td>Гемоглобин</td><td><b>124</b></td><td>г/л</td><td>120–150</td></tr></table>
<div class="stamp"><div class="small">Результаты не являются диагнозом.<br>Интерпретацию проводит врач.</div><div class="mark">ОБРАЗЕЦ</div></div>
</div>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, useContentSize: true, width: 760, height: 560, frame: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 500));
  const h = await win.webContents.executeJavaScript('document.querySelector(".page").offsetHeight');
  win.setContentSize(760, h);
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
  console.log('ok', out, h);
  app.quit();
});
