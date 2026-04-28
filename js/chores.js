import { lucideIcon } from './icons.js';
import state, { CHORE_CATEGORIES_KEY } from './supabase.js';
import { esc, showToast, showDeleteConfirm } from './utils.js';
import { initItemHoverDelay, scrollToAndHighlight, inlineEditText } from './item-utils.js';
import { getCategoryColor } from './todos.js';
import { t } from './i18n.js';

// ===================================================================
// CHORES — DATA, CRUD & RENDERING
// ===================================================================
// (state managed in supabase.js)
// (state managed in supabase.js)
let choreFilter = 'all';
let choreSearchQuery = '';
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
// NEXT_DUE — structured rules computed client-side, custom rules by heartbeat
// ===================================================================
// Structured frequency_rule formats:
//   daily, every_N_days:X, weekly:Mon,Wed,Fri, every_N_weeks:2:Mon,
//   monthly:1, monthly_weekday:first:Mon, every_N_months:3:1, yearly:MM-DD
// Custom (free-text) rules → next_due = null → heartbeat handles them.

const STRUCTURED_PREFIXES = ['daily', 'every_N_days:', 'weekly:', 'every_N_weeks:', 'monthly:', 'monthly_weekday:', 'every_N_months:', 'yearly:'];
const DOW_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW_JS   = [1, 2, 3, 4, 5, 6, 0]; // JS getDay(): Sun=0

function isStructuredRule(rule) {
  if (!rule) return false;
  return STRUCTURED_PREFIXES.some(p => rule === p.replace(/:$/, '') || rule.startsWith(p));
}

function computeNextDue(frequencyRule, lastDoneDate) {
  if (!frequencyRule || !isStructuredRule(frequencyRule)) return null;
  const base = lastDoneDate ? new Date(lastDoneDate) : new Date();
  const baseDay = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const today = new Date(); today.setHours(0,0,0,0);

  if (frequencyRule === 'daily') {
    const next = new Date(baseDay); next.setDate(next.getDate() + 1);
    return next < today ? today.toISOString().slice(0,10) : next.toISOString().slice(0,10);
  }

  if (frequencyRule.startsWith('every_N_days:')) {
    const n = parseInt(frequencyRule.split(':')[1], 10) || 1;
    const next = new Date(baseDay); next.setDate(next.getDate() + n);
    return next < today ? today.toISOString().slice(0,10) : next.toISOString().slice(0,10);
  }

  if (frequencyRule.startsWith('weekly:')) {
    const days = frequencyRule.split(':')[1].split(',');
    const dayIndices = days.map(d => DOW_JS[DOW_KEYS.indexOf(d)]).filter(d => d !== undefined);
    if (dayIndices.length === 0) return null;
    // Find next occurrence after base
    for (let offset = 1; offset <= 7; offset++) {
      const candidate = new Date(baseDay); candidate.setDate(candidate.getDate() + offset);
      if (dayIndices.includes(candidate.getDay())) {
        return candidate < today ? today.toISOString().slice(0,10) : candidate.toISOString().slice(0,10);
      }
    }
    return null;
  }

  if (frequencyRule.startsWith('every_N_weeks:')) {
    const parts = frequencyRule.split(':');
    const n = parseInt(parts[1], 10) || 1;
    const days = (parts[2] || '').split(',');
    const dayIndices = days.map(d => DOW_JS[DOW_KEYS.indexOf(d)]).filter(d => d !== undefined);
    if (dayIndices.length === 0) return null;
    const next = new Date(baseDay); next.setDate(next.getDate() + n * 7);
    // Find the first matching day in that week
    const weekStart = new Date(next);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + (weekStart.getDay() === 0 ? -6 : 1)); // Monday
    for (let offset = 0; offset < 7; offset++) {
      const candidate = new Date(weekStart); candidate.setDate(candidate.getDate() + offset);
      if (dayIndices.includes(candidate.getDay()) && candidate > baseDay) {
        return candidate < today ? today.toISOString().slice(0,10) : candidate.toISOString().slice(0,10);
      }
    }
    return null;
  }

  if (frequencyRule.startsWith('monthly:')) {
    const dom = parseInt(frequencyRule.split(':')[1], 10);
    if (!dom || dom < 1 || dom > 31) return null;
    let next = new Date(baseDay.getFullYear(), baseDay.getMonth(), dom);
    if (next <= baseDay) next = new Date(baseDay.getFullYear(), baseDay.getMonth() + 1, dom);
    return next < today ? today.toISOString().slice(0,10) : next.toISOString().slice(0,10);
  }

  if (frequencyRule.startsWith('monthly_weekday:')) {
    const parts = frequencyRule.split(':');
    const position = parts[1]; // 'first' or 'last'
    const dayName = parts[2];
    const dayIdx = DOW_JS[DOW_KEYS.indexOf(dayName)];
    if (dayIdx === undefined) return null;
    function findNthWeekday(year, month, targetDay, pos) {
      if (pos === 'first') {
        const d = new Date(year, month, 1);
        while (d.getDay() !== targetDay) d.setDate(d.getDate() + 1);
        return d;
      } else {
        const d = new Date(year, month + 1, 0); // last day
        while (d.getDay() !== targetDay) d.setDate(d.getDate() - 1);
        return d;
      }
    }
    let next = findNthWeekday(baseDay.getFullYear(), baseDay.getMonth(), dayIdx, position);
    if (next <= baseDay) next = findNthWeekday(baseDay.getFullYear(), baseDay.getMonth() + 1, dayIdx, position);
    return next < today ? today.toISOString().slice(0,10) : next.toISOString().slice(0,10);
  }

  if (frequencyRule.startsWith('every_N_months:')) {
    const parts = frequencyRule.split(':');
    const n = parseInt(parts[1], 10) || 1;
    const dom = parseInt(parts[2], 10) || 1;
    let next = new Date(baseDay.getFullYear(), baseDay.getMonth() + n, dom);
    return next < today ? today.toISOString().slice(0,10) : next.toISOString().slice(0,10);
  }

  if (frequencyRule.startsWith('yearly:')) {
    const mmdd = frequencyRule.split(':')[1];
    const [mm, dd] = mmdd.split('-').map(Number);
    if (!mm || !dd) return null;
    let next = new Date(baseDay.getFullYear(), mm - 1, dd);
    if (next <= baseDay) next = new Date(baseDay.getFullYear() + 1, mm - 1, dd);
    return next < today ? today.toISOString().slice(0,10) : next.toISOString().slice(0,10);
  }

  return null;
}

