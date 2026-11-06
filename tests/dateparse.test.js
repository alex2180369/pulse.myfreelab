'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTaskText: parse } = require('../core/dateparse');

// Пятница, 6 ноября 2026, 12:00 по Москве.
const now = new Date('2026-11-06T09:00:00Z');
const opts = { now, tz: 'Europe/Moscow' };
const due = (text, o = opts) => parse(text, o).dueAt;

test('время из ТЗ', () => {
  const r = parse('Подготовить договор @anna завтра 15:00', opts);
  assert.equal(r.title, 'Подготовить договор');
  assert.deepEqual(r.mentions, ['anna']);
  assert.equal(r.dueAt, '2026-11-07T12:00:00.000Z');
});

test('сегодня, завтра, послезавтра', () => {
  assert.equal(due('Отчёт сегодня 17:30'), '2026-11-06T14:30:00.000Z');
  assert.equal(due('Отчёт сегодня'), '2026-11-06T15:00:00.000Z', 'без времени: конец рабочего дня');
  assert.equal(due('Отчёт завтра в 9:05'), '2026-11-07T06:05:00.000Z');
  assert.equal(due('Отчёт послезавтра'), '2026-11-08T15:00:00.000Z');
  assert.equal(due('Отчёт до завтра'), '2026-11-07T15:00:00.000Z');
});

test('через', () => {
  assert.equal(due('Позвонить через 2 часа'), '2026-11-06T11:00:00.000Z');
  assert.equal(due('Позвонить через 30 минут'), '2026-11-06T09:30:00.000Z');
  assert.equal(due('Позвонить через 3 дня'), '2026-11-09T15:00:00.000Z');
});

test('дни недели', () => {
  assert.equal(due('Встреча в понедельник'), '2026-11-09T15:00:00.000Z');
  assert.equal(due('Встреча во вторник в 10:00'), '2026-11-10T07:00:00.000Z');
  assert.equal(due('Встреча в пятницу 14:00'), '2026-11-06T11:00:00.000Z', 'сегодня, время впереди');
  assert.equal(due('Встреча в пятницу 10:00'), '2026-11-13T07:00:00.000Z', 'сегодня, время прошло: следующая неделя');
});

test('дата числами', () => {
  assert.equal(due('Сдать 12.11'), '2026-11-12T15:00:00.000Z');
  assert.equal(due('Сдать 12.11 15:00'), '2026-11-12T12:00:00.000Z');
  assert.equal(due('Сдать 12.11.2027'), '2027-11-12T15:00:00.000Z');
  assert.equal(due('Сдать 01.02'), '2027-02-01T15:00:00.000Z', 'дата прошла: следующий год');
  assert.equal(due('Сдать 31.12 23:59'), '2026-12-31T20:59:00.000Z');
});

test('только время', () => {
  assert.equal(due('Созвон в 15:00'), '2026-11-06T12:00:00.000Z');
  assert.equal(due('Созвон в 10:00'), '2026-11-07T07:00:00.000Z', 'время прошло: завтра');
});

test('невозможные даты не превращаются в другие', () => {
  assert.equal(due('Сдать 31.02'), null);
  assert.equal(due('Сдать 45.13'), null);
  assert.equal(due('Отчёт завтра 25:00'), null);
  assert.equal(due('Созвон в 25:00'), null);
});

test('обычный текст не принимается за срок', () => {
  for (const t of ['Обновить версию 2.0 на сервере', 'Купить 3 лампы', 'Заказ 15', 'Сегодняшний отчёт', 'Заказать 12 стульев', 'Проверить ссылку t.me/test']) {
    assert.equal(due(t), null, t);
  }
  assert.equal(parse('Обновить версию 2.0 на сервере', opts).title, 'Обновить версию 2.0 на сервере');
});

test('название остаётся чистым', () => {
  assert.equal(parse('Отчёт, завтра 12:00', opts).title, 'Отчёт');
  assert.equal(parse('завтра 12:00 отчёт', opts).title, 'отчёт');
  assert.equal(parse('@anna @boris Созвон', opts).title, 'Созвон');
  assert.deepEqual(parse('@anna @boris Созвон', opts).mentions, ['anna', 'boris']);
  assert.equal(parse('Написать на mail@example.com', opts).title, 'Написать на mail@example.com', 'почта не упоминание');
  assert.equal(parse('завтра', opts).title, '', 'только срок: названия нет');
});

test('часовой пояс и переход через полночь', () => {
  // В Москве уже 7 ноября, в UTC ещё 6-е.
  const late = new Date('2026-11-06T22:00:00Z');
  assert.equal(parse('Отчёт сегодня 12:00', { now: late, tz: 'Europe/Moscow' }).dueAt, '2026-11-07T09:00:00.000Z');
  assert.equal(parse('Отчёт завтра 12:00', { now: late, tz: 'Asia/Vladivostok' }).dueAt, '2026-11-08T02:00:00.000Z');
  assert.equal(parse('Отчёт завтра 12:00', { now, tz: 'UTC' }).dueAt, '2026-11-07T12:00:00.000Z');
});
