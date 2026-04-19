import { lucideIcon } from './icons.js';
import state, { CHORE_CATEGORIES_KEY } from './supabase.js';
import { esc, showToast, showDeleteConfirm } from './utils.js';
import { initItemHoverDelay, scrollToAndHighlight } from './item-utils.js';
import { getCategoryColor } from './todos.js';

// ===================================================================
// CHORES — DATA, CRUD & RENDERING
// ===================================================================
// (state managed in supabase.js)
// (state managed in supabase.js)
let choreFilter = 'all';
// ── Shortnames ──
const CHORE_SHORTNAMES_KEY = 'claw_chore_shortnames';
function getChoreShortnames() {
  try { return JSON.parse(localStorage.getItem(CHORE_SHORTNAMES_KEY) || '{}'); } catch { return {}; }
}
function saveChoreShortnames(map) { localStorage.setItem(CHORE_SHORTNAMES_KEY, JSON.stringify(map)); }
function getChoreShortname(catName) {
  if (!catName) return '';
  return getChoreShortnames()[catName] || '';
}
function setChoreShortname(catName, shortname) {
  const map = getChoreShortnames();
  if (shortname) { map[catName] = shortname; } else { delete map[catName]; }
  saveChoreShortnames(map);
}
function promptChoreShortname(catName) {
  const current = getChoreShortname(catName) || '';
  const result = prompt('Short name for "' + catName + '" (leave empty to remove):', current);
  if (result === null) return;
  setChoreShortname(catName, result.trim());
  renderChores();
}


// ===================================================================
// NEXT_DUE — delegated to heartbeat cron job
// ===================================================================
// When a chore is created, edited, or completed, we set next_due = null.
// The heartbeat cron job detects null next_due values and computes the
// correct date server-side based on frequency_rule and last completion.

async function clearChoreNextDue(choreId) {
  const { error } = await state.sb.from('chores').update({ next_due: null }).eq('id', choreId);
  if (error) console.warn('Failed to clear next_due:', error.message);
}

function getChoreCategories() {
  try { return JSON.parse(localStorage.getItem(CHORE_CATEGORIES_KEY) || '[]'); } catch { return []; }
}
function saveChoreCategories(cats) { localStorage.setItem(CHORE_CATEGORIES_KEY, JSON.stringify(cats)); }

function syncChoreCategoriesFromData() {
  const known = getChoreCategories();
  const knownSet = new Set(known.map(c => c.toLowerCase()));
  const discovered = new Set();
  state.allChores.forEach(c => {
    if (c.category && c.category !== 'General' && !knownSet.has(c.category.toLowerCase())) {
      discovered.add(c.category);
    }
  });
  if (discovered.size > 0) saveChoreCategories([...known, ...Array.from(discovered)]);
}

async function refreshChores() {
  if (!state.sb) return;
  const { data: chores, error: chErr } = await state.sb.from('chores').select('*').order('created_at', { ascending: true });
  if (chErr) {
    if (chErr.code === '42P01' || chErr.message?.includes('does not exist')) return;
    showToast('Failed to load chores', 'error');
    return;
  }
  state.allChores = chores || [];

  const { data: completions, error: compErr } = await state.sb.from('chore_completions').select('*').order('completed_at', { ascending: false });
  if (!compErr) state.allChoreCompletions = completions || [];

  syncChoreCategoriesFromData();
  if (state.currentView === 'chores') {
    renderChores();
  }
}

function getChoreLastDone(choreId) {
  const comp = state.allChoreCompletions.find(c => c.chore_id === choreId);
  return comp ? new Date(comp.completed_at) : null;
}

function getChoreCompletionCount(choreId) {
  return state.allChoreCompletions.filter(c => c.chore_id === choreId).length;
}

function getChoreCompletions(choreId) {
  return state.allChoreCompletions.filter(c => c.chore_id === choreId);
}

function choreDueStatus(chore) {
  if (!chore.next_due) return 'no-date';
  const now = new Date();
  const due = new Date(chore.next_due);
  // Compare calendar dates, not timestamps
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay - todayStart) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'due-today';
  if (diffDays === 1) return 'due-tomorrow';
  if (diffDays <= 7) return 'due-soon';
  return 'on-track';
}

