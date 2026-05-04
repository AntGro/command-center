// ===================================================================
// WELCOME / TODAY — Daily briefing dashboard
// ===================================================================
import { lucideIcon } from './icons.js';
import { t, getLang } from './i18n.js';
import state from './supabase.js';
import { esc, renderMd, showToast, showDeleteConfirm, formatRelativeDate, truncateWithShowMore } from './utils.js';
import { initItemHoverDelay, inlineEditText } from './item-utils.js';
import { formatFrequency, formatChoreDue, choreDueStatus, getChoreLastDone, formatChoreRelative, getChoreCompletionCount, updateChoreNextDue } from './chores.js';
import { getCategoryColor } from './todos.js';

// ── Local data cache ──
let wTodos = [];
let wChores = [];
let wChoreCompletionsWeek = 0;
let wFlashcards = [];
let wBirthdays = [];
let wProjectCount = 0;
let wVestiaireCount = 0;

// ── Helpers ──
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Flashcard "day" runs 06:00→06:00 instead of midnight→midnight. */
function flashcardDayStart(d) {
  const s = new Date(d);
  if (s.getHours() < 6) s.setDate(s.getDate() - 1);
  return new Date(s.getFullYear(), s.getMonth(), s.getDate(), 6, 0, 0, 0);
}

const FLASHCARD_PRACTICE_THRESHOLD = 10;

function retrievability(S, lastReview, nowStr) {
  if (!S || !lastReview) return 0;
  const elapsed = (new Date(nowStr) - new Date(lastReview)) / 86400000;
  return Math.pow(0.9, elapsed / S);
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return t('welcome.good_morning');
  if (h < 18) return t('welcome.good_afternoon');
  return t('welcome.good_evening');
}

function formatDateLocale() {
  const lang = getLang();
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'es' ? 'es-ES' : 'en-GB';
  return new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function getNextBirthday(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const today = new Date();
  const thisYear = today.getFullYear();
  const todayStart = startOfDay(today);
  const next = new Date(thisYear, bd.getMonth(), bd.getDate());
  if (next < todayStart) next.setFullYear(thisYear + 1);
  return next;
}

function daysUntilBirthday(birthdayStr) {
  const next = getNextBirthday(birthdayStr);
  const todayStart = startOfDay(new Date());
  return Math.round((next - todayStart) / 86400000);
}

function getAge(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const today = new Date();
  let age = today.getFullYear() - bd.getFullYear();
  const m = today.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < bd.getDate())) age--;
  return age;
}

// ── Data fetch ──
let _refreshingWelcome = false;

async function refreshWelcome() {
  if (!state.db.connected || _refreshingWelcome) return;
  _refreshingWelcome = true;
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const weekAgoISO = weekAgo.toISOString();

    const [todosRes, choresRes, completionsRes, flashRes, bdRes, projRes, vestRes] = await Promise.all([
      state.db.from('todos').select('*'),
      state.db.from('chores').select('*'),
      state.db.from('chore_completions').select('completed_at').gte('completed_at', weekAgoISO),
      state.db.from('flashcards').select('*'),
      state.db.from('birthdays').select('*'),
      state.db.from('projects').select('id'),
      state.db.from('vestiaire').select('id'),
    ]);

    wTodos = todosRes.data || [];
    wChores = choresRes.data || [];
    wChoreCompletionsWeek = (completionsRes.data || []).length;
    wFlashcards = flashRes.data || [];
    wBirthdays = bdRes.data || [];
    const archivedIds = (() => { try { return JSON.parse(localStorage.getItem('claw_cc_archived_projects') || '[]'); } catch { return []; } })();
    wProjectCount = (projRes.data || []).filter(p => !archivedIds.includes(p.id)).length;
    wVestiaireCount = (vestRes.data || []).length;
  } finally {
    _refreshingWelcome = false;
  }
}

// ── Listen for todo mutations from the TODOs module ──
document.addEventListener('todos-changed', () => {
  if (state.currentView === 'welcome') {
    refreshWelcome().then(renderWelcome);
  }
});

// ── Listen for chore mutations from the Chores module ──
document.addEventListener('chores-changed', () => {
  if (state.currentView === 'welcome') {
    refreshWelcome().then(renderWelcome);
  }
});

