// ===================================================================
// SHARED ITEM UTILITIES — used by projects.js and todos.js
// ===================================================================

import { showToast } from './utils.js';
import { t } from './i18n.js';

// ===================================================================
// SHARED DRAG STATE
// ===================================================================
export let isDragging = false;
export function setDragging(v) { isDragging = v; }

export const LONG_PRESS_MS = 250;
export const DRAG_THRESHOLD = 5;

// ===================================================================
// HOVER DELAY — show action buttons on hover / single-click
// ===================================================================
// Replaces initTaskHoverDelay (projects) and initTodoHoverDelay (todos)
export function initItemHoverDelay(container, {
  itemSelector,
  actionsSelector,
  rowSelector,
  textSelector,
  editingSelector = '.task-edit-input',
  onDblClick,
}) {
  const isTouchDevice = window.matchMedia('(max-width:480px)').matches || 'ontouchstart' in window;
  if (isTouchDevice) return;

  container.querySelectorAll(itemSelector).forEach(item => {
    let hoverTimer = null;
    let clickTimer = null;
    const actions = item.querySelector(actionsSelector);
    const row = item.querySelector(rowSelector);
    const text = item.querySelector(textSelector);
    if (!actions || !row) return;

    row.addEventListener('mouseenter', () => {
      hoverTimer = setTimeout(() => {
        if (item.querySelector(editingSelector)) return;
        actions.classList.add('visible');
      }, 2000);
    });

    row.addEventListener('mouseleave', () => {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      actions.classList.remove('visible');
    });

    if (text) {
      text.addEventListener('click', () => {
        if (text.dataset.editing) return;
        if (item.querySelector(editingSelector)) return;
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          actions.classList.add('visible');
          if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        }, 250);
      });
      text.addEventListener('dblclick', (e) => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        if (onDblClick) {
          e.preventDefault();
          onDblClick(item);
        }
      });
    }
  });
}


