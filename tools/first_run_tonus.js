// Первый запуск «Тонуса»: снимки экранов каждой роли и ошибки из консоли, без исправлений.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/first_run_tonus.js <url> <out_dir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const [url, outDir] = process.argv.slice(-2);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', '/tmp/tr_first_t_' + process.pid);
app.disableHardwareAcceleration();
const wait = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 900 });
  const wc = win.webContents;
  wc.on('console-message', e => console.log('[console]', e.level, e.message, e.sourceId?.split('/').pop(), e.lineNumber));
  const js = c => wc.executeJavaScript(c);
  const shot = async n => { await wait(500); fs.writeFileSync(path.join(outDir, n + '.png'), (await wc.capturePage()).toPNG()); console.log('shot', n); };
  const text = async () => (await js('document.body.innerText')).slice(0, 300).replace(/\n/g, ' | ');
  await win.loadURL(url); await wait(1500);
  await shot('first_01_landing');
  console.log('body:', await text());
  await js(`document.querySelector('[data-role=client]')?.click()`); await wait(1500);
  await shot('first_02_today');
  console.log('body:', await text());
  await js(`location.hash='/charts/pressure/30'`); await wait(1200);
  await shot('first_03_charts');
  await js(`location.hash='/labs'`); await wait(1200);
  await shot('first_04_labs');
  await js(`location.hash='/experts'`); await wait(1200);
  await shot('first_05_experts');
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 2, mobile: true });
  await js(`location.hash='/today'`); await js('location.reload()'); await wait(1600);
  await shot('first_06_phone_today');
  await js(`location.hash='/charts/weight/30'`); await wait(1200);
  await shot('first_07_phone_charts');
  console.log('overflow:', await js('document.documentElement.scrollWidth') , '>', await js('window.innerWidth'));
  app.quit();
}).catch(e => { console.error(e); app.exit(1); });
