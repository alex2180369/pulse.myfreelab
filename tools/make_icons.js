// Значки PWA из favicon.svg: electron --ozone-platform=headless --no-sandbox tools/make_icons.js <папка public>
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const dir = process.argv.at(-1);
app.setPath('userData', '/tmp/tr_icons_' + process.pid);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(dir, 'favicon.svg'), 'utf8').replace(/rx="\d+"/, 'rx="0"');
  for (const size of [192, 512]) {
    const win = new BrowserWindow({ show: true, useContentSize: true, width: size, height: size, frame: false });
    await win.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`));
    await new Promise(r => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `icon-${size}.png`), img.resize({ width: size, height: size }).toPNG());
    console.log('icon', size, img.getSize());
    win.destroy();
  }
  app.quit();
});
