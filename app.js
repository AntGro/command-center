// ===================================================================
// CONSTANTS
// ===================================================================
const IDEAS_KEY = 'claw_cc_ideas'; // legacy localStorage key (cleanup only)
const THEME_KEY = 'claw_cc_theme';
const ARCHIVED_PROJECTS_KEY = 'claw_cc_archived_projects';
const SHOW_ARCHIVED_KEY = 'claw_cc_show_archived';
const CURRENT_VIEW_KEY = 'claw_cc_current_view';
const STAY_CONNECTED_KEY = 'claw_cc_stay_connected';
const MAX_TEXT_LEN = 5000;
const MAX_META_DISPLAY = 500;

// ===================================================================
// GATE LOGIC — simple URL + key, Chrome autofill handles persistence
// ===================================================================
function initGate() {
  // Check if "Stay connected" credentials exist in localStorage
  const saved = getStayConnectedCreds();
  if (saved) {
    // Show a brief connecting message, then auto-connect
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('loginError').textContent = 'Reconnecting…';
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
    document.getElementById('loginError').textContent = 'Saved session expired — please log in again';
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
  if (!url || !key) { err.textContent = 'Enter both URL and key'; return; }
  err.textContent = 'Connecting...';
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
    err.textContent = 'Connection failed — check URL and key';
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
let sb = null;

async function connect(url, key) {
  sb = window.supabase.createClient(url, key);

  // Test connection with a simple query
  const { error } = await sb.from('projects').select('id').limit(1);
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
  sb.channel('tasks-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => refreshAll())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, async () => { await loadProjects(); buildProjectCards(); initProjectDragDrop(); await refreshAll(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'prompts' }, () => loadPrompts())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, () => refreshTodos())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chores' }, () => refreshChores())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chore_completions' }, () => refreshChores())
    .subscribe();

  // Initialize TODOs
  await refreshTodos();

  // Initialize Chores
  await refreshChores();

  // Restore last view — hash takes priority over localStorage
  const validViews = ['projects', 'todos', 'chores'];
  const rawHash = location.hash.replace('#', '');
  const hashView = validViews.includes(rawHash) ? rawHash : null;
  const savedView = hashView || localStorage.getItem(CURRENT_VIEW_KEY) || 'projects';
  switchView(savedView);

  // Listen for back/forward navigation
  window.addEventListener('hashchange', () => {
    const raw = location.hash.replace('#', '');
    const h = validViews.includes(raw) ? raw : 'projects';
    if (h !== currentView) switchView(h);
  });
}

// ===================================================================
// PROJECTS (loaded from Supabase)
// ===================================================================
let PROJECTS = [];

function getArchivedProjectIds() {
  try { return JSON.parse(localStorage.getItem(ARCHIVED_PROJECTS_KEY) || '[]'); } catch { return []; }
}
function saveArchivedProjectIds(ids) { localStorage.setItem(ARCHIVED_PROJECTS_KEY, JSON.stringify(ids)); }

function isShowArchived() { return localStorage.getItem(SHOW_ARCHIVED_KEY) === 'true'; }

function toggleShowArchived() {
  const current = isShowArchived();
  localStorage.setItem(SHOW_ARCHIVED_KEY, String(!current));
  updateArchiveToggleBtn();
  renderArchivedProjects();
}

function updateArchiveToggleBtn() {
  const btn = document.getElementById('archiveToggleBtn');
  if (!btn) return;
  const active = isShowArchived();
  btn.textContent = active ? '📂' : '📦';
  btn.title = active ? 'Hide archived' : 'Show archived';
  btn.classList.toggle('btn-active', active);
}

async function loadProjects() {
  const { data, error } = await sb.from('projects').select('*').order('sort_order', { ascending: true });
  if (error) { showToast('Failed to load projects', 'error'); return; }
  PROJECTS = (data || []).map(p => ({
    ...p,
    links: typeof p.links === 'string' ? JSON.parse(p.links) : (p.links || [])
  }));
}

async function archiveProject(id) {
  const ids = getArchivedProjectIds();
  if (!ids.includes(id)) { ids.push(id); saveArchivedProjectIds(ids); }
  buildProjectCards();
  initProjectDragDrop();
  renderArchivedProjects();
  await refreshAll();
  showToast('Project archived', 'info');
}

async function unarchiveProject(id) {
  const ids = getArchivedProjectIds().filter(i => i !== id);
  saveArchivedProjectIds(ids);
  buildProjectCards();
  initProjectDragDrop();
  renderArchivedProjects();
  await refreshAll();
  showToast('Project restored', 'success');
}

async function deleteProject(id, name) {
  const taskCount = allTasks.filter(t => t.project === id).length;
  const detail = taskCount > 0 ? `This will also delete ${taskCount} task${taskCount > 1 ? 's' : ''} in this project.` : null;
  showDeleteConfirm(
    'Delete Project',
    `Delete "${name}"? This cannot be undone.`,
    async () => {
      await sb.from('tasks').delete().eq('project', id);
      await sb.from('prompts').delete().eq('key', id);
      const { error } = await sb.from('projects').delete().eq('id', id);
      if (error) { showToast('Failed to delete project: ' + error.message, 'error'); return; }
      const ids = getArchivedProjectIds().filter(i => i !== id);
      saveArchivedProjectIds(ids);
      await loadProjects();
      buildProjectCards();
      renderArchivedProjects();
      initProjectDragDrop();
      showToast(`Project "${name}" deleted`, 'info');
    },
    detail
  );
}

function renderArchivedProjects() {
  const section = document.getElementById('archivedProjectsSection');
  const list = document.getElementById('archivedProjectsList');
  const archivedIds = getArchivedProjectIds();
  const archivedProjects = PROJECTS.filter(p => archivedIds.includes(p.id));

  if (!isShowArchived()) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';

  if (!archivedProjects.length) {
    list.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;padding:8px 0;">No archived projects</p>';
    return;
  }

  list.innerHTML = archivedProjects.map(p => `
    <div class="archived-project-item">
      <span>${esc(p.name)} <span style="color:var(--muted);font-size:0.72rem;">${esc(p.tech || '')}</span></span>
      <button onclick="unarchiveProject('${p.id}')">Restore</button>
      <button onclick="deleteProject('${p.id}','${esc(p.name)}')" style="color:var(--red);">Delete</button>
    </div>
  `).join('');
}

function copyProjectTitle(e, name) {
  e.stopPropagation();
  const text = 'Command-center project ' + name;
  navigator.clipboard.writeText(text).then(() => {
    const tooltip = e.currentTarget.querySelector('.copy-tooltip');
    if (tooltip) { tooltip.classList.add('show'); setTimeout(() => tooltip.classList.remove('show'), 1500); }
  });
}

function buildProjectCards() {
  const grid = document.getElementById('projectGrid');
  const archivedIds = getArchivedProjectIds();
  const visibleProjects = PROJECTS.filter(p => !archivedIds.includes(p.id));

  grid.innerHTML = visibleProjects.map(p => `
    <div class="project-card" data-project="${p.id}" draggable="true">
      <div class="project-accent" style="background:${p.color}"></div>
      <div class="project-card-header">
        <div style="display:flex;align-items:flex-start;gap:6px;">
          <span class="project-drag-handle" title="Drag to reorder" >⠿</span>
          <div class="project-info">
            <h3><span class="project-title-copy" onclick="copyProjectTitle(event, '${esc(p.name)}')">${esc(p.name)}<span class="copy-tooltip">Copied!</span></span></h3>
            <span class="tech">${esc(p.tech || '')}</span>
          </div>
        </div>
        <div class="project-header-actions">
          ${p.links.map(l => `<a class="project-link" href="${l.url}" target="_blank">${l.label} ↗</a>`).join(' ')}
          <button class="expand-project-btn" onclick="toggleExpandProject('${p.id}')" title="Expand/collapse project" id="expand-btn-${p.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
          <button class="prompt-project-btn" onclick="openProjectPrompt('${p.id}')" title="Edit project prompt">📝</button>
          <button class="archive-project-btn" onclick="openEditProjectModal('${p.id}')" title="Edit project">✏️</button>
          <button class="archive-project-btn" onclick="archiveProject('${p.id}')" title="Archive project">📦</button>
        </div>
      </div>
      <div class="task-list" id="tasks-${p.id}"><p class="empty-msg">Loading...</p></div>
      <div class="archive-toggle" onclick="toggleArchivedTasks('${p.id}')" id="archive-toggle-${p.id}" style="display:none;">
        <span class="arrow" id="archive-arrow-${p.id}">▶</span> Archived tasks (<span id="archive-count-${p.id}">0</span>)
        <button class="delete-all-archived-btn" onclick="event.stopPropagation();deleteAllArchivedTasks('${p.id}')" title="Delete all archived tasks">🗑️ Delete all</button>
      </div>
      <div class="archived-tasks" id="archived-tasks-${p.id}"></div>
      <div class="add-task">
        <textarea placeholder="Add task..." maxlength="${MAX_TEXT_LEN}" id="input-${p.id}" onkeydown="handleTaskInput(event,'${p.id}')" oninput="updateCharCounter(this)" rows="1" style="resize:none;overflow:hidden;"></textarea>
        <label class="draft-toggle" title="Save as draft (personal note, not picked up by Claw)"><input type="checkbox" id="draft-${p.id}" onchange="this.parentElement.classList.toggle('active',this.checked)">Draft</label>
        <button onclick="addTask('${p.id}')">+</button>
      </div>
      <div class="char-counter" id="counter-${p.id}"></div>
    </div>
  `).join('');

  renderArchivedProjects();
}

function updateCharCounter(input) {
  const projectId = input.id.replace('input-', '');
  const counter = document.getElementById(`counter-${projectId}`);
  if (!counter) return;
  const len = input.value.length;
  if (len === 0) { counter.textContent = ''; return; }
  counter.textContent = `${len}/${MAX_TEXT_LEN}`;
  counter.className = 'char-counter' + (len > MAX_TEXT_LEN * 0.9 ? ' danger' : len > MAX_TEXT_LEN * 0.7 ? ' warn' : '');
}

const TODO_MAX_LEN = 2000;
function updateTodoCharCounter(input) {
  const catId = input.closest('.todo-category-card')?.id;
  if (!catId) return;
  const counter = document.getElementById(`todo-counter-${catId}`);
  if (!counter) return;
  const len = input.value.length;
  if (len === 0) { counter.textContent = ''; return; }
  counter.textContent = `${len}/${TODO_MAX_LEN}`;
  counter.className = 'char-counter' + (len > TODO_MAX_LEN * 0.9 ? ' danger' : len > TODO_MAX_LEN * 0.7 ? ' warn' : '');
}

// ===================================================================
// SUPABASE TASK CRUD
// ===================================================================
let allTasks = [];

async function refreshAll() {
  if (!sb || isDragging) return;
  const { data, error } = await sb.from('tasks').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true });
  if (error) { showToast('Failed to load tasks', 'error'); return; }
  const all = data || [];
  allTasks = all;
  renderAllTasks();
  updateStats();
  updateFooterStats();
}

