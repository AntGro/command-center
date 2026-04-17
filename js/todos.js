import { lucideIcon } from './icons.js';
import state, { TODO_MAX_LEN } from './supabase.js';
import { esc, renderMd, showToast, showDeleteConfirm, formatRelativeDate, truncateWithShowMore } from './utils.js';

// ===================================================================
// TODOS — DATA & CRUD (Category Card Layout)
// ===================================================================
// ===================================================================
let allTodos = [];
let todoFilter = 'pending';
let isDragging = false;
const CATEGORIES_KEY = 'todo_categories';
const CATEGORY_COLORS_KEY = 'todo_category_colors';
const DEFAULT_CATEGORY_PALETTE = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#84cc16'];
const CATEGORY_SHORTNAMES_KEY = 'todo_category_shortnames';
const GENERAL_CATEGORY_COLOR = '#6c6f7e';

function getCategoryColors() {
  try { return JSON.parse(localStorage.getItem(CATEGORY_COLORS_KEY) || '{}'); } catch { return {}; }
}
function saveCategoryColors(map) { localStorage.setItem(CATEGORY_COLORS_KEY, JSON.stringify(map)); }

function getCategoryColor(catName) {
  if (!catName) return GENERAL_CATEGORY_COLOR;
  const map = getCategoryColors();
  if (map[catName]) return map[catName];
  // Auto-assign a color from the palette
  const usedColors = new Set(Object.values(map));
  const available = DEFAULT_CATEGORY_PALETTE.find(c => !usedColors.has(c)) || DEFAULT_CATEGORY_PALETTE[Object.keys(map).length % DEFAULT_CATEGORY_PALETTE.length];
  map[catName] = available;
  saveCategoryColors(map);
  return available;
}

function setCategoryColor(catName, color) {
  const map = getCategoryColors();
  map[catName] = color;
  saveCategoryColors(map);
}

function getCategoryShortnames() {
  try { return JSON.parse(localStorage.getItem(CATEGORY_SHORTNAMES_KEY) || '{}'); } catch { return {}; }
}
function saveCategoryShortnames(map) { localStorage.setItem(CATEGORY_SHORTNAMES_KEY, JSON.stringify(map)); }

function getCategoryShortname(catName) {
  if (!catName) return null;
  const map = getCategoryShortnames();
  return map[catName] || null;
}

function setCategoryShortname(catName, shortname) {
  const map = getCategoryShortnames();
  if (shortname) { map[catName] = shortname; }
  else { delete map[catName]; }
  saveCategoryShortnames(map);
}

function openEditCategoryModal(catName) {
  document.getElementById('editCategoryOldName').value = catName;
  document.getElementById('editCategoryName').value = catName;
  document.getElementById('editCategoryShortname').value = getCategoryShortname(catName) || '';
  document.getElementById('editCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('editCategoryName').focus(), 50);
}

function closeEditCategoryModal() {
  document.getElementById('editCategoryModal').classList.remove('visible');
}

async function saveEditCategory() {
  const oldName = document.getElementById('editCategoryOldName').value;
  const newName = document.getElementById('editCategoryName').value.trim();
  const shortname = document.getElementById('editCategoryShortname').value.trim();
  if (!newName) { showToast('Name is required', 'error'); return; }

  // Update shortname
  setCategoryShortname(newName, shortname);

  // Rename category if changed
  if (newName !== oldName) {
    // Update localStorage categories list
    const cats = getCategories();
    const idx = cats.indexOf(oldName);
    if (idx !== -1) { cats[idx] = newName; saveCategories(cats); }

    // Move old shortname to new name if different
    if (newName !== oldName) {
      const oldSn = getCategoryShortname(oldName);
      if (oldSn && !shortname) setCategoryShortname(newName, oldSn);
      setCategoryShortname(oldName, ''); // clear old
    }

    // Update all todos in Supabase
    const todosToUpdate = allTodos.filter(t => (t.category || 'General') === oldName);
    if (todosToUpdate.length > 0) {
      await Promise.all(todosToUpdate.map(t =>
        state.sb.from('todos').update({ category: newName }).eq('id', t.id)
      ));
      todosToUpdate.forEach(t => { t.category = newName; });
    }
  }

  closeEditCategoryModal();
  renderTodos();
  showToast('Category updated', 'success');
}

function getCategories() {
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveCategories(cats) {
  localStorage.setItem(CATEGORIES_KEY, JSON.stringify(cats));
}

function syncCategoriesFromTodos() {
  const known = getCategories();
  const knownSet = new Set(known.map(c => c.toLowerCase()));
  const discovered = new Set();
  allTodos.forEach(t => {
    if (t.category && !knownSet.has(t.category.toLowerCase())) {
      discovered.add(t.category);
    }
  });
  if (discovered.size > 0) {
    saveCategories([...known, ...Array.from(discovered)]);
  }
}

// Also migrate old bucket localStorage key if present
function migrateBucketsToCategories() {
  const oldKey = 'todo_buckets';
  const old = localStorage.getItem(oldKey);
  if (old) {
    try {
      const buckets = JSON.parse(old);
      const existing = getCategories();
      const existingSet = new Set(existing.map(c => c.toLowerCase()));
      const newOnes = buckets.filter(b => !existingSet.has(b.toLowerCase()));
      if (newOnes.length) saveCategories([...existing, ...newOnes]);
    } catch {}
    localStorage.removeItem(oldKey);
  }
}

async function refreshTodos() {
  if (!state.sb) return;
  const { data, error } = await state.sb.from('todos').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true });
  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast('Failed to load todos', 'error');
    return;
  }
  allTodos = data || [];
  migrateBucketsToCategories();
  syncCategoriesFromTodos();
  if (state.currentView === 'todos') {
    renderTodos();
  }
}

