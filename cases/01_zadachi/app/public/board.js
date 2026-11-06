import { h, clear, api, guard, avatar, select, toast } from '/shared/ui.js';
import { state, STATUS, isManager, openTask, newTaskDialog, dueBadge, priorityMark, render } from '/app.js';

const TOUCH_DELAY = 260;
const MOUSE_THRESHOLD = 6;
const EDGE = 44;        // ближе к краю экрана доска сама прокручивается
const EDGE_SPEED = 7;   // пикселей за кадр

// Браузер решает, можно ли отменить прокрутку, в момент касания.
// Поэтому обработчик стоит заранее, а не появляется вместе с перетаскиванием.
let dragActive = false;
document.addEventListener('touchmove', e => { if (dragActive) e.preventDefault(); }, { passive: false });
// Долгое нажатие на телефоне не должно открывать системное меню.
document.addEventListener('contextmenu', e => { if (dragActive) e.preventDefault(); });

function canDrag(task) {
  if (isManager()) return true;
  return task.assigneeId === state.user.id && task.status !== 'done';
}

function card(task) {
  const el = h('article', {
    class: `card ${canDrag(task) ? 'draggable' : ''}`, 'data-task': task.id, tabindex: 0, role: 'button',
    'aria-label': `${task.title}, ${STATUS[task.status]}`,
    onclick: () => { if (!el.dataset.dragged) openTask(task.id); delete el.dataset.dragged; },
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(task.id); } },
  },
  h('div', { class: 'card-top' }, priorityMark(task.priority), h('span', { class: 'card-project' }, task.projectName || 'Без проекта')),
  h('p', { class: 'card-title' }, task.title),
  h('div', { class: 'card-foot' }, dueBadge(task) || h('span'),
    h('span', { class: 'card-right' }, task.commentCount ? h('span', { class: 'muted small' }, `${task.commentCount} комм.`) : null, avatar(task.assigneeName, task.assigneeId))));
  if (canDrag(task)) attachDrag(el, task);
  return el;
}