function formatFrequency(rule) {
  if (!rule) return '';
  if (!isStructuredRule(rule)) return rule; // legacy free-text: show as-is

  if (rule === 'daily') return t('chores.freq_display_daily');

  if (rule.startsWith('every_N_days:')) {
    const n = rule.split(':')[1];
    return t('chores.freq_display_every_n_days', n);
  }

  if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1].split(',');
    const dayLabels = days.map(d => t('chores.day_' + d.toLowerCase()));
    return t('chores.freq_display_weekly', dayLabels.join(', '));
  }

  if (rule.startsWith('every_N_weeks:')) {
    const parts = rule.split(':');
    const n = parts[1];
    const days = (parts[2] || '').split(',');
    const dayLabels = days.map(d => t('chores.day_' + d.toLowerCase()));
    return t('chores.freq_display_every_n_weeks', n, dayLabels.join(', '));
  }

  if (rule.startsWith('monthly:')) {
    const dom = rule.split(':')[1];
    return t('chores.freq_display_monthly', ordinalSuffix(parseInt(dom, 10)));
  }

  if (rule.startsWith('monthly_weekday:')) {
    const parts = rule.split(':');
    const pos = t('chores.freq_' + parts[1]);
    const dayLabel = t('chores.day_' + parts[2].toLowerCase());
    return t('chores.freq_display_monthly_weekday', pos, dayLabel);
  }

  if (rule.startsWith('every_N_months:')) {
    const parts = rule.split(':');
    return t('chores.freq_display_every_n_months', parts[1], ordinalSuffix(parseInt(parts[2], 10)));
  }

  if (rule.startsWith('yearly:')) {
    const mmdd = rule.split(':')[1];
    const [mm, dd] = mmdd.split('-').map(Number);
    const d = new Date(2000, mm - 1, dd);
    return t('chores.freq_display_yearly', d.toLocaleDateString([], { month: 'long', day: 'numeric' }));
  }

  return rule;
}

