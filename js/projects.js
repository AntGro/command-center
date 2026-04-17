import { lucideIcon } from './icons.js';
import state, { ARCHIVED_PROJECTS_KEY, SHOW_ARCHIVED_KEY, MAX_TEXT_LEN, MAX_META_DISPLAY, TODO_MAX_LEN } from './supabase.js';
import { esc, linkify, renderMd, showToast, showDeleteConfirm,
         updateFooterStats, updateTaskListMaxHeight, truncateWithShowMore } from './utils.js';

// ===================================================================
// state.PROJECTS (loaded from Supabase)
// ===================================================================
// (state managed in supabase.js)

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
  updateArchiveToggleBtn();
  // Nav buttons don't change on archive toggle
}

function renderProjectNavButtons(projects) {
  const container = document.getElementById('projectNavButtons');
  if (!container) return;
  container.innerHTML = projects.map(p =>
    `<button class="category-nav-btn" style="--cat-color:${p.color};border-color:${p.color};color:${p.color}" onclick="navigateToProject('${p.id}')" title="Go to ${esc(p.name)}">${esc(p.shortname || p.name)}</button>`
  ).join('');
}

function navigateToProject(projectId) {
  const card = document.querySelector(`.project-card[data-project="${projectId}"]`);
  if (!card) return;
  const project = state.PROJECTS.find(p => p.id === projectId);
  const color = project ? project.color : 'var(--accent)';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.style.boxShadow = `0 0 0 2px ${color}`;
  setTimeout(() => { card.style.boxShadow = ''; }, 1500);
}

function updateArchiveToggleBtn() {
  const btn = document.getElementById('archiveToggleBtn');
  if (!btn) return;
  const active = isShowArchived();
  btn.innerHTML = active ? lucideIcon('folder-open') : lucideIcon('package');
  btn.title = active ? 'Hide archived' : 'Show archived';
  btn.classList.toggle('btn-active', active);
}