// ── Welcome-specific TODO action handlers ──

async function welcomeToggleTodo(id, done) {
  const { error } = await state.db.from('todos').update({ done }).eq('id', id);
  if (error) { showToast(t('toast.update_failed'), 'error'); return; }
  showToast(done ? t('common.done') + '!' : t('common.reopen'), 'success');
  await refreshWelcome();
  renderWelcome();
}

async function welcomeDeleteTodo(id) {
  showDeleteConfirm(
    t('common.delete'),
    'Delete this TODO? This cannot be undone.',
    async () => {
      const { error } = await state.db.from('todos').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('toast.deleted'), 'info');
      await refreshWelcome();
      renderWelcome();
    }
  );
}

async function welcomeCyclePriority(id) {
  const todo = wTodos.find(t => t.id === id);
  if (!todo) return;
  const cycle = { normal: 'high', high: 'urgent', urgent: 'normal' };
  const next = cycle[todo.priority] || 'high';
  const { error } = await state.db.from('todos').update({ priority: next }).eq('id', id);
  if (error) { showToast(t('toast.update_failed'), 'error'); return; }
  const labels = { high: t('todos.flag_to_high'), urgent: t('todos.flag_to_urgent'), normal: t('todos.unflag') };
  showToast(labels[next] || `Priority: ${next}`, 'success');
  await refreshWelcome();
  renderWelcome();
}

function welcomeSnooze(id) {
  // Reuse the snooze modal from todos — its doSnooze calls refreshTodos
  // which dispatches 'todos-changed', and our listener refreshes welcome
  if (typeof window.openSnoozeModal === 'function') {
    window.openSnoozeModal(id);
  }
}

// Register welcome action functions on window for onclick handlers
window.welcomeToggleTodo = welcomeToggleTodo;
window.welcomeDeleteTodo = welcomeDeleteTodo;
window.welcomeCyclePriority = welcomeCyclePriority;
window.welcomeSnooze = welcomeSnooze;

// ── Render a focus TODO item (same structure as todos.js) ──
function renderFocusTodoItem(td) {
  const now = new Date();
  const todayStart = startOfDay(now);
  const isOverdue = td.due_date && !td.done && new Date(td.due_date) < now;
  const isSnoozed = td.snooze_until && new Date(td.snooze_until) > now;
  const isFlagged = td.priority && td.priority !== 'normal';

  const flagIcon = td.priority === 'urgent' ? lucideIcon('flag', 14, '#ef4444')
    : td.priority === 'high' ? lucideIcon('flag', 14, '#f97316')
    : lucideIcon('flag', 14);
  const flagTitle = td.priority === 'urgent' ? t('todos.unflag')
    : td.priority === 'high' ? t('todos.flag_to_urgent')
    : t('todos.flag_to_high');
  const flagBtn = `<button class="todo-flag-btn ${isFlagged ? 'flagged' : ''}" onclick="welcomeCyclePriority('${td.id}')" title="${flagTitle}">${flagIcon}</button>`;

  let dueDateStr = '';
  if (td.due_date) {
    const d = new Date(td.due_date);
    const diffMs = d - now;
    const diffH = Math.round(diffMs / (1000 * 60 * 60));
    if (isOverdue) {
      dueDateStr = `<span class="todo-due overdue">${lucideIcon('alert-triangle', 14)} ${t('todos.overdue')} (${formatRelativeDate(d)})</span>`;
    } else if (diffH < 24) {
      dueDateStr = `<span class="todo-due due-soon">${lucideIcon("bell", 16)} ${t('todos.due')} ${formatRelativeDate(d)}</span>`;
    } else {
      dueDateStr = `<span class="todo-due">${lucideIcon("calendar", 16)} ${formatRelativeDate(d)}</span>`;
    }
  }

  let snoozeInfo = '';
  if (isSnoozed) {
    snoozeInfo = `<span class="todo-snoozed">${lucideIcon("moon", 16)} ${t('todos.snoozed_until')} ${new Date(td.snooze_until).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`;
  }

  const classes = [
    'bucket-item',
    'todo-item',
    isOverdue ? 'todo-overdue' : '',
    isFlagged ? 'todo-flagged' : ''
  ].filter(Boolean).join(' ');

  return `<div class="${classes}" data-todo-id="${td.id}">
    <div class="todo-row">
      ${flagBtn}
      <span class="todo-text">${td.text.length > 150 ? truncateWithShowMore(td.text, 150, td.id, 'todo') : renderMd(td.text)}</span>
      <div class="todo-actions">
        <button onclick="welcomeToggleTodo('${td.id}', true)" title="${t('common.done')}">${lucideIcon("circle-check", 16)}</button>
        <button onclick="welcomeSnooze('${td.id}')" title="${t('todos.snooze')}">${lucideIcon("moon", 16)}</button>
        <button onclick="window.editTodoInline('${td.id}')" title="${t('common.edit')}">${lucideIcon("pencil", 16)}</button>
        <button onclick="welcomeDeleteTodo('${td.id}')" title="${t('common.delete')}">${lucideIcon("trash-2", 16)}</button>
      </div>
    </div>
    ${dueDateStr || snoozeInfo ? `<div class="todo-meta">${dueDateStr}${snoozeInfo}</div>` : ''}
  </div>`;
}

