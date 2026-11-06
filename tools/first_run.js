// Снимок первого запуска в браузере без экрана, плюс все ошибки из консоли.
// electron --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/first_run.js <url> <out_dir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const [url, outDir] = process.argv.slice(-2);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', '/tmp/tr_e2e_' + process.pid);
app.disableHardwareAcceleration();
const wait = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1366, height: 860 });
  win.webContents.on('console-message', e => console.log('[console]', e.level, e.message, e.sourceId?.split('/').pop(), e.lineNumber));
  win.webContents.on('did-fail-load', (_e, c, d, u) => console.log('[fail]', c, d, u));
  const js = c => win.webContents.executeJavaScript(c);
  const shot = async n => { await wait(500); fs.writeFileSync(path.join(outDir, n + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('shot', n); };
  await win.loadURL(url); await wait(1200);
  const pre = process.env.PREFIX || 'first';
  await shot(pre + '_01_login');
  console.log('body:', (await js('document.body.innerText')).slice(0, 300).replace(/\n/g, ' | '));
  await js(`document.querySelector('[data-role=lead]')?.click()`); await wait(1500);
  await shot(pre + '_02_mine');
  console.log('body:', (await js('document.body.innerText')).slice(0, 400).replace(/\n/g, ' | '));
  await js(`location.hash='/board'`); await wait(1200);
  await shot(pre + '_03_board');
  if (process.env.PHONE) {
    wc_phone: {
      const wc = win.webContents; wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
      await js('location.reload()'); await wait(1200);
      await shot(pre + '_04_phone_board');
      await js(`location.hash='/mine'`); await wait(900);
      await shot(pre + '_05_phone_mine');
    }
  }
  app.quit();
}).catch(e => { console.error(e); app.exit(1); });
