import { lucideIcon } from './icons.js';
import state from './supabase.js';
import { esc, showToast, showDeleteConfirm } from './utils.js';

// ===================================================================
// FLASHCARDS — Spaced Repetition (FSRS v5)
// ===================================================================

// ── FSRS v5 Parameters ──
const P = {
  w1: 0.40, w2: 0.60, w3: 2.40, w4: -0.30,
  w5: -0.20, w6: 0.80, w7: 0.60,
  w8: 0.30, w9: 0.20, w10: 0.50, w11: 1.20,
  w12: 0.80, w13: 1.30,
  w14: 0.30, w15: 0.80, w16: 5.00,
  targetRetention: 0.90,
};

// ── FSRS v5 Core ──
function clamp(x, lo, hi) { return Math.max(lo, Math.min(x, hi)); }

function daysBetween(d1, d2) {
  return (new Date(d2) - new Date(d1)) / 86400000;
}

function retrievability(S, lastReview, now) {
  if (!lastReview || !S) return 0;
  const t = daysBetween(lastReview, now);
  return Math.exp(-t / S);
}

function nextInterval(S) {
  return Math.max(1, -S * Math.log(P.targetRetention));
}

function initDifficulty(rating) {
  return clamp(P.w1 + P.w2 * (rating - 3), 1, 10);
}

function initStability(rating) {
  return Math.max(0.1, P.w3 * Math.exp(P.w4 * (rating - 3)));
}

function ratingFactor(rating) {
  if (rating === 2) return P.w12;
  if (rating === 4) return P.w13;
  return 1.0;
}

function stabilityAfterSuccess(S, D, R, rating) {
  const growth = Math.exp(P.w5)
    * (11 - D)
    * Math.pow(S, -P.w6)
    * (Math.exp((1 - R) * P.w7) - 1)
    * ratingFactor(rating);
  return S * (1 + growth);
}

function stabilityAfterLapse(S, D, R) {
  return P.w8
    * Math.pow(D, -P.w9)
    * Math.pow(S + 1, P.w10)
    * Math.exp((1 - R) * P.w11);
}

function updateDifficulty(D, rating) {
  const delta = P.w14 * (rating - 3);
  let Dnew = D - delta;
  Dnew = P.w15 * Dnew + (1 - P.w15) * P.w16;
  return clamp(Dnew, 1, 10);
}

function fuzz(interval) {
  if (interval < 2) return interval;
  const noise = (Math.random() - 0.5) * 0.1;
  return interval * (1 + noise);
}

function fsrsUpdate(card, rating, now) {
  const isNew = !card.last_review || card.stability === 0;
  let S, D;

  if (isNew) {
    D = initDifficulty(rating);
    S = initStability(rating);
  } else {
    const R = retrievability(card.stability, card.last_review, now);
    if (rating === 1) {
      S = stabilityAfterLapse(card.stability, card.difficulty, R);
    } else {
      S = stabilityAfterSuccess(card.stability, card.difficulty, R, rating);
    }
    D = updateDifficulty(card.difficulty, rating);
  }

  const interval = fuzz(nextInterval(S));
  const nextReview = new Date(now.getTime() + interval * 86400000);

  return {
    stability: Math.round(S * 100) / 100,
    difficulty: Math.round(D * 100) / 100,
    last_review: now.toISOString(),
    next_review: nextReview.toISOString(),
    review_count: (card.review_count || 0) + 1,
  };
}

// ── State ──
let allCards = [];
let allNotes = [];
let sessionActive = false;
let sessionQueue = [];
let sessionDone = 0;
let sessionCorrect = 0;
let sessionTotal = 0;

const DECK_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#06b6d4', '#f97316',
  '#6366f1', '#14b8a6',
];

function getDeckColor(deck) {
  const decks = [...new Set(allCards.map(c => c.deck))].sort();
  const idx = decks.indexOf(deck);
  return DECK_COLORS[(idx >= 0 ? idx : 0) % DECK_COLORS.length];
}