function formatChoreDue(chore) {
  if (!chore.next_due) return '<span class="chore-due no-date">Awaiting schedule</span>';
  const due = new Date(chore.next_due);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay - todayStart) / (1000 * 60 * 60 * 24));
  const status = choreDueStatus(chore);

  const dateStr = due.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (status === 'overdue') return `<span class="chore-due overdue">Overdue (${dateStr}, ${Math.abs(diffDays)}d ago)</span>`;
  if (status === 'due-today') return `<span class="chore-due due-today">${lucideIcon("bell",16)} Due today</span>`;
  if (status === 'due-tomorrow') return `<span class="chore-due due-today">${lucideIcon("calendar",16)} Tomorrow (${dateStr})</span>`;
  if (status === 'due-soon') return `<span class="chore-due due-soon">${lucideIcon("calendar",16)} ${dateStr} (in ${diffDays}d)</span>`;
  return `<span class="chore-due on-track">${lucideIcon("circle-check",16)} ${dateStr} (in ${diffDays}d)</span>`;
}

function getFilteredChoresForCategory(category) {
  let filtered = state.allChores.filter(c => (c.category || 'General') === (category || 'General'));
  if (choreFilter === 'overdue') filtered = filtered.filter(c => choreDueStatus(c) === 'overdue');
  else if (choreFilter === 'due-soon') filtered = filtered.filter(c => ['overdue', 'due-today', 'due-tomorrow', 'due-soon'].includes(choreDueStatus(c)));

  const sortBy = document.getElementById('choreSortBy')?.value || 'due';
  if (sortBy === 'due') {
    filtered.sort((a, b) => {
      if (!a.next_due && !b.next_due) return 0;
      if (!a.next_due) return 1;
      if (!b.next_due) return -1;
      return new Date(a.next_due) - new Date(b.next_due);
    });
  } else if (sortBy === 'name') {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortBy === 'last-done') {
    filtered.sort((a, b) => {
      const la = getChoreLastDone(a.id);
      const lb = getChoreLastDone(b.id);
      if (!la && !lb) return 0;
      if (!la) return 1;
      if (!lb) return -1;
      return lb - la;
    });
  }
  return filtered;
}