function setTodoFilter(filter) {
  todoFilter = filter;
  document.querySelectorAll('#todoFilters .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderTodos();
}

function getFilteredTodosForCategory(category) {
  const now = new Date();
  let filtered = allTodos.filter(t => {
    const cat = t.category || '';
    return cat === category;
  });

  if (todoFilter === 'pending') {
    filtered = filtered.filter(t => !t.done && (!t.snooze_until || new Date(t.snooze_until) <= now));
  } else if (todoFilter === 'done') {
    filtered = filtered.filter(t => t.done);
  } else if (todoFilter === 'flagged') {
    filtered = filtered.filter(t => !t.done && t.priority && t.priority !== 'normal');
  } else if (todoFilter === 'outdated') {
    filtered = filtered.filter(t => isTodoOutdated(t));
  }

  const sortBy = document.getElementById('todoSortBy')?.value || 'manual';
  if (sortBy === 'due') {
    filtered.sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return new Date(a.due_date) - new Date(b.due_date);
    });
  } else if (sortBy === 'priority') {
    const prio = { urgent: 0, high: 1, normal: 2, low: 3 };
    filtered.sort((a, b) => (prio[a.priority] || 2) - (prio[b.priority] || 2));
  } else if (sortBy === 'created') {
    filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  return filtered;
}

function renderTodos() {
  const grid = document.getElementById('todoCategoryGrid');
  if (!grid) return;

  const categories = getCategories();
  // Always show General first, then user categories
  const categoryList = ['', ...categories];

  // Render category navigation buttons in toolbar
  renderCategoryToolbarButtons(categoryList);

  let html = '';
  for (const cat of categoryList) {
    html += renderCategoryCard(cat);
  }

  grid.innerHTML = html;

  // Init drag-and-drop for each card (individual TODO items)
  categoryList.forEach(cat => {
    const catId = categoryToDomId(cat);
    initTodoDragDropForCard(catId);
    // Init hover delay for TODO action buttons (same as project tasks)
    const catCard = document.getElementById(catId);
    if (catCard) {
      const list = catCard.querySelector('.todo-cat-list');
      if (list) initTodoHoverDelay(list);
    }
  });

  // Init drag-and-drop for category cards themselves
  initCategoryDragDrop();
}

function renderCategoryToolbarButtons(categoryList) {
  const container = document.getElementById('todoNavButtons');
  if (!container) return;
  container.innerHTML = categoryList.map(cat => {
    const name = cat || 'General';
    const shortname = getCategoryShortname(cat);
    const displayName = shortname || name;
    const color = getCategoryColor(cat);
    return `<button class="category-nav-btn" style="--cat-color:${color};border-color:${color};color:${color}" onclick="navigateToCategory('${esc(cat).replace(/'/g, "\\'")}')" title="Go to ${esc(name)}">${esc(displayName)}</button>`;
  }).join('');
}

function navigateToCategory(category) {
  const catId = categoryToDomId(category);
  const card = document.getElementById(catId);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Briefly highlight the card
  card.style.boxShadow = `0 0 0 2px ${getCategoryColor(category)}`;
  setTimeout(() => { card.style.boxShadow = ''; }, 1500);
  // Focus the input for adding a new TODO
  setTimeout(() => {
    const input = card.querySelector('.todo-cat-input');
    if (input) input.focus();
  }, 400);
}

