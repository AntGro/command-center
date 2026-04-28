// ===================================================================
// WELCOME / TODAY — Daily briefing dashboard
// ===================================================================
import { lucideIcon } from './icons.js';
import { t, getLang } from './i18n.js';
import state from './supabase.js';

// ── Local data cache ──
let wTodos = [];
let wChores = [];
let wChoreCompletionsWeek = 0;
let wFlashcards = [];
let wBirthdays = [];
let wProjectCount = 0;
let wVestiaireCount = 0;

// ── Helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

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
async function refreshWelcome() {
  if (!state.db.connected) return;
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
  const practicedToday = wFlashcards.some(c => c.last_review && startOfDay(new Date(c.last_review)).getTime() === todayStart.getTime());
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
    html += `<div class="welcome-items">`;
    for (const td of focusTodos) {
      const flagClass = td.priority === 'urgent' ? 'flag-urgent' : td.priority === 'high' ? 'flag-high' : '';
      const flagIcon = td.priority === 'urgent' ? lucideIcon('flag', 14, '#ef4444') : td.priority === 'high' ? lucideIcon('flag', 14, '#f97316') : '';
      let meta = '';
      if (td.due_date) {
        const dueDate = startOfDay(new Date(td.due_date));
        const diffDays = Math.round((todayStart - dueDate) / 86400000);
        if (diffDays === 0) meta = `<span class="welcome-due-today">${esc(t('welcome.due_today'))}</span>`;
        else if (diffDays === 1) meta = `<span class="welcome-overdue">${esc(t('welcome.overdue_1'))}</span>`;
        else if (diffDays > 1) meta = `<span class="welcome-overdue">${esc(t('welcome.overdue_n', diffDays))}</span>`;
      }
      html += `<div class="welcome-item" onclick="switchView('todos')">`;
      html += `<div class="welcome-item-main">`;
      if (flagIcon) html += `<span class="welcome-flag ${flagClass}">${flagIcon}</span>`;
      html += `<span class="welcome-item-text">${esc(td.text)}</span>`;
      if (td.category) html += `<span class="welcome-badge">${esc(td.category)}</span>`;
      html += `</div>`;
      if (meta) html += `<div class="welcome-item-meta">${meta}</div>`;
      html += `</div>`;
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
    html += `<div class="welcome-items">`;
    for (const ch of choresDue) {
      const dueDate = startOfDay(new Date(ch.next_due));
      const diffDays = Math.round((todayStart - dueDate) / 86400000);
      let label = '';
      if (diffDays === 0) label = t('welcome.due_today');
      else if (diffDays === 1) label = t('welcome.overdue_1');
      else label = t('welcome.overdue_n', diffDays);
      html += `<div class="welcome-item" onclick="switchView('chores')">`;
      html += `<div class="welcome-item-main">`;
      html += `<span class="welcome-item-text">${esc(ch.name)}</span>`;
      if (ch.category) html += `<span class="welcome-badge">${esc(ch.category)}</span>`;
      html += `</div>`;
      html += `<div class="welcome-item-meta"><span class="${diffDays > 0 ? 'welcome-overdue' : 'welcome-due-today'}">${esc(label)}</span></div>`;
      html += `</div>`;
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
    const todayCount = wFlashcards.filter(c => c.last_review && startOfDay(new Date(c.last_review)).getTime() === todayStart.getTime()).length;
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
}

export { refreshWelcome, renderWelcome };

// ── Go to Flashcards tab AND auto-start practice ──
function goToPractice() {
  window['_pendingPracticeStart'] = 1;
  if (typeof switchView === 'function') switchView('flashcards');
  else window.switchView('flashcards');
}
window.goToPractice = goToPractice;
