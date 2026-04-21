import { lucideIcon } from './icons.js';
import { t, getLang, setLang, nextLang } from './i18n.js';
import state, { IDEAS_KEY, THEME_KEY, CURRENT_VIEW_KEY, STAY_CONNECTED_KEY } from './supabase.js';
import { showToast, updateFooterStats, updateTaskListMaxHeight, isEditing } from './utils.js';
import { loadProjects, buildProjectCards, initProjectDragDrop, updateArchiveToggleBtn,
         renderArchivedProjects, refreshAll, loadPrompts } from './projects.js';
import { refreshTodos, renderTodos, getTodoCounts } from './todos.js';
import { refreshChores, renderChores } from './chores.js';
import { refreshBirthdays, renderBirthdays, initBirthdayModals } from './birthdays.js';
import { refreshVestiaire, renderVestiaire, initVestiaireModals } from './vestiaire.js';
import { refreshFlashcards, renderFlashcards, initFlashcardModals, getFlashcardCounts } from './flashcards.js';

// ===================================================================
// ICON HYDRATION — replace <span data-icon="..."> with SVGs from icons.js
// ===================================================================
function hydrateIcons() {
  document.querySelectorAll('[data-icon]').forEach(span => {
    const name = span.dataset.icon;
    const size = parseInt(span.dataset.size || '16');
    const color = span.dataset.color || undefined;
    span.outerHTML = lucideIcon(name, size, color);
  });
}
hydrateIcons();

// ===================================================================
// GATE LOGIC
// ===================================================================
function initGate() {
  // Check if "Stay connected" credentials exist in localStorage
  const saved = getStayConnectedCreds();
  if (saved) {
    // Show a brief connecting message, then auto-connect
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('loginError').textContent = t('toast.reconnecting');
    document.getElementById('username').value = saved.url;
    document.getElementById('password').value = saved.key;
    autoConnect(saved.url, saved.key);
    return;
  }
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('username').focus();
  // Try auto-fill from Credential Management API
  if (window.PasswordCredential) {
    navigator.credentials.get({ password: true, mediation: 'optional' }).then(cred => {
      if (cred) {
        document.getElementById('username').value = cred.id;
        document.getElementById('password').value = cred.password;
      }
    }).catch(() => {});
  }
}

async function autoConnect(url, key) {
  try {
    await connect(url, key);
  } catch (e) {
    // Stored credentials are stale — clear them and show the form
    clearStayConnectedCreds();
    document.getElementById('loginError').textContent = t('toast.session_expired');
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('username').focus();
  }
}

function getStayConnectedCreds() {
  try {
    const raw = localStorage.getItem(STAY_CONNECTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.url && parsed.key) return parsed;
    return null;
  } catch { return null; }
}

function saveStayConnectedCreds(url, key) {
  localStorage.setItem(STAY_CONNECTED_KEY, JSON.stringify({ url, key }));
}

function clearStayConnectedCreds() {
  localStorage.removeItem(STAY_CONNECTED_KEY);
}

function disconnect() {
  clearStayConnectedCreds();
  location.reload();
}

async function doLogin() {
  const url = document.getElementById('username').value.trim();
  const key = document.getElementById('password').value.trim();
  const stayConnected = document.getElementById('stayConnected').checked;
  const err = document.getElementById('loginError');
  if (!url || !key) { err.textContent = t('toast.enter_name'); return; }
  err.textContent = t('toast.connecting');
  try {
    await connect(url, key);
    err.textContent = '';
    // Save credentials if "Stay connected" is checked
    if (stayConnected) {
      saveStayConnectedCreds(url, key);
    }
    // Hide the form — signals "successful login" to Chrome's password manager
    document.getElementById('loginForm').style.display = 'none';
    // Also explicitly store via Credential Management API
    if (window.PasswordCredential) {
      try {
        const cred = new PasswordCredential({ id: url, password: key });
        await navigator.credentials.store(cred);
      } catch(e) {}
    }
  } catch (e) {
    err.textContent = t('toast.connection_failed');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initGate();
  document.getElementById('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    doLogin();
  });
});

