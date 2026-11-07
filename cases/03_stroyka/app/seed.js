'use strict';
// Выдуманная компания для демо. Даты считаются от текущего дня, поэтому демо всегда выглядит свежим.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createUser, now, tx } = require('../../../core');
const { QC_KINDS, QC_TEMPLATE } = require('./api');

const PEOPLE = [
  ['volkov', 'Андрей Волков', 'director'],
  ['krylova', 'Ольга Крылова', 'manager'],
  ['panin', 'Сергей Панин', 'foreman'],
  ['ryabov', 'Дмитрий Рябов', 'foreman'],
  ['zuev', 'Николай Зуев', 'worker'],
  ['ahmetov', 'Тимур Ахметов', 'worker'],
  ['gurov', 'Павел Гуров', 'worker'],
];

const shiftDay = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);

async function seed(db, today) {
  const ids = {};
  for (const [login, name, role] of PEOPLE) {
    // Пароль случайный и нигде не хранится: в демо входят кнопкой.
    ids[login] = await createUser(db, { login, name, role, password: crypto.randomBytes(18).toString('base64') });
  }
  const d = by => shiftDay(today, by);

  tx(db, () => {
    const addSite = (name, address, start, end, status, foreman) => {
      const r = db.prepare('INSERT INTO sites (name, address, start_date, end_date, status, manager_id, foreman_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, address, start, end, status, ids.krylova, foreman, now());
      const siteId = Number(r.lastInsertRowid);
      const add = db.prepare('INSERT INTO qc_items (site_id, kind, position, label) VALUES (?, ?, ?, ?)');
      for (const kind of QC_KINDS) QC_TEMPLATE[kind].forEach((label, i) => add.run(siteId, kind, i, label));
      return siteId;
    };
    const house = addSite('Дом на Лесной, 12', 'Лесная ул., 12', d(-40), d(30), 'active', ids.panin);
    const office = addSite('Офис на Набережной', 'Набережная ул., 8, этаж 3', d(-18), d(45), 'active', ids.panin);
    const dacha = addSite('Дача в Сосновке', 'пос. Сосновка, уч. 41', d(-70), d(80), 'hold', ids.ryabov);
    const flat = addSite('Квартира на Садовой', 'Садовая ул., 5, кв. 77', d(-60), d(-3), 'done', ids.ryabov);

    const task = (site, title, who, due, status = 'todo') => {
      const r = db.prepare('INSERT INTO tasks (site_id, title, assignee_id, due_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(site, title, who, due, status, ids.panin, now(), now());
      return Number(r.lastInsertRowid);
    };
    task(house, 'Смонтировать перегородки на втором этаже', ids.zuev, d(1), 'doing');
    task(house, 'Проложить кабель в гостиной', ids.ahmetov, d(-1));
    task(house, 'Закрыть швы ГКЛ в спальне', ids.zuev, d(3));
    task(house, 'Принять доставку профиля', ids.panin, d(0));
    task(house, 'Вывезти строительный мусор', ids.gurov, d(-4), 'done');
    task(office, 'Смонтировать каркас подвесного потолка', ids.gurov, d(2), 'doing');
    task(office, 'Проверить вентиляцию с подрядчиком', ids.panin, d(4));
    task(dacha, 'Закрыть фундамент от дождя', ids.gurov, d(5));
    task(flat, 'Сдать квартиру заказчику', ids.ryabov, d(-3), 'done');

    const report = (site, day, text, workers, problems = [], problemText = '') => {
      const r = db.prepare('INSERT INTO reports (site_id, day, author_id, done_text, workers, problems, problem_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(site, day, ids.panin, text, workers, JSON.stringify(problems), problemText, now(), now());
      return Number(r.lastInsertRowid);
    };
    const photo = (site, file, day, extra = {}) => db.prepare(
      'INSERT INTO photos (site_id, author_id, file, type, size, seeded, day, report_id, task_id, qc_item_id, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
    ).run(site, ids.panin, `${file}.jpg`, 'image/jpeg', 0, day, extra.report ?? null, extra.task ?? null, extra.qc ?? null, now());

    const r0 = report(house, d(0), 'Монтаж перегородок на втором этаже, разводка кабеля в гостиной.', 6, ['materials'], 'Не привезли профиль, ждём к обеду');
    photo(house, 'drywall', d(0), { report: r0 });
    photo(house, 'materials', d(0), { report: r0 });
    const r1 = report(house, d(-1), 'Закончили кровлю над гаражом, начали перегородки.', 5);
    photo(house, 'roof', d(-1), { report: r1 });
    const r2 = report(house, d(-2), 'Электрика на первом этаже.', 4);
    photo(house, 'electric', d(-2), { report: r2 });
    const r3 = report(house, d(-3), 'Заливка стяжки в гараже.', 4, ['weather']);
    photo(house, 'screed', d(-3), { report: r3 });
    photo(house, 'facade', d(-5));
    photo(house, 'foundation', d(-30));

    const r4 = report(office, d(-1), 'Монтаж каркаса потолка, разметка перегородок.', 3, ['power'], 'Отключали электричество на этаже до 14:00');
    photo(office, 'office', d(-1), { report: r4 });
    photo(office, 'paint', d(-2));
    photo(flat, 'finished', d(-3));
    photo(dacha, 'foundation', d(-20));

    // Контроль качества: одно замечание с фото и уже созданной задачей, одно без задачи.
    const qc = (site, kind, position) => db.prepare('SELECT id FROM qc_items WHERE site_id = ? AND kind = ? AND position = ?').get(site, kind, position).id;
    const mark = (id, state, note = '') => db.prepare('UPDATE qc_items SET state = ?, note = ?, checked_by = ?, checked_at = ? WHERE id = ?').run(state, note, ids.krylova, now(), id);
    mark(qc(house, 'drywall', 0), 'ok');
    mark(qc(house, 'drywall', 1), 'ok');
    const crack = qc(house, 'drywall', 3);
    mark(crack, 'fix', 'Трещина у дверного проёма в спальне');
    const fixId = task(house, 'Исправить: Углы без трещин', ids.zuev, d(2));
    db.prepare('UPDATE qc_items SET task_id = ? WHERE id = ?').run(fixId, crack);
    photo(house, 'crack', d(-1), { qc: crack, task: fixId });
    mark(qc(office, 'paint', 0), 'ok');
    const drips = qc(office, 'paint', 2);
    mark(drips, 'fix', 'Потёки у окна');
    photo(office, 'paint_defect', d(-2), { qc: drips });
    mark(qc(house, 'tile', 0), 'ok');
    const joints = qc(house, 'tile', 1);
    mark(joints, 'fix', 'Швы разной ширины в санузле');
    photo(house, 'tile_defect', d(-1), { qc: joints });
    photo(house, 'tile', d(-4));

    const note = (who, kind, text, link) => db.prepare('INSERT INTO notifications (user_id, kind, text, link, created_at) VALUES (?, ?, ?, ?, ?)').run(ids[who], kind, text, link, now());
    for (const who of ['volkov', 'krylova']) {
      note(who, 'report', 'Отчёт за сегодня: Дом на Лесной, 12', `#/report/${house}/${d(0)}`);
      note(who, 'problem', 'Проблема на объекте «Дом на Лесной, 12»: нет материалов', `#/report/${house}/${d(0)}`);
    }
    note('zuev', 'task', 'Новая задача на объекте «Дом на Лесной, 12»: Закрыть швы ГКЛ в спальне', '#/tasks');
  });
}

// Сброс демо: всё, что посетители изменили за день, включая их фото, удаляется.
async function resetDemo(db, today, photosDir) {
  db.exec(`
    DELETE FROM notifications; DELETE FROM photos; DELETE FROM qc_items; DELETE FROM reports; DELETE FROM tasks; DELETE FROM sites;
    DELETE FROM sessions; DELETE FROM invites; DELETE FROM users;
  `);
  fs.rmSync(photosDir, { recursive: true, force: true });
  await seed(db, today);
}

module.exports = { seed, resetDemo };