function renderAllTasks() {
  const archivedIds = getArchivedProjectIds();
  const visibleProjects = PROJECTS.filter(p => !archivedIds.includes(p.id));

  visibleProjects.forEach(p => {
    const container = document.getElementById(`tasks-${p.id}`);
    if (!container) return;
    const projectTasks = allTasks.filter(t => t.project === p.id);
    const activeTasks = projectTasks.filter(t => t.status !== 'approved');
    const archivedTasks = projectTasks.filter(t => t.status === 'approved');

    // Active tasks
    if (!activeTasks.length) { container.innerHTML = '<p class="empty-msg">No tasks yet</p>'; }
    else { container.innerHTML = activeTasks.map(t => renderTask(t)).join(''); initDragDrop(container, p.id); initTaskHoverDelay(container); }

    // Archived tasks toggle
    const toggleEl = document.getElementById(`archive-toggle-${p.id}`);
    const archivedContainer = document.getElementById(`archived-tasks-${p.id}`);
    const countEl = document.getElementById(`archive-count-${p.id}`);
    if (archivedTasks.length > 0) {
      toggleEl.style.display = 'flex';
      countEl.textContent = archivedTasks.length;
      archivedContainer.innerHTML = archivedTasks.map(t => renderTask(t, true)).join('');
      initTaskHoverDelay(archivedContainer);
    } else {
      toggleEl.style.display = 'none';
      archivedContainer.innerHTML = '';
      archivedContainer.classList.remove('visible');
    }
  });
}

function toggleArchivedTasks(projectId) {
  const container = document.getElementById(`archived-tasks-${projectId}`);
  const arrow = document.getElementById(`archive-arrow-${projectId}`);
  container.classList.toggle('visible');
  arrow.classList.toggle('open');
}

async function deleteAllArchivedTasks(projectId) {
  const archivedTasks = allTasks.filter(t => t.project === projectId && t.status === 'approved');
  if (!archivedTasks.length) return;
  const project = PROJECTS.find(p => p.id === projectId);
  const name = project ? project.name : projectId;
  showDeleteConfirm(
    'Delete All Archived Tasks',
    `Delete all ${archivedTasks.length} archived task${archivedTasks.length > 1 ? 's' : ''} in "${name}"? This cannot be undone.`,
    async () => {
      for (const t of archivedTasks) {
        await sb.from('tasks').delete().eq('id', t.id);
      }
      showToast(`Deleted ${archivedTasks.length} archived task${archivedTasks.length > 1 ? 's' : ''}`, 'info');
      await refreshAll();
    }
  );
}

function truncateWithShowMore(text, maxLen, id, field) {
  if (!text || text.length <= maxLen) return renderMd(text || '');
  const truncated = renderMd(text.slice(0, maxLen)) + '…';
  return `<span id="meta-${id}-${field}-short">${truncated} <button class="show-more-btn" onclick="expandMeta('${id}','${field}')">show more</button></span><span id="meta-${id}-${field}-full" style="display:none;">${renderMd(text)} <button class="show-more-btn" onclick="collapseMeta('${id}','${field}')">show less</button></span>`;
}

function expandMeta(id, field) {
  document.getElementById(`meta-${id}-${field}-short`).style.display = 'none';
  document.getElementById(`meta-${id}-${field}-full`).style.display = 'inline';
}
function collapseMeta(id, field) {
  document.getElementById(`meta-${id}-${field}-short`).style.display = 'inline';
  document.getElementById(`meta-${id}-${field}-full`).style.display = 'none';
}

function renderTask(t, isArchived = false) {
  const isDraft = t.status === 'draft';
  let meta = '';
  if (t.plan_note) meta += `<div class="task-meta-item"><span class="task-meta-label plan">📋 Plan:</span>${truncateWithShowMore(t.plan_note, MAX_META_DISPLAY, t.id, 'plan')}</div>`;
  if (t.hatch_response) meta += `<div class="task-meta-item response"><span class="task-meta-label claw">🪶 Claw:</span>${truncateWithShowMore(t.hatch_response, MAX_META_DISPLAY, t.id, 'resp')}</div>`;

  let promoteBtn = '';
  let actionBtns = '';
  if (isDraft) {
    promoteBtn = `<button class="promote-btn" onclick="updateTaskStatus('${t.id}','todo')" title="Promote to task">▶ Todo</button>`;
  }
  if (t.status === 'review') {
    actionBtns += `<button onclick="updateTaskStatus('${t.id}','approved')" title="Approve">✅</button>`;
    actionBtns += `<button onclick="openRevisionModal('${t.id}')" title="Request Revision">🔄</button>`;
  }
  if (t.status === 'approved' && isArchived) {
    actionBtns += `<button onclick="updateTaskStatus('${t.id}','todo')" title="Reopen">↩️</button>`;
  }
  actionBtns += `<button onclick="promptEditTask('${t.id}')" title="Edit">✏️</button>`;
  actionBtns += `<button onclick="deleteTask('${t.id}')" title="Delete">🗑️</button>`;

  const dragHandle = !isArchived ? '<span class="drag-handle" title="Drag to reorder">⠿</span>' : '';
  const draftClass = isDraft ? ' task-draft' : '';

  return `<div class="task-item${draftClass}" data-task-id="${t.id}">
    <div class="task-row">
      ${dragHandle}
      <span class="status-dot ${t.status}"></span>
      <span class="task-text" ondblclick="promptEditTask('${t.id}')">${renderMd(t.text)}</span>
      ${promoteBtn}
      <div class="task-actions">${actionBtns}</div>
    </div>
    ${meta ? `<div class="task-meta">${meta}</div>` : ''}
  </div>`;
}

// ===================================================================
// TASK HOVER DELAY — show action buttons after 2 seconds of hover
// ===================================================================
function initTaskHoverDelay(container) {
  const isTouchDevice = window.matchMedia('(max-width:480px)').matches || 'ontouchstart' in window;
  if (isTouchDevice) return; // on touch devices, CSS shows actions immediately

  container.querySelectorAll('.task-item').forEach(item => {
    let hoverTimer = null;
    let clickTimer = null;
    const actions = item.querySelector('.task-actions');
    const taskRow = item.querySelector('.task-row');
    const taskText = item.querySelector('.task-text');
    if (!actions || !taskRow) return;

    // Only trigger on task-row hover (task text), not on plan/Claw response meta
    taskRow.addEventListener('mouseenter', () => {
      hoverTimer = setTimeout(() => {
        actions.classList.add('visible');
      }, 2000);
    });

    taskRow.addEventListener('mouseleave', () => {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      actions.classList.remove('visible');
    });

    // Single click on task text shows actions immediately (with short delay to avoid
    // triggering on double-click which should still open the inline editor)
    if (taskText) {
      taskText.addEventListener('click', () => {
        if (taskText.dataset.editing) return;
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          actions.classList.add('visible');
          // Clear the hover timer since actions are already visible
          if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        }, 250);
      });
      taskText.addEventListener('dblclick', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      });
    }
  });
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