// ── Init hover delay for focus items after render ──
function initWelcomeFocusHover() {
  const container = document.querySelector('#welcomeView .welcome-focus-todos');
  if (!container) return;
  initItemHoverDelay(container, {
    itemSelector: '.todo-item',
    actionsSelector: '.todo-actions',
    rowSelector: '.todo-row',
    textSelector: '.todo-text',
    editingSelector: '.task-edit-input, .todo-edit-wrapper',
    onDblClick: (item) => {
      const id = item.dataset.todoId;
      if (id && typeof window.editTodoInline === 'function') {
        window.editTodoInline(id, item);
      }
    },
  });
}

// ===================================================================
// WELCOME — Chore action handlers (mirrors Chores page actions)
// ===================================================================

async function welcomeMarkChoreDone(choreId) {
  if (!choreId) return;
  const chore = (state.allChores || []).find(c => c.id === choreId);
  const now = new Date().toISOString();
  const { error } = await state.db.from('chore_completions').insert({ chore_id: choreId, completed_at: now });
  if (error) { showToast(t('chores.failed_record'), 'error'); return; }
  if (chore) await updateChoreNextDue(choreId, chore.frequency_rule, now);
  showToast(t('chores.chore_done'), 'success');
  await refreshWelcome();
  renderWelcome();
}

async function welcomeDeleteChore(choreId) {
  const chore = (state.allChores || []).find(c => c.id === choreId);
  if (!chore) return;
  showDeleteConfirm(
    t('common.delete'),
    `Delete "${chore.name}"? All completion history will be lost.`,
    async () => {
      const { error } = await state.db.from('chores').delete().eq('id', choreId);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('chores.chore_deleted'), 'info');
      await refreshWelcome();
      renderWelcome();
    }
  );
}

function welcomeEditChore(choreId) {
  // Re-use the existing edit modal from chores.js (registered on window)
  if (typeof window.openEditChoreModal === 'function') {
    window.openEditChoreModal(choreId);
  }
}

function welcomeOpenChoreHistory(choreId) {
  if (typeof window.openChoreHistory === 'function') {
    window.openChoreHistory(choreId);
  }
}

window.welcomeMarkChoreDone = welcomeMarkChoreDone;
window.welcomeDeleteChore = welcomeDeleteChore;
window.welcomeEditChore = welcomeEditChore;
window.welcomeOpenChoreHistory = welcomeOpenChoreHistory;