// Перетаскивание на событиях указателя: работает и мышью, и пальцем.
// На телефоне карточку нужно задержать пальцем, иначе обычное движение листает доску.
function attachDrag(el, task) {
  el.addEventListener('pointerdown', down => {
    if (down.button !== 0) return;
    const touch = down.pointerType === 'touch';
    const start = { x: down.clientX, y: down.clientY };
    let dragging = false;
    let timer = null;
    let ghost = null;
    let holder = null;
    let offset = { x: 0, y: 0 };
    let pointer = { ...start };
    let frame = 0;
    const board = el.closest('.board');

    // Палец не достаёт до соседней колонки: у края экрана доска едет сама.
    const autoScroll = () => {
      if (!dragging) return;
      const box = board.getBoundingClientRect();
      let dx = 0;
      if (pointer.x > Math.min(box.right, window.innerWidth) - EDGE) dx = EDGE_SPEED;
      else if (pointer.x < Math.max(box.left, 0) + EDGE) dx = -EDGE_SPEED;
      let dy = 0;
      if (pointer.y > window.innerHeight - EDGE) dy = EDGE_SPEED;
      else if (pointer.y < EDGE) dy = -EDGE_SPEED;
      if (dx) board.scrollLeft += dx;
      if (dy) window.scrollBy(0, dy);
      if (dx || dy) moveTo(pointer.x, pointer.y);
      frame = requestAnimationFrame(autoScroll);
    };

    const begin = () => {
      dragging = true;
      dragActive = true;
      el.dataset.dragged = '1';
      navigator.vibrate?.(15);
      const r = el.getBoundingClientRect();
      offset = { x: start.x - r.left, y: start.y - r.top };
      ghost = el.cloneNode(true);
      ghost.classList.add('ghost');
      ghost.style.width = `${r.width}px`;
      document.body.append(ghost);
      holder = h('div', { class: 'card-holder' });
      holder.style.height = `${r.height}px`;
      // Карточку нельзя убирать из страницы: касания идут элементу, на который лёг палец.
      // Отсоединённый элемент перестаёт передавать их наверх, и браузер забирает жест.
      el.after(holder);
      el.classList.add('drag-source');
      board.style.scrollSnapType = 'none';
      moveTo(start.x, start.y);
      frame = requestAnimationFrame(autoScroll);
    };

    const moveTo = (x, y) => {
      pointer = { x, y };
      ghost.style.transform = `translate(${x - offset.x}px, ${y - offset.y}px)`;
      const under = document.elementFromPoint(x, y);
      const column = under?.closest('.column-cards') || under?.closest('.column')?.querySelector('.column-cards');
      if (!column) return;
      const cards = [...column.querySelectorAll('.card:not(.drag-source)')];
      const next = cards.find(c => { const b = c.getBoundingClientRect(); return y < b.top + b.height / 2; });
      if (next) column.insertBefore(holder, next); else column.append(holder);
    };

    const onMove = e => {
      if (dragging) { moveTo(e.clientX, e.clientY); return; }
      const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (touch) { if (dist > 10) cancel(); return; }
      if (dist > MOUSE_THRESHOLD) begin();
    };

    const cleanup = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      dragActive = false;
      board.style.scrollSnapType = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cancel);
    };

    // Жест отменён браузером или системой: карточка возвращается на место, запроса нет.
    const cancel = () => {
      cleanup();
      if (!dragging) return;
      dragging = false;
      ghost.remove();
      holder.remove();
      el.classList.remove('drag-source');
      setTimeout(() => delete el.dataset.dragged, 0);
    };

    const onUp = async () => {
      cleanup();
      if (!dragging) return;
      ghost.remove();
      const column = holder.closest('.column');
      const status = column?.dataset.status || task.status;
      let next = holder.nextElementSibling;
      while (next?.classList.contains('drag-source')) next = next.nextElementSibling;
      const nextCard = next?.classList.contains('card') ? next : null;
      holder.replaceWith(el);
      el.classList.remove('drag-source');
      setTimeout(() => delete el.dataset.dragged, 0);
      const moved = await guard(() => api('POST', `/tasks/${task.id}/move`, { status, beforeId: nextCard ? Number(nextCard.dataset.task) : null }));
      if (moved && status !== task.status) toast(`Статус: ${STATUS[status]}`, 'ok');
      render();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    if (touch) timer = setTimeout(begin, TOUCH_DELAY);
  });
}

export async function renderBoard(page, route) {
  const projectId = route.query.get('project') || '';
  const assigneeId = route.query.get('assignee') || '';
  const params = new URLSearchParams();
  if (projectId) params.set('project', projectId);
  if (assigneeId) params.set('assignee', assigneeId);
  const { tasks } = await api('GET', `/tasks?${params}`);

  const setFilter = (key, value) => {
    const q = new URLSearchParams(route.query);
    if (value) q.set(key, value); else q.delete(key);
    location.hash = `/board${q.size ? `?${q}` : ''}`;
  };

  const columns = Object.entries(STATUS).map(([status, label]) => {
    const list = tasks.filter(t => t.status === status);
    return h('section', { class: `column column-${status}`, 'data-status': status },
      h('h2', null, label, h('span', { class: 'count' }, list.length)),
      h('div', { class: 'column-cards' }, list.map(card), !list.length && h('p', { class: 'column-empty' }, 'Здесь пусто')));
  });

  clear(page,
    h('header', { class: 'page-head row between' }, h('h1', null, 'Доска'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => newTaskDialog({ projectId: projectId && projectId !== 'none' ? Number(projectId) : null }) }, 'Новая задача')),
    h('div', { class: 'filters' },
      select([['', 'Все проекты'], ...state.projects.map(p => [p.id, p.name]), ['none', 'Без проекта']], projectId,
        { 'aria-label': 'Проект', name: 'filter-project', onchange: e => setFilter('project', e.target.value) }),
      select([['', 'Все исполнители'], ...state.team.filter(u => u.active).map(u => [u.id, u.name])], assigneeId,
        { 'aria-label': 'Исполнитель', name: 'filter-assignee', onchange: e => setFilter('assignee', e.target.value) })),
    h('div', { class: 'board' }, columns));
}