function ordinalSuffix(n) {
  if (!n) return '';
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function updateChoreNextDue(choreId, frequencyRule, lastDoneDate) {
  if (isStructuredRule(frequencyRule)) {
    const nextDue = computeNextDue(frequencyRule, lastDoneDate);
    const { error } = await state.db.from('chores').update({ next_due: nextDue }).eq('id', choreId);
    if (error) console.warn('Failed to update next_due:', error.message);
  } else {
    await clearChoreNextDue(choreId);
  }
}

async function clearChoreNextDue(choreId) {
  const { error } = await state.db.from('chores').update({ next_due: null }).eq('id', choreId);
  if (error) console.warn('Failed to clear next_due:', error.message);
}

// ===================================================================
// FREQUENCY PICKER — shared UI builder for add/edit/inline
// ===================================================================
const FREQ_TYPES = [
  'daily', 'every_N_days', 'weekly', 'every_N_weeks',
  'monthly', 'monthly_weekday', 'every_N_months', 'yearly', 'custom'
];

function buildFrequencyPicker(container, currentRule) {
  container.innerHTML = '';
  container.className = (container.className.replace(/\bfreq-picker\b/, '') + ' freq-picker').trim();

  // Detect current type from rule
  let currentType = 'custom';
  let parsed = {};
  if (currentRule) {
    if (currentRule === 'daily') { currentType = 'daily'; }
    else if (currentRule.startsWith('every_N_days:')) { currentType = 'every_N_days'; parsed.n = currentRule.split(':')[1]; }
    else if (currentRule.startsWith('weekly:')) { currentType = 'weekly'; parsed.days = currentRule.split(':')[1].split(','); }
    else if (currentRule.startsWith('every_N_weeks:')) { currentType = 'every_N_weeks'; const p = currentRule.split(':'); parsed.n = p[1]; parsed.days = (p[2]||'').split(','); }
    else if (currentRule.startsWith('monthly:')) { currentType = 'monthly'; parsed.dom = currentRule.split(':')[1]; }
    else if (currentRule.startsWith('monthly_weekday:')) { currentType = 'monthly_weekday'; const p = currentRule.split(':'); parsed.position = p[1]; parsed.day = p[2]; }
    else if (currentRule.startsWith('every_N_months:')) { currentType = 'every_N_months'; const p = currentRule.split(':'); parsed.n = p[1]; parsed.dom = p[2]; }
    else if (currentRule.startsWith('yearly:')) { currentType = 'yearly'; parsed.mmdd = currentRule.split(':')[1]; }
    else { currentType = 'custom'; parsed.text = currentRule; }
  }

  // Type selector
  const sel = document.createElement('select');
  sel.className = 'inline-edit-input freq-type-select';
  FREQ_TYPES.forEach(ft => {
    const opt = document.createElement('option');
    opt.value = ft;
    opt.textContent = t('chores.freq_' + ft);
    if (ft === currentType) opt.selected = true;
    sel.appendChild(opt);
  });
  container.appendChild(sel);

  // Options container
  const opts = document.createElement('div');
  opts.className = 'freq-options';
  container.appendChild(opts);

  function renderOptions() {
    opts.innerHTML = '';
    const type = sel.value;

    if (type === 'every_N_days') {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '2'; inp.max = '365'; inp.className = 'inline-edit-input freq-n-input';
      inp.value = parsed.n || '2';
      inp.dataset.freqField = 'n';
      const label = document.createElement('span'); label.className = 'freq-option-label'; label.textContent = t('chores.freq_n_label');
      opts.appendChild(label); opts.appendChild(inp);
    }

    if (type === 'weekly' || type === 'every_N_weeks') {
      if (type === 'every_N_weeks') {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '2'; inp.max = '52'; inp.className = 'inline-edit-input freq-n-input';
        inp.value = parsed.n || '2';
        inp.dataset.freqField = 'n';
        const label = document.createElement('span'); label.className = 'freq-option-label'; label.textContent = t('chores.freq_n_label');
        opts.appendChild(label); opts.appendChild(inp);
      }
      const dayBar = document.createElement('div'); dayBar.className = 'freq-day-bar';
      DOW_KEYS.forEach(d => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'freq-day-btn';
        btn.textContent = t('chores.day_' + d.toLowerCase());
        btn.dataset.day = d;
        if (parsed.days && parsed.days.includes(d)) btn.classList.add('active');
        btn.addEventListener('click', () => btn.classList.toggle('active'));
        dayBar.appendChild(btn);
      });
      opts.appendChild(dayBar);
    }

    if (type === 'monthly' || type === 'every_N_months') {
      if (type === 'every_N_months') {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '2'; inp.max = '12'; inp.className = 'inline-edit-input freq-n-input';
        inp.value = parsed.n || '2';
        inp.dataset.freqField = 'n';
        const label = document.createElement('span'); label.className = 'freq-option-label'; label.textContent = t('chores.freq_n_label');
        opts.appendChild(label); opts.appendChild(inp);
      }
      const domSel = document.createElement('select'); domSel.className = 'inline-edit-input freq-dom-select';
      domSel.dataset.freqField = 'dom';
      for (let i = 1; i <= 31; i++) {
        const opt = document.createElement('option'); opt.value = i; opt.textContent = ordinalSuffix(i);
        if (String(i) === String(parsed.dom || '1')) opt.selected = true;
        domSel.appendChild(opt);
      }
      const domLabel = document.createElement('span'); domLabel.className = 'freq-option-label'; domLabel.textContent = t('chores.freq_day_of_month');
      opts.appendChild(domLabel); opts.appendChild(domSel);
    }

    if (type === 'monthly_weekday') {
      const posSel = document.createElement('select'); posSel.className = 'inline-edit-input freq-pos-select';
      posSel.dataset.freqField = 'position';
      ['first', 'last'].forEach(p => {
        const opt = document.createElement('option'); opt.value = p; opt.textContent = t('chores.freq_' + p);
        if (p === (parsed.position || 'first')) opt.selected = true;
        posSel.appendChild(opt);
      });
      opts.appendChild(posSel);

      const daySel = document.createElement('select'); daySel.className = 'inline-edit-input freq-weekday-select';
      daySel.dataset.freqField = 'day';
      DOW_KEYS.forEach(d => {
        const opt = document.createElement('option'); opt.value = d; opt.textContent = t('chores.day_' + d.toLowerCase());
        if (d === (parsed.day || 'Mon')) opt.selected = true;
        daySel.appendChild(opt);
      });
      opts.appendChild(daySel);
    }

    if (type === 'yearly') {
      const mSel = document.createElement('select'); mSel.className = 'inline-edit-input freq-month-select';
      mSel.dataset.freqField = 'month';
      for (let i = 1; i <= 12; i++) {
        const opt = document.createElement('option'); opt.value = String(i).padStart(2, '0');
        opt.textContent = new Date(2000, i - 1, 1).toLocaleString([], { month: 'long' });
        const curM = parsed.mmdd ? parsed.mmdd.split('-')[0] : '01';
        if (String(i).padStart(2, '0') === curM) opt.selected = true;
        mSel.appendChild(opt);
      }
      opts.appendChild(mSel);

      const dSel = document.createElement('select'); dSel.className = 'inline-edit-input freq-dom-select';
      dSel.dataset.freqField = 'yearday';
      for (let i = 1; i <= 31; i++) {
        const opt = document.createElement('option'); opt.value = String(i).padStart(2, '0'); opt.textContent = String(i);
        const curD = parsed.mmdd ? parsed.mmdd.split('-')[1] : '01';
        if (String(i).padStart(2, '0') === curD) opt.selected = true;
        dSel.appendChild(opt);
      }
      opts.appendChild(dSel);
    }

    if (type === 'custom') {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'inline-edit-input freq-custom-input';
      inp.value = parsed.text || '';
      inp.dataset.freqField = 'text';
      inp.placeholder = 'e.g. "every other weekend"';
      inp.maxLength = 300;
      opts.appendChild(inp);
    }
  }

  sel.addEventListener('change', () => { parsed = {}; renderOptions(); });
  renderOptions();
  return container;
}

