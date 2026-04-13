import { lucideIcon } from './icons.js';
import state from './supabase.js';
import { esc, showToast, showDeleteConfirm } from './utils.js';

// ===================================================================
// BIRTHDAYS — DATA, CRUD & RENDERING
// ===================================================================

async function refreshBirthdays() {
  if (!state.sb) return;
  const { data, error } = await state.sb
    .from('birthdays')
    .select('*')
    .order('birthday', { ascending: true });
  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast('Failed to load birthdays', 'error');
    return;
  }
  state.allBirthdays = data || [];
  if (state.currentView === 'birthdays') {
    renderBirthdays();
  }
}

// ===================================================================
// DATE HELPERS
// ===================================================================

function getNextBirthday(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const today = new Date();
  const thisYear = today.getFullYear();
  const todayStart = new Date(thisYear, today.getMonth(), today.getDate());

  let next = new Date(thisYear, bd.getMonth(), bd.getDate());
  if (next < todayStart) {
    next = new Date(thisYear + 1, bd.getMonth(), bd.getDate());
  }
  return next;
}

function daysUntilBirthday(birthdayStr) {
  const next = getNextBirthday(birthdayStr);
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((next - todayStart) / (1000 * 60 * 60 * 24));
}

function getAge(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const today = new Date();
  let age = today.getFullYear() - bd.getFullYear();
  const m = today.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < bd.getDate())) age--;
  return age;
}

function getTurningAge(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const next = getNextBirthday(birthdayStr);
  return next.getFullYear() - bd.getFullYear();
}

function formatBirthdayDate(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  return bd.toLocaleDateString([], { month: 'long', day: 'numeric' });
}

