'use strict';
// Показатели дневника и правила подсказок по анализам. Пороги и тексты утверждает заказчик,
// здесь демо-набор по общедоступным ориентирам для взрослых.

// v1 — основное значение, v2 — второе (нижнее давление, качество сна, минуты тренировки).
const METRICS = {
  weight: { name: 'Вес', unit: 'кг', v1: [20, 350], step: 0.1, chart: 'line' },
  waist: { name: 'Талия', unit: 'см', v1: [30, 250], step: 0.5, chart: 'line' },
  pressure: { name: 'Давление', unit: 'мм рт. ст.', v1: [60, 260], v2: [30, 180], v2Required: true, step: 1, chart: 'line', v2Name: 'нижнее' },
  pulse: { name: 'Пульс', unit: 'уд/мин', v1: [25, 250], step: 1, chart: 'line' },
  activity: { name: 'Шаги', unit: 'шагов', v1: [0, 100000], v2: [0, 600], step: 1, chart: 'bar', v2Name: 'минут тренировки' },
  sleep: { name: 'Сон', unit: 'ч', v1: [0, 24], v2: [1, 5], step: 0.5, chart: 'bar', v2Name: 'качество 1–5', v2Int: true },
  stress: { name: 'Стресс', unit: 'из 10', v1: [1, 10], step: 1, chart: 'line', v1Int: true },
};
const METRIC_KEYS = Object.keys(METRICS);

// Кто из специалистов какие показатели видит. Тренеру хватает активности, анализы ему не нужны.
const SCOPE = {
  doctor: { metrics: METRIC_KEYS, labs: true },
  nutritionist: { metrics: METRIC_KEYS, labs: true },
  trainer: { metrics: ['activity', 'weight', 'pulse'], labs: false },
};

const GOAL_METRICS = {
  weight: { name: 'Вес', unit: 'кг', mode: 'value' },
  activity: { name: 'Шаги в день', unit: 'шагов', mode: 'average' },
  sleep: { name: 'Сон', unit: 'ч', mode: 'average' },
};

// Диапазоны полуоткрытые: [от, до). Значение ровно на границе относится к следующему диапазону.
const LAB_TESTS = {
  glucose: {
    name: 'Глюкоза натощак', unit: 'ммоль/л', valid: [1, 40], step: 0.1,
    ranges: [
      { below: 3.3, level: 'low', label: 'Ниже нормы', text: 'Сахар ниже обычного. Бывает после долгого голода или нагрузки. Если есть слабость, дрожь, головокружение, обратитесь к терапевту.' },
      { below: 5.6, level: 'ok', label: 'В пределах нормы', text: 'Глюкоза натощак в норме. Повторяйте анализ раз в год.' },
      { below: 7.0, level: 'warn', label: 'Выше нормы', text: 'Глюкоза натощак повышена. Сдайте анализ повторно и покажите результат терапевту или эндокринологу. Помогают регулярная активность и меньше быстрых углеводов.' },
      { below: Infinity, level: 'bad', label: 'Высокая', text: 'Глюкоза значительно выше нормы. Не откладывайте визит к эндокринологу или терапевту.' },
    ],
  },
  cholesterol: {
    name: 'Общий холестерин', unit: 'ммоль/л', valid: [1, 20], step: 0.1,
    ranges: [
      { below: 5.2, level: 'ok', label: 'В пределах нормы', text: 'Холестерин в желательном диапазоне.' },
      { below: 6.2, level: 'warn', label: 'Погранично высокий', text: 'Холестерин на верхней границе. Стоит сократить жирное мясо и выпечку, добавить овощи, рыбу и движение. Повторите анализ через 3 месяца.' },
      { below: Infinity, level: 'bad', label: 'Высокий', text: 'Холестерин высокий. Обратитесь к терапевту: нужен расширенный анализ (липидограмма).' },
    ],
  },
  hemoglobin: {
    name: 'Гемоглобин', unit: 'г/л', valid: [40, 250], step: 1, bySex: true,
    ranges: {
      f: [
        { below: 120, level: 'warn', label: 'Ниже нормы', text: 'Гемоглобин снижен. Возможен недостаток железа. Покажите анализ терапевту, не принимайте железо без назначения.' },
        { below: 151, level: 'ok', label: 'В пределах нормы', text: 'Гемоглобин в норме.' },
        { below: Infinity, level: 'warn', label: 'Выше нормы', text: 'Гемоглобин повышен. Бывает при обезвоживании и курении. Покажите анализ терапевту.' },
      ],
      m: [
        { below: 130, level: 'warn', label: 'Ниже нормы', text: 'Гемоглобин снижен. Возможен недостаток железа. Покажите анализ терапевту, не принимайте железо без назначения.' },
        { below: 171, level: 'ok', label: 'В пределах нормы', text: 'Гемоглобин в норме.' },
        { below: Infinity, level: 'warn', label: 'Выше нормы', text: 'Гемоглобин повышен. Бывает при обезвоживании и курении. Покажите анализ терапевту.' },
      ],
    },
  },
};
const LAB_KEYS = Object.keys(LAB_TESTS);
const DISCLAIMER = 'Подсказка составлена программой по заданным порогам. Это не диагноз и не замена консультации врача.';

function labVerdict(code, value, sex) {
  const test = LAB_TESTS[code];
  if (!test || typeof value !== 'number' || Number.isNaN(value)) return null;
  let ranges = test.ranges;
  if (test.bySex) {
    if (sex !== 'f' && sex !== 'm') return { level: 'unknown', label: 'Нужен пол', text: 'Норма гемоглобина зависит от пола. Укажите пол в профиле, и подсказка появится.' };
    ranges = ranges[sex];
  }
  // Сравнение с округлением до шага анализа: 5.6 из формы не должно стать 5.59999.
  const v = Math.round(value * 1000) / 1000;
  const r = ranges.find(x => v < x.below);
  return { level: r.level, label: r.label, text: r.text };
}

// Давление считается высоким от 140 верхнего или 90 нижнего.
const highPressure = (sys, dia) => sys >= 140 || dia >= 90;

const bmi = (weightKg, heightCm) => {
  if (!weightKg || !heightCm) return null;
  return Math.round((weightKg / ((heightCm / 100) ** 2)) * 10) / 10;
};

function bmiLabel(value) {
  if (value === null) return null;
  if (value < 18.5) return 'ниже нормы';
  if (value < 25) return 'норма';
  if (value < 30) return 'выше нормы';
  return 'ожирение';
}

module.exports = {
  METRICS, METRIC_KEYS, SCOPE, GOAL_METRICS, LAB_TESTS, LAB_KEYS, DISCLAIMER, labVerdict, highPressure, bmi, bmiLabel,
};
