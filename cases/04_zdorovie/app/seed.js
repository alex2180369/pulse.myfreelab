'use strict';
// Выдуманные клиенты и специалисты для демо. Даты считаются от текущего дня, поэтому демо всегда свежее.
// Случайные колебания показателей повторяются от сброса к сбросу: генератор с постоянным зерном.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createUser, now, tx } = require('../../../core');
const { MENU, LESSONS, ARTICLES } = require('./content');

const PEOPLE = [
  ['anna', 'Анна Соколова', 'client', { sex: 'f', year: 1988, height: 168 }],
  ['igor', 'Игорь Белов', 'client', { sex: 'm', year: 1979, height: 182 }],
  ['maria', 'Мария Ким', 'client', { sex: 'f', year: 1995, height: 162 }],
  ['morozova', 'Елена Морозова', 'doctor', { title: 'Терапевт, стаж 14 лет' }],
  ['lebedeva', 'Ирина Лебедева', 'nutritionist', { title: 'Нутрициолог, питание при снижении веса' }],
  ['orlov', 'Максим Орлов', 'trainer', { title: 'Тренер по фитнесу и функциональному тренингу' }],
  ['smirnova', 'Ольга Смирнова', 'admin', { title: 'Администратор сервиса' }],
];

const shiftDay = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);
const weekday = day => new Date(`${day}T00:00:00Z`).getUTCDay();

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MENU_ANSWER = `Анна, спасибо за подробный запрос. Учла, что вы не едите свинину и не переносите арахис. Калорийность около 1600 ккал, это даст снижение примерно на 0,5 кг в неделю.

## День 1
- Завтрак: омлет из 2 яиц со шпинатом, хлебец.
- Обед: суп с фрикадельками из индейки, салат из свежих овощей.
- Ужин: запечённый лосось, брокколи.

## День 2
- Завтрак: овсянка на воде с ягодами и ложкой йогурта.
- Обед: гречка с курицей и тушёной морковью.
- Ужин: творог с зеленью и огурцом.

## День 3
- Завтрак: сырники в духовке, сметана 10%.
- Обед: чечевичный суп, кусочек цельнозернового хлеба.
- Ужин: треска с овощами на пару.

Перекусы: яблоко, кефир, горсть миндаля. Взвешивайтесь утром натощак 2–3 раза в неделю и записывайте в Тонус, через месяц посмотрим динамику.`;