function getFrequencyFromPicker(container) {
  const sel = container.querySelector('.freq-type-select');
  if (!sel) return container.querySelector('input')?.value?.trim() || '';
  const type = sel.value;
  const opts = container.querySelector('.freq-options');

  if (type === 'daily') return 'daily';

  if (type === 'every_N_days') {
    const n = opts.querySelector('[data-freq-field="n"]')?.value || '2';
    return 'every_N_days:' + n;
  }

  if (type === 'weekly') {
    const days = Array.from(opts.querySelectorAll('.freq-day-btn.active')).map(b => b.dataset.day);
    return days.length ? 'weekly:' + days.join(',') : '';
  }

  if (type === 'every_N_weeks') {
    const n = opts.querySelector('[data-freq-field="n"]')?.value || '2';
    const days = Array.from(opts.querySelectorAll('.freq-day-btn.active')).map(b => b.dataset.day);
    return days.length ? 'every_N_weeks:' + n + ':' + days.join(',') : '';
  }

  if (type === 'monthly') {
    const dom = opts.querySelector('[data-freq-field="dom"]')?.value || '1';
    return 'monthly:' + dom;
  }

  if (type === 'monthly_weekday') {
    const pos = opts.querySelector('[data-freq-field="position"]')?.value || 'first';
    const day = opts.querySelector('[data-freq-field="day"]')?.value || 'Mon';
    return 'monthly_weekday:' + pos + ':' + day;
  }

  if (type === 'every_N_months') {
    const n = opts.querySelector('[data-freq-field="n"]')?.value || '2';
    const dom = opts.querySelector('[data-freq-field="dom"]')?.value || '1';
    return 'every_N_months:' + n + ':' + dom;
  }

  if (type === 'yearly') {
    const m = opts.querySelector('[data-freq-field="month"]')?.value || '01';
    const d = opts.querySelector('[data-freq-field="yearday"]')?.value || '01';
    return 'yearly:' + m + '-' + d;
  }

  if (type === 'custom') {
    return opts.querySelector('[data-freq-field="text"]')?.value?.trim() || '';
  }

  return '';
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
  if (!state.db.connected) return;
  const { data: chores, error: chErr } = await state.db.from('chores').select('*').order('created_at', { ascending: true });
  if (chErr) {
    if (chErr.code === '42P01' || chErr.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  state.allChores = chores || [];

  const { data: completions, error: compErr } = await state.db.from('chore_completions').select('*').order('completed_at', { ascending: false });
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
  if (!chore.next_due) return `<span class="chore-due no-date">${t('chores.awaiting_schedule')}</span>`;
  const due = new Date(chore.next_due);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay - todayStart) / (1000 * 60 * 60 * 24));
  const status = choreDueStatus(chore);

  const dateStr = due.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (status === 'overdue') return `<span class="chore-due overdue">${lucideIcon('alert-triangle', 14)} ${t('chores.overdue')} (${dateStr}, ${t('chores.days_ago', Math.abs(diffDays))})</span>`;
  if (status === 'due-today') return `<span class="chore-due due-today">${lucideIcon("bell",16)} ${t('chores.due_today')}</span>`;
  if (status === 'due-tomorrow') return `<span class="chore-due due-today">${lucideIcon("calendar",16)} ${t('chores.tomorrow')} (${dateStr})</span>`;
  if (status === 'due-soon') return `<span class="chore-due due-soon">${lucideIcon("calendar",16)} ${dateStr} (${t('chores.in_days', diffDays)})</span>`;
  return `<span class="chore-due on-track">${lucideIcon("circle-check",16)} ${dateStr} (${t('chores.in_days', diffDays)})</span>`;
}