function categoryToDomId(cat) {
  if (!cat) return 'todo-cat-general';
  return 'todo-cat-' + cat.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

function updateTodoCharCounter(input) {
  const catId = input.closest('.project-card')?.id;
  if (!catId) return;
  const counter = document.getElementById(`todo-counter-${catId}`);
  if (!counter) return;
  const len = input.value.length;
  if (len === 0) { counter.textContent = ''; return; }
  counter.textContent = `${len}/${TODO_MAX_LEN}`;
  counter.className = 'char-counter' + (len > TODO_MAX_LEN * 0.9 ? ' danger' : len > TODO_MAX_LEN * 0.7 ? ' warn' : '');
}

function renderCategoryCard(category) {
  const catId = categoryToDomId(category);
  const catName = category || 'General';
  const isGeneral = !category;
  const shortname = getCategoryShortname(category);
  const allInCat = allTodos.filter(t => (t.category || '') === category);
  const pending = allInCat.filter(t => !t.done).length;
  const doneCount = allInCat.filter(t => t.done).length;

  // Split: active items (not done) and done items
  const activeTodos = getFilteredTodosForCategory(category).filter(t => !t.done);
  const doneTodos = allInCat.filter(t => t.done);

  // If user is explicitly filtering to 'done', show all done; if 'pending', show only active
  let displayActive, displayDone;
  if (todoFilter === 'done') {
    displayActive = [];
    displayDone = doneTodos;
  } else if (todoFilter === 'pending') {
    displayActive = activeTodos;
    displayDone = [];
  } else {
    displayActive = activeTodos;
    displayDone = doneTodos;
  }

  const statsText = `${pending} pending` + (doneCount > 0 ? ` · ${doneCount} done` : '');

  const deleteBtn = !isGeneral
    ? `<button class="todo-cat-delete-btn" onclick="deleteCategory('${esc(category)}')" title="Delete category">${lucideIcon("trash-2",16)}</button>`
    : '';

  const activeEmptyMsg = displayActive.length === 0
    ? `<p class="empty-msg">${todoFilter === 'pending' ? 'All caught up! 🎉' : 'No items yet'}</p>`
    : '';

  const escapedCat = esc(category).replace(/'/g, "\\'");

  const catColor = getCategoryColor(category);

  const catDragHandle = '';

  // Done toggle (collapsible, like archived tasks in projects)
  let doneToggle = '';
  if (doneCount > 0 && todoFilter !== 'done') {
    const deleteAllBtn = `<button class="delete-all-archived-btn" onclick="event.stopPropagation();deleteAllDoneTodos('${escapedCat}')" title="Delete all done">${lucideIcon("trash-2",16)} Delete all</button>`;
    doneToggle = `
      <div class="archive-toggle" onclick="toggleDoneTodos('${catId}')" id="done-toggle-${catId}">
        <span class="arrow" id="done-arrow-${catId}">▶</span> Done (${doneCount})
        ${deleteAllBtn}
      </div>
      <div class="archived-tasks" id="done-list-${catId}">
        ${doneTodos.map(t => renderTodoItem(t)).join('')}
      </div>`;
  }

  // For the 'done' filter view, show done items in the main list
  const mainListContent = todoFilter === 'done'
    ? (displayDone.length === 0 ? '<p class="empty-msg">No completed items</p>' : displayDone.map(t => renderTodoItem(t)).join(''))
    : (activeEmptyMsg || displayActive.map(t => renderTodoItem(t)).join(''));

  const shortnameBtn = !isGeneral
    ? `<button class="todo-cat-shortname-btn" onclick="openEditCategoryModal('${esc(category).replace(/'/g, "\\'")}')" title="Edit category">${lucideIcon("pencil",14)}</button>`
    : '';

  const shortnameLabel = shortname
    ? `<span class="todo-cat-shortname-label">${esc(shortname)}</span>`
    : '';

  return `<div class="project-card" id="${catId}" data-category="${esc(category)}" style="--cat-color:${catColor}">
    <div class="todo-cat-header">
      <div class="todo-cat-header-left">
        ${catDragHandle}
        <div class="todo-cat-info">
          <h3 class="todo-cat-name">${esc(catName)}${shortnameLabel}</h3>
          <span class="todo-cat-stats">${statsText}</span>
        </div>
      </div>
      <div class="todo-cat-header-actions">
        ${shortnameBtn}${deleteBtn}
      </div>
    </div>
    <div class="todo-cat-add">
      <input type="text" placeholder="Add a TODO..." maxlength="2000" class="todo-cat-input" data-category="${esc(category)}" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addTodoToCategory(this);}" oninput="updateTodoCharCounter(this)">
      <button onclick="addTodoToCategory(this.previousElementSibling)">+</button>
    </div>
    <div class="char-counter" id="todo-counter-${catId}"></div>
    <div class="todo-cat-list" data-category="${esc(category)}">
      ${mainListContent}
    </div>
    ${doneToggle}
  </div>`;
}

const TODO_OUTDATED_DAYS = 7;

function isTodoOutdated(t) {
  if (t.done) return false;
  if (!t.due_date) return false;
  const now = new Date();
  const ref = new Date(t.updated_at || t.created_at);
  const diffDays = (now - ref) / (1000 * 60 * 60 * 24);
  return diffDays >= TODO_OUTDATED_DAYS;
}

function renderTodoItem(t) {
  const now = new Date();
  const isOverdue = t.due_date && !t.done && new Date(t.due_date) < now;
  const isSnoozed = t.snooze_until && new Date(t.snooze_until) > now;
  const isOutdated = isTodoOutdated(t);
  const isFlagged = t.priority && t.priority !== 'normal';
  const prioBadge = isFlagged
    ? `<span class="todo-priority-badge priority-${t.priority}">${t.priority}</span>` : '';

  // Flag button: cycles normal → high → urgent → normal
  const flagIcon = t.priority === 'urgent' ? '🚩' : t.priority === 'high' ? '🚩' : '⚑';
  const flagTitle = t.priority === 'urgent' ? 'Unflag (urgent → normal)' : t.priority === 'high' ? 'Flag urgent' : 'Flag high';
  const flagBtn = !t.done ? `<button class="todo-flag-btn ${isFlagged ? 'flagged' : ''}" onclick="cycleTodoPriority('${t.id}')" title="${flagTitle}">${flagIcon}</button>` : '';

  let dueDateStr = '';
  if (t.due_date) {
    const d = new Date(t.due_date);
    const diffMs = d - now;
    const diffH = Math.round(diffMs / (1000 * 60 * 60));
    if (isOverdue) {
      dueDateStr = `<span class="todo-due overdue">⚠️ Overdue (${formatRelativeDate(d)})</span>`;
    } else if (diffH < 24) {
      dueDateStr = `<span class="todo-due due-soon">${lucideIcon("bell",16)} Due ${formatRelativeDate(d)}</span>`;
    } else {
      dueDateStr = `<span class="todo-due">${lucideIcon("calendar",16)} ${formatRelativeDate(d)}</span>`;
    }
  }

  let snoozeInfo = '';
  if (isSnoozed) {
    snoozeInfo = `<span class="todo-snoozed">${lucideIcon("moon",16)} Snoozed until ${new Date(t.snooze_until).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`;
  }

  let outdatedInfo = '';
  if (isOutdated && !t.done) {
    const ref = new Date(t.updated_at || t.created_at);
    const daysAgo = Math.floor((now - ref) / (1000 * 60 * 60 * 24));
    outdatedInfo = `<span class="todo-outdated-badge">🕰️ ${daysAgo}d old</span>`;
  }

  const classes = [
    'todo-item',
    t.done ? 'todo-done' : '',
    isOverdue ? 'todo-overdue' : '',
    isOutdated ? 'todo-outdated' : '',
    isFlagged ? 'todo-flagged' : ''
  ].filter(Boolean).join(' ');

  return `<div class="${classes}" data-todo-id="${t.id}">
    <div class="todo-row">
      ${flagBtn}
      <label class="todo-checkbox-label">
        <input type="checkbox" ${t.done ? 'checked' : ''} onchange="toggleTodo('${t.id}', this.checked)">
        <span class="todo-checkmark"></span>
      </label>
      <span class="todo-text" ondblclick="editTodoInline('${t.id}')">${t.text.length > 150 ? truncateWithShowMore(t.text, 150, t.id, 'todo') : renderMd(t.text)}</span>
      ${prioBadge}
      <div class="todo-actions">
        ${!t.done ? `<button onclick="openSnoozeModal('${t.id}')" title="Snooze">${lucideIcon("moon",16)}</button>` : ''}
        <button onclick="editTodoInline('${t.id}')" title="Edit">${lucideIcon("pencil",16)}</button>
        <button onclick="deleteTodo('${t.id}')" title="Delete">${lucideIcon("trash-2",16)}</button>
      </div>
    </div>
    ${dueDateStr || snoozeInfo || outdatedInfo ? `<div class="todo-meta">${dueDateStr}${snoozeInfo}${outdatedInfo}</div>` : ''}
  </div>`;
}

async function cycleTodoPriority(id) {
  const todo = allTodos.find(t => t.id === id);
  if (!todo) return;
  const cycle = { normal: 'high', high: 'urgent', urgent: 'normal' };
  const next = cycle[todo.priority] || 'high';
  const { error } = await state.sb.from('todos').update({ priority: next }).eq('id', id);
  if (error) { showToast('Failed to update priority', 'error'); return; }
  const labels = { high: '🚩 Flagged high', urgent: '🚩 Flagged urgent', normal: 'Flag removed' };
  showToast(labels[next] || `Priority: ${next}`, 'success');
  await refreshTodos();
}


async function addTodoToCategory(inputEl) {
  const text = inputEl.value.trim();
  if (!text) return;
  const category = inputEl.dataset.category || '';

  const pendingTodos = allTodos.filter(t => !t.done && (t.category || '') === category);
  const maxOrder = pendingTodos.length > 0 ? Math.max(...pendingTodos.map(t => t.sort_order || 0)) + 1 : 0;

  const { error } = await state.sb.from('todos').insert({ text, priority: 'normal', category, sort_order: maxOrder });
  if (error) { showToast('Failed to add todo: ' + error.message, 'error'); return; }
  inputEl.value = '';
  showToast('TODO added', 'success');
  await refreshTodos();
}

async function toggleTodo(id, done) {
  const { error } = await state.sb.from('todos').update({ done }).eq('id', id);
  if (error) { showToast('Update failed', 'error'); return; }
  showToast(done ? 'Done! ✅' : 'Reopened', 'success');
  await refreshTodos();
}

async function deleteTodo(id) {
  showDeleteConfirm(
    'Delete TODO',
    'Delete this TODO? This cannot be undone.',
    async () => {
      const { error } = await state.sb.from('todos').delete().eq('id', id);
      if (error) { showToast('Delete failed', 'error'); return; }
      showToast('TODO deleted', 'info');
      await refreshTodos();
    }
  );
}

function toggleDoneTodos(catId) {
  const container = document.getElementById(`done-list-${catId}`);
  const arrow = document.getElementById(`done-arrow-${catId}`);
  if (container) container.classList.toggle('visible');
  if (arrow) arrow.classList.toggle('open');
}

async function deleteAllDoneTodos(category) {
  const doneTodos = allTodos.filter(t => (t.category || '') === category && t.done);
  if (!doneTodos.length) return;
  const catName = category || 'General';
  showDeleteConfirm(
    'Delete All Done TODOs',
    `Delete all ${doneTodos.length} completed TODO${doneTodos.length > 1 ? 's' : ''} in "${catName}"? This cannot be undone.`,
    async () => {
      for (const t of doneTodos) {
        await state.sb.from('todos').delete().eq('id', t.id);
      }
      showToast(`Deleted ${doneTodos.length} done TODO${doneTodos.length > 1 ? 's' : ''}`, 'info');
      await refreshTodos();
    }
  );
}

async function editTodoInline(id) {
  const todo = allTodos.find(t => t.id === id);
  if (!todo) return;
  const itemEl = document.querySelector(`.todo-item[data-todo-id="${id}"]`);
  if (!itemEl) return;
  const textEl = itemEl.querySelector('.todo-text');
  if (!textEl || textEl.dataset.editing) return;

  textEl.dataset.editing = 'true';

  // Create a wrapper for text + deadline editing
  const wrapper = document.createElement('div');
  wrapper.className = 'todo-edit-wrapper';

  const input = document.createElement('textarea');
  input.className = 'task-edit-input';
  input.value = todo.text;
  input.maxLength = 2000;
  input.rows = Math.max(2, todo.text.split('\n').length);
  input.style.resize = 'none';
  input.style.overflow = 'hidden';
  input.style.minHeight = '2.4em';

  // Deadline date input
  const deadlineRow = document.createElement('div');
  deadlineRow.className = 'todo-edit-deadline-row';
  const deadlineLabel = document.createElement('label');
  deadlineLabel.innerHTML = lucideIcon('calendar') + ' Deadline:';
  deadlineLabel.className = 'todo-edit-deadline-label';
  const deadlineInput = document.createElement('input');
  deadlineInput.type = 'datetime-local';
  deadlineInput.className = 'todo-edit-deadline-input';
  if (todo.due_date) {
    // Format existing due_date for datetime-local input
    const d = new Date(todo.due_date);
    deadlineInput.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'todo-edit-deadline-clear';
  clearBtn.textContent = '✕';
  clearBtn.title = 'Clear deadline';
  clearBtn.onclick = (e) => { e.stopPropagation(); deadlineInput.value = ''; };

  deadlineRow.appendChild(deadlineLabel);
  deadlineRow.appendChild(deadlineInput);
  deadlineRow.appendChild(clearBtn);

  wrapper.appendChild(input);
  wrapper.appendChild(deadlineRow);

  function autoSize() {
    input.style.height = 'auto';
    input.style.height = Math.max(input.scrollHeight, 40) + 'px';
  }

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    if (save) {
      const updates = {};
      const newText = input.value.trim();
      if (newText && newText !== todo.text) updates.text = newText;
      // Update deadline
      const newDeadline = deadlineInput.value ? new Date(deadlineInput.value).toISOString() : null;
      const oldDeadline = todo.due_date || null;
      if (newDeadline !== oldDeadline) updates.due_date = newDeadline;
      if (Object.keys(updates).length > 0) {
        const { error } = await state.sb.from('todos').update(updates).eq('id', id);
        if (error) showToast('Update failed', 'error');
        else showToast('TODO updated', 'success');
      }
    }
    delete textEl.dataset.editing;
    await refreshTodos();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  deadlineInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  // Only finish on blur if focus leaves the entire wrapper
  wrapper.addEventListener('focusout', (e) => {
    setTimeout(() => {
      if (!wrapper.contains(document.activeElement)) finish(true);
    }, 150);
  });
  input.addEventListener('input', autoSize);
  textEl.replaceWith(wrapper);
  // Use rAF to ensure layout is computed before reading scrollHeight
  requestAnimationFrame(() => { autoSize(); input.focus(); input.select(); });
}

// ===================================================================
// CATEGORY MANAGEMENT
// ===================================================================
function initTodoModals() {
  const app = document.getElementById('app');

  // Snooze Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay'; m1.id = 'snoozeModal';
  m1.innerHTML = `<div class="modal snooze-modal"><h2>${lucideIcon("clock",20)} Snooze TODO</h2><p style="font-size:0.82rem;color:var(--muted);margin-bottom:12px;">Pick when to be reminded about this item.</p><div class="snooze-options"><button onclick="snoozeFor(1,'h')">1 hour</button><button onclick="snoozeFor(3,'h')">3 hours</button><button onclick="snoozeFor(1,'d')">Tomorrow</button><button onclick="snoozeFor(3,'d')">3 days</button><button onclick="snoozeFor(7,'d')">1 week</button><button onclick="snoozeFor(1,'M')">1 month</button></div><label style="margin-top:12px;">Or pick a date & time:</label><input type="datetime-local" id="snoozeCustomDate" style="width:100%;margin-top:4px;"><input type="hidden" id="snoozeTaskId"><div class="modal-actions"><button class="modal-cancel" onclick="closeSnoozeModal()">Cancel</button><button class="modal-save" onclick="submitSnooze()">Snooze</button></div></div>`;
  app.appendChild(m1);

  // Add Category Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay'; m2.id = 'addCategoryModal';
  m2.innerHTML = `<div class="modal"><h2>${lucideIcon("folder-plus",20)} Add Category</h2><label>Category Name</label><input type="text" id="newCategoryName" placeholder="e.g. Work, Personal, Shopping..." maxlength="40" onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewCategory();}"><div class="modal-actions"><button class="modal-cancel" onclick="closeAddCategoryModal()">Cancel</button><button class="modal-save" onclick="saveNewCategory()">Create</button></div></div>`;
  app.appendChild(m2);
}

function openAddCategoryModal() {
  document.getElementById('newCategoryName').value = '';
  document.getElementById('addCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('newCategoryName').focus(), 100);
}

function closeAddCategoryModal() {
  document.getElementById('addCategoryModal').classList.remove('visible');
}

function saveNewCategory() {
  const input = document.getElementById('newCategoryName');
  const name = input.value.trim();
  if (!name) { showToast('Enter a category name', 'error'); return; }

  const categories = getCategories();
  if (categories.some(c => c.toLowerCase() === name.toLowerCase())) {
    showToast('Category already exists', 'error');
    return;
  }

  categories.push(name);
  saveCategories(categories);
  closeAddCategoryModal();
  showToast(`Category "${name}" created`, 'success');
  renderTodos();
}

async function deleteCategory(name) {
  const todosInCat = allTodos.filter(t => t.category === name);
  const msg = todosInCat.length > 0
    ? `Delete "${name}"? Its ${todosInCat.length} TODO(s) will move to General.`
    : `Delete empty category "${name}"?`;

  showDeleteConfirm('Delete Category', msg, async () => {
    // Move todos to General
    for (const t of todosInCat) {
      await state.sb.from('todos').update({ category: '' }).eq('id', t.id);
    }
    const categories = getCategories();
    const idx = categories.findIndex(c => c === name);
    if (idx !== -1) {
      categories.splice(idx, 1);
      saveCategories(categories);
    }
    // Clean up color
    const colorMap = getCategoryColors();
    delete colorMap[name];
    saveCategoryColors(colorMap);
    showToast(`Category "${name}" deleted`, 'info');
    await refreshTodos();
  });
}


// ===================================================================
// SNOOZE MODAL
// ===================================================================
function openSnoozeModal(todoId) {
  document.getElementById('snoozeTaskId').value = todoId;
  document.getElementById('snoozeCustomDate').value = '';
  document.getElementById('snoozeModal').classList.add('visible');
}

function closeSnoozeModal() {
  document.getElementById('snoozeModal').classList.remove('visible');
}

function snoozeFor(amount, unit) {
  const now = new Date();
  let target;
  if (unit === 'h') {
    target = new Date(now.getTime() + amount * 60 * 60 * 1000);
  } else if (unit === 'd') {
    target = new Date(now.getTime() + amount * 24 * 60 * 60 * 1000);
    if (amount === 1) { target.setHours(9, 0, 0, 0); }
  } else if (unit === 'M') {
    target = new Date(now);
    target.setMonth(target.getMonth() + amount);
    target.setHours(9, 0, 0, 0);
  }
  doSnooze(target);
}

async function submitSnooze() {
  const customDate = document.getElementById('snoozeCustomDate').value;
  if (!customDate) { showToast('Pick a date or use a quick option', 'error'); return; }
  doSnooze(new Date(customDate));
}

async function doSnooze(snoozeUntil) {
  const taskId = document.getElementById('snoozeTaskId').value;
  if (!taskId) return;
  const { error } = await state.sb.from('todos').update({ snooze_until: snoozeUntil.toISOString() }).eq('id', taskId);
  if (error) { showToast('Snooze failed', 'error'); return; }
  closeSnoozeModal();
  showToast(`Snoozed until ${snoozeUntil.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, 'success');
  await refreshTodos();
}


// ===================================================================
// TODO DRAG & DROP REORDER (per category card)
// ===================================================================
const LONG_PRESS_MS = 250;
const DRAG_THRESHOLD = 5;

function initTodoDragDropForCard(catId) {
  const card = document.getElementById(catId);
  if (!card) return;
  const container = card.querySelector('.todo-cat-list');
  if (!container) return;
  let dragState = null;

  container.querySelectorAll('.todo-item:not(.todo-done)').forEach(item => {
    item.style.touchAction = 'pan-y';
    let pressTimer = null;
    let startX = 0, startY = 0;
    let activated = false;

    item.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a, input, textarea, select, .todo-actions, .todo-checkbox-label')) return;
      if (dragState) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      pressTimer = setTimeout(() => {
        activated = true;
        const rect = item.getBoundingClientRect();
        isDragging = true;
        dragState = { el: item, id: item.dataset.todoId, offsetY: e.clientY - rect.top, clone: null };
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
          clearTimeout(pressTimer); pressTimer = null;
        }
        return;
      }
      if (!dragState || dragState.el !== item) return;
      e.preventDefault();
      dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';
      container.querySelectorAll('.todo-item:not(.dragging)').forEach(el => {
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
      container.querySelectorAll('.todo-item').forEach(el => {
        if (el.classList.contains('drag-over')) { targetId = el.dataset.todoId; el.classList.remove('drag-over'); }
      });
      const draggedId = dragState.id;
      const catKey = container.dataset.category || '';
      dragState = null;
      isDragging = false;
      if (targetId && targetId !== draggedId) await reorderTodosInCategory(container, catId, draggedId, targetId, catKey);
    };

    item.addEventListener('pointerup', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    item.addEventListener('pointercancel', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    item.addEventListener('lostpointercapture', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (dragState && dragState.el === item) {
        if (dragState.clone) dragState.clone.remove();
        item.classList.remove('dragging');
        container.querySelectorAll('.todo-item').forEach(el => el.classList.remove('drag-over'));
        dragState = null;
        isDragging = false;
      }
    });
  });
}

async function reorderTodosInCategory(container, catId, draggedId, targetId, category) {
  const filtered = getFilteredTodosForCategory(category);
  const draggedIdx = filtered.findIndex(t => t.id === draggedId);
  const targetIdx = filtered.findIndex(t => t.id === targetId);
  if (draggedIdx === -1 || targetIdx === -1) return;
  const [dragged] = filtered.splice(draggedIdx, 1);
  filtered.splice(targetIdx, 0, dragged);

  // Update sort_order in memory
  filtered.forEach((t, i) => { t.sort_order = i; });
  filtered.forEach(t => {
    const st = allTodos.find(x => x.id === t.id);
    if (st) st.sort_order = t.sort_order;
  });

  // Move DOM elements
  const items = Array.from(container.querySelectorAll('.todo-item'));
  const ordered = filtered.map(t => items.find(el => el.dataset.todoId === t.id)).filter(Boolean);
  ordered.forEach(el => container.appendChild(el));

  // Re-init drag
  initTodoDragDropForCard(catId);
  showToast('Reordered', 'success');

  // Background Supabase sync
  Promise.all(filtered.map((t, i) =>
    state.sb.from('todos').update({ sort_order: i }).eq('id', t.id)
  )).catch(e => console.error('Todo reorder sync failed:', e));
}


// ===================================================================
// CATEGORY CARD DRAG & DROP REORDER
// ===================================================================
function initCategoryDragDrop() {
  const grid = document.getElementById('todoCategoryGrid');
  if (!grid) return;
  const cards = grid.querySelectorAll('.project-card');
  let dragState = null;

  cards.forEach(card => {
    const category = card.dataset.category;
    // General category (empty string) is not draggable
    if (category === '' || category === undefined) return;
    const header = card.querySelector('.todo-cat-header');
    if (!header) return;

    let pressTimer = null;
    let startX = 0, startY = 0;
    let activated = false;

    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a, input, textarea, select, .todo-cat-header-actions')) return;
      if (dragState) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      pressTimer = setTimeout(() => {
        activated = true;
        const rect = card.getBoundingClientRect();
        isDragging = true;
        dragState = { el: card, category, offsetY: e.clientY - rect.top, offsetX: e.clientX - rect.left, clone: null };
        const clone = card.cloneNode(true);
        clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);border-radius:12px;border:2px solid var(--accent);transition:none;`;
        document.body.appendChild(clone);
        dragState.clone = clone;
        card.classList.add('dragging');
        header.setPointerCapture(e.pointerId);
      }, LONG_PRESS_MS);
    });

    header.addEventListener('pointermove', e => {
      if (pressTimer && !activated) {
        if (Math.abs(e.clientX - startX) > DRAG_THRESHOLD || Math.abs(e.clientY - startY) > DRAG_THRESHOLD) {
          clearTimeout(pressTimer); pressTimer = null;
        }
        return;
      }
      if (!dragState || dragState.el !== card) return;
      e.preventDefault();
      dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';
      dragState.clone.style.left = (e.clientX - dragState.offsetX) + 'px';
      grid.querySelectorAll('.project-card:not(.dragging)').forEach(el => {
        el.classList.remove('drag-over');
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) el.classList.add('drag-over');
      });
    });

    const finishDrag = async () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!dragState || dragState.el !== card) return;
      if (dragState.clone) dragState.clone.remove();
      card.classList.remove('dragging');
      let targetCategory = null;
      grid.querySelectorAll('.project-card').forEach(el => {
        if (el.classList.contains('drag-over')) { targetCategory = el.dataset.category || ''; el.classList.remove('drag-over'); }
      });
      const draggedCategory = dragState.category;
      dragState = null;
      isDragging = false;
      if (targetCategory !== null && targetCategory !== draggedCategory && draggedCategory !== '' && targetCategory !== '') {
        await reorderCategories(draggedCategory, targetCategory);
      }
    };

    header.addEventListener('pointerup', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    header.addEventListener('pointercancel', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    header.addEventListener('lostpointercapture', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (dragState && dragState.el === card) {
        if (dragState.clone) dragState.clone.remove();
        card.classList.remove('dragging');
        grid.querySelectorAll('.project-card').forEach(el => el.classList.remove('drag-over'));
        dragState = null;
        isDragging = false;
      }
    });
  });
}