// ===================================================================
// UNLOCK & INIT APP
// ===================================================================
async function connect(url, key) {
  state.sb = window.supabase.createClient(url, key);

  // Test connection with a simple query
  const { error } = await state.sb.from('projects').select('id').limit(1);
  if (error) throw new Error('Connection failed');

  document.getElementById('gate').style.display = 'none';
  document.getElementById('app').classList.add('active');

  // Set Supabase dashboard link
  const projectRef = url.replace('https://', '').replace('.supabase.co', '');
  document.getElementById('supabaseDashLink').href = `https://supabase.com/dashboard/project/${projectRef}`;

  await loadProjects();
  buildProjectCards();
  initProjectDragDrop();
  updateArchiveToggleBtn();
  renderArchivedProjects();
  await refreshAll();

  // Clean up any legacy localStorage ideas (one-time)
  localStorage.removeItem(IDEAS_KEY);

  // Realtime subscription
  state.sb.channel('tasks-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => { if (!isEditing()) { refreshAll().then(() => markLastUpdated()); } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, async () => { if (isEditing()) return; await loadProjects(); buildProjectCards(); initProjectDragDrop(); await refreshAll(); markLastUpdated(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'prompts' }, () => loadPrompts())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, () => { if (!isEditing()) { refreshTodos().then(() => markLastUpdated()); } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chores' }, () => refreshChores().then(() => markLastUpdated()))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chore_completions' }, () => refreshChores().then(() => markLastUpdated()))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'birthdays' }, () => refreshBirthdays().then(() => markLastUpdated()))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vestiaire' }, () => refreshVestiaire().then(() => markLastUpdated()))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flashcards' }, () => refreshFlashcards().then(() => markLastUpdated()))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flashcard_notes' }, () => refreshFlashcards().then(() => markLastUpdated()))
    .subscribe();

  // Initialize TODOs
  await refreshTodos();

  // Initialize Chores
  await refreshChores();

  // Initialize Birthdays
  initBirthdayModals();
  await refreshBirthdays();

  // Initialize Wardrobe
  initVestiaireModals();
  await refreshVestiaire();

  // Initialize Flashcards
  initFlashcardModals();
  await refreshFlashcards();

  markLastUpdated();

  // Restore last view — hash takes priority over localStorage
  const validViews = ['projects', 'todos', 'chores', 'birthdays', 'vestiaire', 'flashcards'];
  const rawHash = location.hash.replace('#', '');
  const hashView = validViews.includes(rawHash) ? rawHash : null;
  const savedView = hashView || localStorage.getItem(CURRENT_VIEW_KEY) || 'projects';
  switchView(savedView);

  // Listen for back/forward navigation
  window.addEventListener('hashchange', () => {
    const raw = location.hash.replace('#', '');
    const h = validViews.includes(raw) ? raw : 'projects';
    if (h !== state.currentView) switchView(h);
  });
}


// ===================================================================
// LANGUAGE TOGGLE
// ===================================================================
function applyLang() {
  // Highlight active language in dropdown
  const dropdown = document.getElementById('langDropdown');
  if (dropdown) {
    const lang = getLang();
    dropdown.querySelectorAll('.lang-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.lang === lang);
    });
  }
  updateStaticLabels();
}

function initLangPicker() {
  const picker = document.getElementById('langPicker');
  const toggle = document.getElementById('langToggle');
  const dropdown = document.getElementById('langDropdown');
  if (!picker || !toggle || !dropdown) return;

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    picker.classList.toggle('open');
  });

  dropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('.lang-option');
    if (!opt) return;
    const lang = opt.dataset.lang;
    if (lang && lang !== getLang()) {
      setLang(lang);
      applyLang();
      reRenderCurrentView();
    }
    picker.classList.remove('open');
  });

  // Close on outside click
  document.addEventListener('click', () => picker.classList.remove('open'));
  picker.addEventListener('click', (e) => e.stopPropagation());
}

function reRenderCurrentView() {
  const view = state.currentView;
  if (view === 'projects') refreshAll();
  else if (view === 'todos') renderTodos();
  else if (view === 'chores') renderChores();
  else if (view === 'birthdays') renderBirthdays();
  else if (view === 'vestiaire') renderVestiaire();
  else if (view === 'flashcards') renderFlashcards();
}