// ===================================================================
// DRAG & DROP REORDER (pointer-event based — works on mouse + touch)
// ===================================================================
let isDragging = false;

function initDragDrop(container, projectId) {
  let dragState = null;

  container.querySelectorAll('.task-item').forEach(item => {
    const handle = item.querySelector('.drag-handle');
    if (!handle) return;
    handle.style.touchAction = 'none';

    handle.addEventListener('pointerdown', e => {
      if (dragState) return;
      e.preventDefault();

      const rect = item.getBoundingClientRect();
      isDragging = true;
      dragState = {
        el: item,
        id: item.dataset.taskId,
        offsetY: e.clientY - rect.top,
        clone: null
      };

      // Visual clone
      const clone = item.cloneNode(true);
      clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);background:var(--surface);border-radius:8px;border:2px solid var(--accent);`;
      document.body.appendChild(clone);
      dragState.clone = clone;

      item.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', e => {
      if (!dragState || dragState.el !== item) return;
      e.preventDefault();

      dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';

      // Auto-scroll the task list when near edges
      const cRect = container.getBoundingClientRect();
      const edge = 40;
      if (e.clientY < cRect.top + edge && container.scrollTop > 0) {
        container.scrollTop -= 5;
      } else if (e.clientY > cRect.bottom - edge && container.scrollTop < container.scrollHeight - container.clientHeight) {
        container.scrollTop += 5;
      }

      // Highlight drop target
      container.querySelectorAll('.task-item:not(.dragging)').forEach(el => {
        el.classList.remove('drag-over');
        const r = el.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) {
          el.classList.add('drag-over');
        }
      });
    });

    const finishDrag = async () => {
      if (!dragState || dragState.el !== item) return;

      if (dragState.clone) dragState.clone.remove();
      item.classList.remove('dragging');

      let targetId = null;
      container.querySelectorAll('.task-item').forEach(el => {
        if (el.classList.contains('drag-over')) {
          targetId = el.dataset.taskId;
          el.classList.remove('drag-over');
        }
      });

      const draggedId = dragState.id;
      dragState = null;
      isDragging = false;

      if (targetId && targetId !== draggedId) {
        await reorderTasks(projectId, draggedId, targetId);
      }
    };

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', () => {
      if (dragState && dragState.el === item) {
        if (dragState.clone) dragState.clone.remove();
        item.classList.remove('dragging');
        container.querySelectorAll('.task-item').forEach(el => el.classList.remove('drag-over'));
        dragState = null;
        isDragging = false;
      }
    });
  });
}

async function reorderTasks(projectId, draggedId, targetId) {
  const projectTasks = allTasks.filter(t => t.project === projectId && t.status !== 'approved');
  const draggedIdx = projectTasks.findIndex(t => t.id === draggedId);
  const targetIdx = projectTasks.findIndex(t => t.id === targetId);
  if (draggedIdx === -1 || targetIdx === -1) return;

  // Reorder in array
  const [dragged] = projectTasks.splice(draggedIdx, 1);
  projectTasks.splice(targetIdx, 0, dragged);

  // Update sort_order for all tasks in this project
  const updates = projectTasks.map((t, i) => ({ id: t.id, sort_order: i }));

  // Batch update (individual calls since Supabase JS doesn't support batch upsert easily)
  for (const u of updates) {
    await sb.from('tasks').update({ sort_order: u.sort_order }).eq('id', u.id);
  }
  await refreshAll();
  showToast('Reordered', 'success');
}

async function addTask(projectId) {
  const input = document.getElementById(`input-${projectId}`);
  const text = input.value.trim();
  if (!text) return;
  if (text.length > MAX_TEXT_LEN) { showToast(`Max ${MAX_TEXT_LEN} characters`, 'error'); return; }
  const draftCheckbox = document.getElementById(`draft-${projectId}`);
  const isDraft = draftCheckbox && draftCheckbox.checked;
  input.value = '';
  const counter = document.getElementById(`counter-${projectId}`);
  if (counter) counter.textContent = '';
  // Get max sort_order for this project
  const projectTasks = allTasks.filter(t => t.project === projectId && t.status !== 'approved');
  const maxOrder = projectTasks.length > 0 ? Math.max(...projectTasks.map(t => t.sort_order || 0)) + 1 : 0;
  const status = isDraft ? 'draft' : 'todo';
  const { error } = await sb.from('tasks').insert({ project: projectId, text, status, sort_order: maxOrder });
  if (error) showToast('Failed to add task', 'error');
  else { showToast(isDraft ? 'Draft saved' : 'Task added', 'success'); await refreshAll(); }
}

async function updateTaskStatus(id, status) {
  const { error } = await sb.from('tasks').update({ status }).eq('id', id);
  if (error) showToast('Update failed', 'error');
  else { showToast(`Status → ${status}`, 'success'); await refreshAll(); }
}

async function promptEditTask(id) {
  const task = allTasks.find(t => t.id === id);
  if (!task) return;
  const taskEl = document.querySelector(`.task-item[data-task-id="${id}"]`);
  if (!taskEl) return;
  const textSpan = taskEl.querySelector('.task-text');
  if (!textSpan || textSpan.dataset.editing) return;

  const originalText = task.text;
  textSpan.dataset.editing = 'true';
  const input = document.createElement('textarea');
  input.className = 'task-edit-input';
  input.value = originalText;
  input.maxLength = MAX_TEXT_LEN;
  input.rows = Math.max(2, originalText.split('\n').length);
  input.style.resize = 'none';
  input.style.overflow = 'hidden';
  input.style.minHeight = '2.4em';

  // Temporarily expand parent task-list so textarea isn't clipped
  const taskList = taskEl.closest('.task-list');
  let savedMaxHeight = '';
  if (taskList) {
    savedMaxHeight = taskList.style.maxHeight;
    taskList.style.maxHeight = 'none';
    taskList.style.overflowY = 'visible';
  }

  function autoSize() {
    input.style.height = 'auto';
    input.style.height = Math.max(input.scrollHeight, 40) + 'px';
  }

  const finishEdit = async (save) => {
    if (save && input.value.trim() && input.value.trim() !== originalText) {
      const trimmed = input.value.trim().slice(0, MAX_TEXT_LEN);
      const { error } = await sb.from('tasks').update({ text: trimmed }).eq('id', id);
      if (error) showToast('Update failed', 'error');
      else showToast('Task updated', 'success');
    }
    // Restore parent task-list constraints
    if (taskList) {
      taskList.style.maxHeight = savedMaxHeight;
      taskList.style.overflowY = '';
    }
    delete textSpan.dataset.editing;
    await refreshAll();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
  });
  input.addEventListener('input', autoSize);
  input.addEventListener('blur', () => finishEdit(true));

  textSpan.replaceWith(input);
  // Use rAF to ensure layout is computed before reading scrollHeight
  requestAnimationFrame(() => { autoSize(); input.focus(); input.select(); });
}

async function deleteTask(id) {
  showDeleteConfirm(
    'Delete Task',
    'Delete this task? This cannot be undone.',
    async () => {
      const { error } = await sb.from('tasks').delete().eq('id', id);
      if (error) showToast('Delete failed', 'error');
      else { showToast('Task deleted', 'success'); await refreshAll(); }
    }
  );
}

// ===================================================================
// STATS
// ===================================================================
function updateStats() {
  const tasks = allTasks;
  const archivedIds = getArchivedProjectIds();
  document.getElementById('statProjects').textContent = PROJECTS.filter(p => !archivedIds.includes(p.id)).length;
  document.getElementById('statTasks').textContent = tasks.filter(t => t.status !== 'approved' && t.status !== 'draft').length;
  document.getElementById('statReview').textContent = tasks.filter(t => t.status === 'review').length;
  const draftCount = tasks.filter(t => t.status === 'draft').length;
  const draftEl = document.getElementById('statDrafts');
  if (draftEl) draftEl.textContent = draftCount;
}

// ===================================================================
// UTILS
// ===================================================================
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function linkify(html) { return html.replace(/https?:\/\/[^\s<&]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`); }

/** Lightweight markdown renderer: escapes HTML first, then applies markdown formatting */
function renderMd(text) {
  if (!text) return '';
  let html = esc(text);
  // Code blocks (``` ... ```) — must come before inline code
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre class="md-code-block"><code>${code.trim()}</code></pre>`);
  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic (single * not preceded/followed by space only)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Links [text](url) — supports https://, http://, and www. prefixes
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/\[([^\]]+)\]\((www\.[^\s)]+)\)/g, '<a href="https://$2" target="_blank" rel="noopener">$1</a>');
  // Bare URLs (not already in an <a> tag)
  html = html.replace(/(?<!href="|">)(https?:\/\/[^\s<&]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/(?<!href="|"|\/)(www\.[^\s<&]+)/g, '<a href="https://$1" target="_blank" rel="noopener">$1</a>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => t.className = 'toast', 2500);
}

// ===================================================================
// ADD PROJECT MODAL
// ===================================================================
function openAddProjectModal() {
  document.getElementById('addProjectModal').classList.add('visible');
  document.getElementById('newProjectId').value = '';
  document.getElementById('newProjectName').value = '';
  document.getElementById('newProjectColor').value = '#646cff';
  document.getElementById('newProjectTech').value = '';
  document.getElementById('newProjectGithub').value = '';
  document.getElementById('newProjectLive').value = '';
  document.getElementById('newProjectId').focus();
}

function closeAddProjectModal() {
  document.getElementById('addProjectModal').classList.remove('visible');
}

// Close modal on overlay click
document.addEventListener('click', e => {
  if (e.target.id === 'addProjectModal') closeAddProjectModal();
});

async function saveNewProject() {
  const id = document.getElementById('newProjectId').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const name = document.getElementById('newProjectName').value.trim();
  const color = document.getElementById('newProjectColor').value;
  const tech = document.getElementById('newProjectTech').value.trim();
  const github = document.getElementById('newProjectGithub').value.trim();
  const live = document.getElementById('newProjectLive').value.trim();

  if (!id || !name) { showToast('ID and Name are required', 'error'); return; }
  if (PROJECTS.find(p => p.id === id)) { showToast('Project ID already exists', 'error'); return; }

  const links = [];
  if (github) links.push({ label: 'GitHub', url: github });
  if (live) links.push({ label: 'Live', url: live });

  const maxOrder = PROJECTS.length > 0 ? Math.max(...PROJECTS.map(p => p.sort_order || 0)) + 1 : 0;

  const { error } = await sb.from('projects').insert({ id, name, color, tech, links, sort_order: maxOrder });
  if (error) { showToast('Failed to create project: ' + (error.message || ''), 'error'); return; }

  closeAddProjectModal();
  await loadProjects();
  buildProjectCards();
  await refreshAll();
  showToast(`Project "${name}" created`, 'success');
}

// ===================================================================
// PROJECT DRAG & DROP REORDER
// ===================================================================
function initProjectDragDrop() {
  const grid = document.getElementById('projectGrid');
  const cards = grid.querySelectorAll('.project-card');
  cards.forEach(card => {
    // Only make draggable when mousedown on drag handle
    card.setAttribute('draggable', 'false');
    const handle = card.querySelector('.project-drag-handle');
    if (handle) {
      handle.addEventListener('mousedown', () => card.setAttribute('draggable', 'true'));
      handle.addEventListener('mouseup', () => card.setAttribute('draggable', 'false'));
    }
    card.addEventListener('dragstart', e => {
      if (card.getAttribute('draggable') !== 'true') { e.preventDefault(); return; }
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.dataset.project);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      card.setAttribute('draggable', 'false');
      grid.querySelectorAll('.project-card').forEach(c => c.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragging = grid.querySelector('.dragging');
      if (dragging && card !== dragging) card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', async e => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      const targetId = card.dataset.project;
      if (draggedId === targetId) return;
      await reorderProjects(draggedId, targetId);
    });
  });
}

async function reorderProjects(draggedId, targetId) {
  const archivedIds = getArchivedProjectIds();
  const visible = PROJECTS.filter(p => !archivedIds.includes(p.id));
  const draggedIdx = visible.findIndex(p => p.id === draggedId);
  const targetIdx = visible.findIndex(p => p.id === targetId);
  if (draggedIdx === -1 || targetIdx === -1) return;
  const [dragged] = visible.splice(draggedIdx, 1);
  visible.splice(targetIdx, 0, dragged);
  for (let i = 0; i < visible.length; i++) {
    await sb.from('projects').update({ sort_order: i }).eq('id', visible[i].id);
  }
  await loadProjects();
  buildProjectCards();
  initProjectDragDrop();
  await refreshAll();
  showToast('Projects reordered', 'success');
}

// ===================================================================
// EDIT PROJECT MODAL
// ===================================================================
function openEditProjectModal(id) {
  const p = PROJECTS.find(pr => pr.id === id);
  if (!p) return;
  document.getElementById('editProjectId').value = p.id;
  document.getElementById('editProjectName').value = p.name;
  document.getElementById('editProjectColor').value = p.color;
  document.getElementById('editProjectTech').value = p.tech || '';
  const github = (p.links || []).find(l => l.label === 'GitHub');
  const live = (p.links || []).find(l => l.label === 'Live' || l.label === 'Play');
  document.getElementById('editProjectGithub').value = github ? github.url : '';
  document.getElementById('editProjectLive').value = live ? live.url : '';
  document.getElementById('editProjectModal').classList.add('visible');
}

function closeEditProjectModal() {
  document.getElementById('editProjectModal').classList.remove('visible');
}

async function saveEditProject() {
  const id = document.getElementById('editProjectId').value;
  const name = document.getElementById('editProjectName').value.trim();
  const color = document.getElementById('editProjectColor').value;
  const tech = document.getElementById('editProjectTech').value.trim();
  const github = document.getElementById('editProjectGithub').value.trim();
  const live = document.getElementById('editProjectLive').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  const links = [];
  if (github) links.push({ label: 'GitHub', url: github });
  if (live) links.push({ label: 'Live', url: live });
  const { error } = await sb.from('projects').update({ name, color, tech, links }).eq('id', id);
  if (error) { showToast('Update failed: ' + (error.message || ''), 'error'); return; }
  closeEditProjectModal();
  await loadProjects();
  buildProjectCards();
  initProjectDragDrop();
  await refreshAll();
  showToast(`Project "${name}" updated`, 'success');
}

// ===================================================================
// PROJECT EXPAND (INLINE)
// ===================================================================
const EXPAND_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const COLLAPSE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

function toggleExpandProject(projectId) {
  const card = document.querySelector(`.project-card[data-project="${projectId}"]`);
  if (!card) return;
  const isExpanded = card.classList.contains('expanded');
  // Collapse all other cards first
  document.querySelectorAll('.project-card.expanded').forEach(c => {
    c.classList.remove('expanded');
    const btn = c.querySelector('.expand-project-btn');
    if (btn) btn.innerHTML = EXPAND_SVG;
  });
  if (!isExpanded) {
    card.classList.add('expanded');
    const btn = card.querySelector('.expand-project-btn');
    if (btn) btn.innerHTML = COLLAPSE_SVG;
    // Smooth scroll to the expanded card
    setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}

// ===================================================================
// EXPAND TASK VIEW (modal fallback — kept for compatibility)
// ===================================================================
function expandTask(id) {
  const t = allTasks.find(task => task.id === id);
  if (!t) return;
  const project = PROJECTS.find(p => p.id === t.project);
  const content = document.getElementById('taskExpandContent');
  let meta = '';
  if (t.plan_note) meta += `<div class="task-full-meta-item"><strong style="color:var(--accent);">📋 Plan:</strong><br>${renderMd(t.plan_note)}</div>`;
  if (t.hatch_response) meta += `<div class="task-full-meta-item response"><strong style="color:var(--yellow);">🪶 Claw:</strong><br>${renderMd(t.hatch_response)}</div>`;

  let actions = '';
  if (t.status === 'review') {
    actions = `<div style="display:flex;gap:8px;margin-top:12px;"><button class="btn" onclick="updateTaskStatus('${t.id}','approved');closeTaskExpandModal();">✅ Approve</button><button class="btn" onclick="closeTaskExpandModal();openRevisionModal('${t.id}');">🔄 Revision</button></div>`;
  }

  content.innerHTML = `
    <h2><span class="status-dot ${t.status}"></span> ${project ? esc(project.name) : esc(t.project)}</h2>
    <div class="task-full-text">${esc(t.text)}</div>
    ${meta ? `<div class="task-full-meta">${meta}</div>` : ''}
    <div style="font-size:0.72rem;color:var(--muted);">Created: ${new Date(t.created_at).toLocaleString()} · Status: ${t.status}</div>
    ${actions}
    <div style="margin-top:16px;text-align:right;"><button class="btn" onclick="closeTaskExpandModal()">Close</button></div>
  `;
  document.getElementById('taskExpandModal').classList.add('visible');
}

function closeTaskExpandModal() {
  document.getElementById('taskExpandModal').classList.remove('visible');
}

// ===================================================================
// DELETE CONFIRMATION MODAL
// ===================================================================
let _deleteConfirmCallback = null;

function showDeleteConfirm(title, message, onConfirm, detail) {
  document.getElementById('deleteConfirmTitle').textContent = title;
  document.getElementById('deleteConfirmMessage').textContent = message;
  const detailEl = document.getElementById('deleteConfirmDetail');
  if (detail) {
    detailEl.textContent = detail;
    detailEl.style.display = 'block';
  } else {
    detailEl.style.display = 'none';
  }
  _deleteConfirmCallback = onConfirm;
  document.getElementById('deleteConfirmModal').classList.add('visible');
}

function closeDeleteConfirm() {
  document.getElementById('deleteConfirmModal').classList.remove('visible');
  _deleteConfirmCallback = null;
}

async function executeDeleteConfirm() {
  if (_deleteConfirmCallback) {
    const cb = _deleteConfirmCallback;
    closeDeleteConfirm();
    await cb();
  }
}

// Close modals on overlay click / Escape
document.addEventListener('click', e => {
  if (e.target.id === 'editProjectModal') closeEditProjectModal();
  if (e.target.id === 'taskExpandModal') closeTaskExpandModal();
  if (e.target.id === 'revisionModal') closeRevisionModal();
  if (e.target.id === 'promptEditorModal') closePromptEditor();
  if (e.target.id === 'projectPromptModal') closeProjectPrompt();
  if (e.target.id === 'snoozeModal') closeSnoozeModal();
  if (e.target.id === 'deleteConfirmModal') closeDeleteConfirm();
  if (e.target.id === 'addCategoryModal') closeAddCategoryModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAddProjectModal(); closeEditProjectModal(); closeTaskExpandModal(); closeRevisionModal(); closePromptEditor(); closeProjectPrompt(); closeSnoozeModal(); closeDeleteConfirm(); closeAddCategoryModal(); }
});

// ===================================================================
// TEXTAREA AUTO-RESIZE + SHIFT+ENTER
// ===================================================================
function handleTaskInput(event, projectId) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    addTask(projectId);
    return;
  }
  // Shift+Enter: let the browser insert the newline, then auto-resize
  if (event.key === 'Enter' && event.shiftKey) {
    // Don't prevent default — let the newline be inserted
    setTimeout(() => autoResizeTextarea(event.target), 0);
    return;
  }
  // Auto-resize on any other input
  setTimeout(() => autoResizeTextarea(event.target), 0);
}

function autoResizeTextarea(ta) {
  ta.style.height = 'auto';
  const newHeight = Math.min(ta.scrollHeight, 120);
  ta.style.height = newHeight + 'px';
  ta.style.overflowY = ta.scrollHeight > 120 ? 'auto' : 'hidden';
}

// Also auto-resize on input (for paste, etc.)
document.addEventListener('input', e => {
  if (e.target.tagName === 'TEXTAREA' && e.target.id.startsWith('input-')) {
    autoResizeTextarea(e.target);
  }
});

// ===================================================================
// REVISION FEEDBACK MODAL
// ===================================================================
function openRevisionModal(taskId) {
  document.getElementById('revisionTaskId').value = taskId;
  document.getElementById('revisionFeedback').value = '';
  document.getElementById('revisionModal').classList.add('visible');
  const ta = document.getElementById('revisionFeedback');
  ta.focus();
  // Enter submits, Shift+Enter inserts newline
  ta.onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitRevision();
    }
  };
}

function closeRevisionModal() {
  document.getElementById('revisionModal').classList.remove('visible');
}

async function submitRevision() {
  const taskId = document.getElementById('revisionTaskId').value;
  const feedback = document.getElementById('revisionFeedback').value.trim();
  if (!taskId) return;

  const updates = { status: 'revision' };
  if (feedback) {
    // Prepend feedback to plan_note so Claw sees it when picking up
    const task = allTasks.find(t => t.id === taskId);
    const existing = task?.plan_note || '';
    updates.plan_note = `[REVISION FEEDBACK]: ${feedback}\n\n${existing}`.slice(0, 5000);
  }

  const { error } = await sb.from('tasks').update(updates).eq('id', taskId);
  if (error) { showToast('Update failed', 'error'); return; }
  closeRevisionModal();
  showToast('Revision requested' + (feedback ? ' with feedback' : ''), 'success');
  await refreshAll();
}

// ===================================================================
// TASK-PICKUP PROMPT EDITOR (Supabase-backed)
// ===================================================================
let promptsCache = {};

async function loadPrompts() {
  if (!sb) return;
  const { data, error } = await sb.from('prompts').select('*');
  if (error) return;
  promptsCache = {};
  (data || []).forEach(p => { promptsCache[p.key] = p.text; });
}

// Global prompt (header button)
async function openPromptEditor() {
  await loadPrompts();
  document.getElementById('promptGlobalText').value = promptsCache['global'] || '';
  document.getElementById('promptEditorModal').classList.add('visible');
  document.getElementById('promptGlobalText').focus();
}

function closePromptEditor() {
  document.getElementById('promptEditorModal').classList.remove('visible');
}

async function saveGlobalPrompt() {
  const text = document.getElementById('promptGlobalText').value;
  await sb.from('prompts').upsert({ key: 'global', text }, { onConflict: 'key' });
  promptsCache['global'] = text;
  closePromptEditor();
  showToast('Global prompt saved', 'success');
}

// Per-project prompt (card button)
async function openProjectPrompt(projectId) {
  await loadPrompts();
  const project = PROJECTS.find(p => p.id === projectId);
  document.getElementById('projectPromptTitle').textContent = `📝 ${project ? project.name : projectId} Prompt`;
  document.getElementById('promptProjectId').value = projectId;
  document.getElementById('promptProjectText').value = promptsCache[projectId] || '';
  document.getElementById('projectPromptModal').classList.add('visible');
  document.getElementById('promptProjectText').focus();
}

function closeProjectPrompt() {
  document.getElementById('projectPromptModal').classList.remove('visible');
}

async function saveProjectPrompt() {
  const projectId = document.getElementById('promptProjectId').value;
  const text = document.getElementById('promptProjectText').value;
  if (text.trim()) {
    await sb.from('prompts').upsert({ key: projectId, text }, { onConflict: 'key' });
    promptsCache[projectId] = text;
  } else {
    await sb.from('prompts').delete().eq('key', projectId);
    delete promptsCache[projectId];
  }
  closeProjectPrompt();
  showToast('Project prompt saved', 'success');
}

// ===================================================================
// FOOTER STATS
// ===================================================================
function updateFooterStats() {
  document.getElementById('dbTaskCount').textContent = allTasks.length;
  document.getElementById('dbProjectCount').textContent = PROJECTS.length;
  // Set dashboard link using the connected URL
  const urlInput = document.getElementById('username');
  if (urlInput && urlInput.value) {
    const projectRef = urlInput.value.replace('https://', '').replace('.supabase.co', '');
    document.getElementById('supabaseDashLink').href = `https://supabase.com/dashboard/project/${projectRef}`;
  }
  // Fetch DB size via RPC
  if (sb) {
    sb.rpc('db_size_mb').then(({ data, error }) => {
      document.getElementById('dbSizeMb').textContent = error ? '?' : `${data} MB`;
    });
  }
}

// ===================================================================
// DYNAMIC TASK LIST HEIGHT
// ===================================================================
function updateTaskListMaxHeight() {
  const app = document.getElementById('app');
  if (!app || !app.classList.contains('active')) return;
  const header = document.querySelector('.app-header');
  const statsBar = document.querySelector('.stats-bar');
  const legend = document.querySelector('.legend');
  const footer = document.querySelector('.footer-stats');
  
  // Calculate occupied height (header + stats + legend + footer + padding)
  const occupiedHeight = (header?.offsetHeight || 0) + (statsBar?.offsetHeight || 0) + 
    (legend?.offsetHeight || 0) + (footer?.offsetHeight || 0) + 80; // 80px for padding/margins
  
  const availableHeight = window.innerHeight - occupiedHeight;
  // Each card has ~80px overhead (header, add-task, archive toggle, padding)
  const cardOverhead = 100;
  const maxHeight = Math.max(300, availableHeight - cardOverhead);
  
  document.documentElement.style.setProperty('--task-list-max-height', maxHeight + 'px');
}

// Run on load and resize
window.addEventListener('resize', updateTaskListMaxHeight);
// Also call after rendering
const origRenderAllTasks = renderAllTasks;
renderAllTasks = function() {
  origRenderAllTasks();
  updateTaskListMaxHeight();
};

// ===================================================================
// THEME
// ===================================================================
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
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
// VIEW SWITCHER (Projects ↔ TODOs)
// ===================================================================
let currentView = 'projects';

function switchView(view) {
  currentView = view;
  localStorage.setItem(CURRENT_VIEW_KEY, view);
  // Sync URL hash (no reload)
  const newHash = '#' + view;
  if (location.hash !== newHash) history.replaceState(null, '', newHash);
  const projectsView = document.getElementById('projectsView');
  const todosView = document.getElementById('todosView');
  const choresView = document.getElementById('choresView');
  const tabProjects = document.getElementById('tabProjects');
  const tabTodos = document.getElementById('tabTodos');
  const tabChores = document.getElementById('tabChores');
  const addProjectBtn = document.querySelector('.header-actions .btn[onclick="openAddProjectModal()"]');

  // Hide all
  projectsView.style.display = 'none';
  todosView.style.display = 'none';
  if (choresView) choresView.style.display = 'none';
  tabProjects.classList.remove('active');
  tabTodos.classList.remove('active');
  if (tabChores) tabChores.classList.remove('active');

  if (view === 'projects') {
    projectsView.style.display = '';
    tabProjects.classList.add('active');
    if (addProjectBtn) addProjectBtn.style.display = '';
  } else if (view === 'todos') {
    todosView.style.display = '';
    tabTodos.classList.add('active');
    if (addProjectBtn) addProjectBtn.style.display = 'none';
    renderTodos();
  } else if (view === 'chores') {
    if (choresView) choresView.style.display = '';
    if (tabChores) tabChores.classList.add('active');
    if (addProjectBtn) addProjectBtn.style.display = 'none';
    renderChores();
  }
}

// ===================================================================
// ===================================================================
// TODOS — DATA & CRUD (Category Card Layout)
// ===================================================================
let allTodos = [];
let todoFilter = 'pending';
const CATEGORIES_KEY = 'todo_categories';
const CATEGORY_COLORS_KEY = 'todo_category_colors';
const DEFAULT_CATEGORY_PALETTE = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#84cc16'];
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
  if (!sb) return;
  const { data, error } = await sb.from('todos').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true });
  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast('Failed to load todos', 'error');
    return;
  }
  allTodos = data || [];
  migrateBucketsToCategories();
  syncCategoriesFromTodos();
  if (currentView === 'todos') {
    renderTodos();
    updateTodoStats();
  }
}