async function reorderCategories(draggedName, targetName) {
  const grid = document.getElementById('todoCategoryGrid');
  const categories = getCategories();
  const draggedIdx = categories.findIndex(c => c === draggedName);
  const targetIdx = categories.findIndex(c => c === targetName);
  if (draggedIdx === -1 || targetIdx === -1) return;
  const [dragged] = categories.splice(draggedIdx, 1);
  categories.splice(targetIdx, 0, dragged);
  saveCategories(categories);

  // Move DOM elements instead of full re-render
  const cards = Array.from(grid.querySelectorAll('.project-card'));
  // General card (empty category) stays first
  const generalCard = cards.find(c => (c.dataset.category || '') === '');
  // Reorder non-general cards to match categories order
  categories.forEach(catName => {
    const card = cards.find(c => c.dataset.category === catName);
    if (card) grid.appendChild(card);
  });

  initCategoryDragDrop();
  showToast('Categories reordered', 'success');
}



function initTodoHoverDelay(container) {
  const isTouchDevice = window.matchMedia('(max-width:480px)').matches || 'ontouchstart' in window;
  if (isTouchDevice) return;

  container.querySelectorAll('.todo-item').forEach(item => {
    let hoverTimer = null;
    let clickTimer = null;
    const actions = item.querySelector('.todo-actions');
    const todoRow = item.querySelector('.todo-row');
    const todoText = item.querySelector('.todo-text');
    if (!actions || !todoRow) return;

    todoRow.addEventListener('mouseenter', () => {
      hoverTimer = setTimeout(() => {
        actions.classList.add('visible');
      }, 2000);
    });

    todoRow.addEventListener('mouseleave', () => {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      actions.classList.remove('visible');
    });

    // Single click on todo text shows actions immediately (with short delay to avoid
    // triggering on double-click which should still open the inline editor)
    if (todoText) {
      todoText.addEventListener('click', () => {
        if (todoText.dataset.editing) return;
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          actions.classList.add('visible');
          // Clear the hover timer since actions are already visible
          if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        }, 250);
      });
      todoText.addEventListener('dblclick', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      });
    }
  });
}

export { refreshTodos, renderTodos, getCategoryColor, getCategoryColors, initTodoModals };

window.setTodoFilter = setTodoFilter;
window.addTodoToCategory = addTodoToCategory;
window.toggleTodo = toggleTodo;
window.deleteTodo = deleteTodo;
window.editTodoInline = editTodoInline;
window.toggleDoneTodos = toggleDoneTodos;
window.deleteAllDoneTodos = deleteAllDoneTodos;
window.cycleTodoPriority = cycleTodoPriority;
window.openSnoozeModal = openSnoozeModal;
window.closeSnoozeModal = closeSnoozeModal;
window.snoozeFor = snoozeFor;
window.submitSnooze = submitSnooze;
window.openAddCategoryModal = openAddCategoryModal;
window.closeAddCategoryModal = closeAddCategoryModal;
window.saveNewCategory = saveNewCategory;
window.deleteCategory = deleteCategory;
window.navigateToCategory = navigateToCategory;
window.updateTodoCharCounter = updateTodoCharCounter;
window.openEditCategoryModal = openEditCategoryModal;
window.closeEditCategoryModal = closeEditCategoryModal;
window.saveEditCategory = saveEditCategory;