function updateStaticLabels() {
  // Nav tabs
  const tabLabels = { tabProjects: 'nav.projects', tabTodos: 'nav.todos', tabChores: 'nav.chores',
    tabBirthdays: 'nav.birthdays', tabVestiaire: 'nav.wardrobe', tabFlashcards: 'nav.flashcards' };
  for (const [id, key] of Object.entries(tabLabels)) {
    const el = document.getElementById(id);
    if (el) {
      // Keep the icon SVG, replace only text
      const svg = el.querySelector('svg');
      const svgHtml = svg ? svg.outerHTML : '';
      el.innerHTML = svgHtml + ' ' + t(key);
    }
  }
  // Login
  const urlInput = document.getElementById('username');
  const keyInput = document.getElementById('password');
  if (urlInput) urlInput.placeholder = t('login.url_placeholder');
  if (keyInput) keyInput.placeholder = t('login.key_placeholder');
  const stayLabel = document.querySelector('.stay-connected-label span');
  if (stayLabel) stayLabel.textContent = t('login.stay_connected');
  const connectBtn = document.querySelector('#loginForm button[type="submit"]');
  if (connectBtn) connectBtn.textContent = t('login.connect');
  // Search inputs
  const searchMap = {
    'projectsView': 'common.search',
    'todosView': 'common.search',
    'choresView': 'common.search',
    'birthdaysView': 'common.search',
    'vestiaireView': 'common.search',
    'flashcardsView': 'flashcards.search_placeholder',
  };
  for (const [viewId, key] of Object.entries(searchMap)) {
    const view = document.getElementById(viewId);
    if (view) {
      const input = view.querySelector('.page-search');
      if (input) input.placeholder = t(key) + '…';
    }
  }
  // Todo filters
  const todoFilterMap = { pending: 'todos.pending', done: 'todos.done', all: 'todos.all' };
  document.querySelectorAll('#todoFilters .filter-btn').forEach(btn => {
    const f = btn.dataset.filter;
    if (f === 'flagged') { const svg = btn.querySelector('svg'); btn.innerHTML = (svg ? svg.outerHTML : '') + ' ' + t('todos.flagged'); }
    else if (f === 'outdated') { const svg = btn.querySelector('svg'); btn.innerHTML = (svg ? svg.outerHTML : '') + ' ' + t('todos.outdated'); }
    else if (todoFilterMap[f]) btn.textContent = t(todoFilterMap[f]);
  });
  // Todo sort
  const todoSort = document.getElementById('todoSortBy');
  if (todoSort) {
    todoSort.options[0].text = t('todos.sort_manual');
    todoSort.options[1].text = t('todos.sort_due');
    todoSort.options[2].text = t('todos.sort_priority');
    todoSort.options[3].text = t('todos.sort_created');
  }
  // Chore filters
  const choreFilterMap = { all: 'chores.filter_all', overdue: 'chores.filter_overdue', 'due-soon': 'chores.filter_due_soon' };
  document.querySelectorAll('#choreFilters .filter-btn').forEach(btn => {
    const f = btn.dataset.filter;
    if (choreFilterMap[f]) btn.textContent = t(choreFilterMap[f]);
  });
  // Chore sort
  const choreSort = document.getElementById('choreSortBy');
  if (choreSort) {
    choreSort.options[0].text = t('chores.sort_due');
    choreSort.options[1].text = t('chores.sort_name');
    choreSort.options[2].text = t('chores.sort_last_done');
  }
  // Footer
  const dashLink = document.getElementById('supabaseDashLink');
  if (dashLink) dashLink.textContent = t('login.supabase_dashboard') + ' ↗';
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.innerHTML = lucideIcon('log-out', 16);
}

// Init lang on page load
(function() { applyLang(); initLangPicker(); })();


// ===================================================================
// THEME
// ===================================================================
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = theme === 'light' ? lucideIcon('sun', 16) : lucideIcon('moon', 16);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || getSystemTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// Init theme on page load
(function() {
  const stored = localStorage.getItem(THEME_KEY);
  applyTheme(stored || getSystemTheme());
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(getSystemTheme());
  });
})();


// ===================================================================
// VIEW SWITCHER (Projects / TODOs / Chores)
// ===================================================================
// currentView is in state

