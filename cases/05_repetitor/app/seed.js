'use strict';
// Выдуманный репетитор, ученики и родители для демо. Даты считаются от текущего дня.
// Ответы учеников получаются из «уровня» по темам: генератор с постоянным зерном, демо одинаковое после каждого сброса.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createUser, now, tx } = require('../../../core');
const G = require('./grading');
const { PAGE, ASSIGNMENTS, SKILL, OUTCOMES, LONG_ANSWERS, SCHEDULE } = require('./content');

const PEOPLE = [
  ['petrova', 'Ольга Петрова', 'tutor'],
  ['danya', 'Даня Смирнов', 'student', '9 класс', 'ОГЭ на 5'],
  ['liza', 'Лиза Орлова', 'student', '11 класс', 'ЕГЭ профиль, 80+'],
  ['anya', 'Аня Белова', 'student', '9 класс', 'ОГЭ'],
  ['misha', 'Миша Ковалёв', 'student', '7 класс', 'Подтянуть алгебру'],
  ['timur', 'Тимур Гасанов', 'student', '10 класс', 'Школьная программа'],
  ['smirnova', 'Наталья Смирнова', 'parent'],
  ['orlov', 'Сергей Орлов', 'parent'],
];
const PARENTS = [['smirnova', 'danya'], ['orlov', 'liza']];

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

