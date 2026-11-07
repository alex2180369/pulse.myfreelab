'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { streaks, percent, shift } = require('../cases/02_privychki/app/public/stats.js');

const today = '2026-03-02';

test('серия: сегодня отмечено', () => {
  assert.equal(streaks(['2026-03-02', '2026-03-01', '2026-02-28'], today).current, 3);
});

test('серия: сегодня ещё нет, вчера есть — серия жива', () => {
  assert.equal(streaks(['2026-03-01', '2026-02-28'], today).current, 2);
});

test('серия: пропущен вчерашний день — серия оборвалась', () => {
  assert.equal(streaks(['2026-02-28', '2026-02-27'], today).current, 0);
  assert.equal(streaks(['2026-03-02', '2026-02-28'], today).current, 1);
});

test('границы месяца и года, високосный февраль', () => {
  assert.equal(streaks(['2026-03-01', '2026-02-28'], today).current, 2, 'в 2026 феврале 28 дней');
  assert.equal(streaks(['2024-03-01', '2024-02-29', '2024-02-28'], '2024-03-01').current, 3);
  assert.equal(streaks(['2024-03-01', '2024-02-28'], '2024-03-01').current, 1, '29 февраля пропущено');
  assert.equal(streaks(['2027-01-01', '2026-12-31', '2026-12-30'], '2027-01-01').current, 3);
  assert.equal(shift('2024-02-28', 1), '2024-02-29');
  assert.equal(shift('2026-12-31', 1), '2027-01-01');
});

test('лучшая серия и неупорядоченные даты', () => {
  const days = ['2026-01-10', '2026-01-01', '2026-01-03', '2026-01-02', '2026-01-11'];
  assert.deepEqual(streaks(days, '2026-03-02'), { current: 0, best: 3 });
  assert.deepEqual(streaks([], today), { current: 0, best: 0 });
  assert.equal(streaks(['2026-03-02', '2026-03-02'], today).current, 1, 'дубликат не удваивает');
});

test('будущие дни не считаются', () => {
  assert.deepEqual(streaks(['2026-03-03', '2026-03-02'], today), { current: 1, best: 1 });
  assert.equal(percent(['2026-03-03'], '2026-03-02', today), 0);
});

test('процент', () => {
  assert.equal(percent([], today, today), 0, 'новая привычка');
  assert.equal(percent([today], today, today), 100, 'первый день выполнен');
  assert.equal(percent(['2026-03-01'], '2026-03-01', today), 50, 'два дня, один выполнен');
  const month = Array.from({ length: 30 }, (_, i) => shift(today, -i));
  assert.equal(percent(month, '2025-01-01', today), 100);
  assert.equal(percent(month.slice(0, 15), '2025-01-01', today), 50, 'окно 30 дней, старые дни не тянут вниз');
  assert.equal(percent([shift(today, -40)], '2025-01-01', today), 0, 'за окном');
});

test('отметка раньше создания не даёт больше 100%', () => {
  const r = percent([today, '2026-03-01', '2026-02-20'], today, today);
  assert.ok(r > 0 && r <= 100, String(r));
});