function formatBirthdayFull(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  return bd.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

// ===================================================================
// RENDERING
// ===================================================================

function renderBirthdays() {
  const grid = document.getElementById('birthdayGrid');
  if (!grid) return;

  const birthdays = [...state.allBirthdays];

  // Sort by next occurrence
  birthdays.sort((a, b) => {
    const dA = daysUntilBirthday(a.birthday);
    const dB = daysUntilBirthday(b.birthday);
    return dA - dB;
  });

  updateBirthdayStats(birthdays);

  if (birthdays.length === 0) {
    grid.innerHTML = `<div class="birthday-empty">
      ${lucideIcon('cake', 48, 'var(--muted)')}
      <p>No birthdays tracked yet</p>
      <button class="btn-primary" onclick="openAddBirthdayModal()">Add first birthday</button>
    </div>`;
    return;
  }

  // Separate into upcoming (next 30 days) and later
  const upcoming = birthdays.filter(b => daysUntilBirthday(b.birthday) <= 30);
  const later = birthdays.filter(b => daysUntilBirthday(b.birthday) > 30);

  let html = '';

  if (upcoming.length > 0) {
    html += `<div class="birthday-section">
      <h3 class="birthday-section-title">${lucideIcon('party-popper', 18)} Coming Up</h3>
      <div class="birthday-list">
        ${upcoming.map(b => renderBirthdayCard(b, true)).join('')}
      </div>
    </div>`;
  }

  if (later.length > 0) {
    html += `<div class="birthday-section">
      <h3 class="birthday-section-title">${lucideIcon('calendar', 18)} Later This Year</h3>
      <div class="birthday-list">
        ${later.map(b => renderBirthdayCard(b, false)).join('')}
      </div>
    </div>`;
  }

  grid.innerHTML = html;
}

function renderBirthdayCard(b, isUpcoming) {
  const days = daysUntilBirthday(b.birthday);
  const turning = getTurningAge(b.birthday);
  const dateStr = formatBirthdayDate(b.birthday);
  const noteHtml = b.note ? `<span class="birthday-note">${esc(b.note)}</span>` : '';

  let daysLabel;
  if (days === 0) {
    daysLabel = `<span class="birthday-countdown today">${lucideIcon('party-popper', 14)} Today!</span>`;
  } else if (days === 1) {
    daysLabel = `<span class="birthday-countdown tomorrow">Tomorrow</span>`;
  } else {
    daysLabel = `<span class="birthday-countdown ${isUpcoming ? 'soon' : ''}">${days}d</span>`;
  }

  const initial = (b.name || '?').charAt(0).toUpperCase();

  return `<div class="birthday-card ${days === 0 ? 'birthday-today' : ''} ${isUpcoming ? 'birthday-upcoming' : ''}" data-id="${b.id}">
    <div class="birthday-avatar">${initial}</div>
    <div class="birthday-info">
      <div class="birthday-name-row">
        <span class="birthday-name">${esc(b.name)}</span>
        ${daysLabel}
      </div>
      <div class="birthday-meta">
        <span class="birthday-date">${lucideIcon('cake', 14)} ${dateStr}</span>
        <span class="birthday-age">Turning ${turning}</span>
        ${noteHtml}
      </div>
    </div>
    <div class="birthday-actions">
      <button onclick="openEditBirthdayModal('${b.id}')" title="Edit">${lucideIcon('pencil', 16)}</button>
      <button onclick="deleteBirthday('${b.id}')" title="Delete">${lucideIcon('trash-2', 16)}</button>
    </div>
  </div>`;
}

function updateBirthdayStats(birthdays) {
  const total = birthdays ? birthdays.length : state.allBirthdays.length;
  const todayCount = (birthdays || state.allBirthdays).filter(b => daysUntilBirthday(b.birthday) === 0).length;
  const thisWeek = (birthdays || state.allBirthdays).filter(b => { const d = daysUntilBirthday(b.birthday); return d > 0 && d <= 7; }).length;
  const thisMonth = (birthdays || state.allBirthdays).filter(b => { const d = daysUntilBirthday(b.birthday); return d > 0 && d <= 30; }).length;

  const el = id => document.getElementById(id);
  if (el('statBirthdaysTotal')) el('statBirthdaysTotal').textContent = total;
  if (el('statBirthdaysToday')) el('statBirthdaysToday').textContent = todayCount;
  if (el('statBirthdaysWeek')) el('statBirthdaysWeek').textContent = thisWeek;
  if (el('statBirthdaysMonth')) el('statBirthdaysMonth').textContent = thisMonth;
}


// ===================================================================
// MODALS — ADD / EDIT
// ===================================================================

function initBirthdayModals() {
  const app = document.getElementById('app');

  // Add Birthday Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay';
  m1.id = 'addBirthdayModal';
  m1.innerHTML = `<div class="modal">
    <h2>${lucideIcon('cake', 20)} Add Birthday</h2>
    <label>Name</label>
    <input type="text" id="newBirthdayName" placeholder="e.g. Yassin, Maman..." maxlength="200"
      onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewBirthday();}">
    <label>Birthday</label>
    <input type="date" id="newBirthdayDate">
    <label>Note (optional)</label>
    <input type="text" id="newBirthdayNote" placeholder="e.g. Likes books, allergic to nuts..." maxlength="500">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeAddBirthdayModal()">Cancel</button>
      <button class="modal-save" onclick="saveNewBirthday()">Add</button>
    </div>
  </div>`;
  app.appendChild(m1);

  // Edit Birthday Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editBirthdayModal';
  m2.innerHTML = `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} Edit Birthday</h2>
    <input type="hidden" id="editBirthdayId">
    <label>Name</label>
    <input type="text" id="editBirthdayName" maxlength="200">
    <label>Birthday</label>
    <input type="date" id="editBirthdayDate">
    <label>Note (optional)</label>
    <input type="text" id="editBirthdayNote" maxlength="500">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeEditBirthdayModal()">Cancel</button>
      <button class="modal-save" onclick="saveEditBirthday()">Save</button>
    </div>
  </div>`;
  app.appendChild(m2);
}

// ===================================================================
// CRUD OPERATIONS
// ===================================================================

function openAddBirthdayModal() {
  document.getElementById('newBirthdayName').value = '';
  document.getElementById('newBirthdayDate').value = '';
  document.getElementById('newBirthdayNote').value = '';
  document.getElementById('addBirthdayModal').classList.add('visible');
  setTimeout(() => document.getElementById('newBirthdayName').focus(), 100);
}

function closeAddBirthdayModal() {
  document.getElementById('addBirthdayModal').classList.remove('visible');
}

async function saveNewBirthday() {
  const name = document.getElementById('newBirthdayName').value.trim();
  const date = document.getElementById('newBirthdayDate').value;
  const note = document.getElementById('newBirthdayNote').value.trim();

  if (!name) { showToast('Enter a name', 'error'); return; }
  if (!date) { showToast('Enter a birthday date', 'error'); return; }

  const row = { name, birthday: date };
  if (note) row.note = note;

  const { error } = await state.sb.from('birthdays').insert(row);
  if (error) { showToast('Failed to add birthday: ' + error.message, 'error'); return; }

  closeAddBirthdayModal();
  showToast(`🎂 ${name} added!`, 'success');
  await refreshBirthdays();
}

function openEditBirthdayModal(id) {
  const b = state.allBirthdays.find(x => x.id === id);
  if (!b) return;
  document.getElementById('editBirthdayId').value = id;
  document.getElementById('editBirthdayName').value = b.name;
  document.getElementById('editBirthdayDate').value = b.birthday;
  document.getElementById('editBirthdayNote').value = b.note || '';
  document.getElementById('editBirthdayModal').classList.add('visible');
  setTimeout(() => document.getElementById('editBirthdayName').focus(), 100);
}

function closeEditBirthdayModal() {
  document.getElementById('editBirthdayModal').classList.remove('visible');
}

async function saveEditBirthday() {
  const id = document.getElementById('editBirthdayId').value;
  const name = document.getElementById('editBirthdayName').value.trim();
  const date = document.getElementById('editBirthdayDate').value;
  const note = document.getElementById('editBirthdayNote').value.trim();

  if (!name) { showToast('Enter a name', 'error'); return; }
  if (!date) { showToast('Enter a birthday date', 'error'); return; }

  const { error } = await state.sb.from('birthdays').update({
    name, birthday: date, note: note || null, updated_at: new Date().toISOString()
  }).eq('id', id);
  if (error) { showToast('Update failed: ' + error.message, 'error'); return; }

  closeEditBirthdayModal();
  showToast('Birthday updated', 'success');
  await refreshBirthdays();
}

async function deleteBirthday(id) {
  const b = state.allBirthdays.find(x => x.id === id);
  if (!b) return;
  showDeleteConfirm(
    'Delete Birthday',
    `Remove ${b.name}'s birthday?`,
    async () => {
      const { error } = await state.sb.from('birthdays').delete().eq('id', id);
      if (error) { showToast('Delete failed', 'error'); return; }
      showToast('Birthday removed', 'info');
      await refreshBirthdays();
    }
  );
}


export { refreshBirthdays, renderBirthdays, initBirthdayModals };

// Window bindings for inline onclick handlers
window.openAddBirthdayModal = openAddBirthdayModal;
window.closeAddBirthdayModal = closeAddBirthdayModal;
window.saveNewBirthday = saveNewBirthday;
window.openEditBirthdayModal = openEditBirthdayModal;
window.closeEditBirthdayModal = closeEditBirthdayModal;
window.saveEditBirthday = saveEditBirthday;
window.deleteBirthday = deleteBirthday;
window.renderBirthdays = renderBirthdays;