function setTodoFilter(filter) {
  todoFilter = filter;
  document.querySelectorAll('.todo-filters .filter-btn').forEach(btn => {
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
  updateTodoStats();

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
  let container = document.getElementById('categoryNavButtons');
  if (!container) {
    // Create the container in the toolbar
    const toolbar = document.querySelector('.todos-toolbar');
    if (!toolbar) return;
    container = document.createElement('div');
    container.id = 'categoryNavButtons';
    container.className = 'category-nav-buttons';
    // Insert after the filters
    const filters = toolbar.querySelector('.todo-filters');
    if (filters) filters.after(container);
    else toolbar.prepend(container);
  }
  container.innerHTML = categoryList.map(cat => {
    const name = cat || 'General';
    const color = getCategoryColor(cat);
    return `<button class="category-nav-btn" style="--cat-color:${color};border-color:${color};color:${color}" onclick="navigateToCategory('${esc(cat).replace(/'/g, "\\'")}')" title="Go to ${esc(name)}">${esc(name)}</button>`;
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

function renderCategoryCard(category) {
  const catId = categoryToDomId(category);
  const catName = category || 'General';
  const isGeneral = !category;
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
    ? `<button class="todo-cat-delete-btn" onclick="deleteCategory('${esc(category)}')" title="Delete category">🗑️</button>`
    : '';

  const activeEmptyMsg = displayActive.length === 0
    ? `<p class="empty-msg">${todoFilter === 'pending' ? 'All caught up! 🎉' : 'No items yet'}</p>`
    : '';

  const escapedCat = esc(category).replace(/'/g, "\\'");

  const catColor = getCategoryColor(category);

  const catDragHandle = !isGeneral ? `<span class="todo-cat-drag-handle" title="Drag to reorder">⠿</span>` : '';

  // Done toggle (collapsible, like archived tasks in projects)
  let doneToggle = '';
  if (doneCount > 0 && todoFilter !== 'done') {
    const deleteAllBtn = `<button class="delete-all-archived-btn" onclick="event.stopPropagation();deleteAllDoneTodos('${escapedCat}')" title="Delete all done">🗑️ Delete all</button>`;
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

  return `<div class="todo-category-card" id="${catId}" data-category="${esc(category)}">
    <div class="todo-cat-accent" style="background:${catColor}"></div>
    <div class="todo-cat-header">
      <div class="todo-cat-header-left">
        ${catDragHandle}
        <div class="todo-cat-info">
          <h3 class="todo-cat-name">${esc(catName)}</h3>
          <span class="todo-cat-stats">${statsText}</span>
        </div>
      </div>
      <div class="todo-cat-header-actions">
        ${deleteBtn}
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
      dueDateStr = `<span class="todo-due due-soon">🔔 Due ${formatRelativeDate(d)}</span>`;
    } else {
      dueDateStr = `<span class="todo-due">📅 ${formatRelativeDate(d)}</span>`;
    }
  }

  let snoozeInfo = '';
  if (isSnoozed) {
    snoozeInfo = `<span class="todo-snoozed">💤 Snoozed until ${new Date(t.snooze_until).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`;
  }

  let outdatedInfo = '';
  if (isOutdated && !t.done) {
    const ref = new Date(t.updated_at || t.created_at);
    const daysAgo = Math.floor((now - ref) / (1000 * 60 * 60 * 24));
    outdatedInfo = `<span class="todo-outdated-badge">🕰️ ${daysAgo}d old</span>`;
  }

  const dragHandle = !t.done ? '<span class="todo-drag-handle" title="Drag to reorder">⠿</span>' : '';

  const classes = [
    'todo-item',
    t.done ? 'todo-done' : '',
    isOverdue ? 'todo-overdue' : '',
    isOutdated ? 'todo-outdated' : '',
    isFlagged ? 'todo-flagged' : ''
  ].filter(Boolean).join(' ');

  return `<div class="${classes}" data-todo-id="${t.id}">
    <div class="todo-row">
      ${dragHandle}
      ${flagBtn}
      <label class="todo-checkbox-label">
        <input type="checkbox" ${t.done ? 'checked' : ''} onchange="toggleTodo('${t.id}', this.checked)">
        <span class="todo-checkmark"></span>
      </label>
      <span class="todo-text" ondblclick="editTodoInline('${t.id}')">${t.text.length > 150 ? truncateWithShowMore(t.text, 150, t.id, 'todo') : renderMd(t.text)}</span>
      ${prioBadge}
      <div class="todo-actions">
        ${!t.done ? `<button onclick="openSnoozeModal('${t.id}')" title="Snooze">💤</button>` : ''}
        <button onclick="editTodoInline('${t.id}')" title="Edit">✏️</button>
        <button onclick="deleteTodo('${t.id}')" title="Delete">🗑️</button>
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
  const { error } = await sb.from('todos').update({ priority: next }).eq('id', id);
  if (error) { showToast('Failed to update priority', 'error'); return; }
  const labels = { high: '🚩 Flagged high', urgent: '🚩 Flagged urgent', normal: 'Flag removed' };
  showToast(labels[next] || `Priority: ${next}`, 'success');
  await refreshTodos();
}

function formatRelativeDate(d) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) return `today at ${timeStr}`;
  if (diffDays === 1) return `tomorrow at ${timeStr}`;
  if (diffDays === -1) return `yesterday at ${timeStr}`;
  if (diffDays > 1 && diffDays <= 7) return `in ${diffDays} days`;
  if (diffDays < -1 && diffDays >= -7) return `${Math.abs(diffDays)} days ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${timeStr}`;
}

async function addTodoToCategory(inputEl) {
  const text = inputEl.value.trim();
  if (!text) return;
  const category = inputEl.dataset.category || '';

  const pendingTodos = allTodos.filter(t => !t.done && (t.category || '') === category);
  const maxOrder = pendingTodos.length > 0 ? Math.max(...pendingTodos.map(t => t.sort_order || 0)) + 1 : 0;

  const { error } = await sb.from('todos').insert({ text, priority: 'normal', category, sort_order: maxOrder });
  if (error) { showToast('Failed to add todo: ' + error.message, 'error'); return; }
  inputEl.value = '';
  showToast('TODO added', 'success');
  await refreshTodos();
}

async function toggleTodo(id, done) {
  const { error } = await sb.from('todos').update({ done }).eq('id', id);
  if (error) { showToast('Update failed', 'error'); return; }
  showToast(done ? 'Done! ✅' : 'Reopened', 'success');
  await refreshTodos();
}

async function deleteTodo(id) {
  showDeleteConfirm(
    'Delete TODO',
    'Delete this TODO? This cannot be undone.',
    async () => {
      const { error } = await sb.from('todos').delete().eq('id', id);
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
        await sb.from('todos').delete().eq('id', t.id);
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
  const input = document.createElement('textarea');
  input.className = 'task-edit-input';
  input.value = todo.text;
  input.maxLength = 2000;
  input.rows = Math.max(2, todo.text.split('\n').length);
  input.style.resize = 'none';
  input.style.overflow = 'hidden';
  input.style.minHeight = '2.4em';

  function autoSize() {
    input.style.height = 'auto';
    input.style.height = Math.max(input.scrollHeight, 40) + 'px';
  }

  const finish = async (save) => {
    if (save && input.value.trim() && input.value.trim() !== todo.text) {
      const { error } = await sb.from('todos').update({ text: input.value.trim() }).eq('id', id);
      if (error) showToast('Update failed', 'error');
      else showToast('TODO updated', 'success');
    }
    delete textEl.dataset.editing;
    await refreshTodos();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('input', autoSize);
  textEl.replaceWith(input);
  // Use rAF to ensure layout is computed before reading scrollHeight
  requestAnimationFrame(() => { autoSize(); input.focus(); input.select(); });
}

function updateTodoStats() {
  const now = new Date();
  const total = allTodos.length;
  const done = allTodos.filter(t => t.done).length;
  const pending = allTodos.filter(t => !t.done).length;
  const overdue = allTodos.filter(t => !t.done && t.due_date && new Date(t.due_date) < now).length;
  const flagged = allTodos.filter(t => !t.done && t.priority && t.priority !== 'normal').length;
  const outdated = allTodos.filter(t => isTodoOutdated(t)).length;

  const el = id => document.getElementById(id);
  if (el('statTodosTotal')) el('statTodosTotal').textContent = total;
  if (el('statTodosPending')) el('statTodosPending').textContent = pending;
  if (el('statTodosDone')) el('statTodosDone').textContent = done;
  if (el('statTodosOverdue')) el('statTodosOverdue').textContent = overdue;
  if (el('statTodosFlagged')) el('statTodosFlagged').textContent = flagged;
  if (el('statTodosOutdated')) el('statTodosOutdated').textContent = outdated;
}

// ===================================================================
// CATEGORY MANAGEMENT
// ===================================================================
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
      await sb.from('todos').update({ category: '' }).eq('id', t.id);
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
  const { error } = await sb.from('todos').update({ snooze_until: snoozeUntil.toISOString() }).eq('id', taskId);
  if (error) { showToast('Snooze failed', 'error'); return; }
  closeSnoozeModal();
  showToast(`Snoozed until ${snoozeUntil.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, 'success');
  await refreshTodos();
}

// ===================================================================
// TODO DRAG & DROP REORDER (per category card)
// ===================================================================
function initTodoDragDropForCard(catId) {
  const card = document.getElementById(catId);
  if (!card) return;
  const container = card.querySelector('.todo-cat-list');
  if (!container) return;
  let dragState = null;

  container.querySelectorAll('.todo-item').forEach(item => {
    const handle = item.querySelector('.todo-drag-handle');
    if (!handle) return;
    handle.style.touchAction = 'none';

    handle.addEventListener('pointerdown', e => {
      if (dragState) return;
      e.preventDefault();
      const rect = item.getBoundingClientRect();
      isDragging = true;
      dragState = { el: item, id: item.dataset.todoId, offsetY: e.clientY - rect.top, clone: null };
      const clone = item.cloneNode(true);
      clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);background:var(--surface);border-radius:8px;border:2px solid var(--accent);`;
      document.body.appendChild(clone);
      dragState.clone = clone;
      item.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', e => {
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
      if (targetId && targetId !== draggedId) await reorderTodosInCategory(draggedId, targetId, catKey);
    };

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', () => {
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

async function reorderTodosInCategory(draggedId, targetId, category) {
  const filtered = getFilteredTodosForCategory(category);
  const draggedIdx = filtered.findIndex(t => t.id === draggedId);
  const targetIdx = filtered.findIndex(t => t.id === targetId);
  if (draggedIdx === -1 || targetIdx === -1) return;
  const [dragged] = filtered.splice(draggedIdx, 1);
  filtered.splice(targetIdx, 0, dragged);
  for (let i = 0; i < filtered.length; i++) {
    await sb.from('todos').update({ sort_order: i }).eq('id', filtered[i].id);
  }
  await refreshTodos();
  showToast('Reordered', 'success');
}

// ===================================================================
// CATEGORY CARD DRAG & DROP REORDER
// ===================================================================
function initCategoryDragDrop() {
  const grid = document.getElementById('todoCategoryGrid');
  if (!grid) return;
  const cards = grid.querySelectorAll('.todo-category-card');
  let dragState = null;

  cards.forEach(card => {
    const handle = card.querySelector('.todo-cat-drag-handle');
    if (!handle) return; // General category has no handle
    handle.style.touchAction = 'none';

    handle.addEventListener('pointerdown', e => {
      if (dragState) return;
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      isDragging = true;
      dragState = { el: card, category: card.dataset.category, offsetY: e.clientY - rect.top, offsetX: e.clientX - rect.left, clone: null };
      const clone = card.cloneNode(true);
      clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);border-radius:12px;border:2px solid var(--accent);`;
      document.body.appendChild(clone);
      dragState.clone = clone;
      card.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', e => {
      if (!dragState || dragState.el !== card) return;
      e.preventDefault();
      dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';
      dragState.clone.style.left = (e.clientX - dragState.offsetX) + 'px';
      // Highlight drop target
      grid.querySelectorAll('.todo-category-card:not(.dragging)').forEach(el => {
        el.classList.remove('drag-over');
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          el.classList.add('drag-over');
        }
      });
    });

    const finishDrag = async () => {
      if (!dragState || dragState.el !== card) return;
      if (dragState.clone) dragState.clone.remove();
      card.classList.remove('dragging');
      let targetCategory = null;
      grid.querySelectorAll('.todo-category-card').forEach(el => {
        if (el.classList.contains('drag-over')) {
          targetCategory = el.dataset.category || '';
          el.classList.remove('drag-over');
        }
      });
      const draggedCategory = dragState.category;
      dragState = null;
      isDragging = false;
      // Only reorder non-General categories (General is always first)
      if (targetCategory !== null && targetCategory !== draggedCategory && draggedCategory !== '' && targetCategory !== '') {
        await reorderCategories(draggedCategory, targetCategory);
      }
    };

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', () => {
      if (dragState && dragState.el === card) {
        if (dragState.clone) dragState.clone.remove();
        card.classList.remove('dragging');
        grid.querySelectorAll('.todo-category-card').forEach(el => el.classList.remove('drag-over'));
        dragState = null;
        isDragging = false;
      }
    });
  });
}

async function reorderCategories(draggedName, targetName) {
  const categories = getCategories();
  const draggedIdx = categories.findIndex(c => c === draggedName);
  const targetIdx = categories.findIndex(c => c === targetName);
  if (draggedIdx === -1 || targetIdx === -1) return;
  const [dragged] = categories.splice(draggedIdx, 1);
  categories.splice(targetIdx, 0, dragged);
  saveCategories(categories);
  renderTodos();
  showToast('Categories reordered', 'success');
}

// ===================================================================
// SUBTLE MOUSE-FOLLOW AMBIENT GLOW
// ===================================================================
document.addEventListener('mousemove', e => {
  document.body.style.setProperty('--mouse-x', e.clientX + 'px');
  document.body.style.setProperty('--mouse-y', e.clientY + 'px');
});

// ===================================================================
// ===================================================================
// CHORES — DATA, CRUD & RENDERING
// ===================================================================
let allChores = [];
let allChoreCompletions = [];
let choreFilter = 'all';
const CHORE_CATEGORIES_KEY = 'claw_cc_chore_categories';

function getChoreCategories() {
  try { return JSON.parse(localStorage.getItem(CHORE_CATEGORIES_KEY) || '[]'); } catch { return []; }
}
function saveChoreCategories(cats) { localStorage.setItem(CHORE_CATEGORIES_KEY, JSON.stringify(cats)); }

function syncChoreCategoriesFromData() {
  const known = getChoreCategories();
  const knownSet = new Set(known.map(c => c.toLowerCase()));
  const discovered = new Set();
  allChores.forEach(c => {
    if (c.category && c.category !== 'General' && !knownSet.has(c.category.toLowerCase())) {
      discovered.add(c.category);
    }
  });
  if (discovered.size > 0) saveChoreCategories([...known, ...Array.from(discovered)]);
}

async function refreshChores() {
  if (!sb) return;
  const { data: chores, error: chErr } = await sb.from('chores').select('*').order('created_at', { ascending: true });
  if (chErr) {
    if (chErr.code === '42P01' || chErr.message?.includes('does not exist')) return;
    showToast('Failed to load chores', 'error');
    return;
  }
  allChores = chores || [];

  const { data: completions, error: compErr } = await sb.from('chore_completions').select('*').order('completed_at', { ascending: false });
  if (!compErr) allChoreCompletions = completions || [];

  syncChoreCategoriesFromData();
  if (currentView === 'chores') {
    renderChores();
    updateChoreStats();
  }
}

function getChoreLastDone(choreId) {
  const comp = allChoreCompletions.find(c => c.chore_id === choreId);
  return comp ? new Date(comp.completed_at) : null;
}

function getChoreCompletionCount(choreId) {
  return allChoreCompletions.filter(c => c.chore_id === choreId).length;
}

function getChoreCompletions(choreId) {
  return allChoreCompletions.filter(c => c.chore_id === choreId);
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
  if (!chore.next_due) return '<span class="chore-due no-date">⏳ Awaiting schedule</span>';
  const due = new Date(chore.next_due);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay - todayStart) / (1000 * 60 * 60 * 24));
  const status = choreDueStatus(chore);

  const dateStr = due.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (status === 'overdue') return `<span class="chore-due overdue">⚠️ Overdue (${dateStr}, ${Math.abs(diffDays)}d ago)</span>`;
  if (status === 'due-today') return `<span class="chore-due due-today">🔔 Due today</span>`;
  if (status === 'due-tomorrow') return `<span class="chore-due due-today">📅 Tomorrow (${dateStr})</span>`;
  if (status === 'due-soon') return `<span class="chore-due due-soon">📅 ${dateStr} (in ${diffDays}d)</span>`;
  return `<span class="chore-due on-track">✅ ${dateStr} (in ${diffDays}d)</span>`;
}

function getFilteredChoresForCategory(category) {
  let filtered = allChores.filter(c => (c.category || 'General') === (category || 'General'));
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
  document.querySelectorAll('.chore-filters .filter-btn').forEach(btn => {
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
  updateChoreStats();
}

function renderChoreCategoryCard(category) {
  const catName = category || 'General';
  const isGeneral = catName === 'General';
  const choresInCat = getFilteredChoresForCategory(category);
  const totalInCat = allChores.filter(c => (c.category || 'General') === catName).length;
  const overdueCount = allChores.filter(c => (c.category || 'General') === catName && choreDueStatus(c) === 'overdue').length;

  const catColor = getCategoryColor(catName);
  const statsText = `${totalInCat} chore${totalInCat !== 1 ? 's' : ''}` + (overdueCount > 0 ? ` · <span style="color:var(--red)">${overdueCount} overdue</span>` : '');

  const deleteBtn = !isGeneral
    ? `<button class="todo-cat-delete-btn" onclick="deleteChoreCategory('${esc(catName).replace(/'/g, "\\'")}')" title="Delete category">🗑️</button>`
    : '';

  const escapedCat = esc(catName).replace(/'/g, "\\'");

  const items = choresInCat.length === 0
    ? '<p class="empty-msg">No chores here</p>'
    : choresInCat.map(c => renderChoreItem(c)).join('');

  return `<div class="todo-category-card chore-category-card" data-category="${esc(catName)}">
    <div class="todo-cat-accent" style="background:${catColor}"></div>
    <div class="todo-cat-header">
      <div class="todo-cat-header-left">
        <div class="todo-cat-info">
          <h3 class="todo-cat-name">${esc(catName)}</h3>
          <span class="todo-cat-stats">${statsText}</span>
        </div>
      </div>
      <div class="todo-cat-header-actions">
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
  const status = choreDueStatus(chore);
  const dueHtml = formatChoreDue(chore);

  const lastDoneStr = lastDone
    ? `Last: ${lastDone.toLocaleDateString([], { month: 'short', day: 'numeric' })} (${formatChoreRelative(lastDone)})`
    : 'Never done';

  return `<div class="chore-item chore-status-${status}" data-chore-id="${chore.id}">
    <div class="chore-row">
      <div class="chore-info">
        <span class="chore-name">${esc(chore.name)}</span>
        <span class="chore-frequency">${esc(chore.frequency_rule)}</span>
      </div>
      <div class="chore-actions">
        <button onclick="openChoreDoneModal('${chore.id}')" title="Mark done" class="chore-done-btn">✅</button>
        <button onclick="openChoreHistory('${chore.id}')" title="History (${completionCount})" class="chore-history-btn">📋 ${completionCount}</button>
        <button onclick="openEditChoreModal('${chore.id}')" title="Edit">✏️</button>
        <button onclick="deleteChore('${chore.id}')" title="Delete">🗑️</button>
      </div>
    </div>
    <div class="chore-meta">
      ${dueHtml}
      <span class="chore-last-done">${lastDoneStr}</span>
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

function updateChoreStats() {
  const total = allChores.length;
  const overdue = allChores.filter(c => choreDueStatus(c) === 'overdue').length;
  const dueSoon = allChores.filter(c => ['due-today', 'due-tomorrow', 'due-soon'].includes(choreDueStatus(c))).length;
  const onTrack = allChores.filter(c => choreDueStatus(c) === 'on-track').length;

  const el = id => document.getElementById(id);
  if (el('statChoresTotal')) el('statChoresTotal').textContent = total;
  if (el('statChoresOverdue')) el('statChoresOverdue').textContent = overdue;
  if (el('statChoresDueSoon')) el('statChoresDueSoon').textContent = dueSoon;
  if (el('statChoresOnTrack')) el('statChoresOnTrack').textContent = onTrack;
}

// ===================================================================
// CHORE CRUD
// ===================================================================
function openAddChoreModal() {
  document.getElementById('newChoreName').value = '';
  document.getElementById('newChoreFrequency').value = '';
  document.getElementById('newChoreLastDone').value = '';
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

  if (!name) { showToast('Enter a chore name', 'error'); return; }
  if (!freq) { showToast('Enter a frequency rule', 'error'); return; }

  const { data, error } = await sb.from('chores').insert({ name, frequency_rule: freq, category: cat }).select().single();
  if (error) { showToast('Failed to add chore: ' + error.message, 'error'); return; }

  // If lastDone was provided, create an initial completion
  if (lastDoneVal && data && data.id) {
    await sb.from('chore_completions').insert({ chore_id: data.id, completed_at: new Date(lastDoneVal).toISOString() });
  }

  closeAddChoreModal();
  showToast(`Chore "${name}" added`, 'success');
  await refreshChores();
}

function openEditChoreModal(choreId) {
  const chore = allChores.find(c => c.id === choreId);
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

  const { error } = await sb.from('chores').update({ name, frequency_rule: freq, category: cat }).eq('id', id);
  if (error) { showToast('Update failed: ' + error.message, 'error'); return; }
  closeEditChoreModal();
  showToast('Chore updated', 'success');
  await refreshChores();
}

async function deleteChore(choreId) {
  const chore = allChores.find(c => c.id === choreId);
  if (!chore) return;
  showDeleteConfirm(
    'Delete Chore',
    `Delete "${chore.name}"? All completion history will be lost.`,
    async () => {
      const { error } = await sb.from('chores').delete().eq('id', choreId);
      if (error) { showToast('Delete failed', 'error'); return; }
      showToast('Chore deleted', 'info');
      await refreshChores();
    }
  );
}

// ===================================================================
// CHORE DONE FLOW
// ===================================================================
function openChoreDoneModal(choreId) {
  const chore = allChores.find(c => c.id === choreId);
  if (!chore) return;
  document.getElementById('choreDoneId').value = choreId;
  document.getElementById('choreDoneName').textContent = `🧹 ${chore.name}`;
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

  const { error } = await sb.from('chore_completions').insert(row);
  if (error) { showToast('Failed to record completion', 'error'); return; }
  closeChoreDoneModal();
  showToast('Chore done! ✅', 'success');
  await refreshChores();
}

// ===================================================================
// CHORE HISTORY
// ===================================================================
function openChoreHistory(choreId) {
  const chore = allChores.find(c => c.id === choreId);
  if (!chore) return;
  const completions = getChoreCompletions(choreId);
  document.getElementById('choreHistoryName').textContent = `🧹 ${chore.name} — ${chore.frequency_rule}`;

  if (completions.length === 0) {
    document.getElementById('choreHistoryList').innerHTML = '<p class="empty-msg">No completions recorded yet</p>';
  } else {
    const items = completions.map(comp => {
      const d = new Date(comp.completed_at);
      const dateStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const noteStr = comp.note ? ` — <em>${esc(comp.note)}</em>` : '';
      return `<div class="chore-history-item">
        <span class="chore-history-date">✅ ${dateStr} at ${timeStr}</span>
        ${noteStr}
      </div>`;
    }).join('');
    document.getElementById('choreHistoryList').innerHTML = items;
  }

  document.getElementById('choreHistoryModal').classList.add('visible');
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
  const choresInCat = allChores.filter(c => (c.category || 'General') === name);
  const msg = choresInCat.length > 0
    ? `Delete "${name}"? Its ${choresInCat.length} chore(s) will move to General.`
    : `Delete empty category "${name}"?`;

  showDeleteConfirm('Delete Category', msg, async () => {
    for (const c of choresInCat) {
      await sb.from('chores').update({ category: 'General' }).eq('id', c.id);
    }
    const cats = getChoreCategories();
    const idx = cats.findIndex(c => c === name);
    if (idx !== -1) { cats.splice(idx, 1); saveChoreCategories(cats); }
    showToast(`Category "${name}" deleted`, 'info');
    await refreshChores();
  });
}