// ── Render a focus chore item (same structure as chores.js renderChoreItem) ──
function renderFocusChoreItem(chore) {
  const lastDone = getChoreLastDone(chore.id);
  const completionCount = getChoreCompletionCount(chore.id);
  const status = choreDueStatus(chore);
  const dueHtml = formatChoreDue(chore);

  const lastDoneStr = lastDone
    ? `${t('chores.last_done')}: ${lastDone.toLocaleDateString([], { month: 'short', day: 'numeric' })} (${formatChoreRelative(lastDone)})`
    : 'Never done';

  return `<div class="bucket-item chore-item chore-status-${status}" data-chore-id="${chore.id}">
    <div class="chore-row">
      <div class="chore-info">
        <span class="chore-name">${esc(chore.name)}</span>
        <span class="chore-frequency">${esc(formatFrequency(chore.frequency_rule))}</span>
      </div>
      <div class="chore-actions">
        <button onclick="welcomeMarkChoreDone('${chore.id}')" title="${t('chores.mark_done')}" class="chore-done-btn">${lucideIcon("circle-check", 16)}</button>
        <button onclick="welcomeOpenChoreHistory('${chore.id}')" title="${t('chores.chore_history')} (${completionCount})" class="chore-history-btn">${lucideIcon("clipboard-list", 16)} ${completionCount}</button>
        <button onclick="welcomeEditChore('${chore.id}')" title="${t('common.edit')}">${lucideIcon("pencil", 16)}</button>
        <button onclick="welcomeDeleteChore('${chore.id}')" title="${t('common.delete')}">${lucideIcon("trash-2", 16)}</button>
      </div>
    </div>
    <div class="chore-meta">
      ${dueHtml}
      <span class="chore-last-done">${lastDoneStr}</span>
    </div>
  </div>`;
}

// ── Init hover delay for chore items after render ──
function initWelcomeFocusChoreHover() {
  const container = document.querySelector('#welcomeView .welcome-focus-chores');
  if (!container) return;
  initItemHoverDelay(container, {
    itemSelector: '.chore-item',
    actionsSelector: '.chore-actions',
    rowSelector: '.chore-row',
    textSelector: '.chore-name',
    onDblClick: (item) => {
      const id = item.dataset.choreId;
      if (id && typeof window.editChoreInline === 'function') {
        window.editChoreInline(id, item);
      }
    },
  });
}