function setChoreFilter(filter) {
  choreFilter = filter;
  document.querySelectorAll('#choreFilters .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderChores();
}

function renderChores() {
  const grid = document.getElementById('choreCategoryGrid');
  if (!grid) return;

  const categories = getChoreCategories();
  const categoryList = ['General', ...categories];

  let html = '';
  for (const cat of categoryList) {
    html += renderChoreCategoryCard(cat);
  }
  grid.innerHTML = html;
  initChoreHoverDelay(grid);
  renderChoreNavButtons(categoryList);
}

function initChoreHoverDelay(container) {
  initItemHoverDelay(container, {
    itemSelector: '.chore-item',
    actionsSelector: '.chore-actions',
    rowSelector: '.chore-row',
    textSelector: '.chore-name',
  });
}

function renderChoreNavButtons(categoryList) {
  const container = document.getElementById('choreNavButtons');
  if (!container) return;
  container.innerHTML = categoryList.map(cat => {
    const color = getCategoryColor(cat);
    const count = state.allChores.filter(c => (c.category || 'General') === cat).length;
    return `<button class="category-nav-btn" style="--cat-color:${color};border-color:${color};color:${color}" onclick="navigateToChoreCategory('${esc(cat).replace(/'/g, "\\'")}')" title="${esc(cat)}">${esc(cat)} (${count})</button>`;
  }).join('');
}

function navigateToChoreCategory(cat) {
  const card = document.querySelector(`.project-card[data-category="${CSS.escape(cat)}"]`);
  if (!card) return;
  const color = getCategoryColor(cat);
  scrollToAndHighlight(card, color);
}

function renderChoreCategoryCard(category) {
  const catName = category || 'General';
  const isGeneral = catName === 'General';
  const choresInCat = getFilteredChoresForCategory(category);
  const totalInCat = state.allChores.filter(c => (c.category || 'General') === catName).length;
  const overdueCount = state.allChores.filter(c => (c.category || 'General') === catName && choreDueStatus(c) === 'overdue').length;

  const catColor = getCategoryColor(catName);
  const statsText = `${totalInCat} chore${totalInCat !== 1 ? 's' : ''}` + (overdueCount > 0 ? ` · <span style="color:var(--red)">${overdueCount} overdue</span>` : '');

  const deleteBtn = !isGeneral
    ? `<button class="todo-cat-delete-btn" onclick="deleteChoreCategory('${esc(catName).replace(/'/g, "\\'")}')" title="Delete category">${lucideIcon("trash-2",16)}</button>`
    : '';

  const escapedCat = esc(catName).replace(/'/g, "\\'");

  const items = choresInCat.length === 0
    ? '<p class="empty-msg">No chores here</p>'
    : choresInCat.map(c => renderChoreItem(c)).join('');

  return `<div class="project-card" data-category="${esc(catName)}" style="--cat-color:${catColor}">
    <div class="todo-cat-header">
      <div class="todo-cat-header-left">
        <div class="todo-cat-info">
          <h3 class="todo-cat-name">${esc(catName)}${getChoreShortname(catName) ? '<span class="todo-cat-shortname-label">' + esc(getChoreShortname(catName)) + '</span>' : ''}</h3>
          <span class="todo-cat-stats">${statsText}</span>
        </div>
      </div>
      <div class="todo-cat-header-actions">
        <button class="todo-cat-shortname-btn" onclick="promptChoreShortname('${escapedCat}')" title="${getChoreShortname(catName) ? 'Edit short name' : 'Set short name'}">${lucideIcon("pencil",14)}</button>
        ${deleteBtn}
      </div>
    </div>
    <div class="todo-cat-add">
      <input type="text" placeholder="Add a chore..." maxlength="200" class="todo-cat-input chore-add-input" data-category="${esc(catName)}" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addChoreFromInput(this);}">
      <button onclick="addChoreFromInput(this.previousElementSibling)">+</button>
    </div>
    <div class="chore-list todo-cat-list">
      ${items}
    </div>
  </div>`;
}

function renderChoreItem(chore) {
  const lastDone = getChoreLastDone(chore.id);
  const completionCount = getChoreCompletionCount(chore.id);
  const isDraft = chore.is_draft;
  const status = isDraft ? 'draft' : choreDueStatus(chore);
  const dueHtml = isDraft ? '<span class="chore-due draft">${lucideIcon("file-text",16)} Draft</span>' : formatChoreDue(chore);

  const lastDoneStr = lastDone
    ? `Last: ${lastDone.toLocaleDateString([], { month: 'short', day: 'numeric' })} (${formatChoreRelative(lastDone)})`
    : 'Never done';

  const promoteBtn = isDraft ? `<button onclick="promoteChore('${chore.id}')" title="Promote to active chore" class="chore-promote-btn">▶ Activate</button>` : '';

  return `<div class="bucket-item chore-item chore-status-${status}" data-chore-id="${chore.id}">
    <div class="chore-row">
      <div class="chore-info">
        <span class="chore-name">${esc(chore.name)}</span>
        <span class="chore-frequency">${esc(chore.frequency_rule)}</span>
      </div>
      <div class="chore-actions">
        ${promoteBtn}
        ${!isDraft ? `<button onclick="openChoreDoneModal('${chore.id}')" title="Mark done" class="chore-done-btn">${lucideIcon("circle-check",16)}</button>` : ''}
        <button onclick="openChoreHistory('${chore.id}')" title="History (${completionCount})" class="chore-history-btn">${lucideIcon("clipboard-list",16)} ${completionCount}</button>
        <button onclick="openEditChoreModal('${chore.id}')" title="Edit">${lucideIcon("pencil",16)}</button>
        <button onclick="deleteChore('${chore.id}')" title="Delete">${lucideIcon("trash-2",16)}</button>
      </div>
    </div>
    <div class="chore-meta">
      ${dueHtml}
      ${!isDraft ? `<span class="chore-last-done">${lastDoneStr}</span>` : ''}
    </div>
  </div>`;
}

function formatChoreRelative(d) {
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

// ===================================================================
// CHORE CRUD
// ===================================================================
function initChoreModals() {
  const app = document.getElementById('app');

  // Add Chore Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay'; m1.id = 'addChoreModal';
  m1.innerHTML = `<div class="modal"><h2>` + lucideIcon("brush",20) + ` Add Chore</h2><label>Name</label><input type="text" id="newChoreName" placeholder="e.g. Hoovering, Laundry..." maxlength="200" onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewChore();}"><label>Frequency Rule (natural language)</label><input type="text" id="newChoreFrequency" placeholder='e.g. "every other weekend", "second Saturday of the month"' maxlength="300"><label>Category</label><select id="newChoreCategory"></select><label>Last Done (optional)</label><input type="date" id="newChoreLastDone"><label class="chore-draft-toggle"><input type="checkbox" id="newChoreDraft"><span>Save as draft (won\'t show due dates until promoted)</span></label><div class="modal-actions"><button class="modal-cancel" onclick="closeAddChoreModal()">Cancel</button><button class="modal-save" onclick="saveNewChore()">Create</button></div></div>`;
  app.appendChild(m1);

  // Edit Chore Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay'; m2.id = 'editChoreModal';
  m2.innerHTML = `<div class="modal"><h2>` + lucideIcon("pencil",20) + ` Edit Chore</h2><input type="hidden" id="editChoreId"><label>Name</label><input type="text" id="editChoreName" maxlength="200"><label>Frequency Rule</label><input type="text" id="editChoreFrequency" maxlength="300"><label>Category</label><select id="editChoreCategory"></select><div class="modal-actions"><button class="modal-cancel" onclick="closeEditChoreModal()">Cancel</button><button class="modal-save" onclick="saveEditChore()">Save</button></div></div>`;
  app.appendChild(m2);

  // Chore Done Modal
  const m3 = document.createElement('div');
  m3.className = 'modal-overlay'; m3.id = 'choreDoneModal';
  m3.innerHTML = `<div class="modal chore-done-modal"><h2>` + lucideIcon("circle-check",20) + ` Mark Chore Done</h2><p id="choreDoneName" style="font-size:0.88rem;margin-bottom:12px;"></p><label>Note (optional)</label><input type="text" id="choreDoneNote" placeholder="e.g. Deep clean, only kitchen..." maxlength="500" onkeydown="if(event.key==='Enter'){event.preventDefault();submitChoreDone();}"><input type="hidden" id="choreDoneId"><div class="modal-actions"><button class="modal-cancel" onclick="closeChoreDoneModal()">Cancel</button><button class="modal-save" onclick="submitChoreDone()">Done ` + lucideIcon("circle-check",16) + `</button></div></div>`;
  app.appendChild(m3);

  // Chore History Modal
  const m4 = document.createElement('div');
  m4.className = 'modal-overlay'; m4.id = 'choreHistoryModal';
  m4.innerHTML = `<div class="modal chore-history-modal"><h2>` + lucideIcon("clipboard-list",20) + ` Chore History</h2><p id="choreHistoryName" style="font-size:0.88rem;color:var(--muted);margin-bottom:12px;"></p><div id="choreHistoryList"></div><div class="modal-actions"><button class="modal-cancel" onclick="closeChoreHistoryModal()">Close</button></div></div>`;
  app.appendChild(m4);

  // Add Chore Category Modal
  const m5 = document.createElement('div');
  m5.className = 'modal-overlay'; m5.id = 'addChoreCategoryModal';
  m5.innerHTML = `<div class="modal"><h2>` + lucideIcon("folder-plus",20) + ` Add Chore Category</h2><label>Category Name</label><input type="text" id="newChoreCategoryName" placeholder="e.g. Kitchen, Bathroom, Laundry..." maxlength="40" onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewChoreCategory();}"><div class="modal-actions"><button class="modal-cancel" onclick="closeAddChoreCategoryModal()">Cancel</button><button class="modal-save" onclick="saveNewChoreCategory()">Create</button></div></div>`;
  app.appendChild(m5);
}

function openAddChoreModal() {
  document.getElementById('newChoreName').value = '';
  document.getElementById('newChoreFrequency').value = '';
  document.getElementById('newChoreLastDone').value = '';
  document.getElementById('newChoreDraft').checked = false;
  populateChoreCategorySelect('newChoreCategory');
  document.getElementById('addChoreModal').classList.add('visible');
  setTimeout(() => document.getElementById('newChoreName').focus(), 100);
}

function closeAddChoreModal() {
  document.getElementById('addChoreModal').classList.remove('visible');
}

function populateChoreCategorySelect(selectId) {
  const sel = document.getElementById(selectId);
  const cats = ['General', ...getChoreCategories()];
  sel.innerHTML = cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

async function addChoreFromInput(inputEl) {
  const name = inputEl.value.trim();
  if (!name) return;
  const category = inputEl.dataset.category || 'General';

  // Quick-add: opens the full modal pre-filled with name + category
  document.getElementById('newChoreName').value = name;
  document.getElementById('newChoreFrequency').value = '';
  document.getElementById('newChoreLastDone').value = '';
  document.getElementById('newChoreDraft').checked = false;
  populateChoreCategorySelect('newChoreCategory');
  document.getElementById('newChoreCategory').value = category;
  document.getElementById('addChoreModal').classList.add('visible');
  inputEl.value = '';
  setTimeout(() => document.getElementById('newChoreFrequency').focus(), 100);
}

async function saveNewChore() {
  const name = document.getElementById('newChoreName').value.trim();
  const freq = document.getElementById('newChoreFrequency').value.trim();
  const cat = document.getElementById('newChoreCategory').value || 'General';
  const lastDoneVal = document.getElementById('newChoreLastDone').value;
  const isDraft = document.getElementById('newChoreDraft').checked;

  if (!name) { showToast('Enter a chore name', 'error'); return; }
  if (!freq) { showToast('Enter a frequency rule', 'error'); return; }

  const { data, error } = await state.sb.from('chores').insert({ name, frequency_rule: freq, category: cat, is_draft: isDraft }).select().single();
  if (error) { showToast('Failed to add chore: ' + error.message, 'error'); return; }

  // If lastDone was provided, create an initial completion
  if (lastDoneVal && data && data.id) {
    await state.sb.from('chore_completions').insert({ chore_id: data.id, completed_at: new Date(lastDoneVal).toISOString() });
  }
  // Signal heartbeat to compute next_due
  if (data && data.id) {
    await clearChoreNextDue(data.id);
  }

  closeAddChoreModal();
  showToast(`Chore "${name}" added`, 'success');
  await refreshChores();
}

function openEditChoreModal(choreId) {
  const chore = state.allChores.find(c => c.id === choreId);
  if (!chore) return;
  document.getElementById('editChoreId').value = choreId;
  document.getElementById('editChoreName').value = chore.name;
  document.getElementById('editChoreFrequency').value = chore.frequency_rule;
  populateChoreCategorySelect('editChoreCategory');
  document.getElementById('editChoreCategory').value = chore.category || 'General';
  document.getElementById('editChoreModal').classList.add('visible');
  setTimeout(() => document.getElementById('editChoreName').focus(), 100);
}

function closeEditChoreModal() {
  document.getElementById('editChoreModal').classList.remove('visible');
}

async function saveEditChore() {
  const id = document.getElementById('editChoreId').value;
  const name = document.getElementById('editChoreName').value.trim();
  const freq = document.getElementById('editChoreFrequency').value.trim();
  const cat = document.getElementById('editChoreCategory').value || 'General';

  if (!name) { showToast('Enter a chore name', 'error'); return; }
  if (!freq) { showToast('Enter a frequency rule', 'error'); return; }

  const { error } = await state.sb.from('chores').update({ name, frequency_rule: freq, category: cat }).eq('id', id);
  if (error) { showToast('Update failed: ' + error.message, 'error'); return; }

  // Signal heartbeat to recompute next_due
  await clearChoreNextDue(id);

  closeEditChoreModal();
  showToast('Chore updated', 'success');
  await refreshChores();
}

async function deleteChore(choreId) {
  const chore = state.allChores.find(c => c.id === choreId);
  if (!chore) return;
  showDeleteConfirm(
    'Delete Chore',
    `Delete "${chore.name}"? All completion history will be lost.`,
    async () => {
      const { error } = await state.sb.from('chores').delete().eq('id', choreId);
      if (error) { showToast('Delete failed', 'error'); return; }
      showToast('Chore deleted', 'info');
      await refreshChores();
    }
  );
}

async function promoteChore(choreId) {
  const { error } = await state.sb.from('chores').update({ is_draft: false }).eq('id', choreId);
  if (error) { showToast('Failed to promote chore', 'error'); return; }
  showToast('Chore activated', 'success');
  await refreshChores();
}


// ===================================================================
// CHORE DONE FLOW
// ===================================================================
function openChoreDoneModal(choreId) {
  const chore = state.allChores.find(c => c.id === choreId);
  if (!chore) return;
  document.getElementById('choreDoneId').value = choreId;
  document.getElementById('choreDoneName').innerHTML = `${lucideIcon("brush",16)} ${chore.name}`;
  document.getElementById('choreDoneNote').value = '';
  document.getElementById('choreDoneModal').classList.add('visible');
  setTimeout(() => document.getElementById('choreDoneNote').focus(), 100);
}

function closeChoreDoneModal() {
  document.getElementById('choreDoneModal').classList.remove('visible');
}

async function submitChoreDone() {
  const choreId = document.getElementById('choreDoneId').value;
  const note = document.getElementById('choreDoneNote').value.trim();
  if (!choreId) return;

  const row = { chore_id: choreId, completed_at: new Date().toISOString() };
  if (note) row.note = note;

  const { error } = await state.sb.from('chore_completions').insert(row);
  if (error) { showToast('Failed to record completion', 'error'); return; }

  // Signal heartbeat to recompute next_due based on this new completion
  await clearChoreNextDue(choreId);

  closeChoreDoneModal();
  showToast('Chore done!', 'success');
  await refreshChores();
}


// ===================================================================
// CHORE HISTORY
// ===================================================================
function openChoreHistory(choreId) {
  const chore = state.allChores.find(c => c.id === choreId);
  if (!chore) return;
  state._historyChoreId = choreId;
  renderChoreHistoryList(choreId, chore);
  document.getElementById('choreHistoryModal').classList.add('visible');
}

function renderChoreHistoryList(choreId, chore) {
  if (!chore) chore = state.allChores.find(c => c.id === choreId);
  if (!chore) return;
  const completions = getChoreCompletions(choreId);
  document.getElementById('choreHistoryName').innerHTML = `${lucideIcon("brush",16)} ${chore.name} — ${chore.frequency_rule}`;

  if (completions.length === 0) {
    document.getElementById('choreHistoryList').innerHTML = '<p class="empty-msg">No completions recorded yet</p>';
  } else {
    const items = completions.map(comp => {
      const d = new Date(comp.completed_at);
      const dateStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const noteStr = comp.note ? ` — <em>${esc(comp.note)}</em>` : '';
      return `<div class="chore-history-item" data-comp-id="${comp.id}">
        <span class="chore-history-date">${lucideIcon("circle-check",16)} ${dateStr}</span>
        ${noteStr}
        <span class="chore-history-actions">
          <button onclick="editChoreCompletion('${comp.id}')" title="Edit" class="chore-hist-btn">${lucideIcon("pencil",14,"#f59e0b")}</button>
          <button onclick="deleteChoreCompletion('${comp.id}')" title="Delete" class="chore-hist-btn">${lucideIcon("trash-2",14,"#ef4444")}</button>
        </span>
      </div>`;
    }).join('');
    document.getElementById('choreHistoryList').innerHTML = items;
  }
}

async function deleteChoreCompletion(compId) {
  const comp = state.allChoreCompletions.find(c => c.id === compId);
  const dateStr = comp ? new Date(comp.completed_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
  showDeleteConfirm(
    'Delete completion',
    'Are you sure you want to delete this completion record?',
    async () => {
      const { error } = await state.sb.from('chore_completions').delete().eq('id', compId);
      if (error) { showToast('Failed to delete', 'error'); return; }
      showToast('Completion deleted', 'success');
      await refreshChores();
      if (state._historyChoreId) {
        await clearChoreNextDue(state._historyChoreId);
        renderChoreHistoryList(state._historyChoreId);
      }
    },
    dateStr + (comp && comp.note ? ` — ${comp.note}` : '')
  );
}

async function editChoreCompletion(compId) {
  const comp = state.allChoreCompletions.find(c => c.id === compId);
  if (!comp) return;
  const d = new Date(comp.completed_at);
  const dateVal = d.toISOString().slice(0, 10);
  const noteVal = comp.note || '';

  const item = document.querySelector(`.chore-history-item[data-comp-id="${compId}"]`);
  if (!item) return;
  item.innerHTML = `
    <div class="chore-history-edit">
      <label>Date</label>
      <input type="date" id="editCompDate_${compId}" value="${dateVal}">
      <label>Note</label>
      <input type="text" id="editCompNote_${compId}" value="${esc(noteVal)}" placeholder="Optional note..." maxlength="500">
      <div class="chore-history-edit-actions">
        <button onclick="saveChoreCompletion('${compId}')" class="modal-save">Save</button>
        <button onclick="cancelEditCompletion()" class="modal-cancel">Cancel</button>
      </div>
    </div>`;
}

async function saveChoreCompletion(compId) {
  const dateEl = document.getElementById(`editCompDate_${compId}`);
  const noteEl = document.getElementById(`editCompNote_${compId}`);
  if (!dateEl) return;
  const newDate = new Date(dateEl.value + 'T12:00:00Z').toISOString();
  const newNote = noteEl ? noteEl.value.trim() : null;
  const updates = { completed_at: newDate };
  if (newNote !== null) updates.note = newNote || null;

  const { error } = await state.sb.from('chore_completions').update(updates).eq('id', compId);
  if (error) { showToast('Failed to update', 'error'); return; }
  showToast('Completion updated', 'success');
  await refreshChores();
  if (state._historyChoreId) {
    await clearChoreNextDue(state._historyChoreId);
    renderChoreHistoryList(state._historyChoreId);
  }
}

function cancelEditCompletion() {
  if (state._historyChoreId) renderChoreHistoryList(state._historyChoreId);
}

function closeChoreHistoryModal() {
  document.getElementById('choreHistoryModal').classList.remove('visible');
}

// ===================================================================
// CHORE CATEGORY MANAGEMENT
// ===================================================================
function openAddChoreCategoryModal() {
  document.getElementById('newChoreCategoryName').value = '';
  document.getElementById('addChoreCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('newChoreCategoryName').focus(), 100);
}

function closeAddChoreCategoryModal() {
  document.getElementById('addChoreCategoryModal').classList.remove('visible');
}

function saveNewChoreCategory() {
  const name = document.getElementById('newChoreCategoryName').value.trim();
  if (!name) { showToast('Enter a category name', 'error'); return; }
  const cats = getChoreCategories();
  if (cats.some(c => c.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === 'general') {
    showToast('Category already exists', 'error'); return;
  }
  cats.push(name);
  saveChoreCategories(cats);
  closeAddChoreCategoryModal();
  showToast(`Category "${name}" created`, 'success');
  renderChores();
}

async function deleteChoreCategory(name) {
  const choresInCat = state.allChores.filter(c => (c.category || 'General') === name);
  const msg = choresInCat.length > 0
    ? `Delete "${name}"? Its ${choresInCat.length} chore(s) will move to General.`
    : `Delete empty category "${name}"?`;

  showDeleteConfirm('Delete Category', msg, async () => {
    for (const c of choresInCat) {
      await state.sb.from('chores').update({ category: 'General' }).eq('id', c.id);
    }
    const cats = getChoreCategories();
    const idx = cats.findIndex(c => c === name);
    if (idx !== -1) { cats.splice(idx, 1); saveChoreCategories(cats); }
    showToast(`Category "${name}" deleted`, 'info');
    await refreshChores();
  });
}


export { refreshChores, renderChores, initChoreModals };

window.setChoreFilter = setChoreFilter;
window.openAddChoreModal = openAddChoreModal;
window.closeAddChoreModal = closeAddChoreModal;
window.saveNewChore = saveNewChore;
window.openEditChoreModal = openEditChoreModal;
window.closeEditChoreModal = closeEditChoreModal;
window.saveEditChore = saveEditChore;
window.deleteChore = deleteChore;
window.promoteChore = promoteChore;
window.openChoreDoneModal = openChoreDoneModal;
window.closeChoreDoneModal = closeChoreDoneModal;
window.submitChoreDone = submitChoreDone;
window.openChoreHistory = openChoreHistory;
window.closeChoreHistoryModal = closeChoreHistoryModal;
window.editChoreCompletion = editChoreCompletion;
window.saveChoreCompletion = saveChoreCompletion;
window.deleteChoreCompletion = deleteChoreCompletion;
window.cancelEditCompletion = cancelEditCompletion;
window.openAddChoreCategoryModal = openAddChoreCategoryModal;
window.closeAddChoreCategoryModal = closeAddChoreCategoryModal;
window.saveNewChoreCategory = saveNewChoreCategory;
window.deleteChoreCategory = deleteChoreCategory;
window.addChoreFromInput = addChoreFromInput;
window.renderChores = renderChores;
window.navigateToChoreCategory = navigateToChoreCategory;

window.promptChoreShortname = promptChoreShortname;