function getFilteredChoresForCategory(category) {
  let filtered = state.allChores.filter(c => (c.category || 'General') === (category || 'General'));

  // Apply search filter
  if (choreSearchQuery) {
    const q = choreSearchQuery.toLowerCase();
    filtered = filtered.filter(c =>
      (c.name && c.name.toLowerCase().includes(q)) ||
      ((c.category || '').toLowerCase().includes(q))
    );
  }

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
    onDblClick: (item) => {
      const id = item.dataset.choreId;
      if (id) editChoreInline(id);
    },
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
  const statsText = `${totalInCat} chore${totalInCat !== 1 ? 's' : ''}` + (overdueCount > 0 ? ` · <span style="color:var(--red)">${overdueCount} ${t('chores.overdue').toLowerCase()}</span>` : '');

  const deleteBtn = !isGeneral
    ? `<button class="todo-cat-delete-btn" onclick="deleteChoreCategory('${esc(catName).replace(/'/g, "\\'")}')" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>`
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
        <button class="todo-cat-shortname-btn" onclick="promptChoreShortname('${escapedCat}')" title="${getChoreShortname(catName) ? t('common.edit') : t('common.edit')}">${lucideIcon("pencil",14)}</button>
        ${deleteBtn}
      </div>
    </div>
    <div class="todo-cat-add">
      <input type="text" placeholder="${t('chores.quick_add_placeholder')}" maxlength="200" class="todo-cat-input chore-add-input" data-category="${esc(catName)}" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addChoreFromInput(this);}">
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
  const dueHtml = isDraft ? `<span class="chore-due draft">${lucideIcon("file-text",16)} ${t('chores.draft')}</span>` : formatChoreDue(chore);

  const lastDoneStr = lastDone
    ? `${t('chores.last_done')}: ${lastDone.toLocaleDateString([], { month: 'short', day: 'numeric' })} (${formatChoreRelative(lastDone)})`
    : 'Never done';

  const promoteBtn = isDraft ? `<button onclick="promoteChore('${chore.id}')" title="${t('chores.promote')}" class="chore-promote-btn">▶ ${t('chores.promote')}</button>` : '';

  return `<div class="bucket-item chore-item chore-status-${status}" data-chore-id="${chore.id}">
    <div class="chore-row">
      <div class="chore-info">
        <span class="chore-name">${esc(chore.name)}</span>
        <span class="chore-frequency">${esc(formatFrequency(chore.frequency_rule))}</span>
      </div>
      <div class="chore-actions">
        ${promoteBtn}
        ${!isDraft ? `<button onclick="markChoreDone('${chore.id}')" title="${t('chores.mark_done')}" class="chore-done-btn">${lucideIcon("circle-check",16)}</button>` : ''}
        <button onclick="openChoreHistory('${chore.id}')" title="${t('chores.chore_history')} (${completionCount})" class="chore-history-btn">${lucideIcon("clipboard-list",16)} ${completionCount}</button>
        <button onclick="openEditChoreModal('${chore.id}')" title="${t('common.edit')}">${lucideIcon("pencil",16)}</button>
        <button onclick="deleteChore('${chore.id}')" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>
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
  if (diffDays === 0) return t('chores.today');
  if (diffDays === 1) return t('chores.yesterday');
  if (diffDays < 7) return t('chores.days_ago', diffDays);
  if (diffDays < 30) return t('chores.weeks_ago', Math.floor(diffDays / 7));
  return t('chores.months_ago', Math.floor(diffDays / 30));
}

// ===================================================================
// CHORE CRUD
// ===================================================================
function initChoreModals() {
  const app = document.getElementById('app');

  // Add Chore Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay'; m1.id = 'addChoreModal';
  m1.innerHTML = `<div class="modal"><h2>` + lucideIcon("brush",20) + ` ${t('chores.add_chore')}</h2><label>${t('common.name')}</label><input type="text" id="newChoreName" placeholder="${t('chores.chore_placeholder')}" maxlength="200" onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewChore();}"><label>${t('chores.frequency_rule_label')}</label><div id="newChoreFreqPicker"></div><label>${t('common.category')}</label><select id="newChoreCategory"></select><label>${t('chores.last_done_optional')}</label><input type="date" id="newChoreLastDone"><label class="chore-draft-toggle"><input type="checkbox" id="newChoreDraft"><span>Save as draft (won\'t show due dates until promoted)</span></label><div class="modal-actions"><button class="modal-cancel" onclick="closeAddChoreModal()">${t('common.cancel')}</button><button class="modal-save" onclick="saveNewChore()">Create</button></div></div>`;
  app.appendChild(m1);

  // Edit Chore Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay'; m2.id = 'editChoreModal';
  m2.innerHTML = `<div class="modal"><h2>` + lucideIcon("pencil",20) + ` ${t('chores.edit_chore')}</h2><input type="hidden" id="editChoreId"><label>${t('common.name')}</label><input type="text" id="editChoreName" maxlength="200"><label>${t('chores.frequency_rule')}</label><div id="editChoreFreqPicker"></div><label>${t('common.category')}</label><select id="editChoreCategory"></select><div class="modal-actions"><button class="modal-cancel" onclick="closeEditChoreModal()">${t('common.cancel')}</button><button class="modal-save" onclick="saveEditChore()">${t('common.save')}</button></div></div>`;
  app.appendChild(m2);

  // Chore History Modal
  const m3 = document.createElement('div');
  m3.className = 'modal-overlay'; m3.id = 'choreHistoryModal';
  m3.innerHTML = `<div class="modal chore-history-modal"><h2>` + lucideIcon("clipboard-list",20) + ` ${t('chores.chore_history')}</h2><p id="choreHistoryName" style="font-size:0.88rem;color:var(--muted);margin-bottom:12px;"></p><div id="choreHistoryList"></div><div class="modal-actions"><button class="modal-cancel" onclick="closeChoreHistoryModal()">${t('common.close')}</button></div></div>`;
  app.appendChild(m3);

  // Add Chore Category Modal
  const m5 = document.createElement('div');
  m5.className = 'modal-overlay'; m5.id = 'addChoreCategoryModal';
  m5.innerHTML = `<div class="modal"><h2>` + lucideIcon("folder-plus",20) + ` ${t('chores.add_category')}</h2><label>${t('chores.category_name')}</label><input type="text" id="newChoreCategoryName" placeholder="${t('chores.category_placeholder')}" maxlength="40" onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewChoreCategory();}"><div class="modal-actions"><button class="modal-cancel" onclick="closeAddChoreCategoryModal()">${t('common.cancel')}</button><button class="modal-save" onclick="saveNewChoreCategory()">Create</button></div></div>`;
  app.appendChild(m5);
}