// ── Data Loading ──
async function refreshFlashcards() {
  if (!state.sb) return;
  const { data } = await state.sb.from('flashcards').select('*').order('created_at');
  allCards = data || [];
  const { data: notes } = await state.sb.from('flashcard_notes').select('*').order('created_at');
  allNotes = notes || [];
  if (state.currentView === 'flashcards') renderFlashcards();
}

// ── Stats ──
function renderFlashcardStats() {
  const now = new Date();
  const due = allCards.filter(c => !c.next_review || new Date(c.next_review) <= now).length;
  const learning = allCards.filter(c => c.stability > 0 && c.stability <= 21).length;
  const mastered = allCards.filter(c => c.stability > 21).length;

  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  el('statFlashDue', due);
  el('statFlashLearning', learning);
  el('statFlashMastered', mastered);
  el('statFlashTotal', allCards.length);
}

// ── Deck Nav Buttons ──
function renderDeckNavButtons() {
  const container = document.getElementById('flashcardNavButtons');
  if (!container) return;
  const decks = [...new Set(allCards.map(c => c.deck))].sort();
  container.innerHTML = decks.map(deck => {
    const color = getDeckColor(deck);
    return `<button class="category-nav-btn" style="background:${color}22;color:${color};border:1px solid ${color}44;" onclick="navigateToFlashDeck('${esc(deck)}')">${esc(deck)} (${allCards.filter(c=>c.deck===deck).length})</button>`;
  }).join('') + `<button class="category-nav-btn" style="background:#6b728022;color:#9ca3af;border:1px dashed #6b728066;" onclick="navigateToFlashDeck('__notes')">${lucideIcon('sticky-note', 14, '#9ca3af')} Notes (${allNotes.length})</button>`;
}

