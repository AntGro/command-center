import { lucideIcon } from './icons.js';
import { t, getLang, setLang, nextLang } from './i18n.js';
import state, { IDEAS_KEY, THEME_KEY, CURRENT_VIEW_KEY, STAY_CONNECTED_KEY, TAB_VISIBILITY_KEY } from './supabase.js';
import db from './db.js';
import { createSupabaseAdapter } from './adapters/supabase.js';
import { VERSION, REPO_URL } from './version.js';
import { esc, showToast, updateFooterStats, updateTaskListMaxHeight, isEditing } from './utils.js';
import { loadProjects, buildProjectCards, initProjectDragDrop, updateArchiveToggleBtn,
         renderArchivedProjects, refreshAll, loadPrompts } from './projects.js';
import { refreshTodos, renderTodos, getTodoCounts } from './todos.js';
import { refreshChores, renderChores } from './chores.js';
import { refreshBirthdays, renderBirthdays, initBirthdayModals } from './birthdays.js';
import { refreshVestiaire, renderVestiaire, initVestiaireModals } from './vestiaire.js';
import { refreshFlashcards, renderFlashcards, initFlashcardModals, getFlashcardCounts } from './flashcards.js';
import { refreshWelcome, renderWelcome } from './welcome.js';

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
  state.supabaseUrl = url;
  state.supabaseKey = key;
  const adapter = createSupabaseAdapter(url, key);
  db.setAdapter(adapter);

  // Test connection with a simple query
  const { error } = await state.db.from('projects').select('id').limit(1);
  if (error) throw new Error('Connection failed');

  document.getElementById('gate').style.display = 'none';
  document.getElementById('app').classList.add('active');

  // Set Supabase dashboard link
  const projectRef = url.replace('https://', '').replace('.supabase.co', '');
  document.getElementById('supabaseDashLink').href = `https://supabase.com/dashboard/project/${projectRef}`;

  // Set version
  const versionEl = document.getElementById('footerVersion');
  if (versionEl) versionEl.innerHTML = `version: <a href="${REPO_URL}/commit/${VERSION}" target="_blank">${VERSION}</a>`;

  await loadProjects();
  buildProjectCards();
  initProjectDragDrop();
  updateArchiveToggleBtn();
  renderArchivedProjects();
  await refreshAll();

  // Load user settings from DB
  await loadSettings();

  // Clean up any legacy localStorage ideas (one-time)
  localStorage.removeItem(IDEAS_KEY);

  // Realtime subscription
  state.db.channel('tasks-realtime')
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

  // Apply tab visibility
  applyTabVisibility();

  // Restore last view — hash takes priority over localStorage
  const validViews = ['welcome', 'projects', 'todos', 'chores', 'birthdays', 'vestiaire', 'flashcards'];
  const rawHash = location.hash.replace('#', '');
  const hashView = validViews.includes(rawHash) ? rawHash : null;
  let savedView = hashView || localStorage.getItem(CURRENT_VIEW_KEY) || 'welcome';
  // If saved view is hidden, fall back to first visible tab
  if (!isTabVisible(savedView)) {
    const firstVisible = getVisibleTabs()[0];
    savedView = firstVisible ? firstVisible.key : 'welcome';
  }
  switchView(savedView);

  // Listen for back/forward navigation
  window.addEventListener('hashchange', () => {
    const raw = location.hash.replace('#', '');
    const h = validViews.includes(raw) ? raw : 'welcome';
    if (h !== state.currentView) switchView(h);
  });
}