function openAddChoreModal() {
  document.getElementById('newChoreName').value = '';
  document.getElementById('newChoreLastDone').value = '';
  document.getElementById('newChoreDraft').checked = false;
  buildFrequencyPicker(document.getElementById('newChoreFreqPicker'), '');
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
  document.getElementById('newChoreLastDone').value = '';
  document.getElementById('newChoreDraft').checked = false;
  buildFrequencyPicker(document.getElementById('newChoreFreqPicker'), '');
  populateChoreCategorySelect('newChoreCategory');
  document.getElementById('newChoreCategory').value = category;
  document.getElementById('addChoreModal').classList.add('visible');
  inputEl.value = '';
  setTimeout(() => document.getElementById('newChoreFreqPicker').querySelector('select')?.focus(), 100);
}

async function saveNewChore() {
  const name = document.getElementById('newChoreName').value.trim();
  const freq = getFrequencyFromPicker(document.getElementById('newChoreFreqPicker'));
  const cat = document.getElementById('newChoreCategory').value || 'General';
  const lastDoneVal = document.getElementById('newChoreLastDone').value;
  const isDraft = document.getElementById('newChoreDraft').checked;

  if (!name) { showToast(t('chores.enter_chore_name'), 'error'); return; }
  if (!freq) { showToast(t('chores.enter_frequency'), 'error'); return; }

  const { data, error } = await state.db.from('chores').insert({ name, frequency_rule: freq, category: cat, is_draft: isDraft }).select().single();
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

  // If lastDone was provided, create an initial completion
  if (lastDoneVal && data && data.id) {
    await state.db.from('chore_completions').insert({ chore_id: data.id, completed_at: new Date(lastDoneVal).toISOString() });
  }
  // Compute next_due client-side for structured rules, else delegate to heartbeat
  if (data && data.id) {
    await updateChoreNextDue(data.id, freq, lastDoneVal || null);
  }

  closeAddChoreModal();
  showToast(t('chores.chore_added', name), 'success');
  await refreshChores();
}