async function seed(db, today) {
  const ids = {};
  for (const [login, name, role, extra] of PEOPLE) {
    // Пароль случайный и нигде не хранится: в демо входят кнопкой.
    ids[login] = await createUser(db, { login, name, role, password: crypto.randomBytes(18).toString('base64') });
    db.prepare('INSERT INTO profiles (user_id, sex, birth_year, height_cm, title, consent_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ids[login], extra.sex ?? null, extra.year ?? null, extra.height ?? null, extra.title ?? '', role === 'client' ? now() : null);
  }
  const d = by => shiftDay(today, by);
  const rnd = random(20261109);
  const noise = span => (rnd() - 0.5) * 2 * span;
  const r1 = v => Math.round(v * 10) / 10;

  tx(db, () => {
    const put = (who, day, metric, v1, v2 = null) => db.prepare('INSERT INTO measurements (user_id, day, metric, v1, v2, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ids[who], day, metric, v1, v2, now());

    // Анна: три месяца, вес снижается, шаги растут, две недели назад два дня высокого давления.
    for (let i = 89; i >= 1; i--) {
      const day = d(-i);
      const t = (89 - i) / 88;
      const wd = weekday(day);
      if (rnd() < 0.75) put('anna', day, 'weight', r1(74.6 - 4 * t + noise(0.3)));
      if (wd === 1) put('anna', day, 'waist', r1(86 - 4 * t + noise(0.4)));
      if (i === 20 || i === 19) put('anna', day, 'pressure', i === 20 ? 145 : 142, i === 20 ? 92 : 91);
      else if (rnd() < 0.7) put('anna', day, 'pressure', Math.round(122 + noise(7)), Math.round(79 + noise(4)));
      if (rnd() < 0.6) put('anna', day, 'pulse', Math.round(70 - 4 * t + noise(4)));
      const train = [1, 3, 5].includes(wd);
      put('anna', day, 'activity', Math.round(5000 + 3800 * t + noise(1600) + (wd === 0 || wd === 6 ? 1500 : 0)), train ? Math.round(40 + noise(10)) : null);
      const hours = Math.round((7 + noise(1.1)) * 2) / 2;
      if (rnd() < 0.85) put('anna', day, 'sleep', hours, Math.max(1, Math.min(5, Math.round(hours - 3.5 + noise(0.8)))));
      if (rnd() < 0.5) put('anna', day, 'stress', Math.max(1, Math.min(10, Math.round(5 - 1.5 * t + noise(2)))));
    }
    put('anna', d(0), 'weight', 70.4);
    put('anna', d(0), 'sleep', 7.5, 4);

    // Игорь: месяц, давление на верхней границе.
    for (let i = 30; i >= 1; i--) {
      const day = d(-i);
      if (rnd() < 0.6) put('igor', day, 'weight', r1(92.4 - 1.8 * ((30 - i) / 29) + noise(0.4)));
      if (rnd() < 0.8) put('igor', day, 'pressure', Math.round(134 + noise(6)), Math.round(86 + noise(3)));
      if (rnd() < 0.7) put('igor', day, 'pulse', Math.round(76 + noise(5)));
      put('igor', day, 'activity', Math.round(6200 + noise(2200)), weekday(day) === 6 ? 60 : null);
      if (rnd() < 0.7) put('igor', day, 'sleep', Math.round((6.5 + noise(1)) * 2) / 2, Math.round(3 + noise(1.4)));
    }
    // Мария: полтора месяца, хороший сон, тренировки.
    for (let i = 45; i >= 1; i--) {
      const day = d(-i);
      if (rnd() < 0.5) put('maria', day, 'weight', r1(57.2 + noise(0.4)));
      if (rnd() < 0.5) put('maria', day, 'pressure', Math.round(112 + noise(6)), Math.round(72 + noise(4)));
      put('maria', day, 'activity', Math.round(9500 + noise(2500)), [2, 4, 6].includes(weekday(day)) ? 55 : null);
      put('maria', day, 'sleep', Math.round((7.8 + noise(0.8)) * 2) / 2, Math.min(5, Math.round(4 + noise(1))));
      if (rnd() < 0.6) put('maria', day, 'stress', Math.max(1, Math.round(3 + noise(2))));
    }

    const goal = (who, metric, target, start, direction, due) => db.prepare('INSERT INTO goals (user_id, metric, target, start, direction, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ids[who], metric, target, start, direction, due, now());
    goal('anna', 'weight', 68, 74.6, 'down', d(60));
    goal('anna', 'activity', 10000, null, 'up', null);
    goal('anna', 'sleep', 7.5, null, 'up', null);
    goal('igor', 'weight', 88, 92.4, 'down', d(90));

    // Анализы: у Анны два, по старому есть замечания, по свежему всё в норме и приложен пример бланка.
    const lab = (who, day, values, note = '') => {
      const r = db.prepare('INSERT INTO labs (user_id, day, note, created_at) VALUES (?, ?, ?, ?)').run(ids[who], day, note, now());
      const id = Number(r.lastInsertRowid);
      for (const [code, value] of Object.entries(values)) db.prepare('INSERT INTO lab_values (lab_id, code, value) VALUES (?, ?, ?)').run(id, code, value);
      return id;
    };
    lab('anna', d(-84), { glucose: 5.9, cholesterol: 5.7, hemoglobin: 116 }, 'Сдавала в поликлинике');
    const fresh = lab('anna', d(-5), { glucose: 5.2, cholesterol: 5.0, hemoglobin: 124 }, 'Контроль через 3 месяца');
    db.prepare("INSERT INTO lab_files (lab_id, file, name, type, size, seeded, created_at) VALUES (?, 'lab_example.png', 'Бланк анализа (пример).png', 'image/png', 0, 1, ?)").run(fresh, now());
    lab('igor', d(-3), { glucose: 6.1, cholesterol: 6.4, hemoglobin: 152 });
    lab('maria', d(-20), { glucose: 4.8, cholesterol: 4.4, hemoglobin: 128 });

    const med = (who, name, dose, times, days = []) => Number(db.prepare('INSERT INTO meds (user_id, name, dose, times, days, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ids[who], name, dose, JSON.stringify(times), JSON.stringify(days), now()).lastInsertRowid);
    const vitD = med('anna', 'Витамин D3', '2000 МЕ', ['09:00']);
    med('anna', 'Магний B6', '1 таблетка', ['21:00']);
    med('igor', 'Омега-3', '1 капсула', ['08:30', '20:30']);
    db.prepare('INSERT INTO med_intakes (med_id, day, time, taken_at) VALUES (?, ?, ?, ?)').run(vitD, d(0), '09:00', now());
    db.prepare("UPDATE profiles SET diary_remind_at = '20:00' WHERE user_id = ?").run(ids.anna);

    // Запросы и доступ. Доступ открыт только тем, к кому клиент обращался сам.
    const access = (who, spec) => db.prepare('INSERT OR IGNORE INTO access (client_id, specialist_id, granted_at) VALUES (?, ?, ?)').run(ids[who], ids[spec], now());
    // Время запросов разнесено назад от текущего момента, чтобы история выглядела живой.
    const ago = hours => new Date(Date.now() - hours * 3600e3).toISOString();
    const request = (who, spec, kind, status, message, answer, created, updated = created) => {
      access(who, spec);
      return Number(db.prepare('INSERT INTO requests (client_id, specialist_id, kind, status, message, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ids[who], ids[spec], kind, status, message, answer, ago(created), ago(updated)).lastInsertRowid);
    };
    request('anna', 'lebedeva', 'menu', 'done', 'Хочу снизить вес до 68 кг без жёстких диет. Не ем свинину, аллергия на арахис.', MENU_ANSWER, 150, 30);
    request('anna', 'morozova', 'labs', 'work', 'Посмотрите, пожалуйста, свежие анализы. Три месяца назад гемоглобин был низкий, пила железо по назначению.', '', 96, 20);
    const igorReq = request('igor', 'morozova', 'labs', 'new', 'Холестерин 6,4. Что делать и нужно ли пить таблетки?', '', 5);
    request('maria', 'morozova', 'labs', 'done', 'Плановый контроль перед соревнованиями.', 'Мария, анализы в норме, ограничений к тренировкам по ним нет. Повторите через полгода.', 400, 380);
    const mariaReq = request('maria', 'lebedeva', 'menu', 'new', 'Тренируюсь 3 раза в неделю, хочу план питания для набора мышечной массы. Вегетарианка.', '', 26);

    // Расписание тренера на 10 дней вперёд. Силовая в мини-группе заполнена: на ней видно «мест нет».
    const slot = (day, time, minutes, kind, capacity) => Number(db.prepare('INSERT INTO slots (trainer_id, day, time, minutes, kind, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ids.orlov, day, time, minutes, kind, capacity, now()).lastInsertRowid);
    const book = (sid, who) => {
      db.prepare('INSERT INTO bookings (slot_id, client_id, created_at) VALUES (?, ?, ?)').run(sid, ids[who], now());
      access(who, 'orlov');
    };
    const booked = { anna: false, yoga: false, power: false };
    for (let i = 1; i <= 10; i++) {
      const day = d(i);
      const wd = weekday(day);
      if ([1, 3, 5].includes(wd)) {
        const s = slot(day, '08:00', 60, 'Функциональная тренировка', 6);
        if (!booked.anna) { book(s, 'anna'); book(s, 'igor'); booked.anna = true; }
      }
      if ([2, 4].includes(wd)) {
        const s = slot(day, '19:00', 60, 'Йога для спины', 8);
        if (!booked.yoga) { book(s, 'maria'); booked.yoga = true; }
      }
      if (wd === 6) {
        const s = slot(day, '11:00', 90, 'Силовая в мини-группе', 3);
        if (!booked.power) { for (const who of ['anna', 'igor', 'maria']) book(s, who); booked.power = true; }
      }
    }

    // Бесплатные материалы.
    const material = (kind, section, item, position, author) => db.prepare(`INSERT INTO materials (kind, section, title, summary, body, video_url, position, published, author_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', ?, 1, ?, ?, ?)`).run(kind, section, item.title, item.summary, item.body, position, author, now(), now());
    MENU.forEach((m, i) => material('menu', 'food', m, i, ids.smirnova));
    LESSONS.forEach((m, i) => material('lesson', m.section, m, i, ids.smirnova));
    const authors = { doctor: ids.morozova, nutritionist: ids.lebedeva, trainer: ids.orlov };
    ARTICLES.forEach((m, i) => material('article', m.section, m, i, authors[m.author]));

    const note = (who, kind, text, link, hours, read = false) => db.prepare('INSERT INTO notifications (user_id, kind, text, link, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ids[who], kind, text, link, read ? now() : null, ago(hours));
    note('anna', 'alert', 'Давление выше 140/90 два дня подряд. Покажите записи врачу.', '#/charts/pressure', 19 * 24, true);
    db.prepare('INSERT INTO sent (key, user_id, day, sent_at) VALUES (?, ?, ?, ?)').run(`bp:${ids.anna}:${d(-19)}`, ids.anna, d(-19), now());
    note('anna', 'answer', 'Меню готово: Ирина Лебедева', '#/experts', 30);
    note('morozova', 'request', 'Новый запрос: Игорь Белов, посмотреть анализы', `#/request/${igorReq}`, 5);
    note('lebedeva', 'request', 'Новый запрос: Мария Ким, составить меню', `#/request/${mariaReq}`, 26);
    note('orlov', 'booking', 'Новая запись: Анна Соколова, функциональная тренировка', '#/schedule', 48);
  });
}

// Сброс демо: всё, что посетители изменили за день, включая файлы, удаляется.
async function resetDemo(db, today, filesDir) {
  db.exec(`
    DELETE FROM notifications; DELETE FROM sent; DELETE FROM push_subs; DELETE FROM bookings; DELETE FROM slots;
    DELETE FROM requests; DELETE FROM access; DELETE FROM med_intakes; DELETE FROM meds; DELETE FROM lab_files;
    DELETE FROM lab_values; DELETE FROM labs; DELETE FROM goals; DELETE FROM measurements; DELETE FROM materials;
    DELETE FROM profiles; DELETE FROM sessions; DELETE FROM invites; DELETE FROM users;
  `);
  if (filesDir) fs.rmSync(filesDir, { recursive: true, force: true });
  await seed(db, today);
}

module.exports = { seed, resetDemo };