// ===================================================================
// HEADER MENU (3-dot dropdown)
// ===================================================================
function applyLang() {
  // Highlight active language in menu
  const lang = getLang();
  document.querySelectorAll('.header-menu-lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  updateStaticLabels();
}

function initHeaderMenu() {
  const menu = document.getElementById('headerMenu');
  const toggle = document.getElementById('headerMenuToggle');
  const dropdown = document.getElementById('headerMenuDropdown');
  if (!menu || !toggle || !dropdown) return;

  // Toggle dropdown
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
    // Update theme icon/label when opening
    if (menu.classList.contains('open')) updateMenuThemeItem();
  });

  // Language buttons
  dropdown.querySelectorAll('.header-menu-lang-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lang = btn.dataset.lang;
      if (lang && lang !== getLang()) {
        setLang(lang);
        applyLang();
        reRenderCurrentView();
      }
    });
  });

  // Theme toggle
  document.getElementById('menuThemeToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTheme();
    updateMenuThemeItem();
  });

  // Settings
  document.getElementById('menuSettings').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.remove('open');
    openSettings();
  });

  // Disconnect
  document.getElementById('menuDisconnect').addEventListener('click', () => {
    disconnect();
  });

  // Close on outside click
  document.addEventListener('click', () => menu.classList.remove('open'));
  menu.addEventListener('click', (e) => e.stopPropagation());
}

function updateMenuThemeItem() {
  const current = document.documentElement.getAttribute('data-theme') || getSystemTheme();
  const iconEl = document.getElementById('menuThemeIcon');
  if (iconEl) iconEl.innerHTML = current === 'light' ? lucideIcon('sun', 16) : lucideIcon('moon', 16);
}

function reRenderCurrentView() {
  const view = state.currentView;
  if (view === 'welcome') renderWelcome();
  else if (view === 'projects') refreshAll();
  else if (view === 'todos') renderTodos();
  else if (view === 'chores') renderChores();
  else if (view === 'birthdays') renderBirthdays();
  else if (view === 'vestiaire') renderVestiaire();
  else if (view === 'flashcards') renderFlashcards();
}

