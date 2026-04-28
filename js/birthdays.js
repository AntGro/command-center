import { lucideIcon } from './icons.js';
import state from './supabase.js';
import { esc, showToast, showDeleteConfirm } from './utils.js';
import { scrollToAndHighlight, initItemHoverDelay, inlineEditText } from './item-utils.js';
import { t, getLang } from './i18n.js';

// ===================================================================
// BIRTHDAYS — DATA, CRUD & RENDERING
// ===================================================================

let birthdaySearchQuery = '';

async function refreshBirthdays() {
  if (!state.db.connected) return;
  const { data, error } = await state.db
    .from('birthdays')
    .select('*')
    .order('birthday', { ascending: true });
  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
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
  return bd.toLocaleDateString(getLang(), { month: 'long', day: 'numeric' });
}

function formatBirthdayFull(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  return bd.toLocaleDateString(getLang(), { month: 'long', day: 'numeric', year: 'numeric' });
}

// ===================================================================
// RENDERING
// ===================================================================

function renderBirthdays() {
  const grid = document.getElementById('birthdayGrid');
  if (!grid) return;

  let birthdays = [...state.allBirthdays];

  // Apply search filter
  if (birthdaySearchQuery) {
    const q = birthdaySearchQuery.toLowerCase();
    birthdays = birthdays.filter(b => b.name && b.name.toLowerCase().includes(q));
  }

  // Sort by next occurrence
  birthdays.sort((a, b) => {
    const dA = daysUntilBirthday(a.birthday);
    const dB = daysUntilBirthday(b.birthday);
    return dA - dB;
  });


  if (birthdays.length === 0) {
    grid.innerHTML = `<div class="birthday-empty">
      ${lucideIcon('cake', 48, 'var(--muted)')}
      <p>No birthdays tracked yet</p>
      <button class="btn-primary" onclick="openAddBirthdayModal()">${t('birthdays.add_first')}</button>
    </div>`;
    document.getElementById('birthdayNavButtons').innerHTML = '';
    return;
  }

  // Separate into upcoming (next 30 days) and later
  const upcoming = birthdays.filter(b => daysUntilBirthday(b.birthday) <= 30);
  const later = birthdays.filter(b => daysUntilBirthday(b.birthday) > 30);

  // Build ordered sections: "Coming Up" + month groups
  const sections = [];
  if (upcoming.length > 0) {
    sections.push({ key: 'upcoming', label: 'Coming Up', icon: 'party-popper', items: upcoming, isUpcoming: true });
  }

  if (later.length > 0) {
    const monthGroups = {};
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    for (const b of later) {
      const next = getNextBirthday(b.birthday);
      const key = `${next.getFullYear()}-${String(next.getMonth()).padStart(2,'0')}`;
      const label = `${monthNames[next.getMonth()]} ${next.getFullYear()}`;
      const shortLabel = `${monthNames[next.getMonth()].slice(0,3)} ${String(next.getFullYear()).slice(2)}`;
      if (!monthGroups[key]) monthGroups[key] = { label, shortLabel, items: [] };
      monthGroups[key].items.push(b);
    }
    const sortedKeys = Object.keys(monthGroups).sort();
    for (const key of sortedKeys) {
      const grp = monthGroups[key];
      sections.push({ key, label: grp.label, shortLabel: grp.shortLabel, icon: 'calendar', items: grp.items, isUpcoming: false });
    }
  }

  // Generate gradient colors — rotate hue across sections for continuity
  // Start at warm orange (25°), end at cool blue-purple (260°)
  const totalSections = sections.length;
  const hueStart = 25;
  const hueEnd = 260;
  for (let i = 0; i < totalSections; i++) {
    const hue = totalSections === 1 ? hueStart : Math.round(hueStart + (hueEnd - hueStart) * (i / (totalSections - 1)));
    sections[i].color = `hsl(${hue}, 70%, 55%)`;
  }

  // Render nav buttons
  const navContainer = document.getElementById('birthdayNavButtons');
  navContainer.innerHTML = sections.map(s => {
    const display = s.isUpcoming ? t('birthdays.soon') : (s.shortLabel || s.label);
    return `<button class="category-nav-btn" style="--cat-color:${s.color};border-color:${s.color};color:${s.color}" onclick="navigateToBirthdaySection('${s.key}')" title="${s.label}">${display}</button>`;
  }).join('');

  // Render grid
  let html = '';
  for (const s of sections) {
    html += `<div class="project-card" style="--cat-color:${s.color}" data-birthday-section="${s.key}">
      <div class="project-card-header">
        <div class="project-title">${lucideIcon(s.icon, 18)} ${s.label}</div>
        <span class="birthday-bucket-count">${s.items.length}</span>
      </div>
      <div class="task-list birthday-bucket-list">
        ${s.items.map(b => renderBirthdayCard(b, s.isUpcoming)).join('')}
      </div>
    </div>`;
  }

  grid.innerHTML = html;
  initBirthdayHoverDelay(grid);
}

