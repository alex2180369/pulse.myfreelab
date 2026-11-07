// Подсчёт серий и процентов. Один и тот же код работает на сервере и в браузере, в том числе без сети.
(function (root) {
  const DAY = 864e5;
  const toNum = day => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY;
  const toDay = n => new Date(n * DAY).toISOString().slice(0, 10);
  const shift = (day, by) => toDay(toNum(day) + by);

  // days — массив дат 'ГГГГ-ММ-ДД', когда привычка выполнена.
  function streaks(days, today) {
    const set = new Set(days);
    // Сегодня ещё не отмечено: серия живёт до конца дня и считается от вчера.
    let cursor = set.has(today) ? today : shift(today, -1);
    let current = 0;
    while (set.has(cursor)) { current++; cursor = shift(cursor, -1); }
    let best = 0;
    let run = 0;
    let prev = null;
    for (const n of [...set].filter(d => d <= today).map(toNum).sort((a, b) => a - b)) {
      run = prev !== null && n === prev + 1 ? run + 1 : 1;
      if (run > best) best = run;
      prev = n;
    }
    return { current, best };
  }

  // Процент за период: от начала привычки, но не дальше period дней назад.
  function percent(days, createdDay, today, period = 30) {
    const valid = days.filter(d => d <= today);
    const earliest = valid.reduce((m, d) => (d < m ? d : m), createdDay);
    const start = Math.max(toNum(earliest), toNum(today) - period + 1);
    const total = toNum(today) - start + 1;
    if (total <= 0) return 0;
    const done = valid.filter(d => toNum(d) >= start).length;
    return Math.round(done / total * 100);
  }

  const api = { streaks, percent, shift };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