function updateStaticLabels() {
  // Nav tabs
  const tabLabels = { tabWelcome: 'nav.today', tabProjects: 'nav.projects', tabTodos: 'nav.todos', tabChores: 'nav.chores',
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
      const toggle = view.querySelector('.search-toggle');
      if (toggle) toggle.title = t('common.search');
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
  // Header menu labels
  const menuLangLabel = document.getElementById('menuLangLabel');
  if (menuLangLabel) menuLangLabel.textContent = t('menu.language');
  const menuThemeLabel = document.getElementById('menuThemeLabel');
  if (menuThemeLabel) menuThemeLabel.textContent = t('menu.toggle_theme');
  const menuSettingsLabel = document.getElementById('menuSettingsLabel');
  if (menuSettingsLabel) menuSettingsLabel.textContent = t('menu.settings');
  const menuDisconnectLabel = document.getElementById('menuDisconnectLabel');
  if (menuDisconnectLabel) menuDisconnectLabel.textContent = t('menu.disconnect');
  // Settings modal
  const settingsTitle = document.getElementById('settingsTitle');
  if (settingsTitle) settingsTitle.textContent = t('menu.settings_title');
  const settingsNavGeneral = document.getElementById('settingsNavGeneral');
  if (settingsNavGeneral) settingsNavGeneral.textContent = t('menu.settings_general');
  const settingsNavAi = document.getElementById('settingsNavAi');
  if (settingsNavAi) settingsNavAi.textContent = t('menu.settings_ai');
  const settingsPaneGeneralTitle = document.getElementById('settingsPaneGeneralTitle');
  if (settingsPaneGeneralTitle) settingsPaneGeneralTitle.textContent = t('menu.settings_general');
  const settingsPaneAiTitle = document.getElementById('settingsPaneAiTitle');
  if (settingsPaneAiTitle) settingsPaneAiTitle.textContent = t('menu.settings_ai');
  const settingsTabsLabel = document.getElementById('settingsTabsLabel');
  if (settingsTabsLabel) settingsTabsLabel.textContent = t('menu.settings_tabs');
  const settingsTabsHint = document.getElementById('settingsTabsHint');
  if (settingsTabsHint) settingsTabsHint.textContent = t('menu.settings_tabs_hint');
  const settingsNvidiaKeyLabel = document.getElementById('settingsNvidiaKeyLabel');
  if (settingsNvidiaKeyLabel) settingsNvidiaKeyLabel.textContent = t('menu.settings_nvidia_key');
  const settingsNvidiaKeyHint = document.getElementById('settingsNvidiaKeyHint');
  if (settingsNvidiaKeyHint) settingsNvidiaKeyHint.textContent = t('menu.settings_nvidia_key_hint');
  const settingsNvidiaModelLabel = document.getElementById('settingsNvidiaModelLabel');
  if (settingsNvidiaModelLabel) settingsNvidiaModelLabel.textContent = t('menu.settings_model');
  const settingsTestLabel = document.getElementById('settingsTestLabel');
  if (settingsTestLabel) settingsTestLabel.textContent = t('menu.settings_test');
  const settingsTestBtnLabel = document.getElementById('settingsTestBtnLabel');
  if (settingsTestBtnLabel) settingsTestBtnLabel.textContent = t('menu.settings_test_btn');
  const settingsUsageLabel = document.getElementById('settingsUsageLabel');
  if (settingsUsageLabel) settingsUsageLabel.textContent = t('menu.settings_usage_label');
  const nvidiaUsageToggleLabel = document.getElementById('nvidiaUsageToggleLabel');
  if (nvidiaUsageToggleLabel) nvidiaUsageToggleLabel.textContent = t('menu.settings_usage_by_model');
}

// Init lang and header menu on page load
(function() { applyLang(); initHeaderMenu(); })();

// Auto-collapse title when tabs overflow
(function() {
  const header = document.querySelector('.app-header');
  const switcher = document.querySelector('.view-switcher');
  if (!header || !switcher) return;
  function checkOverflow() {
    // First, uncollapse to measure natural width
    header.classList.remove('title-collapsed');
    // Force layout
    void switcher.scrollWidth;
    if (switcher.scrollWidth > switcher.clientWidth + 1) {
      header.classList.add('title-collapsed');
    }
  }
  const ro = new ResizeObserver(checkOverflow);
  ro.observe(switcher);
  // Also re-check when tabs are toggled (DOM mutations)
  const mo = new MutationObserver(checkOverflow);
  mo.observe(switcher, { childList: true, subtree: true, attributes: true });
  checkOverflow();
})();


// ===================================================================
// THEME
// ===================================================================
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  updateMenuThemeItem();
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
// TAB VISIBILITY
// ===================================================================
const ALL_TABS = [
  { key: 'welcome', tabId: 'tabWelcome', icon: 'home', color: '#3b82f6', labelKey: 'nav.today' },
  { key: 'projects', tabId: 'tabProjects', icon: 'layout-grid', color: '#6366f1', labelKey: 'nav.projects' },
  { key: 'todos', tabId: 'tabTodos', icon: 'list-checks', color: '#22c55e', labelKey: 'nav.todos' },
  { key: 'chores', tabId: 'tabChores', icon: 'brush', color: '#ec4899', labelKey: 'nav.chores' },
  { key: 'birthdays', tabId: 'tabBirthdays', icon: 'cake', color: '#f97316', labelKey: 'nav.birthdays' },
  { key: 'vestiaire', tabId: 'tabVestiaire', icon: 'shirt', color: '#8b5cf6', labelKey: 'nav.wardrobe' },
  { key: 'flashcards', tabId: 'tabFlashcards', icon: 'book-open', color: '#06b6d4', labelKey: 'nav.flashcards' },
];

function getTabVisibility() {
  try {
    const raw = localStorage.getItem(TAB_VISIBILITY_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveTabVisibility(vis) {
  localStorage.setItem(TAB_VISIBILITY_KEY, JSON.stringify(vis));
}

function isTabVisible(key) {
  const vis = getTabVisibility();
  if (!vis) return true; // all visible by default
  return vis[key] !== false;
}

function applyTabVisibility() {
  const vis = getTabVisibility();
  ALL_TABS.forEach(tab => {
    const el = document.getElementById(tab.tabId);
    if (el) {
      const visible = !vis || vis[tab.key] !== false;
      el.style.display = visible ? '' : 'none';
    }
  });
}

function getVisibleTabs() {
  return ALL_TABS.filter(t => isTabVisible(t.key));
}

// ── Settings Modal ──
let _tabConfigState = {};

function openSettings() {
  const vis = getTabVisibility() || {};
  _tabConfigState = {};
  ALL_TABS.forEach(tab => {
    _tabConfigState[tab.key] = vis[tab.key] !== false;
  });
  renderTabConfigList();
  // Populate NVIDIA key field
  const inp = document.getElementById('settingsNvidiaKey');
  if (inp) {
    inp.value = state.nvidiaApiKey || '';
    inp.type = 'password';
  }
  // Reset visibility toggle icon
  const toggleBtn = document.getElementById('settingsToggleVis');
  if (toggleBtn) toggleBtn.innerHTML = `<span data-icon="eye" data-size="16"></span>`;
  // Reset to first pane
  switchSettingsPane('general');
  hydrateIcons();
  document.getElementById('settingsModal').classList.add('visible');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('visible');
}

function switchSettingsPane(paneKey) {
  document.querySelectorAll('.settings-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pane === paneKey);
  });
  document.querySelectorAll('.settings-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `settingsPane-${paneKey}`);
  });
  if (paneKey === 'ai') { populateNvidiaModels(); loadNvidiaUsage(); }
}

function renderTabConfigList() {
  const list = document.getElementById('tabConfigList');
  if (!list) return;
  list.innerHTML = ALL_TABS.map(tab => {
    const locked = tab.key === 'welcome';
    const checked = locked || _tabConfigState[tab.key] ? 'checked' : '';
    const lockedClass = locked ? ' locked' : '';
    return `<div class="tab-config-item ${checked}${lockedClass}" data-tab-key="${tab.key}"${locked ? '' : ` onclick="toggleTabConfigItem('${tab.key}')"`}>
      <span class="tab-config-icon">${lucideIcon(tab.icon, 18, tab.color)}</span>
      <span class="tab-config-label">${t(tab.labelKey)}</span>
      <span class="tab-config-toggle"></span>
    </div>`;
  }).join('');
}

function toggleTabConfigItem(key) {
  if (key === 'welcome') return;
  _tabConfigState[key] = !_tabConfigState[key];
  // Ensure at least one tab remains visible (besides Today which is always on)
  const anyVisible = Object.values(_tabConfigState).some(v => v);
  if (!anyVisible) {
    _tabConfigState[key] = true;
    showToast(t('menu.settings_tabs_hint'));
    return;
  }
  renderTabConfigList();
  // Apply immediately
  saveTabVisibility(_tabConfigState);
  applyTabVisibility();
  if (!_tabConfigState[state.currentView]) {
    const firstVisible = ALL_TABS.find(t => _tabConfigState[t.key]);
    if (firstVisible) switchView(firstVisible.key);
  }
}

// ── AI Settings ──

async function loadSettings() {
  try {
    const { data, error } = await state.db.from('settings').select('key,value');
    if (error) { console.warn('Settings table not available:', error.message); return; }
    if (data) {
      for (const row of data) {
        if (row.key === 'nvidia_api_key') state.nvidiaApiKey = row.value || null;
        if (row.key === 'nvidia_model') state.nvidiaModel = row.value || 'meta/llama-3.1-8b-instruct';
      }
    }
  } catch (e) { console.warn('Could not load settings:', e.message); }
}

async function saveNvidiaKey() {
  const inp = document.getElementById('settingsNvidiaKey');
  if (!inp) return;
  const val = inp.value.trim();
  try {
    if (val) {
      // Upsert: try update first, then insert if no rows affected
      const { data, error: upErr } = await state.db.from('settings')
        .update({ value: val, updated_at: new Date().toISOString() })
        .eq('key', 'nvidia_api_key')
        .select();
      if (upErr) throw upErr;
      if (!data || data.length === 0) {
        const { error: insErr } = await state.db.from('settings')
          .insert({ key: 'nvidia_api_key', value: val, updated_at: new Date().toISOString() });
        if (insErr) throw insErr;
      }
      state.nvidiaApiKey = val;
    } else {
      // Delete the key
      await state.db.from('settings').delete().eq('key', 'nvidia_api_key');
      state.nvidiaApiKey = null;
    }
    showToast(t('menu.settings_key_saved'));
  } catch (e) {
    console.error('Failed to save API key:', e);
    showToast(t('menu.settings_key_error'));
  }
}

function toggleNvidiaKeyVisibility() {
  const inp = document.getElementById('settingsNvidiaKey');
  const btn = document.getElementById('settingsToggleVis');
  if (!inp || !btn) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.innerHTML = `<span data-icon="${show ? 'eye-off' : 'eye'}" data-size="16"></span>`;
  hydrateIcons();
}

async function saveNvidiaModel() {
  const sel = document.getElementById('settingsNvidiaModel');
  if (!sel) return;
  const val = sel.value;
  try {
    const { data } = await state.db.from('settings')
      .update({ value: val, updated_at: new Date().toISOString() })
      .eq('key', 'nvidia_model').select();
    if (!data || data.length === 0) {
      await state.db.from('settings')
        .insert({ key: 'nvidia_model', value: val, updated_at: new Date().toISOString() });
    }
    state.nvidiaModel = val;
  } catch (e) { console.error('Failed to save model:', e); }
}

const NVIDIA_POPULAR_MODELS = [
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-4-maverick-17b-128e-instruct',
  'mistralai/mistral-large-2-instruct',
  'google/gemma-3-27b-it',
  'deepseek-ai/deepseek-v3.2',
  'nvidia/llama-3.1-nemotron-70b-instruct',
];

function renderModelSelect(models, selectedModel) {
  const sel = document.getElementById('settingsNvidiaModel');
  if (!sel) return;

  const popular = models.filter(id => NVIDIA_POPULAR_MODELS.includes(id));
  const others = models.filter(id => !NVIDIA_POPULAR_MODELS.includes(id));
  const customInList = selectedModel && !models.includes(selectedModel);

  let html = '';
  if (popular.length) {
    html += `<optgroup label="Popular">`;
    html += popular.map(id =>
      `<option value="${esc(id)}"${id === selectedModel ? ' selected' : ''}>${esc(id)}</option>`
    ).join('');
    html += `</optgroup>`;
  }
  if (others.length) {
    html += `<optgroup label="All">`;
    html += others.map(id =>
      `<option value="${esc(id)}"${id === selectedModel ? ' selected' : ''}>${esc(id)}</option>`
    ).join('');
    html += `</optgroup>`;
  }
  if (customInList) {
    html += `<optgroup label="Custom">`;
    html += `<option value="${esc(selectedModel)}" selected>${esc(selectedModel)}</option>`;
    html += `</optgroup>`;
  }
  html += `<option value="__custom">${t('menu.settings_model_custom')}</option>`;
  sel.innerHTML = html;
}

function populateNvidiaModels() {
  const sel = document.getElementById('settingsNvidiaModel');
  if (!sel) return;
  // Render hardcoded fallback first, then fetch live list
  renderModelSelect(NVIDIA_POPULAR_MODELS, state.nvidiaModel);
  fetchNvidiaModelsRpc();
}

async function fetchNvidiaModelsRpc() {
  try {
    const { data, error } = await state.db.rpc('nvidia_list_models');
    if (error || !data?.data) return;
    const chatModels = data.data
      .map(m => m.id)
      .filter(id => /instruct|chat|-it$/i.test(id) && !/guard|safety|embed|retriever/i.test(id))
      .sort((a, b) => {
        const ai = NVIDIA_POPULAR_MODELS.includes(a) ? 0 : 1;
        const bi = NVIDIA_POPULAR_MODELS.includes(b) ? 0 : 1;
        return ai - bi || a.localeCompare(b);
      });
    if (chatModels.length) renderModelSelect(chatModels, state.nvidiaModel);
  } catch (e) { console.warn('Could not fetch NVIDIA models:', e.message); }
}

function handleModelChange() {
  const sel = document.getElementById('settingsNvidiaModel');
  const customRow = document.getElementById('settingsCustomModelRow');
  if (!sel) return;
  if (sel.value === '__custom') {
    if (customRow) customRow.style.display = '';
    document.getElementById('settingsCustomModel')?.focus();
  } else {
    if (customRow) customRow.style.display = 'none';
    saveNvidiaModel();
  }
}

function applyCustomModel() {
  const input = document.getElementById('settingsCustomModel');
  const val = input?.value?.trim();
  if (!val) return;
  state.nvidiaModel = val;
  // Re-render with custom value selected, then save
  const sel = document.getElementById('settingsNvidiaModel');
  const opts = Array.from(sel?.options || []).map(o => o.value).filter(v => v !== '__custom');
  if (!opts.includes(val)) {
    renderModelSelect(opts, val);
  }
  saveNvidiaModel();
  const customRow = document.getElementById('settingsCustomModelRow');
  if (customRow) customRow.style.display = 'none';
}

let _nvidiaAbort = null;

async function testNvidiaApi() {
  const apiKey = state.nvidiaApiKey || document.getElementById('settingsNvidiaKey')?.value?.trim();
  const model = document.getElementById('settingsNvidiaModel')?.value;
  const prompt = document.getElementById('settingsTestPrompt')?.value?.trim();
  const resultEl = document.getElementById('settingsTestResult');
  const btn = document.getElementById('settingsTestBtn');
  if (!resultEl || !btn) return;
  if (!apiKey) {
    resultEl.style.display = 'block';
    resultEl.className = 'settings-test-result error';
    resultEl.textContent = t('menu.settings_test_no_key');
    return;
  }
  if (!prompt) return;

  // If already running, abort
  if (_nvidiaAbort) {
    _nvidiaAbort.abort();
    _nvidiaAbort = null;
    btn.textContent = t('menu.settings_test_btn');
    btn.disabled = false;
    resultEl.className = 'settings-test-result error';
    resultEl.textContent = t('menu.settings_test_cancelled');
    return;
  }

  _nvidiaAbort = new AbortController();
  btn.textContent = t('menu.settings_test_stop');
  btn.disabled = false;
  resultEl.style.display = 'block';
  resultEl.className = 'settings-test-result';
  resultEl.textContent = '';
  try {
    const fetchOpts = (stream) => ({
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.supabaseKey}`,
        'apikey': state.supabaseKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_api_key: apiKey, p_model: model, p_prompt: prompt, p_stream: stream }),
      signal: _nvidiaAbort.signal,
    });

    let res = await fetch(`${state.supabaseUrl}/functions/v1/nvidia-chat`, fetchOpts(true));

    // SSE streaming
    if (res.ok && res.headers.get('content-type')?.includes('text/event-stream')) {
      resultEl.className = 'settings-test-result success';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) { text += delta; resultEl.textContent = text; }
            } catch (_) {}
          }
        }
      }
      if (!text) resultEl.textContent = '(empty response)';
      loadNvidiaUsage();
      return;
    }

    // Stream failed (model doesn't support it) — retry without streaming
    if (!res.ok) {
      res = await fetch(`${state.supabaseUrl}/functions/v1/nvidia-chat`, fetchOpts(false));
    }

    // Non-streaming JSON response
    const data = await res.json();
    const status = data?.status;
    const body = data?.body;
    if (status && status >= 400) {
      resultEl.className = 'settings-test-result error';
      resultEl.textContent = body?.detail || body?.error?.message || `HTTP ${status}`;
    } else {
      resultEl.className = 'settings-test-result success';
      resultEl.textContent = body?.choices?.[0]?.message?.content || JSON.stringify(body);
    }
    loadNvidiaUsage();
  } catch (e) {
    if (e.name === 'AbortError') {
      resultEl.className = 'settings-test-result error';
      resultEl.textContent = t('menu.settings_test_cancelled');
    } else {
      resultEl.className = 'settings-test-result error';
      resultEl.textContent = e.message;
    }
  } finally {
    _nvidiaAbort = null;
    btn.textContent = t('menu.settings_test_btn');
    btn.disabled = false;
  }
}

window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.switchSettingsPane = switchSettingsPane;
window.toggleTabConfigItem = toggleTabConfigItem;
window.toggleNvidiaKeyVisibility = toggleNvidiaKeyVisibility;
window.saveNvidiaKey = saveNvidiaKey;
window.saveNvidiaModel = saveNvidiaModel;
window.handleModelChange = handleModelChange;
window.applyCustomModel = applyCustomModel;
window.testNvidiaApi = testNvidiaApi;
window.toggleNvidiaUsageDetail = toggleNvidiaUsageDetail;

// ── AI Usage Stats ──

async function loadNvidiaUsage() {
  const container = document.getElementById('nvidiaUsageStats');
  const toggleBtn = document.getElementById('nvidiaUsageToggle');
  const detailEl = document.getElementById('nvidiaUsageDetail');
  if (!container) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await state.db.from('nvidia_usage')
    .select('model,prompt_tokens,completion_tokens,total_tokens,status,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (error || !data || data.length === 0) {
    container.innerHTML = `<span class="nvidia-usage-empty">${t('menu.settings_usage_empty')}</span>`;
    if (toggleBtn) toggleBtn.style.display = 'none';
    if (detailEl) detailEl.style.display = 'none';
    return;
  }

  const totals = { requests: data.length, prompt: 0, completion: 0, total: 0 };
  const byModel = {};
  for (const row of data) {
    totals.prompt += row.prompt_tokens || 0;
    totals.completion += row.completion_tokens || 0;
    totals.total += row.total_tokens || 0;
    const m = row.model || 'unknown';
    if (!byModel[m]) byModel[m] = { requests: 0, prompt: 0, completion: 0, total: 0 };
    byModel[m].requests++;
    byModel[m].prompt += row.prompt_tokens || 0;
    byModel[m].completion += row.completion_tokens || 0;
    byModel[m].total += row.total_tokens || 0;
  }

  container.innerHTML = renderUsageRow(totals);

  const models = Object.keys(byModel).sort((a, b) => byModel[b].total - byModel[a].total);
  if (models.length > 1) {
    if (toggleBtn) toggleBtn.style.display = '';
    if (detailEl) {
      detailEl.innerHTML = models.map(m =>
        `<div class="nvidia-usage-model"><span class="nvidia-usage-model-name">${esc(m)}</span>${renderUsageRow(byModel[m])}</div>`
      ).join('');
    }
  } else if (models.length === 1) {
    if (toggleBtn) toggleBtn.style.display = '';
    if (detailEl) {
      detailEl.innerHTML = `<div class="nvidia-usage-model"><span class="nvidia-usage-model-name">${esc(models[0])}</span></div>`;
    }
  } else {
    if (toggleBtn) toggleBtn.style.display = 'none';
  }
}

function renderUsageRow(s) {
  return `<div class="nvidia-usage-grid">
    <div class="nvidia-usage-cell"><span class="nvidia-usage-val">${s.requests}</span><span class="nvidia-usage-lbl">${t('menu.settings_usage_requests')}</span></div>
    <div class="nvidia-usage-cell"><span class="nvidia-usage-val">${s.prompt.toLocaleString()}</span><span class="nvidia-usage-lbl">${t('menu.settings_usage_prompt')}</span></div>
    <div class="nvidia-usage-cell"><span class="nvidia-usage-val">${s.completion.toLocaleString()}</span><span class="nvidia-usage-lbl">${t('menu.settings_usage_completion')}</span></div>
    <div class="nvidia-usage-cell"><span class="nvidia-usage-val">${s.total.toLocaleString()}</span><span class="nvidia-usage-lbl">${t('menu.settings_usage_total')}</span></div>
  </div>`;
}

function toggleNvidiaUsageDetail() {
  const detailEl = document.getElementById('nvidiaUsageDetail');
  const toggleBtn = document.getElementById('nvidiaUsageToggle');
  if (!detailEl) return;
  const open = detailEl.style.display !== 'none';
  detailEl.style.display = open ? 'none' : '';
  if (toggleBtn) toggleBtn.classList.toggle('open', !open);
}

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
  const welcomeView = document.getElementById('welcomeView');
  const projectsView = document.getElementById('projectsView');
  const todosView = document.getElementById('todosView');
  const choresView = document.getElementById('choresView');
  const birthdaysView = document.getElementById('birthdaysView');
  const vestiaireView = document.getElementById('vestiaireView');
  const flashcardsView = document.getElementById('flashcardsView');
  const tabWelcome = document.getElementById('tabWelcome');
  const tabProjects = document.getElementById('tabProjects');
  const tabTodos = document.getElementById('tabTodos');
  const tabChores = document.getElementById('tabChores');
  const tabBirthdays = document.getElementById('tabBirthdays');
  const tabVestiaire = document.getElementById('tabVestiaire');
  const tabFlashcards = document.getElementById('tabFlashcards');

  // Hide all
  if (welcomeView) welcomeView.style.display = 'none';
  projectsView.style.display = 'none';
  todosView.style.display = 'none';
  if (choresView) choresView.style.display = 'none';
  if (birthdaysView) birthdaysView.style.display = 'none';
  if (vestiaireView) vestiaireView.style.display = 'none';
  if (flashcardsView) flashcardsView.style.display = 'none';
  if (tabWelcome) tabWelcome.classList.remove('active');
  tabProjects.classList.remove('active');
  tabTodos.classList.remove('active');
  if (tabChores) tabChores.classList.remove('active');
  if (tabBirthdays) tabBirthdays.classList.remove('active');
  if (tabVestiaire) tabVestiaire.classList.remove('active');
  if (tabFlashcards) tabFlashcards.classList.remove('active');

  if (view === 'welcome') {
    if (welcomeView) welcomeView.style.display = '';
    if (tabWelcome) tabWelcome.classList.add('active');
    refreshWelcome().then(() => { renderWelcome(); markLastUpdated(); });
  } else if (view === 'projects') {
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
    refreshFlashcards().then(() => { renderFlashcards(); markLastUpdated(); if (window._pendingPracticeStart) { delete window._pendingPracticeStart; if (typeof window.startPractice === 'function') window.startPractice('__all'); } });
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
    welcome: () => [
      `${icon('home')} ${t('nav.today')}`,
    ],
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

// ===================================================================
// SEARCH TOGGLE — collapsible search input
// ===================================================================
function toggleSearch(btn) {
  const wrapper = btn.closest('.search-wrapper');
  wrapper.classList.add('expanded');
  const input = wrapper.querySelector('.page-search');
  input.focus();
  if (!input.dataset.searchBlur) {
    input.dataset.searchBlur = '1';
    input.addEventListener('blur', function() {
      if (!input.value.trim()) {
        wrapper.classList.remove('expanded');
        input.value = '';
        input.dispatchEvent(new Event('input'));
      }
    });
  }
}

window.switchView = switchView;
window.toggleTheme = toggleTheme;
window.disconnect = disconnect;
window.toggleSearch = toggleSearch;