function editChoreInline(choreId) {
  const chore = state.allChores.find(c => c.id === choreId);
  if (!chore) return;
  const nameEl = document.querySelector(`.chore-item[data-chore-id="${choreId}"] .chore-name`);
  if (!nameEl) return;

  // Hide actions while editing
  const actionsEl = nameEl.closest('.chore-item')?.querySelector('.chore-actions');
  if (actionsEl) actionsEl.classList.remove('visible');

  // Build extra fields
  const extras = document.createElement('div');
  extras.className = 'inline-edit-extras';

  // Frequency picker row
  const freqRow = document.createElement('div');
  freqRow.className = 'inline-edit-row inline-edit-row-freq';
  const freqLabel = document.createElement('label');
  freqLabel.className = 'inline-edit-label';
  freqLabel.textContent = t('chores.frequency_rule');
  const freqContainer = document.createElement('div');
  freqContainer.className = 'freq-picker-inline';
  buildFrequencyPicker(freqContainer, chore.frequency_rule || '');
  freqRow.appendChild(freqLabel);
  freqRow.appendChild(freqContainer);

  // Category row
  const catRow = document.createElement('div');
  catRow.className = 'inline-edit-row';
  const catLabel = document.createElement('label');
  catLabel.className = 'inline-edit-label';
  catLabel.textContent = t('common.category');
  const catSelect = document.createElement('select');
  catSelect.className = 'inline-edit-input';
  const cats = ['General', ...getChoreCategories()];
  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    if (c === (chore.category || 'General')) opt.selected = true;
    catSelect.appendChild(opt);
  });
  catRow.appendChild(catLabel);
  catRow.appendChild(catSelect);

  extras.appendChild(freqRow);
  extras.appendChild(catRow);

  inlineEditText(nameEl, chore.name, {
    maxLength: 200,
    extraEl: extras,
    collectExtra: () => ({
      frequency_rule: getFrequencyFromPicker(freqContainer),
      category: catSelect.value || 'General',
    }),
    saveFn: async (newName, extra) => {
      const updates = {};
      if (newName !== chore.name) updates.name = newName;
      if (extra) {
        if (extra.frequency_rule && extra.frequency_rule !== chore.frequency_rule) updates.frequency_rule = extra.frequency_rule;
        if (extra.category !== (chore.category || 'General')) updates.category = extra.category;
      }
      if (Object.keys(updates).length > 0) {
        const { error } = await state.db.from('chores').update(updates).eq('id', choreId);
        if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
        if (updates.frequency_rule) {
          const lastDone = getChoreLastDone(choreId);
          await updateChoreNextDue(choreId, updates.frequency_rule, lastDone);
        }
        showToast(t('chores.chore_updated'), 'success');
      }
    },
    refreshFn: renderChores,
  });
}

function openEditChoreModal(choreId) {
  const chore = state.allChores.find(c => c.id === choreId);
  if (!chore) return;
  document.getElementById('editChoreId').value = choreId;
  document.getElementById('editChoreName').value = chore.name;
  buildFrequencyPicker(document.getElementById('editChoreFreqPicker'), chore.frequency_rule);
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
  const freq = getFrequencyFromPicker(document.getElementById('editChoreFreqPicker'));
  const cat = document.getElementById('editChoreCategory').value || 'General';

  if (!name) { showToast(t('chores.enter_chore_name'), 'error'); return; }
  if (!freq) { showToast(t('chores.enter_frequency'), 'error'); return; }

  const { error } = await state.db.from('chores').update({ name, frequency_rule: freq, category: cat }).eq('id', id);
  if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }

  // Compute next_due client-side for structured rules, else delegate to heartbeat
  const lastDone = getChoreLastDone(id);
  await updateChoreNextDue(id, freq, lastDone);

  closeEditChoreModal();
  showToast(t('chores.chore_updated'), 'success');
  await refreshChores();
}