// ── Render ──
function renderWelcome() {
  const container = document.getElementById('welcomeView');
  if (!container) return;

  const now = new Date();
  const todayStart = startOfDay(now);
  const nowStr = now.toISOString();

  // ── 1. Focus TODOs ──
  const focusTodos = wTodos.filter(td => {
    if (td.done) return false;
    // Snoozed and still sleeping → skip
    if (td.snooze_until && new Date(td.snooze_until) > now) return false;
    // Flagged
    if (td.priority && td.priority !== 'normal') return true;
    // Deadline today or overdue
    if (td.due_date) {
      const due = startOfDay(new Date(td.due_date));
      if (due <= todayStart) return true;
    }
    return false;
  });
  // Sort: urgent first, then high, then by deadline
  const priOrd = { urgent: 0, high: 1 };
  focusTodos.sort((a, b) => {
    const pa = priOrd[a.priority] ?? 2;
    const pb = priOrd[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return 0;
  });

  // ── 2. Chores due ──
  const choresDue = wChores.filter(c => {
    if (c.is_draft) return false;
    if (!c.next_due) return false;
    return startOfDay(new Date(c.next_due)) <= todayStart;
  });
  choresDue.sort((a, b) => new Date(a.next_due) - new Date(b.next_due));

  // ── 3. Flashcards ──
  const dueCards = wFlashcards.filter(c => c.last_review && (!c.next_review || new Date(c.next_review) <= now));
  const newCards = wFlashcards.filter(c => !c.last_review);
  // Did the user already practice today? Check if any card was reviewed today.
  // Flashcard "day" runs 06:00→06:00; require ≥10 cards to count as practiced
  const fcDayStart = flashcardDayStart(now);
  const todayReviewedCards = wFlashcards.filter(c => c.last_review && new Date(c.last_review) >= fcDayStart);
  const practicedToday = todayReviewedCards.length >= FLASHCARD_PRACTICE_THRESHOLD;
  let avgR = 0;
  const reviewedCards = wFlashcards.filter(c => c.last_review && c.stability);
  if (reviewedCards.length > 0) {
    const sumR = reviewedCards.reduce((acc, c) => acc + retrievability(c.stability, c.last_review, nowStr), 0);
    avgR = sumR / reviewedCards.length;
  }

  // ── 4. Upcoming birthdays (next 7 days) ──
  const upcomingBDs = wBirthdays
    .map(b => ({ ...b, daysUntil: daysUntilBirthday(b.birthday), age: getAge(b.birthday) }))
    .filter(b => b.daysUntil >= 0 && b.daysUntil <= 7)
    .sort((a, b) => a.daysUntil - b.daysUntil);

  // ── 5. Stats ──
  const todosPending = wTodos.filter(td => !td.done).length;
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
  if (weekStart > todayStart) weekStart.setDate(weekStart.getDate() - 7);
  const todosDoneWeek = wTodos.filter(td => td.done && td.updated_at && new Date(td.updated_at) >= weekStart).length;

  // ── Build HTML ──
  let html = '';

  // Header
  html += `<div class="welcome-header">`;
  html += `<div class="welcome-greeting">${esc(getGreeting())}</div>`;
  html += `<div class="welcome-date">${esc(formatDateLocale())}</div>`;
  html += `</div>`;

  // Focus TODOs + Chores due — side by side
  html += `<div class="welcome-grid">`;

  // Focus TODOs section
  html += `<div class="welcome-section">`;
  html += `<div class="welcome-section-header">${lucideIcon('list-checks', 18, '#22c55e')} <span>${esc(t('welcome.focus_todos'))}</span></div>`;
  if (focusTodos.length === 0) {
    html += `<div class="welcome-empty">${esc(t('welcome.all_clear'))}</div>`;
  } else {
    // Group todos by category
    const todosByCategory = {};
    for (const td of focusTodos) {
      const cat = td.category || '';
      if (!todosByCategory[cat]) todosByCategory[cat] = [];
      todosByCategory[cat].push(td);
    }
    html += `<div class="welcome-items welcome-focus-todos">`;
    const catKeys = Object.keys(todosByCategory);
    for (const cat of catKeys) {
      const catColor = getCategoryColor(cat);
      const catName = cat || 'General';
      if (catKeys.length > 1 || cat) {
        html += `<div class="welcome-todo-cat-label" style="--cat-color:${catColor}"><span class="welcome-todo-cat-dot"></span>${esc(catName)}</div>`;
      }
      for (const td of todosByCategory[cat]) {
        html += renderFocusTodoItem(td);
      }
    }
    html += `</div>`;
  }
  html += `</div>`;

  // Chores due
  html += `<div class="welcome-section">`;
  html += `<div class="welcome-section-header">${lucideIcon('brush', 18, '#ec4899')} <span>${esc(t('welcome.chores_due'))}</span></div>`;
  if (choresDue.length === 0) {
    html += `<div class="welcome-empty">${esc(t('welcome.no_chores_due'))}</div>`;
  } else {
    html += `<div class="welcome-items welcome-focus-chores">`;
    for (const ch of choresDue) {
      html += renderFocusChoreItem(ch);
    }
    html += `</div>`;
  }
  html += `</div>`;
  html += `</div>`; // close welcome-grid

  // Flashcards + Birthdays — second row grid
  html += `<div class="welcome-grid">`;

  // Flashcard reminder
  html += `<div class="welcome-section">`;
  html += `<div class="welcome-section-header">${lucideIcon('book-open', 18, '#06b6d4')} <span>${esc(t('welcome.flashcards'))}</span></div>`;
  if (practicedToday) {
    // Already practiced today — show positive state
    const todayCount = todayReviewedCards.length;
    html += `<div class="welcome-flash-done">${lucideIcon('circle-check', 16, '#22c55e')} ${esc(t('welcome.practiced_today', todayCount))}</div>`;
    if (dueCards.length > 0) {
      html += `<div class="welcome-flash-summary">`;
      html += `<span class="welcome-flash-due">${esc(t('welcome.cards_still_due', dueCards.length))}</span>`;
      html += `<button class="welcome-flash-btn" onclick="goToPractice()">${lucideIcon('play', 14)} ${esc(t('welcome.go_to_flashcards'))}</button>`;
      html += `</div>`;
    }
  } else if (dueCards.length > 0 || newCards.length > 0) {
    // Not practiced today and there are cards to review
    html += `<div class="welcome-flash-summary">`;
    if (dueCards.length > 0) {
      html += `<span class="welcome-flash-due">${esc(t('welcome.cards_due', dueCards.length))}</span>`;
    }
    if (newCards.length > 0) {
      html += `<span class="welcome-flash-new">${esc(t('welcome.new_cards', newCards.length))}</span>`;
    }
    html += `<button class="welcome-flash-btn" onclick="goToPractice()">${lucideIcon('play', 14)} ${esc(t('welcome.go_to_flashcards'))}</button>`;
    html += `</div>`;
  } else {
    html += `<div class="welcome-empty">${esc(t('welcome.up_to_date'))}</div>`;
  }
  if (reviewedCards.length > 0) {
    html += `<div class="welcome-flash-stats">${esc(t('welcome.avg_retrievability'))}: ${Math.round(avgR * 100)}%</div>`;
  }
  html += `</div>`;

  // Upcoming birthdays
  html += `<div class="welcome-section">`;
  html += `<div class="welcome-section-header">${lucideIcon('cake', 18, '#f97316')} <span>${esc(t('welcome.upcoming_birthdays'))}</span></div>`;
  if (upcomingBDs.length > 0) {
    html += `<div class="welcome-items">`;
    for (const b of upcomingBDs) {
      const dayLabel = b.daysUntil === 0 ? t('welcome.today_birthday')
        : b.daysUntil === 1 ? t('welcome.tomorrow_birthday')
        : t('welcome.in_days', b.daysUntil);
      html += `<div class="welcome-item" onclick="switchView('birthdays')">`;
      html += `<div class="welcome-item-main">`;
      html += `<span class="welcome-item-text">${esc(b.name)}</span>`;
      html += `<span class="welcome-badge birthday-badge">${esc(dayLabel)}</span>`;
      html += `</div>`;
      if (b.age > 0) {
        html += `<div class="welcome-item-meta">${esc(t('welcome.turning', b.age + (b.daysUntil === 0 ? 0 : 1)))}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="welcome-empty">${esc(t('welcome.no_birthdays'))}</div>`;
  }
  html += `</div>`;
  html += `</div>`; // close second welcome-grid

  // Stats overview
  html += `<div class="welcome-section">`;
  html += `<div class="welcome-section-header">${lucideIcon('bar-chart-3', 18, 'var(--accent)')} <span>${esc(t('welcome.stats'))}</span></div>`;
  html += `<div class="welcome-stats-grid">`;
  const stats = [
    { icon: 'list-checks', value: todosPending, label: t('welcome.todos_pending'), color: '#22c55e' },
    { icon: 'circle-check', value: todosDoneWeek, label: t('welcome.todos_done_week'), color: '#10b981' },
    { icon: 'brush', value: wChoreCompletionsWeek, label: t('welcome.chores_done_week'), color: '#ec4899' },
    { icon: 'book-open', value: wFlashcards.length, label: t('welcome.total_flashcards'), color: '#06b6d4' },
    { icon: 'shirt', value: wVestiaireCount, label: t('welcome.wardrobe_items'), color: '#8b5cf6' },
    { icon: 'layout-grid', value: wProjectCount, label: t('welcome.projects'), color: '#6366f1' },
  ];
  for (const s of stats) {
    html += `<div class="welcome-stat-card">`;
    html += `<div class="welcome-stat-icon">${lucideIcon(s.icon, 16, s.color)}</div>`;
    html += `<div class="welcome-stat-value">${s.value}</div>`;
    html += `<div class="welcome-stat-label">${esc(s.label)}</div>`;
    html += `</div>`;
  }
  html += `</div>`;
  html += `</div>`;

  container.innerHTML = html;

  // Init hover delay for focus TODO items (action buttons appear on hover/long-press)
  initWelcomeFocusHover();

  // Init hover delay for focus chore items (same behavior)
  initWelcomeFocusChoreHover();
}

export { refreshWelcome, renderWelcome };

// ── Go to Flashcards tab AND auto-start practice ──
function goToPractice() {
  window['_pendingPracticeStart'] = 1;
  if (typeof switchView === 'function') switchView('flashcards');
  else window.switchView('flashcards');
}
window.goToPractice = goToPractice;
