'use strict';
// Разбор короткой записи задачи: «Подготовить договор @anna завтра 15:00».

const WEEKDAYS = {
  'понедельник': 1, 'пн': 1, 'вторник': 2, 'вт': 2, 'среду': 3, 'среда': 3, 'ср': 3, 'четверг': 4, 'чт': 4,
  'пятницу': 5, 'пятница': 5, 'пт': 5, 'субботу': 6, 'суббота': 6, 'сб': 6, 'воскресенье': 0, 'вс': 0,
};
const DEFAULT_HOUR = 18;

// Смещение часового пояса в минутах для момента времени.
function tzOffset(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, Number(x.value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

// Местное время в поясе tz превращается в настоящий момент времени.
function localToDate(y, m, d, h, min, tz) {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  return new Date(guess.getTime() - tzOffset(guess, tz) * 60000);
}

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

// Календарный сдвиг дней без привязки к часовому поясу.
function addDays({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const validTime = (h, min) => h >= 0 && h <= 23 && min >= 0 && min <= 59;
const validDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

const TIME = '(?:(?:\\s+в)?\\s+(\\d{1,2})[:.](\\d{2}))?';

const PATTERNS = [
  { // через 2 часа, через 30 минут, через 3 дня
    re: /(?:^|\s)(?:до\s+)?через\s+(\d{1,3})\s*(минут[ауы]?|мин|час(?:а|ов)?|дн(?:я|ей)|день)(?=\s|$|[.,!])/iu,
    get(m, now, tz) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (unit.startsWith('мин')) return new Date(now.getTime() + n * 60000);
      if (unit.startsWith('час')) return new Date(now.getTime() + n * 3600000);
      const day = addDays(localParts(now, tz), n);
      return localToDate(day.y, day.m, day.d, DEFAULT_HOUR, 0, tz);
    },
  },
  { // сегодня / завтра / послезавтра [в 15:00]
    re: new RegExp(`(?:^|\\s)(?:до\\s+)?(сегодня|послезавтра|завтра)${TIME}(?=\\s|$|[.,!])`, 'iu'),
    get(m, now, tz) {
      const shift = { сегодня: 0, завтра: 1, послезавтра: 2 }[m[1].toLowerCase()];
      const day = addDays(localParts(now, tz), shift);
      const h = m[2] === undefined ? DEFAULT_HOUR : Number(m[2]);
      const min = m[3] === undefined ? 0 : Number(m[3]);
      return validTime(h, min) ? localToDate(day.y, day.m, day.d, h, min, tz) : null;
    },
  },
  { // в пятницу [в 15:00], до среды не разбираем: это другая форма слова
    re: new RegExp(`(?:^|\\s)(?:во?\\s+)(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|пн|вт|ср|чт|пт|сб|вс)${TIME}(?=\\s|$|[.,!])`, 'iu'),
    get(m, now, tz) {
      const target = WEEKDAYS[m[1].toLowerCase()];
      const today = localParts(now, tz);
      const h = m[2] === undefined ? DEFAULT_HOUR : Number(m[2]);
      const min = m[3] === undefined ? 0 : Number(m[3]);
      if (!validTime(h, min)) return null;
      let days = (target - today.weekday + 7) % 7;
      let day = addDays(today, days);
      let result = localToDate(day.y, day.m, day.d, h, min, tz);
      if (result <= now) { days += 7; day = addDays(today, days); result = localToDate(day.y, day.m, day.d, h, min, tz); }
      return result;
    },
  },
  { // 12.11, 12.11.2026 [15:00]
    re: new RegExp(`(?:^|\\s)(?:до\\s+)?(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}))?${TIME}(?=\\s|$|[,!])`, 'u'),
    get(m, now, tz) {
      const today = localParts(now, tz);
      const d = Number(m[1]);
      const mon = Number(m[2]);
      let y = m[3] ? Number(m[3]) : today.y;
      const h = m[4] === undefined ? DEFAULT_HOUR : Number(m[4]);
      const min = m[5] === undefined ? 0 : Number(m[5]);
      if (!validDate(y, mon, d) || !validTime(h, min)) return null;
      let result = localToDate(y, mon, d, h, min, tz);
      if (!m[3] && result <= now) { y += 1; result = localToDate(y, mon, d, h, min, tz); }
      return result;
    },
  },
  { // в 15:00: сегодня, а если время прошло, завтра
    re: /(?:^|\s)(?:до|в)\s+(\d{1,2}):(\d{2})(?=\s|$|[.,!])/iu,
    get(m, now, tz) {
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (!validTime(h, min)) return null;
      const today = localParts(now, tz);
      let result = localToDate(today.y, today.m, today.d, h, min, tz);
      if (result <= now) { const day = addDays(today, 1); result = localToDate(day.y, day.m, day.d, h, min, tz); }
      return result;
    },
  },
];

function parseTaskText(input, { now = new Date(), tz = 'Europe/Moscow' } = {}) {
  let text = String(input || '').replace(/\s+/g, ' ').trim();
  const mentions = [];
  text = text.replace(/(^|\s)@([a-zA-Z0-9_]{3,32})(?=\s|$|[.,!])/g, (_, lead, name) => { mentions.push(name.toLowerCase()); return lead; });

  let dueAt = null;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const date = p.get(m, now, tz);
    if (date) {
      dueAt = date.toISOString();
      text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length));
      break;
    }
  }
  const title = text.replace(/\s+/g, ' ').replace(/\s+([.,!])/g, '$1').replace(/[,\s]+$/, '').trim();
  return { title, dueAt, mentions };
}

module.exports = { parseTaskText, localParts, localToDate };