async function deleteChore(choreId) {
  const chore = state.allChores.find(c => c.id === choreId);
  if (!chore) return;
  showDeleteConfirm(
    t('common.delete'),
    `Delete "${chore.name}"? All completion history will be lost.`,
    async () => {
      const { error } = await state.db.from('chores').delete().eq('id', choreId);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('chores.chore_deleted'), 'info');
      await refreshChores();
    }
  );
}

async function promoteChore(choreId) {
  const { error } = await state.db.from('chores').update({ is_draft: false }).eq('id', choreId);
  if (error) { showToast(t('chores.failed_promote'), 'error'); return; }
  showToast(t('chores.chore_activated'), 'success');
  await refreshChores();
}


// ===================================================================
// CHORE DONE FLOW
// ===================================================================
async function markChoreDone(choreId) {
  if (!choreId) return;
  const chore = state.allChores.find(c => c.id === choreId);
  const now = new Date().toISOString();

  const row = { chore_id: choreId, completed_at: now };

  const { error } = await state.db.from('chore_completions').insert(row);
  if (error) { showToast(t('chores.failed_record'), 'error'); return; }

  // Compute next_due for structured rules, delegate to heartbeat for custom
  if (chore) {
    await updateChoreNextDue(choreId, chore.frequency_rule, now);
  } else {
    await clearChoreNextDue(choreId);
  }

  showToast(t('chores.chore_done'), 'success');
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
  document.getElementById('choreHistoryName').innerHTML = `${lucideIcon("brush",16)} ${chore.name} — ${formatFrequency(chore.frequency_rule)}`;

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
          <button onclick="editChoreCompletion('${comp.id}')" title="${t('common.edit')}" class="chore-hist-btn">${lucideIcon("pencil",14,"#f59e0b")}</button>
          <button onclick="deleteChoreCompletion('${comp.id}')" title="${t('common.delete')}" class="chore-hist-btn">${lucideIcon("trash-2",14,"#ef4444")}</button>
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
    t('common.delete'),
    'Are you sure you want to delete this completion record?',
    async () => {
      const { error } = await state.db.from('chore_completions').delete().eq('id', compId);
      if (error) { showToast(t('toast.failed_to_delete'), 'error'); return; }
      showToast(t('chores.completion_deleted'), 'success');
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
      <label>${t('chores.edit_date')}</label>
      <input type="date" id="editCompDate_${compId}" value="${dateVal}">
      <label>${t('chores.edit_note')}</label>
      <input type="text" id="editCompNote_${compId}" value="${esc(noteVal)}" placeholder="${t('chores.note_optional')}" maxlength="500">
      <div class="chore-history-edit-actions">
        <button onclick="saveChoreCompletion('${compId}')" class="modal-save">${t('common.save')}</button>
        <button onclick="cancelEditCompletion()" class="modal-cancel">${t('common.cancel')}</button>
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

  const { error } = await state.db.from('chore_completions').update(updates).eq('id', compId);
  if (error) { showToast(t('toast.failed_to_update'), 'error'); return; }
  showToast(t('chores.completion_updated'), 'success');
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
  if (!name) { showToast(t('chores.enter_chore_name'), 'error'); return; }
  const cats = getChoreCategories();
  if (cats.some(c => c.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === 'general') {
    showToast(t('chores.category_exists'), 'error'); return;
  }
  cats.push(name);
  saveChoreCategories(cats);
  closeAddChoreCategoryModal();
  showToast(t('chores.category_created', name), 'success');
  renderChores();
}

async function deleteChoreCategory(name) {
  const choresInCat = state.allChores.filter(c => (c.category || 'General') === name);
  const msg = choresInCat.length > 0
    ? `Delete "${name}"? Its ${choresInCat.length} chore(s) will move to General.`
    : `Delete empty category "${name}"?`;

  showDeleteConfirm(t('common.delete'), msg, async () => {
    for (const c of choresInCat) {
      await state.db.from('chores').update({ category: 'General' }).eq('id', c.id);
    }
    const cats = getChoreCategories();
    const idx = cats.findIndex(c => c === name);
    if (idx !== -1) { cats.splice(idx, 1); saveChoreCategories(cats); }
    showToast(t('chores.category_deleted', name), 'info');
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
window.markChoreDone = markChoreDone;
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
window.filterChores = function(e) { choreSearchQuery = e.target.value; renderChores(); };