async function loadProjects() {
  const { data, error } = await state.sb.from('projects').select('*').order('sort_order', { ascending: true });
  if (error) { showToast('Failed to load projects', 'error'); return; }
  state.PROJECTS = (data || []).map(p => ({
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
  const taskCount = state.allTasks.filter(t => t.project === id).length;
  const detail = taskCount > 0 ? `This will also delete ${taskCount} task${taskCount > 1 ? 's' : ''} in this project.` : null;
  showDeleteConfirm(
    'Delete Project',
    `Delete "${name}"? This cannot be undone.`,
    async () => {
      await state.sb.from('tasks').delete().eq('project', id);
      await state.sb.from('prompts').delete().eq('key', id);
      const { error } = await state.sb.from('projects').delete().eq('id', id);
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
  const archivedProjects = state.PROJECTS.filter(p => archivedIds.includes(p.id));

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
  const visibleProjects = state.PROJECTS.filter(p => !archivedIds.includes(p.id));

  grid.innerHTML = visibleProjects.map(p => `
    <div class="project-card" data-project="${p.id}" style="--cat-color:${p.color}">
      <div class="project-card-header">
        <div style="display:flex;align-items:flex-start;gap:6px;">
          <div class="project-info">
            <h3><span class="project-title-copy" onclick="copyProjectTitle(event, '${esc(p.name)}')">${esc(p.name)}<span class="copy-tooltip">Copied!</span></span></h3>
            <span class="tech">${esc(p.tech || '')}</span>
          </div>
        </div>
        <div class="project-header-actions">
          ${p.links.map(l => `<a class="project-link" href="${l.url}" target="_blank">${l.label} ↗</a>`).join(' ')}
          <button class="expand-project-btn" onclick="toggleExpandProject('${p.id}')" title="Expand/collapse project" id="expand-btn-${p.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
          <button class="prompt-project-btn" onclick="openProjectPrompt('${p.id}')" title="Edit project prompt">${lucideIcon("file-text",16)}</button>
          <button class="archive-project-btn" onclick="openEditProjectModal('${p.id}')" title="Edit project">${lucideIcon("pencil",16)}</button>
          <button class="archive-project-btn" onclick="archiveProject('${p.id}')" title="Archive project">${lucideIcon("package")}</button>
        </div>
      </div>
      <div class="task-list" id="tasks-${p.id}"><p class="empty-msg">Loading...</p></div>
      <div class="archive-toggle" onclick="toggleArchivedTasks('${p.id}')" id="archive-toggle-${p.id}" style="display:none;">
        <span class="arrow" id="archive-arrow-${p.id}">▶</span> Archived tasks (<span id="archive-count-${p.id}">0</span>)
        <button class="delete-all-archived-btn" onclick="event.stopPropagation();deleteAllArchivedTasks('${p.id}')" title="Delete all archived tasks">${lucideIcon("trash-2",16)} Delete all</button>
      </div>
      <div class="archived-tasks" id="archived-tasks-${p.id}"></div>
      <div class="add-task">
        <textarea placeholder="Add task..." maxlength="${MAX_TEXT_LEN}" id="input-${p.id}" onkeydown="handleTaskInput(event,'${p.id}')" oninput="updateCharCounter(this)" rows="1" style="resize:none;overflow:hidden;"></textarea>
        <label class="draft-slider" title="Save as draft (personal note, not picked up by Claw)"><input type="checkbox" id="draft-${p.id}" onchange="this.parentElement.classList.toggle('active',this.checked)"><span class="draft-slider-track"><span class="draft-slider-thumb"></span></span><span class="draft-slider-label">Draft</span></label>
        <button onclick="addTask('${p.id}')">+</button>
      </div>
      <div class="char-counter" id="counter-${p.id}"></div>
    </div>
  `).join('');

  renderArchivedProjects();
  renderProjectNavButtons(visibleProjects);
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



// ===================================================================
// SUPABASE TASK CRUD
// ===================================================================
// (state managed in supabase.js)

async function refreshAll() {
  if (!state.sb || isDragging) return;
  const { data, error } = await state.sb.from('tasks').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true });
  if (error) { showToast('Failed to load tasks', 'error'); return; }
  const all = data || [];
  state.allTasks = all;
  renderAllTasks();
  updateFooterStats();
}

function renderAllTasks() {
  const archivedIds = getArchivedProjectIds();
  const visibleProjects = state.PROJECTS.filter(p => !archivedIds.includes(p.id));

  visibleProjects.forEach(p => {
    const container = document.getElementById(`tasks-${p.id}`);
    if (!container) return;
    const projectTasks = state.allTasks.filter(t => t.project === p.id);
    const activeTasks = projectTasks.filter(t => t.status !== 'approved');
    // Sort: non-draft tasks first, then drafts, preserving sort_order within each group
    activeTasks.sort((a, b) => {
      const aDraft = a.status === 'draft' ? 1 : 0;
      const bDraft = b.status === 'draft' ? 1 : 0;
      if (aDraft !== bDraft) return aDraft - bDraft;
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
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
  updateTaskListMaxHeight();
}

function toggleArchivedTasks(projectId) {
  const container = document.getElementById(`archived-tasks-${projectId}`);
  const arrow = document.getElementById(`archive-arrow-${projectId}`);
  container.classList.toggle('visible');
  arrow.classList.toggle('open');
}

async function deleteAllArchivedTasks(projectId) {
  const archivedTasks = state.allTasks.filter(t => t.project === projectId && t.status === 'approved');
  if (!archivedTasks.length) return;
  const project = state.PROJECTS.find(p => p.id === projectId);
  const name = project ? project.name : projectId;
  showDeleteConfirm(
    'Delete All Archived Tasks',
    `Delete all ${archivedTasks.length} archived task${archivedTasks.length > 1 ? 's' : ''} in "${name}"? This cannot be undone.`,
    async () => {
      for (const t of archivedTasks) {
        await state.sb.from('tasks').delete().eq('id', t.id);
      }
      showToast(`Deleted ${archivedTasks.length} archived task${archivedTasks.length > 1 ? 's' : ''}`, 'info');
      await refreshAll();
    }
  );
}


function renderTask(t, isArchived = false) {
  const isDraft = t.status === 'draft';
  let meta = '';
  if (t.plan_note) meta += `<div class="task-meta-item"><span class="task-meta-label plan">${lucideIcon("clipboard-list",16)} Plan:</span>${truncateWithShowMore(t.plan_note, MAX_META_DISPLAY, t.id, 'plan')}</div>`;
  if (t.hatch_response) meta += `<div class="task-meta-item response"><span class="task-meta-label claw">🪶 Claw:</span>${truncateWithShowMore(t.hatch_response, MAX_META_DISPLAY, t.id, 'response')}</div>`;

  let promoteBtn = '';
  let actionBtns = '';
  if (isDraft) {
    promoteBtn = `<button class="promote-btn" onclick="updateTaskStatus('${t.id}','todo')" title="Promote to task">▶ Todo</button>`;
  }
  if (t.status === 'review') {
    actionBtns += `<button onclick="updateTaskStatus('${t.id}','approved')" title="Approve">${lucideIcon("circle-check",16)}</button>`;
    actionBtns += `<button onclick="openRevisionModal('${t.id}')" title="Request Revision">${lucideIcon("refresh-cw",16)}</button>`;
  }
  if (t.status === 'approved' && isArchived) {
    actionBtns += `<button onclick="updateTaskStatus('${t.id}','todo')" title="Reopen">↩️</button>`;
  }
  actionBtns += `<button onclick="promptEditTask('${t.id}')" title="Edit">${lucideIcon("pencil",16)}</button>`;
  actionBtns += `<button onclick="deleteTask('${t.id}')" title="Delete">${lucideIcon("trash-2",16)}</button>`;

  const draftClass = isDraft ? ' task-draft' : '';

  return `<div class="task-item${draftClass} task-status-${t.status}" data-task-id="${t.id}">
    <div class="task-row">
      <span class="task-text" ondblclick="promptEditTask('${t.id}')">${renderMd(t.text)}</span>
      ${promoteBtn}
      <div class="task-actions">${actionBtns}</div>
    </div>
    ${meta ? `<div class="task-meta">${meta}</div>` : ''}
  </div>`;
}


// ===================================================================
// TASK HOVER DELAY
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


// ===================================================================
// DRAG & DROP REORDER
// ===================================================================
let isDragging = false;
const LONG_PRESS_MS = 250;
const DRAG_THRESHOLD = 5;

function initDragDrop(container, projectId) {
  let dragState = null;

  container.querySelectorAll('.task-item').forEach(item => {
    // Skip archived items (inside .archived-tasks)
    if (item.closest('.archived-tasks')) return;
    item.style.touchAction = 'pan-y';
    let pressTimer = null;
    let startX = 0, startY = 0;
    let activated = false;

    item.addEventListener('pointerdown', e => {
      // Don't initiate drag from interactive elements
      if (e.target.closest('button, a, input, textarea, select, .task-actions, .promote-btn')) return;
      if (dragState) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      pressTimer = setTimeout(() => {
        activated = true;
        e.preventDefault();
        const rect = item.getBoundingClientRect();
        isDragging = true;
        dragState = { el: item, id: item.dataset.taskId, offsetY: e.clientY - rect.top, clone: null, pointerId: e.pointerId };

        const clone = item.cloneNode(true);
        clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);background:var(--surface);border-radius:8px;border:2px solid var(--accent);transition:none;`;
        document.body.appendChild(clone);
        dragState.clone = clone;
        item.classList.add('dragging');
        item.setPointerCapture(e.pointerId);
      }, LONG_PRESS_MS);
    });

    item.addEventListener('pointermove', e => {
      // Cancel long-press if moved too far before activation
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

      container.querySelectorAll('.task-item:not(.dragging)').forEach(el => {
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
      container.querySelectorAll('.task-item').forEach(el => {
        if (el.classList.contains('drag-over')) { targetId = el.dataset.taskId; el.classList.remove('drag-over'); }
      });
      const draggedId = dragState.id;
      dragState = null;
      isDragging = false;
      if (targetId && targetId !== draggedId) await reorderTasks(container, projectId, draggedId, targetId);
    };

    item.addEventListener('pointerup', e => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      finishDrag();
    });
    item.addEventListener('pointercancel', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      finishDrag();
    });
    item.addEventListener('lostpointercapture', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
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

async function reorderTasks(container, projectId, draggedId, targetId) {
  const projectTasks = state.allTasks.filter(t => t.project === projectId && t.status !== 'approved');
  const draggedIdx = projectTasks.findIndex(t => t.id === draggedId);
  const targetIdx = projectTasks.findIndex(t => t.id === targetId);
  if (draggedIdx === -1 || targetIdx === -1) return;

  // Reorder in array
  const [dragged] = projectTasks.splice(draggedIdx, 1);
  projectTasks.splice(targetIdx, 0, dragged);

  // Update sort_order in memory
  projectTasks.forEach((t, i) => { t.sort_order = i; });
  // Also update in state.allTasks
  projectTasks.forEach(t => {
    const st = state.allTasks.find(x => x.id === t.id);
    if (st) st.sort_order = t.sort_order;
  });

  // Move DOM elements to match new order
  const items = Array.from(container.querySelectorAll('.task-item'));
  const ordered = projectTasks.map(t => items.find(el => el.dataset.taskId === t.id)).filter(Boolean);
  ordered.forEach(el => container.appendChild(el));

  // Re-init drag for this container
  initDragDrop(container, projectId);

  showToast('Reordered', 'success');

  // Background Supabase sync
  const updates = projectTasks.map((t, i) => ({ id: t.id, sort_order: i }));
  Promise.all(updates.map(u =>
    state.sb.from('tasks').update({ sort_order: u.sort_order }).eq('id', u.id)
  )).catch(e => console.error('Task reorder sync failed:', e));
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
  const projectTasks = state.allTasks.filter(t => t.project === projectId && t.status !== 'approved');
  const maxOrder = projectTasks.length > 0 ? Math.max(...projectTasks.map(t => t.sort_order || 0)) + 1 : 0;
  const status = isDraft ? 'draft' : 'todo';
  const { error } = await state.sb.from('tasks').insert({ project: projectId, text, status, sort_order: maxOrder });
  if (error) showToast('Failed to add task', 'error');
  else { showToast(isDraft ? 'Draft saved' : 'Task added', 'success'); await refreshAll(); }
}

async function updateTaskStatus(id, status) {
  const { error } = await state.sb.from('tasks').update({ status }).eq('id', id);
  if (error) showToast('Update failed', 'error');
  else { showToast(`Status → ${status}`, 'success'); await refreshAll(); }
}

async function promptEditTask(id) {
  const task = state.allTasks.find(t => t.id === id);
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
      const { error } = await state.sb.from('tasks').update({ text: trimmed }).eq('id', id);
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
      const { error } = await state.sb.from('tasks').delete().eq('id', id);
      if (error) showToast('Delete failed', 'error');
      else { showToast('Task deleted', 'success'); await refreshAll(); }
    }
  );
}


// ===================================================================
// ADD PROJECT MODAL
// ===================================================================
// ===================================================================
function openAddProjectModal() {
  document.getElementById('addProjectModal').classList.add('visible');
  document.getElementById('newProjectId').value = '';
  document.getElementById('newProjectName').value = '';
  document.getElementById('newProjectShortname').value = '';
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
  const shortname = document.getElementById('newProjectShortname').value.trim() || null;
  const color = document.getElementById('newProjectColor').value;
  const tech = document.getElementById('newProjectTech').value.trim();
  const github = document.getElementById('newProjectGithub').value.trim();
  const live = document.getElementById('newProjectLive').value.trim();

  if (!id || !name) { showToast('ID and Name are required', 'error'); return; }
  if (state.PROJECTS.find(p => p.id === id)) { showToast('Project ID already exists', 'error'); return; }

  const links = [];
  if (github) links.push({ label: 'GitHub', url: github });
  if (live) links.push({ label: 'Live', url: live });

  const maxOrder = state.PROJECTS.length > 0 ? Math.max(...state.PROJECTS.map(p => p.sort_order || 0)) + 1 : 0;

  const { error } = await state.sb.from('projects').insert({ id, name, shortname, color, tech, links, sort_order: maxOrder });
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
  let dragState = null;

  cards.forEach(card => {
    const header = card.querySelector('.project-card-header');
    if (!header) return;

    let pressTimer = null;
    let startX = 0, startY = 0;
    let activated = false;

    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a, input, textarea, select, .project-header-actions')) return;
      if (dragState) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      pressTimer = setTimeout(() => {
        activated = true;
        const rect = card.getBoundingClientRect();
        isDragging = true;
        dragState = { el: card, id: card.dataset.project, offsetY: e.clientY - rect.top, offsetX: e.clientX - rect.left, clone: null, pointerId: e.pointerId };

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
      let targetId = null;
      grid.querySelectorAll('.project-card').forEach(el => {
        if (el.classList.contains('drag-over')) { targetId = el.dataset.project; el.classList.remove('drag-over'); }
      });
      const draggedId = dragState.id;
      dragState = null;
      isDragging = false;
      if (targetId && targetId !== draggedId) await reorderProjects(draggedId, targetId);
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

async function reorderProjects(draggedId, targetId) {
  const grid = document.getElementById('projectGrid');
  const archivedIds = getArchivedProjectIds();
  const visible = state.PROJECTS.filter(p => !archivedIds.includes(p.id));
  const draggedIdx = visible.findIndex(p => p.id === draggedId);
  const targetIdx = visible.findIndex(p => p.id === targetId);
  if (draggedIdx === -1 || targetIdx === -1) return;
  const [dragged] = visible.splice(draggedIdx, 1);
  visible.splice(targetIdx, 0, dragged);

  // Update sort_order in memory
  visible.forEach((p, i) => { p.sort_order = i; });
  visible.forEach(p => {
    const sp = state.PROJECTS.find(x => x.id === p.id);
    if (sp) sp.sort_order = p.sort_order;
  });
  state.PROJECTS.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  // Move DOM elements
  const cards = Array.from(grid.querySelectorAll('.project-card'));
  visible.forEach(p => {
    const card = cards.find(c => c.dataset.project === p.id);
    if (card) grid.appendChild(card);
  });

  // Re-init drag
  initProjectDragDrop();
  showToast('Projects reordered', 'success');

  // Background Supabase sync
  Promise.all(visible.map((p, i) =>
    state.sb.from('projects').update({ sort_order: i }).eq('id', p.id)
  )).catch(e => console.error('Project reorder sync failed:', e));
}


// ===================================================================
// EDIT PROJECT MODAL
// ===================================================================
function openEditProjectModal(id) {
  const p = state.PROJECTS.find(pr => pr.id === id);
  if (!p) return;
  document.getElementById('editProjectId').value = p.id;
  document.getElementById('editProjectName').value = p.name;
  document.getElementById('editProjectShortname').value = p.shortname || '';
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
  const shortname = document.getElementById('editProjectShortname').value.trim() || null;
  const color = document.getElementById('editProjectColor').value;
  const tech = document.getElementById('editProjectTech').value.trim();
  const github = document.getElementById('editProjectGithub').value.trim();
  const live = document.getElementById('editProjectLive').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  const links = [];
  if (github) links.push({ label: 'GitHub', url: github });
  if (live) links.push({ label: 'Live', url: live });
  const { error } = await state.sb.from('projects').update({ name, shortname, color, tech, links }).eq('id', id);
  if (error) { showToast('Update failed: ' + (error.message || ''), 'error'); return; }
  closeEditProjectModal();
  await loadProjects();
  buildProjectCards();
  initProjectDragDrop();
  await refreshAll();
  showToast(`Project "${name}" updated`, 'success');
}

// ===================================================================

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
// EXPAND TASK VIEW (modal)
// ===================================================================
function expandTask(id) {
  const t = state.allTasks.find(task => task.id === id);
  if (!t) return;
  const project = state.PROJECTS.find(p => p.id === t.project);
  const content = document.getElementById('taskExpandContent');
  let meta = '';
  if (t.plan_note) meta += `<div class="task-full-meta-item"><strong style="color:var(--accent);">${lucideIcon("clipboard-list",16)} Plan:</strong><br>${renderMd(t.plan_note)}</div>`;
  if (t.hatch_response) meta += `<div class="task-full-meta-item response"><strong style="color:var(--yellow);">🪶 Claw:</strong><br>${renderMd(t.hatch_response)}</div>`;

  let actions = '';
  if (t.status === 'review') {
    actions = `<div style="display:flex;gap:8px;margin-top:12px;"><button class="btn" onclick="updateTaskStatus('${t.id}','approved');closeTaskExpandModal();">${lucideIcon("circle-check",16)} Approve</button><button class="btn" onclick="closeTaskExpandModal();openRevisionModal('${t.id}');">${lucideIcon("refresh-cw",16)} Revision</button></div>`;
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
    const task = state.allTasks.find(t => t.id === taskId);
    const existing = task?.plan_note || '';
    updates.plan_note = `[REVISION FEEDBACK]: ${feedback}\n\n${existing}`.slice(0, 5000);
  }

  const { error } = await state.sb.from('tasks').update(updates).eq('id', taskId);
  if (error) { showToast('Update failed', 'error'); return; }
  closeRevisionModal();
  showToast('Revision requested' + (feedback ? ' with feedback' : ''), 'success');
  await refreshAll();
}


// ===================================================================
// TASK-PICKUP PROMPT EDITOR (Supabase-backed)
// ===================================================================
// ===================================================================
let promptsCache = {};

async function loadPrompts() {
  if (!state.sb) return;
  const { data, error } = await state.sb.from('prompts').select('*');
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
  await state.sb.from('prompts').upsert({ key: 'global', text }, { onConflict: 'key' });
  promptsCache['global'] = text;
  closePromptEditor();
  showToast('Global prompt saved', 'success');
}

// Per-project prompt (card button)
async function openProjectPrompt(projectId) {
  await loadPrompts();
  const project = state.PROJECTS.find(p => p.id === projectId);
  document.getElementById('projectPromptTitle').innerHTML = `${lucideIcon("file-text",20)} ${project ? project.name : projectId} Prompt`;
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
    await state.sb.from('prompts').upsert({ key: projectId, text }, { onConflict: 'key' });
    promptsCache[projectId] = text;
  } else {
    await state.sb.from('prompts').delete().eq('key', projectId);
    delete promptsCache[projectId];
  }
  closeProjectPrompt();
  showToast('Project prompt saved', 'success');
}



// ===================================================================
// TEXTAREA AUTO-RESIZE + SHIFT+ENTER
// ===================================================================
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
export {
  loadProjects, buildProjectCards, initProjectDragDrop, updateArchiveToggleBtn,
  renderArchivedProjects, refreshAll, getArchivedProjectIds, loadPrompts,
};

window.addTask = addTask;
window.updateTaskStatus = updateTaskStatus;
window.promptEditTask = promptEditTask;
window.deleteTask = deleteTask;
window.toggleArchivedTasks = toggleArchivedTasks;
window.deleteAllArchivedTasks = deleteAllArchivedTasks;

window.archiveProject = archiveProject;
window.unarchiveProject = unarchiveProject;
window.deleteProject = deleteProject;
window.copyProjectTitle = copyProjectTitle;
window.navigateToProject = navigateToProject;
window.toggleShowArchived = toggleShowArchived;
window.toggleExpandProject = toggleExpandProject;
window.closeTaskExpandModal = closeTaskExpandModal;
window.openAddProjectModal = openAddProjectModal;
window.closeAddProjectModal = closeAddProjectModal;
window.saveNewProject = saveNewProject;
window.openEditProjectModal = openEditProjectModal;
window.closeEditProjectModal = closeEditProjectModal;
window.saveEditProject = saveEditProject;
window.openRevisionModal = openRevisionModal;
window.closeRevisionModal = closeRevisionModal;
window.submitRevision = submitRevision;
window.openPromptEditor = openPromptEditor;
window.closePromptEditor = closePromptEditor;
window.saveGlobalPrompt = saveGlobalPrompt;
window.openProjectPrompt = openProjectPrompt;
window.closeProjectPrompt = closeProjectPrompt;
window.saveProjectPrompt = saveProjectPrompt;
window.updateCharCounter = updateCharCounter;
window.handleTaskInput = handleTaskInput;
window.refreshAll = refreshAll;
