'use strict';
// Telegram-бот «Пульса задач».
// Бот не имеет своих прав: всё, что меняет задачи, он делает через тот же API от имени человека.
const crypto = require('node:crypto');
const { HttpError, createSession, now, tx, randomToken } = require('../../../core');
const { parseTaskText, localParts } = require('../../../core/dateparse');

const STATUS = { new: 'Новая', progress: 'В работе', review: 'На проверке', done: 'Готово' };
const ROLE = { admin: 'Администратор', lead: 'Руководитель', member: 'Сотрудник' };
const HOUR = 3600e3;
const LINK_MINUTES = 15;
const MANAGERS = ['admin', 'lead'];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const isManagerRole = r => MANAGERS.includes(r);

// ---------- Вход в веб-приложение внутри Telegram ----------

// Проверка подписи данных по правилам Telegram: подделать их без токена бота нельзя.
function verifyInitData(initData, token, maxAgeSeconds = 86400) {
  if (typeof initData !== 'string' || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

class Telegram {
  constructor(token, base) { this.url = `${base}/bot${token}`; }
  async call(method, params = {}, timeoutMs = 20000) {
    const res = await fetch(`${this.url}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (!data.ok) {
      const err = new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
      err.code = data.error_code;
      err.retryAfter = data.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }
}

function startBot({ db, app, port, token, telegramBase, publicUrl, demo, tz, tickMs = 30000, pollTimeout = 25 }) {
  const tg = new Telegram(token, telegramBase);
  const sessions = new Map();
  const pending = new Map();
  const actions = new Map();
  let botUsername = '';
  let running = true;

  const getState = key => db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key)?.value ?? null;
  const setState = (key, value) => db.prepare(
    'INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

  const link = tgId => db.prepare(`
    SELECT l.user_id, l.chat_id, u.name, u.role, u.login FROM tg_links l JOIN users u ON u.id = l.user_id
    WHERE l.tg_id = ? AND u.active = 1`).get(tgId);

  const appUrl = taskId => `${publicUrl}/${taskId ? `?task=${taskId}` : ''}`;

  // ---------- Запросы к API от имени человека ----------

  async function apiAs(userId, method, path, body) {
    const once = async () => {
      let session = sessions.get(userId);
      if (!session) { session = createSession(db, userId); sessions.set(userId, session); }
      const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${session}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    let r = await once();
    if (r.status === 401) { sessions.delete(userId); r = await once(); }
    if (r.status >= 400) throw new Error(r.data.error?.message || 'Не получилось');
    return r.data;
  }

  // ---------- Сообщения ----------

  const dueText = iso => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  function taskText(t, lead = '') {
    const lines = [];
    if (lead) lines.push(lead, '');
    lines.push(`<b>${esc(t.title)}</b>`);
    lines.push(`${esc(t.projectName || 'Без проекта')} · ${STATUS[t.status]}`);
    lines.push(`Ответственный: ${esc(t.assigneeName || 'не назначен')}`);
    if (t.dueAt) lines.push(`Срок: ${dueText(t.dueAt)}${t.overdue ? ' (просрочено)' : ''}`);
    return lines.join('\n');
  }

  // Кнопки показывают следующий шаг. Право на него всё равно проверяет API.
  function taskKeyboard(t, { isPrivate, role }) {
    const row = [];
    if (t.status === 'new') row.push({ text: 'В работу', callback_data: `s:${t.id}:progress` });
    if (t.status === 'progress') row.push({ text: 'На проверку', callback_data: `s:${t.id}:review` });
    if (t.status === 'review' && (!role || isManagerRole(role))) {
      row.push({ text: 'Принять', callback_data: `s:${t.id}:done` }, { text: 'Вернуть', callback_data: `s:${t.id}:progress` });
    }
    // Веб-приложение внутри Telegram открывается только из личного чата.
    const open = isPrivate ? { text: 'Открыть', web_app: { url: appUrl(t.id) } } : { text: 'Открыть', url: appUrl(t.id) };
    return { inline_keyboard: [...(row.length ? [row] : []), [open]] };
  }

  const reply = (chatId, text, extra = {}) => tg.call('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra,
  });

  // Сообщения человеку. Если он заблокировал бота, привязка снимается: писать некуда.
  async function notify(userId, text, keyboardFor) {
    const links = db.prepare('SELECT tg_id, chat_id FROM tg_links WHERE user_id = ?').all(userId);
    for (const l of links) {
      try {
        await reply(l.chat_id, text, keyboardFor ? { reply_markup: keyboardFor() } : {});
      } catch (e) {
        if (e.code === 403) db.prepare('DELETE FROM tg_links WHERE tg_id = ?').run(l.tg_id);
        else if (e.retryAfter) await new Promise(r => setTimeout(r, Math.min(e.retryAfter, 30) * 1000));
        else console.error(e.message);
      }
    }
  }

  // ---------- Команды ----------

  const NOT_LINKED = demo
    ? 'Сначала выберите роль в демо: отправьте /start боту в личном чате.'
    : 'Аккаунт не подключён. Откройте веб-приложение: Настройки → Подключить Telegram.';

  function saveLink(from, chatId, userId) {
    db.prepare(`INSERT INTO tg_links (tg_id, user_id, chat_id, username) VALUES (?, ?, ?, ?)
      ON CONFLICT(tg_id) DO UPDATE SET user_id = excluded.user_id, chat_id = excluded.chat_id, username = excluded.username`)
      // В открытом демо имя пользователя не сохраняем: хватает номера чата, он удаляется при ночном сбросе.
      .run(from.id, userId, chatId, !demo && from.username ? from.username.toLowerCase() : null);
  }

  const HELP = [
    '<b>Как ставить задачи</b>',
    '',
    'В личном чате просто напишите текст, я предложу создать задачу.',
    'В чате команды: <code>/task Подготовить договор @anna завтра 15:00</code>',
    '',
    'Срок можно писать так: сегодня 18:00, завтра, в пятницу 10:00, 12.11, через 2 часа.',
    '',
    '/my — мои задачи',
    '/stop — отключить бота от аккаунта',
    '/help — эта подсказка',
  ].join('\n');

  async function cmdStart(msg, payload) {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') { await reply(chatId, 'Напишите мне /start в личном чате.'); return; }
    if (payload) {
      const row = tx(db, () => {
        const code = db.prepare('SELECT * FROM tg_codes WHERE code_hash = ? AND expires_at > ?').get(sha256(payload), now());
        if (!code) return null;
        db.prepare('DELETE FROM tg_codes WHERE code_hash = ?').run(code.code_hash);
        saveLink(msg.from, chatId, code.user_id);
        return db.prepare('SELECT name FROM users WHERE id = ?').get(code.user_id);
      });
      await reply(chatId, row ? `${esc(row.name)}, Telegram подключён. Теперь напоминания будут приходить сюда.\n\n${HELP}` : 'Ссылка устарела. Создайте новую в настройках веб-приложения.');
      return;
    }
    const known = link(msg.from.id);
    if (known) { await reply(chatId, `${esc(known.name)}, я на связи.\n\n${HELP}`); return; }
    if (demo) {
      await reply(chatId, 'Это демо с выдуманной командой. Номер вашего чата хранится до ночного сброса данных и нужен только для ответов бота. Команда /stop удалит его сразу.\n\nВыберите роль, чтобы посмотреть, как работает бот:', {
        reply_markup: { inline_keyboard: Object.entries(ROLE).map(([role, label]) => [{ text: label, callback_data: `d:${role}` }]) },
      });
      return;
    }
    await reply(chatId, NOT_LINKED);
  }

  async function cmdMy(msg) {
    // Личный список не показываем всей группе.
    if (msg.chat.type !== 'private') { await reply(msg.chat.id, 'Свои задачи смотрите в личном чате со мной: /my'); return; }
    const me = link(msg.from.id);
    if (!me) { await reply(msg.chat.id, NOT_LINKED); return; }
    const { tasks } = await apiAs(me.user_id, 'GET', '/tasks?mine=1&open=1');
    if (!tasks.length) { await reply(msg.chat.id, 'Открытых задач нет.'); return; }
    tasks.sort((a, b) => (a.dueAt || '9').localeCompare(b.dueAt || '9'));
    const shown = tasks.slice(0, 8);
    const lines = shown.map(t => `${t.overdue ? '❗' : '•'} ${esc(t.title)}${t.dueAt ? ` — ${dueText(t.dueAt)}` : ''}`);
    if (tasks.length > shown.length) lines.push(`И ещё ${tasks.length - shown.length}.`);
    await reply(msg.chat.id, `<b>Мои задачи: ${tasks.length}</b>\n${lines.join('\n')}`, {
      reply_markup: { inline_keyboard: [
        ...shown.map(t => [{ text: t.title.slice(0, 40), callback_data: `v:${t.id}` }]),
        [{ text: 'Открыть приложение', web_app: { url: appUrl() } }],
      ] },
    });
  }

  // Упоминание ищем среди подключённых к боту, затем по логину в приложении.
  function resolveMention(name) {
    const byTg = db.prepare('SELECT user_id FROM tg_links WHERE username = ?').get(name);
    if (byTg) return byTg.user_id;
    return db.prepare('SELECT id FROM users WHERE login = ? AND active = 1').get(name)?.id ?? null;
  }

  function buildDraft(text) {
    const parsed = parseTaskText(text, { tz });
    if (!parsed.title) return { error: 'Не вижу названия задачи. Пример: /task Подготовить договор @anna завтра 15:00' };
    if (parsed.mentions.length > 1) return { error: 'Ответственный может быть только один.' };
    let assigneeId;
    if (parsed.mentions.length) {
      assigneeId = resolveMention(parsed.mentions[0]);
      if (!assigneeId) return { error: `Не знаю, кто такой @${esc(parsed.mentions[0])}. Этот человек должен подключить бота, либо укажите его логин.` };
    }
    const assigneeName = assigneeId ? db.prepare('SELECT name FROM users WHERE id = ?').get(assigneeId)?.name : null;
    return { draft: { title: parsed.title.slice(0, 200), assigneeId, assigneeName, dueAt: parsed.dueAt } };
  }

  async function createTask(me, draft, chat) {
    const body = { title: draft.title };
    if (draft.assigneeId) body.assigneeId = draft.assigneeId;
    if (draft.dueAt) body.dueAt = draft.dueAt;
    const { task } = await apiAs(me.user_id, 'POST', '/tasks', body);
    return { text: taskText(task, 'Задача создана.'), keyboard: taskKeyboard(task, { isPrivate: chat.type === 'private', role: chat.type === 'private' ? me.role : null }) };
  }

  async function cmdTask(msg, args) {
    const me = link(msg.from.id);
    if (!me) { await reply(msg.chat.id, NOT_LINKED); return; }
    if (!args) { await reply(msg.chat.id, 'Пример: <code>/task Подготовить договор @anna завтра 15:00</code>'); return; }
    const { draft, error } = buildDraft(args);
    if (error) { await reply(msg.chat.id, error); return; }
    try {
      const made = await createTask(me, draft, msg.chat);
      await reply(msg.chat.id, made.text, { reply_markup: made.keyboard });
    } catch (e) {
      await reply(msg.chat.id, esc(e.message));
    }
  }

  async function plainText(msg) {
    if (msg.chat.type !== 'private') return;
    const me = link(msg.from.id);
    if (!me) { await reply(msg.chat.id, NOT_LINKED); return; }
    const { draft, error } = buildDraft(msg.text);
    if (error) { await reply(msg.chat.id, error); return; }
    const key = randomToken().slice(0, 12);
    if (pending.size > 500) pending.delete(pending.keys().next().value);
    pending.set(key, { draft, tgId: msg.from.id });
    const details = [
      draft.assigneeName ? `Ответственный: ${esc(draft.assigneeName)}` : null,
      draft.dueAt ? `Срок: ${dueText(draft.dueAt)}` : null,
    ].filter(Boolean);
    await reply(msg.chat.id, [`Создать задачу?`, `<b>${esc(draft.title)}</b>`, ...details].join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: 'Создать', callback_data: `ok:${key}` }, { text: 'Отмена', callback_data: `no:${key}` }]] },
    });
  }

  async function onMessage(msg) {
    const text = msg.text;
    if (!text || !msg.from || msg.from.is_bot) return;
    const m = /^\/([a-zA-Z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (m) {
      if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return;
      const args = (m[3] || '').trim();
      const cmd = m[1].toLowerCase();
      if (cmd === 'start') return cmdStart(msg, args);
      if (cmd === 'task') return cmdTask(msg, args);
      if (cmd === 'my') return cmdMy(msg);
      if (cmd === 'help') return void await reply(msg.chat.id, HELP);
      if (cmd === 'stop') {
        db.prepare('DELETE FROM tg_links WHERE tg_id = ?').run(msg.from.id);
        return void await reply(msg.chat.id, 'Бот отключён от аккаунта. Напоминаний больше не будет.');
      }
      if (msg.chat.type === 'private') await reply(msg.chat.id, 'Такой команды нет. Подсказка: /help');
      return;
    }
    return plainText(msg);
  }

  async function onCallback(q) {
    const answer = (text, alert = false) => tg.call('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: alert });
    const [kind, a, b] = String(q.data || '').split(':');
    const chat = q.message?.chat;
    const edit = (text, reply_markup) => tg.call('editMessageText', {
      chat_id: chat.id, message_id: q.message.message_id, text, parse_mode: 'HTML', reply_markup,
    });

    if (kind === 'd') {
      if (!demo || !MANAGERS.concat('member').includes(a)) return answer('Недоступно');
      const user = db.prepare('SELECT id, name FROM users WHERE role = ? AND active = 1 ORDER BY id LIMIT 1').get(a);
      if (!user) return answer('Демо обновляется, попробуйте позже');
      saveLink(q.from, chat.id, user.id);
      await answer('Готово');
      await edit(`Вы вошли как ${esc(user.name)}, ${ROLE[a].toLowerCase()}. Данные демо обновляются раз в сутки.\n\n${HELP}`);
      return;
    }

    const me = link(q.from.id);
    if (!me) return answer(NOT_LINKED, true);
    const isPrivate = chat?.type === 'private';

    if (kind === 'ok' || kind === 'no') {
      const item = pending.get(a);
      pending.delete(a);
      if (!item || item.tgId !== q.from.id) return answer('Запрос устарел', true);
      if (kind === 'no') { await answer('Отменено'); await edit('Отменено.'); return; }
      try {
        const made = await createTask(me, item.draft, chat);
        await answer('Создано');
        await edit(made.text, made.keyboard);
      } catch (e) {
        await answer(e.message, true);
      }
      return;
    }

    if (kind === 'v') {
      try {
        const { task } = await apiAs(me.user_id, 'GET', `/tasks/${Number(a)}`);
        await answer('');
        await reply(chat.id, taskText(task), { reply_markup: taskKeyboard(task, { isPrivate, role: isPrivate ? me.role : null }) });
      } catch (e) { await answer(e.message, true); }
      return;
    }

    if (kind === 's') {
      try {
        const { task } = await apiAs(me.user_id, 'PATCH', `/tasks/${Number(a)}`, { status: b });
        await answer(`Статус: ${STATUS[task.status]}`);
        await edit(taskText(task), taskKeyboard(task, { isPrivate, role: isPrivate ? me.role : null }));
      } catch (e) { await answer(e.message, true); }
      return;
    }
    return answer('');
  }

  // Не больше 30 действий в минуту от одного человека: бот открыт всему Telegram.
  function allowed(tgId) {
    const t = Date.now();
    const list = (actions.get(tgId) || []).filter(x => t - x < 60e3);
    list.push(t);
    actions.set(tgId, list);
    if (actions.size > 5000) actions.clear();
    return list.length <= 30;
  }

  async function onUpdate(u) {
    const from = u.message?.from || u.callback_query?.from;
    if (from && !allowed(from.id)) return;
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  }

  // ---------- Уведомления о событиях ----------

  const taskFor = id => db.prepare(`
    SELECT t.*, p.name AS project_name, p.owner_id, a.name AS assignee_name
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users a ON a.id = t.assignee_id WHERE t.id = ?`).get(id);

  const plainTask = t => ({
    id: t.id, title: t.title, status: t.status, projectName: t.project_name, assigneeName: t.assignee_name, dueAt: t.due_at,
    overdue: !!t.due_at && t.status !== 'done' && t.due_at < now(),
  });

  const managerOf = t => t.owner_id || t.creator_id;
  const roleOf = id => db.prepare('SELECT role FROM users WHERE id = ?').get(id)?.role;
  const send = (userId, lead, t) => notify(userId, taskText(plainTask(t), lead), () => taskKeyboard(plainTask(t), { isPrivate: true, role: roleOf(userId) }));

  async function processEvents() {
    let last = getState('history_id');
    if (last === null) {
      last = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM task_history').get().m;
      setState('history_id', last);
    }
    const rows = db.prepare(`SELECT h.*, u.name AS actor FROM task_history h JOIN users u ON u.id = h.user_id
      WHERE h.id > ? ORDER BY h.id LIMIT 100`).all(Number(last));
    for (const h of rows) {
      // Сначала двигаем отметку: сбой отправки не должен превратиться в рассылку по кругу.
      setState('history_id', h.id);
      const t = taskFor(h.task_id);
      if (!t) continue;
      const actor = esc(h.actor);
      if ((h.action === 'created' || h.action === 'assignee') && t.assignee_id && t.assignee_id !== h.user_id) {
        await send(t.assignee_id, `Новая задача от ${actor}.`, t);
      } else if (h.action === 'status' && h.to_value === 'review' && managerOf(t) !== h.user_id) {
        await send(managerOf(t), `${actor} просит проверить задачу.`, t);
      } else if (h.action === 'status' && h.to_value === 'done' && t.assignee_id && t.assignee_id !== h.user_id) {
        await send(t.assignee_id, `${actor} принял(а) задачу.`, t);
      } else if (h.action === 'status' && h.from_value === 'review' && h.to_value === 'progress' && t.assignee_id && t.assignee_id !== h.user_id) {
        await send(t.assignee_id, `${actor} вернул(а) задачу на доработку.`, t);
      } else if (h.action === 'comment') {
        const c = db.prepare('SELECT body FROM comments WHERE task_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(t.id, h.user_id);
        const who = new Set([t.assignee_id, managerOf(t)].filter(id => id && id !== h.user_id));
        for (const id of who) await send(id, `${actor} пишет: ${esc(c?.body?.slice(0, 300) ?? '')}`, t);
      }
    }
  }

  // ---------- Напоминания о сроках ----------

  const settingsOf = id => {
    const row = db.prepare('SELECT data FROM user_settings WHERE user_id = ?').get(id);
    return { before24h: true, before3h: true, atDue: true, overdue: true, digest: true, ...(row ? JSON.parse(row.data) : {}) };
  };

  // Запись делается до отправки: при сбое лучше пропустить напоминание, чем прислать дважды.
  const claim = (userId, taskId, kind, dueAt) => db.prepare(
    'INSERT OR IGNORE INTO reminders_sent (user_id, task_id, kind, due_at, sent_at) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, taskId, kind, dueAt, now()).changes === 1;

  const LEAD = {
    before24h: 'До срока меньше суток.', before3h: 'До срока меньше 3 часов.', atDue: 'Срок наступил.', overdue: 'Задача просрочена.',
  };

  function reminderKind(dueMs, nowMs) {
    const left = dueMs - nowMs;
    if (left > 24 * HOUR || left <= -48 * HOUR) return null;
    if (left > 3 * HOUR) return 'before24h';
    if (left > 0) return 'before3h';
    if (left > -HOUR) return 'atDue';
    return 'overdue';
  }

  // Срок мог быть поставлен, когда окно напоминания уже открылось: тогда повод писать ещё не наступил.
  function dueSetAt(t) {
    const row = db.prepare("SELECT MAX(created_at) AS m FROM task_history WHERE task_id = ? AND action = 'due'").get(t.id);
    return row.m && row.m > t.created_at ? row.m : t.created_at;
  }

  async function processReminders() {
    const nowMs = Date.now();
    const tasks = db.prepare(`
      SELECT t.id FROM tasks t WHERE t.status <> 'done' AND t.due_at IS NOT NULL AND t.assignee_id IS NOT NULL AND t.due_at BETWEEN ? AND ?`)
      .all(new Date(nowMs - 48 * HOUR).toISOString(), new Date(nowMs + 24 * HOUR).toISOString());
    for (const { id } of tasks) {
      const t = taskFor(id);
      const dueMs = new Date(t.due_at).getTime();
      const kind = reminderKind(dueMs, nowMs);
      if (!kind) continue;
      if (kind === 'before24h' || kind === 'before3h') {
        const windowStart = dueMs - (kind === 'before24h' ? 24 : 3) * HOUR;
        if (new Date(dueSetAt(t)).getTime() > windowStart) continue;
      }
      const recipients = new Set([t.assignee_id]);
      if (kind === 'overdue') recipients.add(managerOf(t));
      for (const userId of recipients) {
        if (!settingsOf(userId)[kind]) continue;
        if (claim(userId, t.id, kind, t.due_at)) await send(userId, LEAD[kind], t);
      }
    }
  }

  async function processDigest(hour = 9) {
    const local = localParts(new Date(), tz);
    if (local.h < hour) return;
    const day = `${local.y}-${local.m}-${local.d}`;
    const users = db.prepare('SELECT DISTINCT user_id FROM tg_links').all();
    for (const { user_id: userId } of users) {
      if (!settingsOf(userId).digest) continue;
      if (!claim(userId, 0, 'digest', day)) continue;
      const { tasks } = await apiAs(userId, 'GET', '/tasks?mine=1&open=1').catch(() => ({ tasks: [] }));
      const todayEnd = new Date(Date.now() + 24 * HOUR);
      const urgent = tasks.filter(t => t.overdue || (t.dueAt && new Date(t.dueAt) < todayEnd));
      if (!urgent.length) continue;
      const lines = urgent.slice(0, 10).map(t => `${t.overdue ? '❗' : '•'} ${esc(t.title)} — ${dueText(t.dueAt)}`);
      await notify(userId, `<b>Доброе утро. Срочное: ${urgent.length}</b>\n${lines.join('\n')}`);
    }
  }

  // ---------- Циклы ----------

  async function tick() {
    try {
      await processEvents();
      await processReminders();
      await processDigest();
    } catch (e) { console.error('Бот, напоминания:', e.message); }
  }

  async function poll() {
    let offset = Number(getState('update_offset') || 0);
    while (running) {
      try {
        const updates = await tg.call('getUpdates', { offset, timeout: pollTimeout, allowed_updates: ['message', 'callback_query'] }, (pollTimeout + 10) * 1000);
        for (const u of updates) {
          offset = u.update_id + 1;
          setState('update_offset', offset);
          await onUpdate(u).catch(e => console.error('Бот:', e.message));
        }
      } catch (e) {
        if (running) { console.error('Бот, связь:', e.message); await new Promise(r => setTimeout(r, 5000)); }
      }
    }
  }

  async function start() {
    for (let i = 0; running; i++) {
      try {
        const me = await tg.call('getMe');
        botUsername = me.username;
        await tg.call('setMyCommands', { commands: [
          { command: 'task', description: 'Поставить задачу' }, { command: 'my', description: 'Мои задачи' },
          { command: 'help', description: 'Подсказка' }, { command: 'stop', description: 'Отключить бота' },
        ] });
        await tg.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: appUrl() } } });
        break;
      } catch (e) {
        console.error('Бот, запуск:', e.message);
        await new Promise(r => setTimeout(r, Math.min(5000 * (i + 1), 60000)));
      }
    }
    console.log(`Бот @${botUsername} запущен`);
    setInterval(tick, tickMs).unref();
    tick();
    poll();
  }

  // ---------- Маршруты для веб-приложения ----------

  const telegramLimit = new Map();

  app.route('POST', '/api/v1/auth/telegram', ctx => {
    const t = Date.now();
    const hits = (telegramLimit.get(ctx.ip) || []).filter(x => t - x < 60e3);
    hits.push(t);
    telegramLimit.set(ctx.ip, hits);
    if (hits.length > 30) throw new HttpError(429, 'too_many', 'Слишком много попыток');
    const user = verifyInitData(ctx.body.initData, token);
    if (!user) throw new HttpError(401, 'bad_signature', 'Не удалось подтвердить вход из Telegram');
    const me = link(user.id);
    if (!me) throw new HttpError(404, 'not_linked', 'Telegram ещё не подключён к аккаунту');
    return { token: createSession(db, me.user_id) };
  }, { public: true });

  app.route('GET', '/api/v1/telegram', ctx => ({
    enabled: true,
    botUsername,
    linked: !!db.prepare('SELECT 1 FROM tg_links WHERE user_id = ?').get(ctx.user.id),
  }));

  app.route('POST', '/api/v1/telegram/link', ctx => {
    if (demo) throw new HttpError(403, 'forbidden', 'В демо роль выбирается в самом боте');
    const code = randomToken();
    db.prepare('DELETE FROM tg_codes WHERE user_id = ? OR expires_at < ?').run(ctx.user.id, now());
    db.prepare('INSERT INTO tg_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(code), ctx.user.id, new Date(Date.now() + LINK_MINUTES * 60e3).toISOString());
    return { url: `https://t.me/${botUsername}?start=${code}` };
  });

  app.route('DELETE', '/api/v1/telegram/link', ctx => {
    if (demo) throw new HttpError(403, 'forbidden', 'В демо бот отключается командой /stop');
    db.prepare('DELETE FROM tg_links WHERE user_id = ?').run(ctx.user.id);
    return { ok: true };
  });

  return { start, stop: () => { running = false; } };
}

module.exports = { startBot, verifyInitData };