async function seed(db, today) {
  const ids = {};
  for (const [login, name, role, grade, goal] of PEOPLE) {
    // Пароль случайный и нигде не хранится: в демо входят кнопкой.
    ids[login] = await createUser(db, { login, name, role, password: crypto.randomBytes(18).toString('base64') });
    if (role === 'student') db.prepare('INSERT INTO students (user_id, grade, goal) VALUES (?, ?, ?)').run(ids[login], grade, goal);
  }
  const d = by => shiftDay(today, by);
  const at = (day, hour) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`).toISOString();
  const rnd = random(20261110);

  tx(db, () => {
    for (const [p, s] of PARENTS) db.prepare('INSERT INTO parent_links (parent_id, student_id) VALUES (?, ?)').run(ids[p], ids[s]);
    for (const [k, v] of Object.entries(PAGE)) db.prepare('INSERT INTO page (key, value) VALUES (?, ?)').run(k, v);

    const file = (kind, name, type, stored) => Number(db.prepare('INSERT INTO files (kind, file, name, type, size, seeded, owner_id, created_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?)')
      .run(kind, stored, name, type, ids.petrova, now()).lastInsertRowid);
    db.prepare("INSERT INTO page (key, value) VALUES ('photo_id', ?)").run(String(file('photo', 'Обложка', 'image/png', 'cover.png')));
    const material = (title, topic, access, f, students = []) => {
      const mid = Number(db.prepare('INSERT INTO materials (file_id, title, topic, access, created_at) VALUES (?, ?, ?, ?, ?)').run(f, title, topic, access, now()).lastInsertRowid);
      for (const s of students) db.prepare('INSERT INTO material_access (material_id, student_id) VALUES (?, ?)').run(mid, ids[s]);
    };
    material('Формулы сокращённого умножения', 'Алгебра', 'public', file('material', 'Формулы сокращённого умножения.pdf', 'application/pdf', 'formulas.pdf'));
    material('Таблица квадратов', 'Алгебра', 'students', file('material', 'Таблица квадратов.png', 'image/png', 'squares.png'));
    material('План подготовки к ОГЭ', 'ОГЭ', 'selected', file('material', 'План подготовки к ОГЭ.pdf', 'application/pdf', 'oge_plan.pdf'), ['danya', 'anya']);
    const trapezoid = file('question', 'Картинка к вопросу', 'image/png', 'trapezoid.png');

    const notes = [];
    for (const a of ASSIGNMENTS) {
      const aid = Number(db.prepare('INSERT INTO assignments (title, description, due_day, show_answers, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(a.title, a.description, d(a.due), at(d(a.due - 6), 9)).lastInsertRowid);
      const qs = a.questions.map(([kind, text, options, correct, points, topic, image], i) => {
        const r = db.prepare('INSERT INTO questions (assignment_id, position, kind, text, options, correct, points, topic, image_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(aid, i, kind, text, JSON.stringify(options), JSON.stringify(correct), points, topic, image ? trapezoid : null);
        return { id: Number(r.lastInsertRowid), kind, options, correct, points, topic };
      });
      for (const s of a.students) {
        db.prepare('INSERT INTO assignment_students (assignment_id, student_id, assigned_at) VALUES (?, ?, ?)').run(aid, ids[s], at(d(a.due - 6), 9));
        const outcome = OUTCOMES[a.key][s] || 'none';
        if (outcome === 'none') continue;
        const skill = q => SKILL[s][q.topic] ?? SKILL[s].default;
        const answers = {};
        const manual = {};
        for (const q of qs) {
          const ok = rnd() < skill(q);
          if (q.kind === 'single') answers[q.id] = ok ? q.correct : (q.correct + 1) % q.options.length;
          if (q.kind === 'multi') answers[q.id] = ok ? q.correct : q.correct.slice(0, 1);
          if (q.kind === 'short') answers[q.id] = ok ? q.correct[0] : String(Number(q.correct[0]) + 2);
          if (q.kind === 'long') {
            answers[q.id] = ok ? LONG_ANSWERS[a.key] : 'Начал решать, но запутался в вычислениях.';
            manual[q.id] = ok ? q.points : Math.max(0, Math.round(q.points * skill(q)) - 1);
          }
        }
        if (outcome === 'draft') {
          db.prepare('INSERT INTO submissions (assignment_id, student_id, status, answers, updated_at) VALUES (?, ?, ?, ?, ?)').run(aid, ids[s], 'draft', JSON.stringify(answers), now());
          continue;
        }
        const late = outcome.endsWith('late');
        const submittedDay = late ? d(a.due + 1) : a.due > 0 ? d(-1) : d(a.due - 1);
        const pending = outcome === 'pending';
        const res = G.grade(qs, answers, pending ? {} : manual);
        const status = res.pending ? 'submitted' : 'checked';
        const comment = status === 'checked' && res.score < res.max * 0.6 ? 'Разберём ошибки на занятии.' : status === 'checked' && res.score === res.max ? 'Отлично!' : '';
        const sub = Number(db.prepare(`INSERT INTO submissions (assignment_id, student_id, status, answers, results, score, max_score, late, comment, submitted_at, checked_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(aid, ids[s], status, JSON.stringify(answers), JSON.stringify(res.results), res.score, res.max, late ? 1 : 0, comment,
          at(submittedDay, 16), status === 'checked' ? at(submittedDay, 19) : null, now()).lastInsertRowid);
        if (status === 'submitted') notes.push(['petrova', 'submitted', `Ждёт проверки: ${PEOPLE.find(p => p[0] === s)[1]}, «${a.title}»`, `#/check/${sub}`]);
      }
      if (a.key === 'powers') notes.push(['danya', 'assignment', `Новое задание: ${a.title}, срок ${d(a.due).slice(8)}.${d(a.due).slice(5, 7)}`, `#/task/${aid}`]);
      if (a.key === 'area') notes.push(['smirnova', 'checked', `Проверено: «${a.title}»`, `#/task/${aid}`]);
    }

    // Расписание: каждую неделю, 4 недели назад и 8 вперёд. Прошедшие отмечены, есть пропуски, отмена и перенос.
    for (const [s, wd, time, minutes, format] of SCHEDULE) {
      let first = d(-28);
      while (weekday(first) !== wd) first = shiftDay(first, 1);
      let series = null;
      for (let w = 0; w < 12; w++) {
        const day = shiftDay(first, 7 * w);
        let status = day < today ? 'done' : 'planned';
        if (day < today && ((s === 'misha' && (w === 1 || w === 3)) || (s === 'timur' && w === 2))) status = 'missed';
        if (s === 'anya' && day < today && day >= d(-7)) status = 'cancelled';
        const link = format === 'online' ? 'https://telemost.yandex.ru/j/demo-zachet' : '';
        const r = db.prepare('INSERT INTO lessons (student_id, series_id, day, time, minutes, format, link, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(ids[s], series, day, time, minutes, format, link, status, now());
        const id = Number(r.lastInsertRowid);
        if (!series) { series = id; db.prepare('UPDATE lessons SET series_id = ? WHERE id = ?').run(id, id); }
      }
    }
    // Одно ближайшее занятие Дани в четверг перенесено на пятницу.
    const thu = db.prepare('SELECT * FROM lessons WHERE student_id = ? AND day > ? AND status = ? ORDER BY day').all(ids.danya, today, 'planned').find(l => weekday(l.day) === 4);
    if (thu) db.prepare('UPDATE lessons SET day = ?, time = ?, moved_from = ? WHERE id = ?').run(shiftDay(thu.day, 1), '18:00', `${thu.day} ${thu.time}`, thu.id);

    for (const [who, kind, text, link] of notes) db.prepare('INSERT INTO notifications (user_id, kind, text, link, created_at) VALUES (?, ?, ?, ?, ?)').run(ids[who], kind, text, link, now());
  });
}

// Сброс демо: всё, что посетители изменили за день, включая загруженные файлы, удаляется.
async function resetDemo(db, today, filesDir) {
  db.exec(`
    DELETE FROM notifications; DELETE FROM sent; DELETE FROM push_subs; DELETE FROM answer_files; DELETE FROM submissions;
    DELETE FROM assignment_students; DELETE FROM questions; DELETE FROM assignments; DELETE FROM material_access; DELETE FROM materials;
    DELETE FROM lessons; DELETE FROM leads; DELETE FROM files; DELETE FROM page; DELETE FROM parent_links; DELETE FROM students;
    DELETE FROM sessions; DELETE FROM invites; DELETE FROM users;
  `);
  if (filesDir) fs.rmSync(filesDir, { recursive: true, force: true });
  await seed(db, today);
}

module.exports = { seed, resetDemo };
