// ===================================================================
// CONSTANTS
// ===================================================================
const IDEAS_KEY = 'claw_cc_ideas';
const THEME_KEY = 'claw_cc_theme';
const ARCHIVED_PROJECTS_KEY = 'claw_cc_archived_projects';
const SHOW_ARCHIVED_KEY = 'claw_cc_show_archived';
const MAX_TEXT_LEN = 5000;
const MAX_META_DISPLAY = 500;

// ===================================================================
// GATE LOGIC — simple URL + key, Chrome autofill handles persistence
// ===================================================================
function initGate() {
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

async function doLogin() {
  const url = document.getElementById('username').value.trim();
  const key = document.getElementById('password').value.trim();
  const err = document.getElementById('loginError');
  if (!url || !key) { err.textContent = 'Enter both URL and key'; return; }
  err.textContent = 'Connecting...';
  try {
    await connect(url, key);
    err.textContent = '';
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
  populateIdeaProjectSelect();
  await refreshAll();

  // Realtime subscription
  sb.channel('tasks-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => refreshAll())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, async () => { await loadProjects(); buildProjectCards(); initProjectDragDrop(); populateIdeaProjectSelect(); await refreshAll(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'prompts' }, () => loadPrompts())
    .subscribe();
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
  buildProjectCards();
  renderArchivedProjects();
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
  populateIdeaProjectSelect();
  renderArchivedProjects();
  await refreshAll();
  showToast('Project archived', 'info');
}

async function unarchiveProject(id) {
  const ids = getArchivedProjectIds().filter(i => i !== id);
  saveArchivedProjectIds(ids);
  buildProjectCards();
  initProjectDragDrop();
  populateIdeaProjectSelect();
  renderArchivedProjects();
  await refreshAll();
  showToast('Project restored', 'success');
}

async function deleteProject(id, name) {
  if (!confirm(`Delete project "${name}" and ALL its tasks? This cannot be undone.`)) return;
  // Delete all tasks for this project first
  await sb.from('tasks').delete().eq('project', id);
  // Delete project prompts
  await sb.from('prompts').delete().eq('key', id);
  // Delete the project
  const { error } = await sb.from('projects').delete().eq('id', id);
  if (error) { showToast('Failed to delete project: ' + error.message, 'error'); return; }
  // Remove from archived list
  const ids = getArchivedProjectIds().filter(i => i !== id);
  saveArchivedProjectIds(ids);
  await loadProjects();
  buildProjectCards();
  renderArchivedProjects();
  initProjectDragDrop();
  showToast(`Project "${name}" deleted`, 'info');
}

function renderArchivedProjects() {
  const section = document.getElementById('archivedProjectsSection');
  const list = document.getElementById('archivedProjectsList');
  const archivedIds = getArchivedProjectIds();
  const archivedProjects = PROJECTS.filter(p => archivedIds.includes(p.id));

  if (!archivedProjects.length || !isShowArchived()) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
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
      </div>
      <div class="archived-tasks" id="archived-tasks-${p.id}"></div>
      <div class="add-task">
        <textarea placeholder="Add task..." maxlength="${MAX_TEXT_LEN}" id="input-${p.id}" onkeydown="handleTaskInput(event,'${p.id}')" oninput="updateCharCounter(this)" rows="1" style="resize:none;overflow:hidden;"></textarea>
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

function populateIdeaProjectSelect() {
  const sel = document.getElementById('ideaProject');
  sel.innerHTML = '<option value="">No project</option>';
  PROJECTS.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
}

// ===================================================================
// SUPABASE TASK CRUD
// ===================================================================
let allTasks = [];

async function refreshAll() {
  if (!sb) return;
  const { data, error } = await sb.from('tasks').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true });
  if (error) { showToast('Failed to load tasks', 'error'); return; }
  allTasks = data || [];
  renderAllTasks();
  renderIdeas();
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
    else { container.innerHTML = activeTasks.map(t => renderTask(t)).join(''); initDragDrop(container, p.id); }

    // Archived tasks toggle
    const toggleEl = document.getElementById(`archive-toggle-${p.id}`);
    const archivedContainer = document.getElementById(`archived-tasks-${p.id}`);
    const countEl = document.getElementById(`archive-count-${p.id}`);
    if (archivedTasks.length > 0) {
      toggleEl.style.display = 'flex';
      countEl.textContent = archivedTasks.length;
      archivedContainer.innerHTML = archivedTasks.map(t => renderTask(t, true)).join('');
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

function truncateWithShowMore(text, maxLen, id, field) {
  if (!text || text.length <= maxLen) return linkify(esc(text || ''));
  const truncated = linkify(esc(text.slice(0, maxLen))) + '…';
  return `<span id="meta-${id}-${field}-short">${truncated} <button class="show-more-btn" onclick="expandMeta('${id}','${field}')">show more</button></span><span id="meta-${id}-${field}-full" style="display:none;">${linkify(esc(text))} <button class="show-more-btn" onclick="collapseMeta('${id}','${field}')">show less</button></span>`;
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
  let meta = '';
  if (t.plan_note) meta += `<div class="task-meta-item"><span class="task-meta-label plan">📋 Plan:</span>${truncateWithShowMore(t.plan_note, MAX_META_DISPLAY, t.id, 'plan')}</div>`;
  if (t.hatch_response) meta += `<div class="task-meta-item response"><span class="task-meta-label claw">🪶 Claw:</span>${truncateWithShowMore(t.hatch_response, MAX_META_DISPLAY, t.id, 'resp')}</div>`;

  let actionBtns = '';
  if (t.status === 'review') {
    actionBtns += `<button onclick="updateTaskStatus('${t.id}','approved')" title="Approve">✅</button>`;
    actionBtns += `<button onclick="openRevisionModal('${t.id}')" title="Request Revision">🔄</button>`;
  }
  if (t.status === 'approved' && isArchived) {
    actionBtns += `<button onclick="updateTaskStatus('${t.id}','todo')" title="Reopen">↩️</button>`;
  }
  actionBtns += `<button onclick="promptEditTask('${t.id}')" title="Edit">✏️</button>`;
  actionBtns += `<button onclick="deleteTask('${t.id}')" title="Delete">🗑️</button>`;

  // draggable set dynamically via handle mousedown/mouseup
  const dragHandle = !isArchived ? '<span class="drag-handle" title="Drag to reorder" >⠿</span>' : '';

  return `<div class="task-item" data-task-id="${t.id}">
    <div class="task-row">
      ${dragHandle}
      <span class="status-dot ${t.status}"></span>
      <span class="task-text">${esc(t.text)}</span>
      <div class="task-actions">${actionBtns}</div>
    </div>
    ${meta ? `<div class="task-meta">${meta}</div>` : ''}
  </div>`;
}

// ===================================================================
// DRAG & DROP REORDER
// ===================================================================
function initDragDrop(container, projectId) {
  const items = container.querySelectorAll('.task-item');
  items.forEach(item => {
    // Handle-only dragging
    const handle = item.querySelector('.drag-handle');
    if (handle) {
      handle.addEventListener('mousedown', () => { item.setAttribute('draggable', 'true'); });
      item.addEventListener('mouseup', () => { item.removeAttribute('draggable'); });
      item.addEventListener('mouseleave', () => { item.removeAttribute('draggable'); });
    }
    item.addEventListener('dragstart', e => {
      item.classList.add('dragging');
      e.dataTransfer.setData('text/plain', item.dataset.taskId);
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      container.querySelectorAll('.task-item').forEach(i => i.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragging = container.querySelector('.dragging');
      if (dragging && item !== dragging) {
        item.classList.add('drag-over');
      }
    });
    item.addEventListener('dragleave', () => { item.classList.remove('drag-over'); });
    item.addEventListener('drop', async e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      const targetId = item.dataset.taskId;
      if (draggedId === targetId) return;
      await reorderTasks(projectId, draggedId, targetId);
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
  input.value = '';
  const counter = document.getElementById(`counter-${projectId}`);
  if (counter) counter.textContent = '';
  // Get max sort_order for this project
  const projectTasks = allTasks.filter(t => t.project === projectId && t.status !== 'approved');
  const maxOrder = projectTasks.length > 0 ? Math.max(...projectTasks.map(t => t.sort_order || 0)) + 1 : 0;
  const { error } = await sb.from('tasks').insert({ project: projectId, text, status: 'todo', sort_order: maxOrder });
  if (error) showToast('Failed to add task', 'error');
  else { showToast('Task added', 'success'); await refreshAll(); }
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
  input.rows = Math.max(1, originalText.split('\n').length);
  input.style.resize = 'none';
  input.style.overflow = 'hidden';

  const finishEdit = async (save) => {
    if (save && input.value.trim() && input.value.trim() !== originalText) {
      const trimmed = input.value.trim().slice(0, MAX_TEXT_LEN);
      const { error } = await sb.from('tasks').update({ text: trimmed }).eq('id', id);
      if (error) showToast('Update failed', 'error');
      else showToast('Task updated', 'success');
    }
    delete textSpan.dataset.editing;
    await refreshAll();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  });
  input.addEventListener('blur', () => finishEdit(true));

  textSpan.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  const { error } = await sb.from('tasks').delete().eq('id', id);
  if (error) showToast('Delete failed', 'error');
  else { showToast('Task deleted', 'success'); await refreshAll(); }
}

// ===================================================================
// IDEAS (localStorage + ship to Supabase)
// ===================================================================
function getIdeas() { try { return JSON.parse(localStorage.getItem(IDEAS_KEY) || '[]'); } catch { return []; } }
function saveIdeas(ideas) { localStorage.setItem(IDEAS_KEY, JSON.stringify(ideas)); }

function addIdea() {
  const input = document.getElementById('ideaInput');
  const project = document.getElementById('ideaProject').value;
  const text = input.value.trim();
  if (!text) return;
  if (text.length > MAX_TEXT_LEN) { showToast(`Max ${MAX_TEXT_LEN} characters`, 'error'); return; }
  input.value = '';
  const ideas = getIdeas();
  ideas.push({ id: crypto.randomUUID(), text, project: project || 'general', status: 'idea', created: Date.now() });
  saveIdeas(ideas);
  renderIdeas();
  updateStats();
  showToast('Idea added 💡', 'success');
}

function renderIdeas() {
  const container = document.getElementById('ideaList');
  const ideas = getIdeas();
  if (!ideas.length) { container.innerHTML = '<p class="empty-msg">No ideas yet — throw some in!</p>'; return; }
  container.innerHTML = ideas.map(idea => {
    const projName = PROJECTS.find(p => p.id === idea.project)?.name || idea.project;
    let statusTag = '';
    if (idea.status === 'shipped') statusTag = '<span style="color:var(--accent);font-size:0.72rem;font-weight:600;margin-right:6px;">🪶 Shipped</span>';
    if (idea.status === 'plan-requested') statusTag = '<span style="color:var(--yellow);font-size:0.72rem;font-weight:600;margin-right:6px;">📋 Plan Requested</span>';
    return `<div class="idea-item">
      ${statusTag}
      <span class="idea-text">${esc(idea.text)}</span>
      <span class="idea-project">${esc(projName)}</span>
      <div class="idea-actions">
        ${idea.status === 'idea' ? `
          <button class="ship-btn" onclick="shipIdea('${idea.id}')" title="Ship to Claw">🪶 Ship</button>
          <button class="plan-btn" onclick="planIdea('${idea.id}')" title="Request Plan">📋 Plan</button>
        ` : ''}
        <button class="del-btn" onclick="deleteIdea('${idea.id}')" title="Delete">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function shipIdea(id) {
  const ideas = getIdeas();
  const idea = ideas.find(i => i.id === id);
  if (!idea) return;
  const { error } = await sb.from('tasks').insert({ project: idea.project, text: idea.text, status: 'todo' });
  if (error) { showToast('Failed to ship', 'error'); return; }
  idea.status = 'shipped';
  saveIdeas(ideas);
  renderIdeas();
  updateStats();
  await refreshAll();
  showToast('Shipped 🪶 — task created', 'success');
}

async function planIdea(id) {
  const ideas = getIdeas();
  const idea = ideas.find(i => i.id === id);
  if (!idea) return;
  const { error } = await sb.from('tasks').insert({ project: idea.project, text: '[PLAN REQUEST] ' + idea.text, status: 'todo' });
  if (error) { showToast('Failed', 'error'); return; }
  idea.status = 'plan-requested';
  saveIdeas(ideas);
  renderIdeas();
  updateStats();
  await refreshAll();
  showToast('Plan requested 📋 — task created', 'success');
}

function deleteIdea(id) {
  const ideas = getIdeas().filter(i => i.id !== id);
  saveIdeas(ideas);
  renderIdeas();
  updateStats();
  showToast('Idea removed', 'info');
}

// ===================================================================
// STATS
// ===================================================================
function updateStats() {
  const tasks = allTasks;
  const ideas = getIdeas();
  const archivedIds = getArchivedProjectIds();
  document.getElementById('statProjects').textContent = PROJECTS.filter(p => !archivedIds.includes(p.id)).length;
  document.getElementById('statTasks').textContent = tasks.filter(t => t.status !== 'approved').length;
  document.getElementById('statReview').textContent = tasks.filter(t => t.status === 'review').length;
  document.getElementById('statIdeas').textContent = ideas.length;
}

// ===================================================================
// UTILS
// ===================================================================
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function linkify(html) { return html.replace(/https?:\/\/[^\s<&]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`); }

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
  populateIdeaProjectSelect();
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
  populateIdeaProjectSelect();
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
  if (t.plan_note) meta += `<div class="task-full-meta-item"><strong style="color:var(--accent);">📋 Plan:</strong><br>${linkify(esc(t.plan_note))}</div>`;
  if (t.hatch_response) meta += `<div class="task-full-meta-item response"><strong style="color:var(--yellow);">🪶 Claw:</strong><br>${linkify(esc(t.hatch_response))}</div>`;

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

// Close modals on overlay click / Escape
document.addEventListener('click', e => {
  if (e.target.id === 'editProjectModal') closeEditProjectModal();
  if (e.target.id === 'taskExpandModal') closeTaskExpandModal();
  if (e.target.id === 'revisionModal') closeRevisionModal();
  if (e.target.id === 'promptEditorModal') closePromptEditor();
  if (e.target.id === 'projectPromptModal') closeProjectPrompt();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAddProjectModal(); closeEditProjectModal(); closeTaskExpandModal(); closeRevisionModal(); closePromptEditor(); closeProjectPrompt(); }
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
  document.getElementById('revisionFeedback').focus();
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
  const ideasSection = document.querySelector('.ideas-section');
  
  // Calculate occupied height (header + stats + legend + footer + ideas + padding)
  const occupiedHeight = (header?.offsetHeight || 0) + (statsBar?.offsetHeight || 0) + 
    (legend?.offsetHeight || 0) + (footer?.offsetHeight || 0) + 
    (ideasSection?.offsetHeight || 0) + 80; // 80px for padding/margins
  
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