window.navigateToFlashDeck = function(deck) {
  const el = document.getElementById(deck === '__notes' ? 'flashcardNotesSection' : `flashDeck-${CSS.escape(deck)}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ── State for collapse/search ──
const deckCollapsed = {}; // deck -> bool (true = showing only preview)
const PREVIEW_COUNT = 8;
let searchQuery = '';

// ── Main Render ──
function renderFlashcards() {
  renderFlashcardStats();
  renderDeckNavButtons();
  renderDeckGrid();
  renderNotesSection();
}

function renderDeckGrid() {
  const grid = document.getElementById('flashcardGrid');
  if (!grid) return;
  const decks = [...new Set(allCards.map(c => c.deck))].sort();
  if (decks.length === 0) {
    grid.innerHTML = `<div class="fc-empty-state">
      <div class="fc-empty-icon">${lucideIcon('book-open', 40, '#8b5cf6')}</div>
      <h3>No flashcards yet</h3>
      <p>Import from XML or create cards manually to start learning.</p>
    </div>`;
    return;
  }

  const q = searchQuery.toLowerCase().trim();

  grid.innerHTML = decks.map(deck => {
    let cards = allCards.filter(c => c.deck === deck);
    if (q) cards = cards.filter(c => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));
    if (cards.length === 0 && q) return '';

    const color = getDeckColor(deck);
    const now = new Date();
    const allDeckCards = allCards.filter(c => c.deck === deck);
    const newCount = allDeckCards.filter(c => !c.last_review).length;
    const dueCount = allDeckCards.filter(c => c.last_review && (!c.next_review || new Date(c.next_review) <= now)).length;
    const masteredCount = allDeckCards.filter(c => c.stability > 21).length;

    const isCollapsed = deckCollapsed[deck] !== false; // default collapsed
    const visibleCards = isCollapsed ? cards.slice(0, PREVIEW_COUNT) : cards;
    const hasMore = cards.length > PREVIEW_COUNT;

    // Mini stats chips
    const chips = [];
    if (newCount > 0) chips.push(`<span class="fc-chip fc-chip-new">${newCount} new</span>`);
    if (dueCount > 0) chips.push(`<span class="fc-chip fc-chip-due">${dueCount} due</span>`);
    if (masteredCount > 0) chips.push(`<span class="fc-chip fc-chip-mastered">${masteredCount} mastered</span>`);

    return `<div class="fc-deck-card" id="flashDeck-${esc(deck)}">
      <div class="fc-deck-accent" style="background:${color};"></div>
      <div class="fc-deck-header">
        <div class="fc-deck-title-row">
          <svg class="lucide-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
          <h3 class="fc-deck-name" style="color:${color};">${esc(deck)}</h3>
          <span class="fc-deck-count">${allDeckCards.length} cards</span>
          <div class="fc-deck-chips">${chips.join('')}</div>
        </div>
        <div class="fc-deck-actions">
          ${dueCount + newCount > 0 ? `<button class="fc-practice-btn" style="background:${color};" onclick="startPractice('${esc(deck)}')" title="Practice due cards">${lucideIcon('play', 14, '#fff')} Practice (${dueCount + newCount})</button>` : `<span class="fc-all-done">${lucideIcon('circle-check', 14, '#22c55e')} All caught up</span>`}
          <button class="icon-btn" title="Add card" onclick="openAddFlashcardModal('${esc(deck)}')" style="color:${color};font-size:1.2rem;">+</button>
        </div>
      </div>
      <div class="fc-card-list">
        ${visibleCards.map(c => renderFlashcardItem(c, color)).join('')}
        ${hasMore && isCollapsed ? `<button class="fc-show-more" onclick="toggleDeckCollapse('${esc(deck)}')" style="color:${color};">Show all ${cards.length} cards ${lucideIcon('chevron-down', 14, color)}</button>` : ''}
        ${hasMore && !isCollapsed ? `<button class="fc-show-more" onclick="toggleDeckCollapse('${esc(deck)}')" style="color:${color};">Show less ${lucideIcon('chevron-up', 14, color)}</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

window.toggleDeckCollapse = function(deck) {
  deckCollapsed[deck] = deckCollapsed[deck] === false ? true : false;
  renderDeckGrid();
};

window.filterFlashcards = function(e) {
  searchQuery = e.target.value;
  renderDeckGrid();
};

function renderFlashcardItem(c, color) {
  const now = new Date();
  const isNew = !c.last_review;
  const isDue = !isNew && (!c.next_review || new Date(c.next_review) <= now);
  const R = c.last_review && c.stability ? retrievability(c.stability, c.last_review, now.toISOString()) : null;

  // Status badge — styled like project status badges
  let badge = '';
  if (isNew) {
    badge = `<span class="fc-status-badge fc-status-new">New</span>`;
  } else if (isDue) {
    badge = `<span class="fc-status-badge fc-status-due">Due</span>`;
  } else {
    // Reviewed and not yet due — show next review date
    const daysLeft = c.next_review ? Math.ceil((new Date(c.next_review) - now) / 86400000) : 0;
    badge = `<span class="fc-status-badge fc-status-ok">${daysLeft}d</span>`;
  }

  // Strength indicator
  let strengthEl = '';
  if (R !== null) {
    const pct = Math.round(R * 100);
    const barColor = R > 0.8 ? '#22c55e' : R > 0.5 ? '#f59e0b' : '#ef4444';
    strengthEl = `<div class="fc-strength-bar" title="${pct}% recall"><div class="fc-strength" style="width:${pct}%;background:${barColor};"></div></div>`;
  }

  // Difficulty dots (1-10 scale, show as discrete indicator)
  let diffDots = '';
  if (c.last_review && c.difficulty) {
    const d = Math.round(c.difficulty);
    const dotColor = d <= 3 ? '#22c55e' : d <= 6 ? '#f59e0b' : '#ef4444';
    diffDots = `<span class="fc-diff" title="Difficulty: ${c.difficulty}" style="color:${dotColor};">${'●'.repeat(Math.min(d, 5))}</span>`;
  }

  const frontTrunc = c.front.length > 90 ? c.front.slice(0, 90) + '…' : c.front;
  return `<div class="fc-item${isDue ? ' fc-item--due' : ''}${isNew ? ' fc-item--new' : ''}" data-id="${c.id}">
    <div class="fc-item-indicator" style="background:${isNew ? '#818cf8' : isDue ? '#f59e0b' : '#22c55e'};"></div>
    <div class="fc-item-body">
      <div class="fc-item-text">${esc(frontTrunc)}</div>
      <div class="fc-item-meta">
        ${badge}
        ${strengthEl}
        ${diffDots}
      </div>
    </div>
    <div class="fc-item-actions">
      <button class="icon-btn" title="Edit" onclick="openEditFlashcardModal('${c.id}')">${lucideIcon('pencil', 14)}</button>
      <button class="icon-btn" title="Delete" onclick="deleteFlashcard('${c.id}')">${lucideIcon('trash-2', 14)}</button>
    </div>
  </div>`;
}

// ── Notes Section ──
function renderNotesSection() {
  const container = document.getElementById('flashcardNotesSection');
  if (!container) return;
  container.innerHTML = `
    <div class="fc-deck-card" id="flashcardNotesDeck" style="margin-top:16px;">
      <div class="fc-deck-accent" style="background:#6b7280;"></div>
      <div class="fc-deck-header">
        <div class="fc-deck-title-row">
          <span>${lucideIcon('sticky-note', 18, '#9ca3af')}</span>
          <h3 class="fc-deck-name" style="color:#9ca3af;">Unstructured Notes</h3>
          <span class="fc-deck-count">${allNotes.length} items</span>
        </div>
        <div class="fc-deck-actions">
          <button class="icon-btn" title="Add note" onclick="openAddNoteModal()" style="color:#9ca3af;font-size:1.2rem;">+</button>
        </div>
      </div>
      <div class="fc-card-list">
        ${allNotes.length === 0 ? '<div class="fc-empty-note">Items you want to learn but haven\'t formalized as cards yet.</div>' : ''}
        ${allNotes.map(n => `<div class="fc-item" data-id="${n.id}">
          <div class="fc-item-text">${esc(n.content.length > 100 ? n.content.slice(0, 100) + '…' : n.content)}</div>
          <div class="fc-item-actions">
            <button class="icon-btn" title="Convert to card" onclick="convertNoteToCard('${n.id}')">${lucideIcon('arrow-right-left', 14)}</button>
            <button class="icon-btn" title="Edit" onclick="openEditNoteModal('${n.id}')">${lucideIcon('pencil', 14)}</button>
            <button class="icon-btn" title="Delete" onclick="deleteNote('${n.id}')">${lucideIcon('trash-2', 14)}</button>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
}

// ── Practice Session ──
function startPractice(deckFilter) {
  const now = new Date();
  let pool = allCards.filter(c => !c.next_review || new Date(c.next_review) <= now);
  if (deckFilter && deckFilter !== '__all') pool = pool.filter(c => c.deck === deckFilter);

  if (pool.length === 0) {
    showToast('No cards due for review!');
    return;
  }

  // Smart selection: prioritize by urgency
  // 1. Failed cards (low stability, reviewed before) — most urgent
  // 2. Overdue cards (next_review far in the past) — sorted by how overdue
  // 3. New cards (never reviewed) — fill remaining slots
  const SESSION_SIZE = 10;

  const failed = pool.filter(c => c.last_review && c.stability > 0 && c.stability <= 2);
  const overdue = pool.filter(c => c.last_review && c.stability > 2)
    .sort((a, b) => new Date(a.next_review || 0) - new Date(b.next_review || 0));
  const fresh = pool.filter(c => !c.last_review)
    .sort(() => Math.random() - 0.5);

  // Build queue: failed first, then most overdue, then new
  let selected = [];
  for (const group of [failed, overdue, fresh]) {
    for (const card of group) {
      if (selected.length >= SESSION_SIZE) break;
      if (!selected.find(s => s.id === card.id)) selected.push(card);
    }
    if (selected.length >= SESSION_SIZE) break;
  }

  // Shuffle selected for variety (don't always show failed first)
  selected.sort(() => Math.random() - 0.5);

  sessionQueue = selected;
  sessionDone = 0;
  sessionCorrect = 0;
  sessionActive = true;
  sessionTotal = selected.length;
  showPracticeOverlay();
  showNextCard();
}
window.startPractice = startPractice;

function showPracticeOverlay() {
  let overlay = document.getElementById('practiceOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'practiceOverlay';
    overlay.className = 'practice-overlay';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function hidePracticeOverlay() {
  const overlay = document.getElementById('practiceOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  sessionActive = false;
}

function showNextCard() {
  const overlay = document.getElementById('practiceOverlay');
  if (!overlay) return;

  if (sessionQueue.length === 0) {
    showSessionSummary();
    return;
  }

  const card = sessionQueue[0];
  const pct = sessionTotal > 0 ? Math.round((sessionDone / sessionTotal) * 100) : 0;

  overlay.innerHTML = `
    <div class="practice-header">
      <div class="practice-progress-bar"><div class="practice-progress-fill" style="width:${pct}%;"></div></div>
      <div class="practice-meta">${sessionDone} / ${sessionTotal} · ${card.deck}</div>
      <button class="practice-close" onclick="endPractice()">✕</button>
    </div>
    <div class="practice-card-area" onclick="revealCard()">
      <div class="practice-card" id="practiceCard">
        <div class="practice-card-front">
          <div class="practice-card-label">Question</div>
          <div class="practice-card-text">${esc(card.front)}</div>
        </div>
        <div class="practice-card-back">
          <div class="practice-card-label">Answer</div>
          <div class="practice-card-text">${esc(card.back)}</div>
        </div>
      </div>
    </div>
    <div class="practice-hint" id="practiceHint">Tap to reveal answer</div>
    <div class="practice-buttons" id="practiceButtons" style="display:none;">
      <button class="rating-btn rating-again" onclick="rateCard(1)"><span class="rating-num">1</span> Again</button>
      <button class="rating-btn rating-hard" onclick="rateCard(2)"><span class="rating-num">2</span> Hard</button>
      <button class="rating-btn rating-good" onclick="rateCard(3)"><span class="rating-num">3</span> Good</button>
      <button class="rating-btn rating-easy" onclick="rateCard(4)"><span class="rating-num">4</span> Easy</button>
    </div>
  `;
}

window.revealCard = function() {
  const card = document.getElementById('practiceCard');
  if (!card || card.classList.contains('flipped')) return;
  card.classList.add('flipped');
  const hint = document.getElementById('practiceHint');
  if (hint) hint.style.display = 'none';
  const btns = document.getElementById('practiceButtons');
  if (btns) btns.style.display = 'flex';
};

window.rateCard = async function(rating) {
  if (sessionQueue.length === 0) return;
  const card = sessionQueue.shift();
  const now = new Date();
  const updates = fsrsUpdate(card, rating, now);

  // Update locally
  Object.assign(card, updates);
  const idx = allCards.findIndex(c => c.id === card.id);
  if (idx >= 0) Object.assign(allCards[idx], updates);

  // Push to Supabase
  if (state.sb) {
    await state.sb.from('flashcards').update(updates).eq('id', card.id);
  }

  sessionDone++;
  if (rating >= 3) sessionCorrect++;

  showNextCard();
};

window.endPractice = function() {
  hidePracticeOverlay();
  renderFlashcards();
};

function showSessionSummary() {
  const overlay = document.getElementById('practiceOverlay');
  if (!overlay) return;
  const accuracy = sessionDone > 0 ? Math.round((sessionCorrect / sessionDone) * 100) : 0;
  overlay.innerHTML = `
    <div class="practice-summary">
      <div class="practice-summary-emoji">${accuracy >= 80 ? '🎉' : accuracy >= 50 ? '💪' : '📚'}</div>
      <h2>Session Complete</h2>
      <div class="practice-summary-stats">
        <div class="practice-summary-stat"><span class="practice-stat-val">${sessionDone}</span><span class="practice-stat-lbl">Reviewed</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${sessionCorrect}</span><span class="practice-stat-lbl">Good+</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${accuracy}%</span><span class="practice-stat-lbl">Accuracy</span></div>
      </div>
      <button class="btn practice-done-btn" onclick="endPractice()">Done</button>
    </div>
  `;
}

// ── Modals: Add/Edit Flashcard ──
function initFlashcardModals() {
  // Modals are created dynamically
}

window.openAddFlashcardModal = function(deck) {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addFlashcardModal" style="display:flex;" onclick="if(event.target===this)closeAddFlashcardModal()">
    <div class="modal">
      <h2>Add Flashcard</h2>
      <input type="hidden" id="newFlashDeck" value="${esc(deck || 'Général')}">
      <label>Front (Question)</label>
      <textarea id="newFlashFront" rows="3" placeholder="Question…" style="width:100%;"></textarea>
      <label>Back (Answer)</label>
      <textarea id="newFlashBack" rows="3" placeholder="Answer…" style="width:100%;"></textarea>
      <div class="modal-actions">
        <button class="btn" onclick="closeAddFlashcardModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveNewFlashcard()">Save</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('newFlashFront').focus();
};

window.closeAddFlashcardModal = function() {
  const m = document.getElementById('addFlashcardModal');
  if (m) m.remove();
};

window.saveNewFlashcard = async function() {
  const deck = document.getElementById('newFlashDeck').value.trim();
  const front = document.getElementById('newFlashFront').value.trim();
  const back = document.getElementById('newFlashBack').value.trim();
  if (!front || !back) { showToast('Front and back required'); return; }

  if (state.sb) {
    await state.sb.from('flashcards').insert({ deck, front, back });
  }
  closeAddFlashcardModal();
  await refreshFlashcards();
  showToast('Card added');
};

window.openEditFlashcardModal = function(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="editFlashcardModal" style="display:flex;" onclick="if(event.target===this)closeEditFlashcardModal()">
    <div class="modal">
      <h2>Edit Flashcard</h2>
      <input type="hidden" id="editFlashId" value="${id}">
      <label>Deck</label>
      <input type="text" id="editFlashDeck" value="${esc(card.deck)}" style="width:100%;">
      <label>Front (Question)</label>
      <textarea id="editFlashFront" rows="3" style="width:100%;">${esc(card.front)}</textarea>
      <label>Back (Answer)</label>
      <textarea id="editFlashBack" rows="3" style="width:100%;">${esc(card.back)}</textarea>
      <div class="modal-actions">
        <button class="btn" onclick="closeEditFlashcardModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditFlashcard()">Save</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.closeEditFlashcardModal = function() {
  const m = document.getElementById('editFlashcardModal');
  if (m) m.remove();
};

window.saveEditFlashcard = async function() {
  const id = document.getElementById('editFlashId').value;
  const deck = document.getElementById('editFlashDeck').value.trim();
  const front = document.getElementById('editFlashFront').value.trim();
  const back = document.getElementById('editFlashBack').value.trim();
  if (!front || !back) { showToast('Front and back required'); return; }

  if (state.sb) {
    await state.sb.from('flashcards').update({ deck, front, back }).eq('id', id);
  }
  closeEditFlashcardModal();
  await refreshFlashcards();
  showToast('Card updated');
};

window.deleteFlashcard = function(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  showDeleteConfirm(
    'Delete Flashcard',
    'Are you sure?',
    card.front.slice(0, 80),
    async () => {
      if (state.sb) await state.sb.from('flashcards').delete().eq('id', id);
      await refreshFlashcards();
      showToast('Card deleted');
    }
  );
};

// ── Notes CRUD ──
window.openAddNoteModal = function() {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addNoteModal" style="display:flex;" onclick="if(event.target===this)closeAddNoteModal()">
    <div class="modal">
      <h2>Add Note</h2>
      <label>What do you want to learn?</label>
      <textarea id="newNoteContent" rows="4" placeholder="Anything you want to remember…" style="width:100%;"></textarea>
      <div class="modal-actions">
        <button class="btn" onclick="closeAddNoteModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveNewNote()">Save</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('newNoteContent').focus();
};

window.closeAddNoteModal = function() {
  const m = document.getElementById('addNoteModal');
  if (m) m.remove();
};

window.saveNewNote = async function() {
  const content = document.getElementById('newNoteContent').value.trim();
  if (!content) { showToast('Content required'); return; }
  if (state.sb) await state.sb.from('flashcard_notes').insert({ content });
  closeAddNoteModal();
  await refreshFlashcards();
  showToast('Note added');
};

window.openEditNoteModal = function(id) {
  const note = allNotes.find(n => n.id === id);
  if (!note) return;
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="editNoteModal" style="display:flex;" onclick="if(event.target===this)closeEditNoteModal()">
    <div class="modal">
      <h2>Edit Note</h2>
      <input type="hidden" id="editNoteId" value="${id}">
      <textarea id="editNoteContent" rows="4" style="width:100%;">${esc(note.content)}</textarea>
      <div class="modal-actions">
        <button class="btn" onclick="closeEditNoteModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditNote()">Save</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.closeEditNoteModal = function() {
  const m = document.getElementById('editNoteModal');
  if (m) m.remove();
};

window.saveEditNote = async function() {
  const id = document.getElementById('editNoteId').value;
  const content = document.getElementById('editNoteContent').value.trim();
  if (!content) { showToast('Content required'); return; }
  if (state.sb) await state.sb.from('flashcard_notes').update({ content }).eq('id', id);
  closeEditNoteModal();
  await refreshFlashcards();
  showToast('Note updated');
};

window.deleteNote = function(id) {
  const note = allNotes.find(n => n.id === id);
  if (!note) return;
  showDeleteConfirm('Delete Note', 'Are you sure?', note.content.slice(0, 80), async () => {
    if (state.sb) await state.sb.from('flashcard_notes').delete().eq('id', id);
    await refreshFlashcards();
    showToast('Note deleted');
  });
};

window.convertNoteToCard = function(id) {
  const note = allNotes.find(n => n.id === id);
  if (!note) return;
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="convertNoteModal" style="display:flex;" onclick="if(event.target===this)closeConvertNoteModal()">
    <div class="modal">
      <h2>Convert to Flashcard</h2>
      <input type="hidden" id="convertNoteId" value="${id}">
      <label>Deck</label>
      <input type="text" id="convertNoteDeck" value="Général" style="width:100%;">
      <label>Front (Question)</label>
      <textarea id="convertNoteFront" rows="3" placeholder="Question…" style="width:100%;">${esc(note.content)}</textarea>
      <label>Back (Answer)</label>
      <textarea id="convertNoteBack" rows="3" placeholder="Answer…" style="width:100%;"></textarea>
      <div class="modal-actions">
        <button class="btn" onclick="closeConvertNoteModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveConvertNote()">Convert</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.closeConvertNoteModal = function() {
  const m = document.getElementById('convertNoteModal');
  if (m) m.remove();
};

window.saveConvertNote = async function() {
  const noteId = document.getElementById('convertNoteId').value;
  const deck = document.getElementById('convertNoteDeck').value.trim() || 'Général';
  const front = document.getElementById('convertNoteFront').value.trim();
  const back = document.getElementById('convertNoteBack').value.trim();
  if (!front || !back) { showToast('Front and back required'); return; }
  if (state.sb) {
    await state.sb.from('flashcards').insert({ deck, front, back });
    await state.sb.from('flashcard_notes').delete().eq('id', noteId);
  }
  closeConvertNoteModal();
  await refreshFlashcards();
  showToast('Converted to flashcard');
};

function closeAllFlashModals() {
  ['addFlashcardModal','editFlashcardModal','addNoteModal','editNoteModal','convertNoteModal','importXmlModal','addFlashDeckModal'].forEach(id => {
    const m = document.getElementById(id);
    if (m) m.remove();
  });
}

// ── XML Import ──
window.openImportXmlModal = function() {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="importXmlModal" style="display:flex;" onclick="if(event.target===this)closeImportXmlModal()">
    <div class="modal">
      <h2>Import from XML</h2>
      <p style="font-size:0.85rem;color:var(--muted);margin-bottom:12px;">Upload an XML file with &lt;card&gt; elements containing &lt;rich-text name="Avant"&gt; and &lt;rich-text name="Arrière"&gt;.</p>
      <input type="file" id="xmlFileInput" accept=".xml" style="width:100%;margin-bottom:12px;">
      <label>Target Deck</label>
      <input type="text" id="importDeckName" value="Général" style="width:100%;">
      <div id="importPreview" style="margin-top:12px;font-size:0.85rem;color:var(--muted);"></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeImportXmlModal()">Cancel</button>
        <button class="btn btn-primary" id="importXmlBtn" onclick="doImportXml()" disabled>Import</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('xmlFileInput').addEventListener('change', previewXml);
};

window.closeImportXmlModal = function() {
  const m = document.getElementById('importXmlModal');
  if (m) m.remove();
};

let pendingImportCards = [];

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  // Remove chatgpt:// links but keep text
  tmp.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('chatgpt://')) {
      a.replaceWith(a.textContent);
    }
  });
  return tmp.textContent.replace(/\s+/g, ' ').trim();
}

function previewXml(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(ev.target.result, 'text/xml');
      const cards = doc.querySelectorAll('card');
      pendingImportCards = [];
      cards.forEach(card => {
        const avant = card.querySelector('rich-text[name="Avant"]');
        const arriere = card.querySelector('rich-text[name="Arrière"]');
        if (avant && arriere) {
          const front = stripHtml(avant.innerHTML);
          const back = stripHtml(arriere.innerHTML);
          if (front && back) pendingImportCards.push({ front, back });
        }
      });
      const preview = document.getElementById('importPreview');
      if (preview) preview.textContent = `Found ${pendingImportCards.length} cards ready to import.`;
      const btn = document.getElementById('importXmlBtn');
      if (btn) btn.disabled = pendingImportCards.length === 0;
    } catch (err) {
      const preview = document.getElementById('importPreview');
      if (preview) preview.textContent = 'Error parsing XML: ' + err.message;
    }
  };
  reader.readAsText(file);
}

window.doImportXml = async function() {
  if (pendingImportCards.length === 0) return;
  const deck = document.getElementById('importDeckName').value.trim() || 'Général';
  const btn = document.getElementById('importXmlBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

  if (state.sb) {
    const rows = pendingImportCards.map(c => ({ deck, front: c.front, back: c.back }));
    // Insert in batches of 50
    for (let i = 0; i < rows.length; i += 50) {
      await state.sb.from('flashcards').insert(rows.slice(i, i + 50));
    }
  }

  closeImportXmlModal();
  pendingImportCards = [];
  await refreshFlashcards();
  showToast(`Imported cards into "${deck}"`);
};

// ── Add Deck ──
window.openAddFlashDeckModal = function() {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addFlashDeckModal" style="display:flex;" onclick="if(event.target===this)closeAddFlashDeckModal()">
    <div class="modal">
      <h2>New Deck</h2>
      <label>Deck Name</label>
      <input type="text" id="newDeckName" placeholder="e.g. Histoire, Vocabulaire…" style="width:100%;">
      <div class="modal-actions">
        <button class="btn" onclick="closeAddFlashDeckModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveNewFlashDeck()">Create</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('newDeckName').focus();
};

window.closeAddFlashDeckModal = function() {
  const m = document.getElementById('addFlashDeckModal');
  if (m) m.remove();
};

window.saveNewFlashDeck = function() {
  const name = document.getElementById('newDeckName').value.trim();
  if (!name) { showToast('Name required'); return; }
  closeAddFlashDeckModal();
  openAddFlashcardModal(name);
};

// ── Keyboard shortcuts in practice ──
document.addEventListener('keydown', (e) => {
  if (!sessionActive) return;
  const card = document.getElementById('practiceCard');
  if (!card) return;

  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (!card.classList.contains('flipped')) {
      window.revealCard();
    }
  } else if (card.classList.contains('flipped')) {
    if (e.key === '1') window.rateCard(1);
    else if (e.key === '2') window.rateCard(2);
    else if (e.key === '3') window.rateCard(3);
    else if (e.key === '4') window.rateCard(4);
  }

  if (e.key === 'Escape') window.endPractice();
});

// ===================================================================
// EXPORTS
// ===================================================================

export { refreshFlashcards, renderFlashcards, initFlashcardModals };

window.renderFlashcards = renderFlashcards;
window.refreshFlashcards = refreshFlashcards;
