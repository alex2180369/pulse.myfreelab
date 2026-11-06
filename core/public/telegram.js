// Запуск внутри Telegram. Внешний скрипт Telegram не подключаем: правила безопасности страницы
// разрешают только свой код, а всё нужное Telegram передаёт в адресе страницы.
export const telegram = { initData: '', theme: null };

function post(event, data = '') {
  if (window.TelegramWebviewProxy?.postEvent) window.TelegramWebviewProxy.postEvent(event, data);
  else if (window.external?.notify) window.external.notify(JSON.stringify({ eventType: event, eventData: data }));
  else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType: event, eventData: data }), 'https://web.telegram.org');
}

function readLaunchParams() {
  const raw = location.hash.slice(1);
  if (!raw.includes('tgWebAppData=')) return JSON.parse(sessionStorage.getItem('tg') || 'null');
  const params = new URLSearchParams(raw);
  const launch = { initData: params.get('tgWebAppData'), theme: params.get('tgWebAppThemeParams') };
  sessionStorage.setItem('tg', JSON.stringify(launch));
  // Убираем данные из адреса, дальше он нужен для переходов внутри приложения.
  history.replaceState(null, '', `${location.pathname}${location.search}#/mine`);
  return launch;
}

function applyTheme(json) {
  let t;
  try { t = JSON.parse(json); } catch { return; }
  const root = document.documentElement.style;
  const set = (name, value) => { if (/^#[0-9a-f]{3,8}$/i.test(value || '')) root.setProperty(name, value); };
  set('--bg', t.secondary_bg_color || t.bg_color);
  set('--surface', t.bg_color);
  set('--surface-2', t.secondary_bg_color);
  set('--ink', t.text_color);
  set('--muted', t.hint_color);
  set('--accent', t.button_color);
  set('--accent-ink', t.button_text_color);
  if (t.button_color && t.bg_color) {
    root.setProperty('--accent-soft', `color-mix(in srgb, ${t.button_color} 18%, ${t.bg_color})`);
    root.setProperty('--line', `color-mix(in srgb, ${t.text_color || t.hint_color} 14%, ${t.bg_color})`);
  }
}

const launch = readLaunchParams();
if (launch?.initData) {
  telegram.initData = launch.initData;
  if (launch.theme) applyTheme(launch.theme);
  document.documentElement.classList.add('in-telegram');
}

let ready = false;
export function telegramReady() {
  if (ready || !telegram.initData) return;
  ready = true;
  post('web_app_ready');
  post('web_app_expand');
}