function switchView(view) {
  state.currentView = view;
  localStorage.setItem(CURRENT_VIEW_KEY, view);
  // Sync URL hash (no reload)
  const newHash = '#' + view;
  if (location.hash !== newHash) history.replaceState(null, '', newHash);
  const projectsView = document.getElementById('projectsView');
  const todosView = document.getElementById('todosView');
  const choresView = document.getElementById('choresView');
  const birthdaysView = document.getElementById('birthdaysView');
  const vestiaireView = document.getElementById('vestiaireView');
  const flashcardsView = document.getElementById('flashcardsView');
  const tabProjects = document.getElementById('tabProjects');
  const tabTodos = document.getElementById('tabTodos');
  const tabChores = document.getElementById('tabChores');
  const tabBirthdays = document.getElementById('tabBirthdays');
  const tabVestiaire = document.getElementById('tabVestiaire');
  const tabFlashcards = document.getElementById('tabFlashcards');

  // Hide all
  projectsView.style.display = 'none';
  todosView.style.display = 'none';
  if (choresView) choresView.style.display = 'none';
  if (birthdaysView) birthdaysView.style.display = 'none';
  if (vestiaireView) vestiaireView.style.display = 'none';
  if (flashcardsView) flashcardsView.style.display = 'none';
  tabProjects.classList.remove('active');
  tabTodos.classList.remove('active');
  if (tabChores) tabChores.classList.remove('active');
  if (tabBirthdays) tabBirthdays.classList.remove('active');
  if (tabVestiaire) tabVestiaire.classList.remove('active');
  if (tabFlashcards) tabFlashcards.classList.remove('active');

  if (view === 'projects') {
    projectsView.style.display = '';
    tabProjects.classList.add('active');
    refreshAll().then(() => markLastUpdated());
  } else if (view === 'todos') {
    todosView.style.display = '';
    tabTodos.classList.add('active');
    refreshTodos().then(() => { renderTodos(); markLastUpdated(); });
  } else if (view === 'chores') {
    if (choresView) choresView.style.display = '';
    if (tabChores) tabChores.classList.add('active');
    refreshChores().then(() => { renderChores(); markLastUpdated(); });
  } else if (view === 'birthdays') {
    if (birthdaysView) birthdaysView.style.display = '';
    if (tabBirthdays) tabBirthdays.classList.add('active');
    refreshBirthdays().then(() => { renderBirthdays(); markLastUpdated(); });
  } else if (view === 'vestiaire') {
    if (vestiaireView) vestiaireView.style.display = '';
    if (tabVestiaire) tabVestiaire.classList.add('active');
    refreshVestiaire().then(() => { renderVestiaire(); markLastUpdated(); });
  } else if (view === 'flashcards') {
    if (flashcardsView) flashcardsView.style.display = '';
    if (tabFlashcards) tabFlashcards.classList.add('active');
    refreshFlashcards().then(() => { renderFlashcards(); markLastUpdated(); });
  }

  // Scroll active tab into view on mobile (horizontal carousel)
  const activeTab = document.querySelector('.view-tab.active');
  if (activeTab) activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

// ===================================================================

// ===================================================================
// VIEW-AWARE FOOTER STATS
// ===================================================================
function updateViewFooterStats() {
  const view = state.currentView;
  const icon = (name, sz = 14) => lucideIcon(name, sz);
  const viewCountsMap = {
    projects: () => [
      `${icon('folder')} Projects: ${state.PROJECTS.length}`,
      `${icon('list-checks')} Tasks: ${state.allTasks.length}`,
    ],
    todos: () => {
      const c = getTodoCounts();
      return [
        `${icon('circle-dot')} Pending: ${c.pending}`,
        `${icon('circle-check')} Done: ${c.done}`,
      ];
    },
    chores: () => {
      const overdue = state.allChores.filter(c => c.next_due && new Date(c.next_due) < new Date()).length;
      return [
        `${icon('repeat')} Chores: ${state.allChores.length}`,
        `${icon('alert-triangle')} Overdue: ${overdue}`,
      ];
    },
    birthdays: () => [
      `${icon('cake')} Birthdays: ${state.allBirthdays.length}`,
    ],
    vestiaire: () => [
      `${icon('shirt')} Items: ${state.allVestiaire.length}`,
    ],
    flashcards: () => {
      const c = getFlashcardCounts();
      return [
        `${icon('book-open')} Cards: ${c.cards}`,
        `${icon('file-text')} Drafts: ${c.drafts}`,
      ];
    },
  };
  updateFooterStats(viewCountsMap[view] || null);
}

// ===================================================================
// LAST UPDATED LABEL
// ===================================================================
let _lastUpdatedAt = null;
let _lastUpdatedTimer = null;

function markLastUpdated() {
  _lastUpdatedAt = Date.now();
  renderLastUpdated();
  updateViewFooterStats();
  if (!_lastUpdatedTimer) {
    _lastUpdatedTimer = setInterval(renderLastUpdated, 60000);
  }
}

function renderLastUpdated() {
  const el = document.getElementById('lastUpdatedLabel');
  if (!el || !_lastUpdatedAt) return;
  const secs = Math.round((Date.now() - _lastUpdatedAt) / 1000);
  let label;
  if (secs < 5) label = 'just now';
  else if (secs < 60) label = `${secs}s ago`;
  else if (secs < 3600) label = `${Math.floor(secs / 60)}m ago`;
  else label = `${Math.floor(secs / 3600)}h ago`;
  el.textContent = `Updated ${label}`;
}


window.switchView = switchView;
window.toggleTheme = toggleTheme;
window.disconnect = disconnect;
