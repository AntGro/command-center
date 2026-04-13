import { lucideIcon } from './icons.js';
import state from './supabase.js';
import { esc, showToast, showDeleteConfirm } from './utils.js';

// ===================================================================
// VESTIAIRE — WARDROBE TRACKER (bucket-card layout)
// ===================================================================

const DEFAULT_CATEGORIES = ['Haut', 'Bas', 'Chaussures', 'Manteau'];
const VESTIAIRE_CATEGORIES_KEY = 'claw_cc_vestiaire_categories';

function getVestiaireCategories() {
  try {
    const raw = localStorage.getItem(VESTIAIRE_CATEGORIES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return [...DEFAULT_CATEGORIES];
}

function saveVestiaireCategories(cats) {
  localStorage.setItem(VESTIAIRE_CATEGORIES_KEY, JSON.stringify(cats));
}


// ===================================================================
// DATA
// ===================================================================

async function refreshVestiaire() {
  if (!state.sb) return;
  const { data, error } = await state.sb
    .from('vestiaire')
    .select('*')
    .order('name', { ascending: true });
  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast('Failed to load vestiaire', 'error');
    return;
  }
  state.allVestiaire = data || [];
  syncCategoriesFromData();
  if (state.currentView === 'vestiaire') {
    renderVestiaire();
  }
}

function syncCategoriesFromData() {
  const cats = getVestiaireCategories();
  const dataCats = [...new Set((state.allVestiaire || []).map(v => v.category).filter(Boolean))];
  let changed = false;
  dataCats.forEach(c => {
    if (!cats.includes(c)) { cats.push(c); changed = true; }
  });
  if (changed) saveVestiaireCategories(cats);
}


// ===================================================================
// RENDERING — bucket cards (like Projects)
// ===================================================================

function renderVestiaire() {
  const grid = document.getElementById('vestiaireGrid');
  if (!grid) return;

  const items = state.allVestiaire || [];
  const cats = getVestiaireCategories();

  updateVestiaireStats(items);
  renderVestiaireNavButtons(cats, items);

  // Group items by category
  const grouped = {};
  cats.forEach(c => { grouped[c] = []; });
  items.forEach(v => {
    const cat = v.category || 'Autre';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(v);
  });

  // Render a card per category
  let html = '';
  cats.forEach(cat => {
    const catItems = grouped[cat] || [];
    html += renderCategoryCard(cat, catItems);
  });

  // "Autre" for uncategorized
  if (grouped['Autre'] && grouped['Autre'].length > 0 && !cats.includes('Autre')) {
    html += renderCategoryCard('Autre', grouped['Autre']);
  }

  grid.innerHTML = html;
  grid.className = 'project-grid';
}

function renderCategoryCard(cat, items) {
  const icon = getCategoryIcon(cat);
  const escapedCat = esc(cat);
  const count = items.length;

  let itemsHtml = '';
  if (count === 0) {
    itemsHtml = `<div class="vestiaire-empty-cat" style="padding:12px 0;color:var(--muted);font-size:0.82rem;text-align:center;">No items yet</div>`;
  } else {
    itemsHtml = items.map(v => renderVestiaireItem(v)).join('');
  }

  return `<div class="project-card vestiaire-bucket" data-category="${escapedCat}">
    <div class="project-card-header">
      <div style="display:flex;align-items:center;gap:8px;">
        ${icon}
        <strong style="font-size:1rem;">${escapedCat}</strong>
        <span style="font-size:0.78rem;color:var(--muted);">(${count})</span>
      </div>
      <div class="project-header-actions" style="opacity:1;">
        <button onclick="openAddVestiaireModal('${escapedCat}')" title="Add to ${escapedCat}" style="background:none;border:none;cursor:pointer;color:var(--accent);padding:2px 6px;border-radius:4px;transition:all 0.2s;">
          ${lucideIcon('plus', 16)}
        </button>
        <button onclick="deleteVestiaireCategory('${escapedCat}')" title="Delete category" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:2px 6px;border-radius:4px;transition:all 0.2s;">
          ${lucideIcon('trash-2', 14)}
        </button>
      </div>
    </div>
    <div class="task-list" style="padding:4px 16px 12px;">
      ${itemsHtml}
    </div>
  </div>`;
}

function renderVestiaireItem(v) {
  const brandHtml = v.brand ? `<span style="font-size:0.75rem;color:var(--muted);margin-left:6px;">${esc(v.brand)}</span>` : '';
  const metaParts = [];
  if (v.size) metaParts.push(`${lucideIcon('ruler', 12)} ${esc(v.size)}`);
  if (v.color) metaParts.push(`${lucideIcon('palette', 12)} ${esc(v.color)}`);
  if (v.notes) metaParts.push(`${esc(v.notes)}`);
  const metaHtml = metaParts.length
    ? `<div style="font-size:0.75rem;color:var(--muted);margin-top:2px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">${metaParts.join('')}</div>`
    : '';

  return `<div class="vestiaire-item" style="display:flex;align-items:flex-start;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;">
        <span style="font-size:0.88rem;font-weight:500;">${esc(v.name)}</span>
        ${brandHtml}
      </div>
      ${metaHtml}
    </div>
    <div class="vestiaire-item-actions" style="display:flex;gap:4px;opacity:0;transition:opacity 0.2s;">
      <button onclick="openEditVestiaireModal('${v.id}')" title="Edit" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:2px;">${lucideIcon('pencil', 14)}</button>
      <button onclick="deleteVestiaire('${v.id}')" title="Delete" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:2px;">${lucideIcon('trash-2', 14)}</button>
    </div>
  </div>`;
}

function renderVestiaireNavButtons(cats, items) {
  const container = document.getElementById('vestiaireNavButtons');
  if (!container) return;
  container.innerHTML = cats.map(cat => {
    const count = items.filter(v => v.category === cat).length;
    return `<button class="category-nav-btn" style="--cat-color:var(--accent);border-color:var(--accent);color:var(--accent)" onclick="navigateToVestiaireCat('${esc(cat)}')" title="${esc(cat)} (${count})">${esc(cat)} (${count})</button>`;
  }).join('');
}

function navigateToVestiaireCat(cat) {
  const card = document.querySelector(`.vestiaire-bucket[data-category="${cat}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.style.boxShadow = '0 0 0 2px var(--accent)';
  setTimeout(() => { card.style.boxShadow = ''; }, 1500);
}

function getCategoryIcon(cat) {
  const lower = (cat || '').toLowerCase();
  if (lower.includes('haut') || lower.includes('top') || lower.includes('chemis') || lower.includes('pull') || lower.includes('t-shirt'))
    return lucideIcon('shirt', 18);
  if (lower.includes('bas') || lower.includes('pantal') || lower.includes('jean') || lower.includes('short'))
    return lucideIcon('scissors', 18);
  if (lower.includes('costume') || lower.includes('suit'))
    return lucideIcon('briefcase', 18);
  if (lower.includes('chaussur') || lower.includes('shoe') || lower.includes('basket') || lower.includes('boot'))
    return lucideIcon('footprints', 18);
  if (lower.includes('mante') || lower.includes('vest') || lower.includes('jacket') || lower.includes('blouson'))
    return lucideIcon('cloud-rain', 18);
  if (lower.includes('access') || lower.includes('ceintur') || lower.includes('montre') || lower.includes('écharpe'))
    return lucideIcon('watch', 18);
  if (lower.includes('sous-vêtement') || lower.includes('underwear') || lower.includes('chaussett'))
    return lucideIcon('layers', 18);
  return lucideIcon('tag', 18);
}

function updateVestiaireStats(items) {
  const all = items || state.allVestiaire || [];
  const total = all.length;
  const categories = [...new Set(all.map(v => v.category).filter(Boolean))].length;
  const brands = [...new Set(all.map(v => v.brand).filter(Boolean))].length;
  const withSize = all.filter(v => v.size).length;

  const el = id => document.getElementById(id);
  if (el('statVestiaireTotal')) el('statVestiaireTotal').textContent = total;
  if (el('statVestiaireCategories')) el('statVestiaireCategories').textContent = categories;
  if (el('statVestiaireBrands')) el('statVestiaireBrands').textContent = brands;
  if (el('statVestiaireSized')) el('statVestiaireSized').textContent = withSize;
}


// ===================================================================
// MODALS
// ===================================================================

function initVestiaireModals() {
  const app = document.getElementById('app');

  // Add Item Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay';
  m1.id = 'addVestiaireModal';
  m1.innerHTML = `<div class="modal">
    <h2>${lucideIcon('shirt', 20)} Add Clothing Item</h2>
    <label>Name</label>
    <input type="text" id="newVestiaireName" placeholder="e.g. Oxford shirt, Chinos..." maxlength="200"
      onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewVestiaire();}">
    <label>Brand / Make</label>
    <input type="text" id="newVestiaireBrand" placeholder="e.g. Uniqlo, John Lewis..." maxlength="200">
    <label>Size</label>
    <input type="text" id="newVestiaireSize" placeholder="e.g. M, 28W32L, 42..." maxlength="100">
    <label>Category</label>
    <select id="newVestiaireCategory"></select>
    <label>Color (optional)</label>
    <input type="text" id="newVestiaireColor" placeholder="e.g. Navy, Blanc..." maxlength="100">
    <label>Notes (optional)</label>
    <input type="text" id="newVestiaireNotes" placeholder="e.g. Slim fit, bought at..." maxlength="500">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeAddVestiaireModal()">Cancel</button>
      <button class="modal-save" onclick="saveNewVestiaire()">Add</button>
    </div>
  </div>`;
  app.appendChild(m1);

  // Edit Item Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editVestiaireModal';
  m2.innerHTML = `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} Edit Clothing Item</h2>
    <input type="hidden" id="editVestiaireId">
    <label>Name</label>
    <input type="text" id="editVestiaireName" maxlength="200">
    <label>Brand / Make</label>
    <input type="text" id="editVestiaireBrand" maxlength="200">
    <label>Size</label>
    <input type="text" id="editVestiaireSize" maxlength="100">
    <label>Category</label>
    <select id="editVestiaireCategory"></select>
    <label>Color (optional)</label>
    <input type="text" id="editVestiaireColor" maxlength="100">
    <label>Notes (optional)</label>
    <input type="text" id="editVestiaireNotes" maxlength="500">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeEditVestiaireModal()">Cancel</button>
      <button class="modal-save" onclick="saveEditVestiaire()">Save</button>
    </div>
  </div>`;
  app.appendChild(m2);

  // Add Category Modal
  const m3 = document.createElement('div');
  m3.className = 'modal-overlay';
  m3.id = 'addVestiaireCategoryModal';
  m3.innerHTML = `<div class="modal">
    <h2>${lucideIcon('folder-plus', 20)} Add Category</h2>
    <label>Category Name</label>
    <input type="text" id="newVestiaireCategoryName" placeholder="e.g. Sport, Formel..." maxlength="40"
      onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewVestiaireCategory();}">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeAddVestiaireCategoryModal()">Cancel</button>
      <button class="modal-save" onclick="saveNewVestiaireCategory()">Create</button>
    </div>
  </div>`;
  app.appendChild(m3);
}

function populateCategorySelect(selectId, preselect) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const cats = getVestiaireCategories();
  sel.innerHTML = cats.map(c => `<option value="${esc(c)}" ${c === preselect ? 'selected' : ''}>${esc(c)}</option>`).join('');
}


// ===================================================================
// CRUD
// ===================================================================

function openAddVestiaireModal(preselectedCategory) {
  document.getElementById('newVestiaireName').value = '';
  document.getElementById('newVestiaireBrand').value = '';
  document.getElementById('newVestiaireSize').value = '';
  document.getElementById('newVestiaireColor').value = '';
  document.getElementById('newVestiaireNotes').value = '';
  populateCategorySelect('newVestiaireCategory', preselectedCategory || '');
  document.getElementById('addVestiaireModal').classList.add('visible');
  setTimeout(() => document.getElementById('newVestiaireName').focus(), 100);
}

function closeAddVestiaireModal() {
  document.getElementById('addVestiaireModal').classList.remove('visible');
}

async function saveNewVestiaire() {
  const name = document.getElementById('newVestiaireName').value.trim();
  const brand = document.getElementById('newVestiaireBrand').value.trim();
  const size = document.getElementById('newVestiaireSize').value.trim();
  const category = document.getElementById('newVestiaireCategory').value;
  const color = document.getElementById('newVestiaireColor').value.trim();
  const notes = document.getElementById('newVestiaireNotes').value.trim();

  if (!name) { showToast('Enter a name', 'error'); return; }

  const row = { name, category };
  if (brand) row.brand = brand;
  if (size) row.size = size;
  if (color) row.color = color;
  if (notes) row.notes = notes;

  const { error } = await state.sb.from('vestiaire').insert(row);
  if (error) { showToast('Failed to add item: ' + error.message, 'error'); return; }

  closeAddVestiaireModal();
  showToast(`👔 ${name} added!`, 'success');
  await refreshVestiaire();
}

function openEditVestiaireModal(id) {
  const v = (state.allVestiaire || []).find(x => x.id === id);
  if (!v) return;
  document.getElementById('editVestiaireId').value = id;
  document.getElementById('editVestiaireName').value = v.name || '';
  document.getElementById('editVestiaireBrand').value = v.brand || '';
  document.getElementById('editVestiaireSize').value = v.size || '';
  document.getElementById('editVestiaireColor').value = v.color || '';
  document.getElementById('editVestiaireNotes').value = v.notes || '';
  populateCategorySelect('editVestiaireCategory', v.category);
  document.getElementById('editVestiaireModal').classList.add('visible');
  setTimeout(() => document.getElementById('editVestiaireName').focus(), 100);
}

function closeEditVestiaireModal() {
  document.getElementById('editVestiaireModal').classList.remove('visible');
}

async function saveEditVestiaire() {
  const id = document.getElementById('editVestiaireId').value;
  const name = document.getElementById('editVestiaireName').value.trim();
  const brand = document.getElementById('editVestiaireBrand').value.trim();
  const size = document.getElementById('editVestiaireSize').value.trim();
  const category = document.getElementById('editVestiaireCategory').value;
  const color = document.getElementById('editVestiaireColor').value.trim();
  const notes = document.getElementById('editVestiaireNotes').value.trim();

  if (!name) { showToast('Enter a name', 'error'); return; }

  const { error } = await state.sb.from('vestiaire').update({
    name, brand: brand || null, size: size || null, category,
    color: color || null, notes: notes || null,
    updated_at: new Date().toISOString()
  }).eq('id', id);
  if (error) { showToast('Update failed: ' + error.message, 'error'); return; }

  closeEditVestiaireModal();
  showToast('Item updated', 'success');
  await refreshVestiaire();
}

async function deleteVestiaire(id) {
  const v = (state.allVestiaire || []).find(x => x.id === id);
  if (!v) return;
  showDeleteConfirm(
    'Delete Item',
    `Remove "${v.name}" from your wardrobe?`,
    async () => {
      const { error } = await state.sb.from('vestiaire').delete().eq('id', id);
      if (error) { showToast('Delete failed', 'error'); return; }
      showToast('Item removed', 'info');
      await refreshVestiaire();
    }
  );
}


// ===================================================================
// CATEGORY MANAGEMENT
// ===================================================================

function openAddVestiaireCategoryModal() {
  document.getElementById('newVestiaireCategoryName').value = '';
  document.getElementById('addVestiaireCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('newVestiaireCategoryName').focus(), 100);
}

function closeAddVestiaireCategoryModal() {
  document.getElementById('addVestiaireCategoryModal').classList.remove('visible');
}

function saveNewVestiaireCategory() {
  const name = document.getElementById('newVestiaireCategoryName').value.trim();
  if (!name) { showToast('Enter a category name', 'error'); return; }
  const cats = getVestiaireCategories();
  if (cats.includes(name)) { showToast('Category already exists', 'error'); return; }
  cats.push(name);
  saveVestiaireCategories(cats);
  closeAddVestiaireCategoryModal();
  showToast(`Category "${name}" added`, 'success');
  renderVestiaire();
}

function deleteVestiaireCategory(cat) {
  const items = (state.allVestiaire || []).filter(v => v.category === cat);
  if (items.length > 0) {
    showToast(`Can't delete "${cat}" — it has ${items.length} item(s). Move or delete them first.`, 'error');
    return;
  }
  showDeleteConfirm(
    'Delete Category',
    `Remove the "${cat}" category?`,
    () => {
      const cats = getVestiaireCategories().filter(c => c !== cat);
      saveVestiaireCategories(cats);
      showToast(`Category "${cat}" removed`, 'info');
      renderVestiaire();
    }
  );
}


// ===================================================================
// EXPORTS
// ===================================================================

export { refreshVestiaire, renderVestiaire, initVestiaireModals };

// Window bindings
window.openAddVestiaireModal = openAddVestiaireModal;
window.closeAddVestiaireModal = closeAddVestiaireModal;
window.saveNewVestiaire = saveNewVestiaire;
window.openEditVestiaireModal = openEditVestiaireModal;
window.closeEditVestiaireModal = closeEditVestiaireModal;
window.saveEditVestiaire = saveEditVestiaire;
window.deleteVestiaire = deleteVestiaire;
window.openAddVestiaireCategoryModal = openAddVestiaireCategoryModal;
window.closeAddVestiaireCategoryModal = closeAddVestiaireCategoryModal;
window.saveNewVestiaireCategory = saveNewVestiaireCategory;
window.deleteVestiaireCategory = deleteVestiaireCategory;
window.navigateToVestiaireCat = navigateToVestiaireCat;
window.renderVestiaire = renderVestiaire;