function initBirthdayHoverDelay(container) {
  initItemHoverDelay(container, {
    itemSelector: '.birthday-card',
    actionsSelector: '.birthday-actions',
    rowSelector: '.birthday-info',
    textSelector: '.birthday-name',
    onDblClick: (item) => {
      const id = item.dataset.id;
      if (id) editBirthdayInline(id);
    },
  });
}

function navigateToBirthdaySection(key) {
  const card = document.querySelector(`[data-birthday-section="${key}"]`);
  scrollToAndHighlight(card, null);
}

function renderBirthdayCard(b, isUpcoming) {
  const days = daysUntilBirthday(b.birthday);
  const turning = getTurningAge(b.birthday);
  const dateStr = formatBirthdayDate(b.birthday);
  const noteHtml = b.note ? `<span class="birthday-note">${esc(b.note)}</span>` : '';

  let daysLabel;
  if (days === 0) {
    daysLabel = `<span class="birthday-countdown today">${lucideIcon('party-popper', 14)} ${t('birthdays.today')}</span>`;
  } else if (days === 1) {
    daysLabel = `<span class="birthday-countdown tomorrow">${t('birthdays.tomorrow')}</span>`;
  } else {
    daysLabel = `<span class="birthday-countdown ${isUpcoming ? 'soon' : ''}">${days}d</span>`;
  }

  const initial = (b.name || '?').charAt(0).toUpperCase();

  return `<div class="bucket-item birthday-card ${days === 0 ? 'birthday-today' : ''} ${isUpcoming ? 'birthday-upcoming' : ''}" data-id="${b.id}">
    <div class="birthday-avatar">${initial}</div>
    <div class="birthday-info">
      <div class="birthday-name-row">
        <span class="birthday-name">${esc(b.name)}</span>
        ${daysLabel}
      </div>
      <div class="birthday-meta">
        <span class="birthday-date">${lucideIcon('cake', 14)} ${dateStr}</span>
        <span class="birthday-age">${t('birthdays.turning')} ${turning}</span>
        ${noteHtml}
      </div>
    </div>
    <div class="birthday-actions">
      <button onclick="openEditBirthdayModal('${b.id}')" title="${t('common.edit')}">${lucideIcon('pencil', 16)}</button>
      <button onclick="deleteBirthday('${b.id}')" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>
    </div>
  </div>`;
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
    <h2>${lucideIcon('cake', 20)} ${t('birthdays.add_birthday')}</h2>
    <label>${t('common.name')}</label>
    <input type="text" id="newBirthdayName" placeholder="${t('birthdays.name_placeholder')}" maxlength="200"
      onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewBirthday();}">
    <label>${t('birthdays.birthday_label')}</label>
    <input type="date" id="newBirthdayDate">
    <label>${t('birthdays.note_label')}</label>
    <input type="text" id="newBirthdayNote" placeholder="${t('birthdays.note_placeholder')}" maxlength="500">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeAddBirthdayModal()">${t('common.cancel')}</button>
      <button class="modal-save" onclick="saveNewBirthday()">${t('common.add')}</button>
    </div>
  </div>`;
  app.appendChild(m1);

  // Edit Birthday Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editBirthdayModal';
  m2.innerHTML = `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('birthdays.edit_birthday')}</h2>
    <input type="hidden" id="editBirthdayId">
    <label>${t('common.name')}</label>
    <input type="text" id="editBirthdayName" maxlength="200">
    <label>${t('birthdays.birthday_label')}</label>
    <input type="date" id="editBirthdayDate">
    <label>${t('birthdays.note_label')}</label>
    <input type="text" id="editBirthdayNote" maxlength="500">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeEditBirthdayModal()">${t('common.cancel')}</button>
      <button class="modal-save" onclick="saveEditBirthday()">${t('common.save')}</button>
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

  if (!name) { showToast(t('birthdays.enter_name'), 'error'); return; }
  if (!date) { showToast(t('birthdays.enter_date'), 'error'); return; }

  const row = { name, birthday: date };
  if (note) row.note = note;

  const { error } = await state.db.from('birthdays').insert(row);
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

  closeAddBirthdayModal();
  showToast(t('birthdays.birthday_added', name), 'success');
  await refreshBirthdays();
}