// ===================================================================
// ITEM-LEVEL DRAG & DROP
// ===================================================================
// Replaces initDragDrop (projects) and initTodoDragDropForCard (todos)
export function initItemDragDrop(container, {
  itemSelector,
  excludeSelector = 'button, a, input, textarea, select',
  skipInsideSelector = null,
  idAttr,
  onReorder,
}) {
  let dragState = null;

  container.querySelectorAll(itemSelector).forEach(item => {
    if (skipInsideSelector && item.closest(skipInsideSelector)) return;
    item.style.touchAction = 'pan-y';
    let pressTimer = null;
    let startX = 0, startY = 0;
    let activated = false;

    item.addEventListener('pointerdown', e => {
      if (e.target.closest(excludeSelector)) return;
      if (dragState) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      pressTimer = setTimeout(() => {
        activated = true;
        e.preventDefault();
        const rect = item.getBoundingClientRect();
        isDragging = true;
        dragState = { el: item, id: item.dataset[idAttr], offsetY: e.clientY - rect.top, clone: null, pointerId: e.pointerId };

        const clone = item.cloneNode(true);
        clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);background:var(--surface);border-radius:8px;border:2px solid var(--accent);transition:none;`;
        document.body.appendChild(clone);
        dragState.clone = clone;
        item.classList.add('dragging');
        item.setPointerCapture(e.pointerId);
      }, LONG_PRESS_MS);
    });

    item.addEventListener('pointermove', e => {
      if (pressTimer && !activated) {
        if (Math.abs(e.clientX - startX) > DRAG_THRESHOLD || Math.abs(e.clientY - startY) > DRAG_THRESHOLD) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
        return;
      }
      if (!dragState || dragState.el !== item) return;
      e.preventDefault();
      dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';

      // Auto-scroll
      const cRect = container.getBoundingClientRect();
      const edge = 40;
      if (e.clientY < cRect.top + edge && container.scrollTop > 0) container.scrollTop -= 5;
      else if (e.clientY > cRect.bottom - edge && container.scrollTop < container.scrollHeight - container.clientHeight) container.scrollTop += 5;

      container.querySelectorAll(`${itemSelector}:not(.dragging)`).forEach(el => {
        el.classList.remove('drag-over');
        const r = el.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) el.classList.add('drag-over');
      });
    });

    const finishDrag = async () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!dragState || dragState.el !== item) return;
      if (dragState.clone) dragState.clone.remove();
      item.classList.remove('dragging');

      let targetId = null;
      container.querySelectorAll(itemSelector).forEach(el => {
        if (el.classList.contains('drag-over')) { targetId = el.dataset[idAttr]; el.classList.remove('drag-over'); }
      });
      const draggedId = dragState.id;
      dragState = null;
      isDragging = false;
      if (targetId && targetId !== draggedId) await onReorder(draggedId, targetId);
    };

    item.addEventListener('pointerup', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    item.addEventListener('pointercancel', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    item.addEventListener('lostpointercapture', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (dragState && dragState.el === item) {
        if (dragState.clone) dragState.clone.remove();
        item.classList.remove('dragging');
        container.querySelectorAll(itemSelector).forEach(el => el.classList.remove('drag-over'));
        dragState = null;
        isDragging = false;
      }
    });
  });
}


// ===================================================================
// REORDER ITEMS — splice array, move DOM, sync to Supabase
// ===================================================================
// Replaces reorderTasks (projects) and reorderTodosInCategory (todos)
export async function reorderItems({
  items,
  allItems,
  draggedId,
  targetId,
  container,
  itemSelector,
  idAttr,
  tableName,
  sb,
  reinitFn,
}) {
  const draggedIdx = items.findIndex(t => t.id === draggedId);
  const targetIdx = items.findIndex(t => t.id === targetId);
  if (draggedIdx === -1 || targetIdx === -1) return;

  const [dragged] = items.splice(draggedIdx, 1);
  items.splice(targetIdx, 0, dragged);

  items.forEach((t, i) => { t.sort_order = i; });
  items.forEach(t => {
    const st = allItems.find(x => x.id === t.id);
    if (st) st.sort_order = t.sort_order;
  });

  const domItems = Array.from(container.querySelectorAll(itemSelector));
  const ordered = items.map(t => domItems.find(el => el.dataset[idAttr] === t.id)).filter(Boolean);
  ordered.forEach(el => container.appendChild(el));

  if (reinitFn) reinitFn();
  showToast(t('toast.reordered'), 'success');

  Promise.all(items.map((t, i) =>
    sb.from(tableName).update({ sort_order: i }).eq('id', t.id)
  )).catch(e => console.error(`${tableName} reorder sync failed:`, e));
}


// ===================================================================
// SCROLL TO & HIGHLIGHT
// ===================================================================
export function scrollToAndHighlight(element, color, durationMs = 1500) {
  if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (color) {
    element.style.boxShadow = `0 0 0 2px ${color}`;
    setTimeout(() => { element.style.boxShadow = ''; }, durationMs);
  }
}


// ===================================================================
// INLINE TEXT EDIT — generic textarea-replace pattern
// ===================================================================
// Options:
//   maxLength    — textarea maxLength
//   saveFn(text) — called with trimmed new text on save
//   refreshFn()  — called after edit finishes (save or cancel)
//   extraEl      — optional DOM element appended below textarea (e.g. deadline row)
//   onStart()    — called before replacing span (e.g. expand parent)
//   onFinish()   — called after edit ends (e.g. restore parent)
//   collectExtra() — optional fn returning extra update data from extraEl
export function inlineEditText(spanEl, originalText, { maxLength, saveFn, refreshFn, extraEl, onStart, onFinish, collectExtra }) {
  if (spanEl.dataset.editing) return;
  spanEl.dataset.editing = 'true';

  const input = document.createElement('textarea');
  input.className = 'task-edit-input';
  input.value = originalText;
  input.rows = originalText.split('\n').length;
  input.style.resize = 'none';
  input.style.overflow = 'hidden';
  if (maxLength) input.maxLength = maxLength;

  // If extra element, wrap textarea + extra together
  let root = input;
  if (extraEl) {
    const wrapper = document.createElement('div');
    wrapper.className = 'todo-edit-wrapper';
    wrapper.appendChild(input);
    wrapper.appendChild(extraEl);
    root = wrapper;
  }

  if (onStart) onStart();

  function autoSize() {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }

  let finished = false;
  const finishEdit = async (save) => {
    if (finished) return;
    finished = true;
    const trimmed = input.value.trim();
    if (save && trimmed && trimmed !== originalText) {
      const extra = collectExtra ? collectExtra() : undefined;
      await saveFn(trimmed, extra);
    } else if (save && collectExtra) {
      // Text unchanged but extra fields may have changed
      const extra = collectExtra();
      if (extra) await saveFn(originalText, extra);
    }
    if (onFinish) onFinish();
    delete spanEl.dataset.editing;
    await refreshFn();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
  });
  input.addEventListener('input', autoSize);

  if (extraEl) {
    // Blur only when focus leaves the entire wrapper
    root.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!root.contains(document.activeElement)) finishEdit(true);
      }, 150);
    });
    // Enter/Escape on extra inputs
    extraEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    });
  } else {
    input.addEventListener('blur', () => finishEdit(true));
  }

  spanEl.replaceWith(root);
  requestAnimationFrame(() => { autoSize(); input.focus(); input.select(); });
}
