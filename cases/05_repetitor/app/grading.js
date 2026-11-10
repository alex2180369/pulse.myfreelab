'use strict';
// Автопроверка заданий. Один файл для сервера и тестов, в браузер правильные ответы не уходят.

const KINDS = ['single', 'multi', 'short', 'long'];
const KIND_NAME = { single: 'Один ответ', multi: 'Несколько ответов', short: 'Короткий ответ', long: 'Развёрнутый ответ' };

// Короткий ответ: регистр, ё, лишние пробелы и запятая вместо точки не важны. Числа сравниваются как числа.
const norm = s => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/,/g, '.');
const asNumber = s => {
  const t = s.replace(/\s/g, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
};

function sameShort(answer, accepted) {
  const a = norm(answer);
  if (!a) return false;
  const na = asNumber(a);
  return accepted.some(x => {
    const b = norm(x);
    if (a === b) return true;
    const nb = asNumber(b);
    return na !== null && nb !== null && Math.abs(na - nb) < 1e-9;
  });
}

// Проверяет один вопрос. Развёрнутый ответ возвращает null: его оценивает репетитор.
function check(q, answer) {
  if (q.kind === 'long') return null;
  let ok = false;
  if (q.kind === 'single') ok = Number.isInteger(answer) && answer === q.correct;
  if (q.kind === 'multi') {
    // Балл только за полное совпадение: правило простое и понятное ученику.
    const given = Array.isArray(answer) ? [...new Set(answer)].sort((a, b) => a - b) : [];
    const right = [...q.correct].sort((a, b) => a - b);
    ok = given.length === right.length && given.every((v, i) => v === right[i]);
  }
  if (q.kind === 'short') ok = sameShort(answer, q.correct);
  return { correct: ok, points: ok ? q.points : 0 };
}

// Итог работы: автоматические баллы, ручные баллы, сколько ещё ждёт проверки.
function grade(questions, answers, manual = {}) {
  const results = {};
  let score = 0;
  let max = 0;
  let pending = 0;
  for (const q of questions) {
    max += q.points;
    const r = check(q, answers[q.id]);
    if (r) {
      results[q.id] = r;
      score += r.points;
    } else if (manual[q.id] !== undefined && manual[q.id] !== null) {
      results[q.id] = { manual: true, points: manual[q.id] };
      score += manual[q.id];
    } else {
      results[q.id] = { manual: true, points: null };
      pending++;
    }
  }
  return { results, score, max, pending };
}

const percent = (score, max) => (max ? Math.round((score / max) * 100) : null);

module.exports = { KINDS, KIND_NAME, norm, sameShort, check, grade, percent };