function editBirthdayInline(id) {
  const b = state.allBirthdays.find(x => x.id === id);
  if (!b) return;
  const nameEl = document.querySelector(`.birthday-card[data-id="${id}"] .birthday-name`);
  if (!nameEl) return;

  // Hide actions while editing
  const actionsEl = nameEl.closest('.birthday-card')?.querySelector('.birthday-actions');
  if (actionsEl) actionsEl.classList.remove('visible');

  // Build extra fields
  const extras = document.createElement('div');
  extras.className = 'inline-edit-extras';

  // Birthday date row
  const dateRow = document.createElement('div');
  dateRow.className = 'inline-edit-row';
  const dateLabel = document.createElement('label');
  dateLabel.className = 'inline-edit-label';
  dateLabel.textContent = t('birthdays.birthday_label');
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'inline-edit-input';
  dateInput.value = b.birthday || '';
  dateRow.appendChild(dateLabel);
  dateRow.appendChild(dateInput);

  // Note row
  const noteRow = document.createElement('div');
  noteRow.className = 'inline-edit-row';
  const noteLabel = document.createElement('label');
  noteLabel.className = 'inline-edit-label';
  noteLabel.textContent = t('common.note');
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.className = 'inline-edit-input';
  noteInput.value = b.note || '';
  noteInput.placeholder = t('birthdays.note_placeholder');
  noteRow.appendChild(noteLabel);
  noteRow.appendChild(noteInput);

  extras.appendChild(dateRow);
  extras.appendChild(noteRow);

  inlineEditText(nameEl, b.name, {
    maxLength: 200,
    extraEl: extras,
    collectExtra: () => ({
      birthday: dateInput.value,
      note: noteInput.value.trim(),
    }),
    saveFn: async (newName, extra) => {
      const updates = {};
      if (newName !== b.name) updates.name = newName;
      if (extra) {
        if (extra.birthday && extra.birthday !== b.birthday) updates.birthday = extra.birthday;
        const oldNote = b.note || '';
        if (extra.note !== oldNote) updates.note = extra.note || null;
      }
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        const { error } = await state.db.from('birthdays').update(updates).eq('id', id);
        if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
        showToast(t('birthdays.birthday_updated'), 'success');
      }
    },
    refreshFn: renderBirthdays,
  });
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

  if (!name) { showToast(t('birthdays.enter_name'), 'error'); return; }
  if (!date) { showToast(t('birthdays.enter_date'), 'error'); return; }

  const { error } = await state.db.from('birthdays').update({
    name, birthday: date, note: note || null, updated_at: new Date().toISOString()
  }).eq('id', id);
  if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }

  closeEditBirthdayModal();
  showToast(t('birthdays.birthday_updated'), 'success');
  await refreshBirthdays();
}

async function deleteBirthday(id) {
  const b = state.allBirthdays.find(x => x.id === id);
  if (!b) return;
  showDeleteConfirm(
    'Delete Birthday',
    `Remove ${b.name}'s birthday?`,
    async () => {
      const { error } = await state.db.from('birthdays').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('birthdays.birthday_removed'), 'info');
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
window.navigateToBirthdaySection = navigateToBirthdaySection;
window.filterBirthdays = function(e) { birthdaySearchQuery = e.target.value; renderBirthdays(); };
