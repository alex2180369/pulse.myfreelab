// Графики показателей: SVG без библиотек. Данные никуда не уходят, всё рисуется в браузере.
const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    // Цвета из переменных темы задаём через стиль: в атрибуте SVG var() работает не везде.
    if ((k === 'fill' || k === 'stroke') && String(v).startsWith('var(')) el.style.setProperty(k, v);
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const dayIndex = (from, day) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
const shortDay = day => `${day.slice(8)}.${day.slice(5, 7)}`;
const num = v => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v);

// Подбирает «красивые» деления оси: 3–4 метки с круглым шагом.
function ticks(min, max) {
  const span = max - min || 1;
  const raw = span / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(x => x >= raw);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

export const COLORS = {
  weight: ['var(--c-weight)'], waist: ['var(--c-waist)'], pressure: ['var(--c-sys)', 'var(--c-dia)'], pulse: ['var(--c-pulse)'],
  activity: ['var(--c-activity)'], sleep: ['var(--c-sleep)'], stress: ['var(--c-stress)'],
};

// points: [{ day, v1, v2 }], from/days задают ось дат. kind: line или bar.
export function chart({ metric, def, points, from, days, goal = null, mini = false }) {
  // Ширина под экран: иначе на компьютере подписи осей растягиваются вдвое.
  const W = Math.round(Math.min(680, Math.max(300, (window.innerWidth || 360) - 64)));
  const H = mini ? 120 : Math.round(Math.min(260, Math.max(190, W * 0.45)));
  const m = { l: 34, r: 8, t: 12, b: 20 };
  const pw = W - m.l - m.r; const ph = H - m.t - m.b;
  const bars = def.chart === 'bar';
  const two = metric === 'pressure';
  const values = points.flatMap(p => (two ? [p.v1, p.v2] : [p.v1])).filter(v => v !== null && v !== undefined);
  const refs = two ? [140, 90] : [];
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${def.name}: график за ${days} дней` });
  if (!values.length) {
    svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-text' }, 'За этот период записей нет'));
    return svg;
  }
  let lo = Math.min(...values, ...(goal !== null ? [goal] : []), ...refs.filter(() => !bars));
  let hi = Math.max(...values, ...(goal !== null ? [goal] : []), ...refs);
  if (bars) lo = 0;
  else { const pad = (hi - lo) * 0.12 || Math.max(1, hi * 0.03); lo -= pad; hi += pad; }
  if (bars) hi *= 1.08;
  const y = v => m.t + ph - ((v - lo) / (hi - lo)) * ph;
  const step = days > 1 ? pw / (days - 1) : pw;
  const x = day => m.l + (bars ? (dayIndex(from, day) + 0.5) * (pw / days) : dayIndex(from, day) * step);

  for (const t of ticks(lo, hi)) {
    if (t < lo || t > hi) continue;
    svg.append(s('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
    svg.append(s('text', { x: m.l - 5, y: y(t) + 3, 'text-anchor': 'end' }, t >= 10000 ? `${Math.round(t / 1000)}т` : num(t)));
  }
  for (const r of refs) svg.append(s('line', { class: 'ref', x1: m.l, x2: W - m.r, y1: y(r), y2: y(r) }));
  if (goal !== null) {
    svg.append(s('line', { class: 'goal-line', x1: m.l, x2: W - m.r, y1: y(goal), y2: y(goal) }));
    if (!mini) svg.append(s('text', { class: 'goal-label', x: W - m.r, y: y(goal) - 4, 'text-anchor': 'end' }, 'цель'));
  }
  const labelDays = [0, Math.floor((days - 1) / 2), days - 1];
  for (const i of labelDays) {
    const day = new Date(Date.parse(`${from}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10);
    const anchor = i === 0 ? 'start' : i === days - 1 ? 'end' : 'middle';
    const px = bars ? x(day) : m.l + i * step;
    svg.append(s('text', { x: i === 0 ? m.l : i === days - 1 ? W - m.r : px, y: H - 5, 'text-anchor': anchor }, shortDay(day)));
  }

  const series = two ? [['v1', COLORS.pressure[0]], ['v2', COLORS.pressure[1]]] : [['v1', COLORS[metric][0]]];
  if (bars) {
    const bw = Math.max(2, (pw / days) * 0.68);
    const g = s('g', { fill: series[0][1] });
    for (const p of points) {
      if (p.v1 === null) continue;
      const top = y(p.v1);
      g.append(s('rect', { x: x(p.day) - bw / 2, y: top, width: bw, height: Math.max(1, m.t + ph - top), rx: Math.min(3, bw / 2) },
        s('title', {}, `${shortDay(p.day)}: ${num(p.v1)}`)));
    }
    svg.append(g);
    return svg;
  }
  for (const [key, color] of series) {
    const list = points.filter(p => p[key] !== null && p[key] !== undefined);
    if (!list.length) continue;
    svg.append(s('polyline', { class: 'line', stroke: color, points: list.map(p => `${x(p.day).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ') }));
    if (days <= 30 && !mini) {
      const g = s('g', { fill: color });
      for (const p of list) g.append(s('circle', { class: 'dot', cx: x(p.day), cy: y(p[key]), r: 3 }, s('title', {}, `${shortDay(p.day)}: ${num(p[key])}`)));
      svg.append(g);
    }
  }
  return svg;
}
