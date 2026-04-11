import { lucideIcon } from './icons.js';
import state from './supabase.js';

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
// STATS (Project legend counts)
// ===================================================================
function updateStats() {
  const tasks = state.allTasks;
  const counts = { todo: 0, 'in-progress': 0, review: 0, approved: 0, revision: 0, draft: 0 };
  tasks.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });
  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = `(${n || 0})`; };
  setCount('legendTodo', counts.todo);
  setCount('legendInProgress', counts['in-progress']);
  setCount('legendReview', counts.review);
  setCount('legendApproved', counts.approved);
  setCount('legendRevision', counts.revision);
  setCount('legendDraft', counts.draft);
}


// ===================================================================
// DELETE CONFIRMATION MODAL
// ===================================================================
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
// FOOTER STATS
// ===================================================================
// ===================================================================
function updateFooterStats() {
  document.getElementById('dbTaskCount').textContent = state.allTasks.length;
  document.getElementById('dbProjectCount').textContent = state.PROJECTS.length;
  // Set dashboard link using the connected URL
  const urlInput = document.getElementById('username');
  if (urlInput && urlInput.value) {
    const projectRef = urlInput.value.replace('https://', '').replace('.supabase.co', '');
    document.getElementById('supabaseDashLink').href = `https://supabase.com/dashboard/project/${projectRef}`;
  }
  // Fetch DB size via RPC
  if (state.sb) {
    state.sb.rpc('db_size_mb').then(({ data, error }) => {
      document.getElementById('dbSizeMb').textContent = error ? '?' : `${data} MB`;
    });
  }
}


// ===================================================================
// DYNAMIC TASK LIST HEIGHT
// ===================================================================
// ===================================================================
function updateTaskListMaxHeight() {
  const app = document.getElementById('app');
  if (!app || !app.classList.contains('active')) return;
  const header = document.querySelector('.app-header');
  const legend = document.querySelector('.legend');
  const footer = document.querySelector('.footer-stats');
  
  // Calculate occupied height (header + legend + footer + padding)
  const occupiedHeight = (header?.offsetHeight || 0) + 
    (legend?.offsetHeight || 0) + (footer?.offsetHeight || 0) + 80; // 80px for padding/margins
  
  const availableHeight = window.innerHeight - occupiedHeight;
  // Each card has ~80px overhead (header, add-task, archive toggle, padding)
  const cardOverhead = 100;
  const maxHeight = Math.max(300, availableHeight - cardOverhead);
  
  document.documentElement.style.setProperty('--task-list-max-height', maxHeight + 'px');
}

// Run on load and resize
window.addEventListener('resize', updateTaskListMaxHeight);



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

// Exports
export {
  esc, linkify, renderMd, showToast, formatRelativeDate,
  updateStats, showDeleteConfirm, closeDeleteConfirm, executeDeleteConfirm,
  updateFooterStats, updateTaskListMaxHeight,
};

window.closeDeleteConfirm = closeDeleteConfirm;
window.executeDeleteConfirm = executeDeleteConfirm;
