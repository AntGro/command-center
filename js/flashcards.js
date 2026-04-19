import { lucideIcon } from './icons.js';
import state from './supabase.js';
import { esc, showToast, showDeleteConfirm } from './utils.js';
import { scrollToAndHighlight, inlineEditText, initItemHoverDelay } from './item-utils.js';

// ===================================================================
// FLASHCARDS — Spaced Repetition (Algo-style intervals)
// ===================================================================

// ── SM-2 / Algo-style Spaced Repetition Core ──
// Ratings: 1=Again, 2=Hard, 3=Good, 4=Easy
// Stability ≈ target interval in days. Next review = stability days from now.

const DECAY = 0.5;
const FACTOR = Math.pow(0.9, 1 / -DECAY) - 1; // ≈ 0.2346 — power forgetting curve constant

function clamp(x, lo, hi) { return Math.max(lo, Math.min(x, hi)); }
function daysBetween(d1, d2) { return (new Date(d2) - new Date(d1)) / 86400000; }

// Power forgetting curve (FSRS v5 style): R(S,S)=0.9 by construction
function retrievability(S, lastReview, now) {
  if (!lastReview || !S) return 0;
  const t = daysBetween(lastReview, now);
  return Math.pow(t / S * FACTOR + 1, -DECAY);
}

// Interval ≈ stability (for 90% target retention)
function nextInterval(S) { return Math.max(1, Math.round(S)); }

// New card: initial stabilities per rating
function initStability(rating) {
  return [0.007, 1, 1, 4][rating - 1] || 1; // Again≈10min, Hard=1d, Good=1d, Easy=4d
}

// New card: initial difficulty (Easy→low, Again→high)
function initDifficulty(rating) {
  return clamp(7 - 1.5 * (rating - 1), 1, 10); // Again=7, Hard=5.5, Good=4, Easy=2.5
}

// Successful review: multiply stability by rating-dependent factor
function stabilityAfterSuccess(S, D, R, rating) {
  const baseMult = { 2: 1.2, 3: 2.5, 4: 2.5 }[rating] || 2.5;
  const easyBonus = rating === 4 ? 1.3 : 1.0;
  const diffFactor = clamp(1 + (5 - D) * 0.05, 0.75, 1.25); // easy cards grow faster
  return S * baseMult * easyBonus * diffFactor;
}

// Lapse (Again on review): reduce interval significantly
function stabilityAfterLapse(S, D, R) {
  return Math.max(0.5, S * 0.3);
}

// Difficulty drifts toward 5 (mean reversion), adjusted by rating
function updateDifficulty(D, rating) {
  const delta = -(rating - 3) * 0.5; // Easy→-0.5, Good→0, Hard→+0.5, Again→+1.0
  const Dnew = D + delta;
  return clamp(Dnew * 0.9 + 5 * 0.1, 1, 10); // 10% mean reversion toward 5
}

function fuzz(interval) {
  if (interval < 2) return interval;
  return interval * (1 + (Math.random() - 0.5) * 0.1);
}

function fsrsUpdate(card, rating, now) {
  const isNew = !card.last_review || card.stability === 0;
  let S, D;
  if (isNew) { D = initDifficulty(rating); S = initStability(rating); }
  else {
    const R = retrievability(card.stability, card.last_review, now.toISOString());
    S = rating === 1 ? stabilityAfterLapse(card.stability, card.difficulty, R)
      : stabilityAfterSuccess(card.stability, card.difficulty, R, rating);
    D = updateDifficulty(card.difficulty, rating);
  }
  const interval = fuzz(nextInterval(S));
  return {
    stability: Math.round(S * 100) / 100,
    difficulty: Math.round(D * 100) / 100,
    last_review: now.toISOString(),
    next_review: new Date(now.getTime() + interval * 86400000).toISOString(),
    review_count: (card.review_count || 0) + 1,
  };
}

// ── State ──
let allCards = [];
let allDrafts = [];
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

// ── Shortnames ──
const FLASH_SHORTNAMES_KEY = 'claw_flash_shortnames';
function getFlashShortnames() {
  try { return JSON.parse(localStorage.getItem(FLASH_SHORTNAMES_KEY) || '{}'); } catch { return {}; }
}
function saveFlashShortnames(map) { localStorage.setItem(FLASH_SHORTNAMES_KEY, JSON.stringify(map)); }
function getFlashShortname(deckName) {
  if (!deckName) return '';
  return getFlashShortnames()[deckName] || '';
}
function setFlashShortname(deckName, shortname) {
  const map = getFlashShortnames();
  if (shortname) { map[deckName] = shortname; } else { delete map[deckName]; }
  saveFlashShortnames(map);
}
function promptFlashShortname(deckName) {
  const current = getFlashShortname(deckName) || '';
  const result = prompt('Short name for "' + deckName + '" (leave empty to remove):', current);
  if (result === null) return;
  setFlashShortname(deckName, result.trim());
  refreshFlashcards();
}
const DRAFT_COLOR = '#6b7280';

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
  const { data: drafts } = await state.sb.from('flashcard_notes').select('*').order('created_at');
  allDrafts = drafts || [];
  if (state.currentView === 'flashcards') renderFlashcards();
}

// ── Deck Nav Buttons ──
function renderDeckNavButtons() {
  const container = document.getElementById('flashcardNavButtons');
  if (!container) return;
  const decks = [...new Set(allCards.map(c => c.deck))].sort();

  // Draft nav button first
  let html = `<button class="category-nav-btn" style="--cat-color:${DRAFT_COLOR};border-color:${DRAFT_COLOR};color:${DRAFT_COLOR}" onclick="navigateToFlashDeck('__drafts')">${lucideIcon('file-edit', 14, DRAFT_COLOR)} Drafts (${allDrafts.length})</button>`;

  html += decks.map(deck => {
    const color = getDeckColor(deck);
    const sn = getFlashShortname(deck);
    const display = sn || deck;
    return `<button class="category-nav-btn" style="--cat-color:${color};border-color:${color};color:${color}" onclick="navigateToFlashDeck('${esc(deck)}')" title="${esc(deck)}">${esc(display)} (${allCards.filter(c => c.deck === deck).length})</button>`;
  }).join('');

  container.innerHTML = html;
}

window.navigateToFlashDeck = function(deck) {
  const el = document.getElementById(deck === '__drafts' ? 'flashDraftsDeck' : `flashDeck-${CSS.escape(deck)}`);
  scrollToAndHighlight(el, null);
};

// ── Search State ──
let searchQuery = '';

// ── Main Render ──
function renderFlashcards() {
  renderDeckNavButtons();
  renderAllBuckets();
}

function renderAllBuckets() {
  const grid = document.getElementById('flashcardGrid');
  if (!grid) return;
  grid.className = 'project-grid';

  const decks = [...new Set(allCards.map(c => c.deck))].sort();
  const q = searchQuery.toLowerCase().trim();

  // Draft bucket first
  let html = renderDraftsBucket(q);

  // Then deck buckets
  html += decks.map(deck => renderDeckBucket(deck, q)).join('');

  if (!html.trim()) {
    html = `<div class="fc-empty-state">
      <div class="fc-empty-icon">${lucideIcon('book-open', 40, '#8b5cf6')}</div>
      <h3>No flashcards yet</h3>
      <p>Add drafts or create cards to start learning.</p>
    </div>`;
  }

  grid.innerHTML = html;
  initFlashcardHoverDelay(grid);
}

function initFlashcardHoverDelay(container) {
  initItemHoverDelay(container, {
    itemSelector: '.todo-item',
    actionsSelector: '.todo-actions',
    rowSelector: '.todo-row',
    textSelector: '.todo-text',
  });
}

// ── Draft Bucket ──
function renderDraftsBucket(q) {
  let drafts = allDrafts;
  if (q) drafts = drafts.filter(d => d.content.toLowerCase().includes(q));

  const pendingCount = drafts.filter(d => d.proposal_status === 'pending').length;
  const readyCount = drafts.filter(d => d.proposal_status === 'ready').length;

  const chips = [];
  if (pendingCount > 0) chips.push(`<span class="fc-chip" style="background:rgba(245,158,11,0.15);color:#f59e0b;">${pendingCount} generating…</span>`);
  if (readyCount > 0) chips.push(`<span class="fc-chip" style="background:rgba(34,197,94,0.15);color:#22c55e;">${readyCount} ready</span>`);

  return `<div class="project-card" id="flashDraftsDeck" style="--cat-color:${DRAFT_COLOR}">
    <div class="project-card-header">
      <div style="display:flex;align-items:flex-start;gap:6px;">
        <div class="project-info">
          <h3>${lucideIcon('file-edit', 16, DRAFT_COLOR)} <span style="color:${DRAFT_COLOR};">Drafts</span></h3>
          <span class="tech">${drafts.length} items ${chips.join(' ')}</span>
        </div>
      </div>
    </div>
    <div class="add-task">
      <textarea placeholder="Add draft…" id="draftQuickInput" onkeydown="handleDraftInput(event)" rows="1" style="resize:none;overflow:hidden;"></textarea>
      <button onclick="quickAddDraft()">+</button>
    </div>
    <div class="task-list">
      ${drafts.length === 0 ? '<p class="empty-msg">Jot down topics to learn — generate flashcard proposals from them.</p>' : ''}
      ${drafts.map(d => renderDraftItem(d)).join('')}
    </div>
  </div>`;
}

function renderDraftItem(d) {
  const hasProposal = d.proposal_status === 'ready' && d.proposed_front && d.proposed_back;
  const isPending = d.proposal_status === 'pending';

  let proposalHtml = '';
  if (hasProposal) {
    const suggestedDeck = d.proposed_deck || 'Général';
    const deckOptions = [...new Set([...allCards.map(c => c.deck), suggestedDeck])].sort().map(dk =>
      `<option value="${esc(dk)}"${dk === suggestedDeck ? ' selected' : ''}>${esc(dk)}</option>`
    ).join('');
    proposalHtml = `<div class="fc-proposal">
      <div class="fc-proposal-label">${lucideIcon('sparkles', 14, '#22c55e')} Proposed card:</div>
      <div class="fc-proposal-qa"><strong>Q:</strong> ${esc(d.proposed_front)}</div>
      <div class="fc-proposal-qa"><strong>A:</strong> ${esc(d.proposed_back)}</div>
      <div class="fc-proposal-deck"><strong>Deck:</strong> <select onchange="updateProposedDeck('${d.id}', this.value)">${deckOptions}</select></div>
      <div class="fc-proposal-actions">
        <button class="fc-proposal-accept" onclick="acceptProposal('${d.id}')">${lucideIcon('check', 14, '#fff')} Accept</button>
        <button class="fc-proposal-edit" onclick="editProposal('${d.id}')">${lucideIcon('pencil', 14)} Edit</button>
        <button class="fc-proposal-reject" onclick="rejectProposal('${d.id}')">${lucideIcon('x', 14)} Reject</button>
      </div>
    </div>`;
  }

  return `<div class="bucket-item todo-item" data-draft-id="${d.id}">
    <div class="todo-row">
      <span class="todo-text" ondblclick="startInlineEditDraft('${d.id}', this)" style="cursor:text;">${esc(d.content.length > 120 ? d.content.slice(0, 120) + '…' : d.content)}</span>
      ${isPending ? `<span class="fc-status-badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">⏳ Generating…</span>` : ''}
      <div class="todo-actions">
        ${!hasProposal && !isPending ? `<button onclick="requestProposal('${d.id}')" title="Generate flashcard">${lucideIcon('sparkles', 16)}</button>` : ''}
        <button onclick="startInlineEditDraftById('${d.id}')" title="Edit">${lucideIcon('pencil', 16)}</button>
        <button onclick="deleteDraft('${d.id}')" title="Delete">${lucideIcon('trash-2', 16)}</button>
      </div>
    </div>
    ${proposalHtml}
  </div>`;
}

// ── Deck Bucket ──
function renderDeckBucket(deck, q) {
  let cards = allCards.filter(c => c.deck === deck);
  if (q) cards = cards.filter(c => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));
  if (cards.length === 0 && q) return '';

  // Sort by strength (retrievability): weakest first, new cards at the end
  const nowStr = new Date().toISOString();
  cards.sort((a, b) => {
    const rA = a.last_review && a.stability ? retrievability(a.stability, a.last_review, nowStr) : 2;
    const rB = b.last_review && b.stability ? retrievability(b.stability, b.last_review, nowStr) : 2;
    return rA - rB;
  });

  const color = getDeckColor(deck);
  const now = new Date();
  const allDeckCards = allCards.filter(c => c.deck === deck);
  const newCount = allDeckCards.filter(c => !c.last_review).length;
  const dueCount = allDeckCards.filter(c => c.last_review && (!c.next_review || new Date(c.next_review) <= now)).length;

  const chips = [];
  if (newCount > 0) chips.push(`<span class="fc-chip fc-chip-new">${newCount} new</span>`);
  if (dueCount > 0) chips.push(`<span class="fc-chip fc-chip-due">${dueCount} due</span>`);

  const practiceCount = dueCount + newCount;

  return `<div class="project-card" id="flashDeck-${esc(deck)}" style="--cat-color:${color}">
    <div class="project-card-header">
      <div style="display:flex;align-items:flex-start;gap:6px;">
        <div class="project-info">
          <h3><span style="color:${color};">${esc(deck)}</span>${getFlashShortname(deck) ? '<span class="todo-cat-shortname-label">' + esc(getFlashShortname(deck)) + '</span>' : ''}</h3>
          <span class="tech">${allDeckCards.length} cards ${chips.join(' ')}</span>
        </div>
      </div>
      <div class="project-header-actions" style="opacity:1;">
        <button class="todo-cat-shortname-btn" onclick="promptFlashShortname('${esc(deck).replace(/'/g, "\\\\'")}')" title="${getFlashShortname(deck) ? 'Edit short name' : 'Set short name'}">${lucideIcon("pencil",14)}</button>
        ${practiceCount > 0 ? `<button class="fc-practice-btn" style="background:${color};" onclick="startPractice('${esc(deck)}')" title="Practice">${lucideIcon('play', 14, '#fff')} ${practiceCount}</button>` : `<span class="fc-all-done">${lucideIcon('circle-check', 14, '#22c55e')} Caught up</span>`}
        <button class="archive-project-btn" onclick="openAddFlashcardModal('${esc(deck)}')" title="Add card">${lucideIcon('plus', 16)}</button>
      </div>
    </div>
    <div class="task-list">
      ${cards.map(c => renderFlashcardItem(c, color)).join('')}
    </div>
  </div>`;
}

function renderFlashcardItem(c, color) {
  const now = new Date();
  const isNew = !c.last_review;
  const isDue = !isNew && (!c.next_review || new Date(c.next_review) <= now);
  const R = c.last_review && c.stability ? retrievability(c.stability, c.last_review, now.toISOString()) : null;

  let badge = '';
  if (isNew) badge = `<span class="fc-status-badge fc-status-new">New</span>`;
  else if (isDue) badge = `<span class="fc-status-badge fc-status-due">Due</span>`;
  else {
    const daysLeft = c.next_review ? Math.ceil((new Date(c.next_review) - now) / 86400000) : 0;
    badge = `<span class="fc-status-badge fc-status-ok">${daysLeft}d</span>`;
  }

  // Left border color: smooth gradient from red (R=0) → amber (R=0.5) → green (R=1), grey for new
  let borderColor = 'var(--muted)';
  if (R !== null) {
    // Interpolate hue: 0 (red) → 38 (amber) → 142 (green) based on R
    const hue = R <= 0.5
      ? Math.round(R * 2 * 38)            // 0→38
      : Math.round(38 + (R - 0.5) * 2 * 104); // 38→142
    const sat = 70 + Math.round(R * 15);   // 70-85%
    const lum = 40 + Math.round(R * 10);   // 40-50%
    borderColor = `hsl(${hue}, ${sat}%, ${lum}%)`;
  }

  const frontTrunc = c.front.length > 90 ? c.front.slice(0, 90) + '…' : c.front;

  return `<div class="bucket-item todo-item${isDue ? ' todo-overdue' : ''}" data-card-id="${c.id}" style="border-left:3px solid ${borderColor};">
    <div class="todo-row">
      <span class="todo-text">${esc(frontTrunc)}</span>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        ${badge}
      </div>
      <div class="todo-actions">
        <button onclick="openEditFlashcardModal('${c.id}')" title="Edit">${lucideIcon('pencil', 16)}</button>
        <button onclick="deleteFlashcard('${c.id}')" title="Delete">${lucideIcon('trash-2', 16)}</button>
      </div>
    </div>
  </div>`;
}

window.filterFlashcards = function(e) {
  searchQuery = e.target.value;
  renderAllBuckets();
};

// ── Draft CRUD ──
window.openAddDraftModal = function() {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addDraftModal" style="display:flex;" onclick="if(event.target===this)closeAddDraftModal()">
    <div class="modal">
      <h2>${lucideIcon('file-edit', 18, DRAFT_COLOR)} Add Draft</h2>
      <label>What do you want to learn?</label>
      <textarea id="newDraftContent" rows="4" placeholder="Any topic, question, or fact you want to memorize…"></textarea>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeAddDraftModal()">Cancel</button>
        <button class="modal-save" onclick="saveNewDraft()">Save</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('newDraftContent').focus();
};

window.closeAddDraftModal = function() {
  const m = document.getElementById('addDraftModal'); if (m) m.remove();
};

window.saveNewDraft = async function() {
  const content = document.getElementById('newDraftContent').value.trim();
  if (!content) { showToast('Content required'); return; }
  if (state.sb) await state.sb.from('flashcard_notes').insert({ content });
  closeAddDraftModal();
  await refreshFlashcards();
  showToast('Draft added');
};

window.handleDraftInput = function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); quickAddDraft(); }
};

window.quickAddDraft = async function() {
  const input = document.getElementById('draftQuickInput');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  if (state.sb) await state.sb.from('flashcard_notes').insert({ content });
  input.value = '';
  await refreshFlashcards();
  showToast('Draft added');
};

// ── Inline Draft Editing (uses shared inlineEditText) ──
window.startInlineEditDraft = function(id, spanEl) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft) return;
  inlineEditText(spanEl, draft.content, {
    saveFn: async (content) => {
      if (state.sb) {
        await state.sb.from('flashcard_notes').update({ content }).eq('id', id);
        showToast('Draft updated');
      }
    },
    refreshFn: refreshFlashcards,
  });
};

window.startInlineEditDraftById = function(id) {
  const el = document.querySelector(`[data-draft-id="${id}"] .todo-text`);
  if (el) window.startInlineEditDraft(id, el);
};

window.deleteDraft = function(id) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft) return;
  showDeleteConfirm('Delete Draft', 'Are you sure?', async () => {
    if (state.sb) await state.sb.from('flashcard_notes').delete().eq('id', id);
    await refreshFlashcards();
    showToast('Draft deleted');
  });
};

// ── Proposal Workflow ──
window.requestProposal = async function(id) {
  if (!state.sb) return;
  await state.sb.from('flashcard_notes').update({ proposal_status: 'pending' }).eq('id', id);
  const draft = allDrafts.find(d => d.id === id);
  if (draft) draft.proposal_status = 'pending';
  renderAllBuckets();
  showToast('Generating flashcard proposal…');
};

window.acceptProposal = async function(id) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft || !draft.proposed_front || !draft.proposed_back) return;
  const deck = draft.proposed_deck || 'Général';
  if (state.sb) {
    await state.sb.from('flashcards').insert({ deck, front: draft.proposed_front, back: draft.proposed_back });
    await state.sb.from('flashcard_notes').delete().eq('id', id);
  }
  await refreshFlashcards();
  showToast(`Card added to ${deck}`);
};

window.rejectProposal = async function(id) {
  if (!state.sb) return;
  await state.sb.from('flashcard_notes').update({
    proposal_status: null, proposed_front: null, proposed_back: null
  }).eq('id', id);
  const draft = allDrafts.find(d => d.id === id);
  if (draft) { draft.proposal_status = null; draft.proposed_front = null; draft.proposed_back = null; }
  renderAllBuckets();
  showToast('Proposal rejected');
};

window.editProposal = function(id) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft) return;
  closeAllFlashModals();
  const currentDeck = draft.proposed_deck || 'Général';
  const deckOptions = [...new Set([...allCards.map(c => c.deck), currentDeck])].sort().map(dk =>
    `<option value="${esc(dk)}"${dk === currentDeck ? ' selected' : ''}>${esc(dk)}</option>`
  ).join('');
  const html = `<div class="modal-overlay" id="editProposalModal" style="display:flex;" onclick="if(event.target===this)closeEditProposalModal()">
    <div class="modal">
      <h2>${lucideIcon('pencil', 18, '#8b5cf6')} Edit Proposal</h2>
      <label>Front (Question)</label>
      <textarea id="editProposalFront" rows="3">${esc(draft.proposed_front || '')}</textarea>
      <label>Back (Answer)</label>
      <textarea id="editProposalBack" rows="4">${esc(draft.proposed_back || '')}</textarea>
      <label>Deck</label>
      <select id="editProposalDeck">${deckOptions}</select>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeEditProposalModal()">Cancel</button>
        <button class="modal-save" onclick="saveEditedProposal('${draft.id}')">Save</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.closeEditProposalModal = function() {
  document.getElementById('editProposalModal')?.remove();
};

window.saveEditedProposal = async function(id) {
  const front = document.getElementById('editProposalFront').value.trim();
  const back = document.getElementById('editProposalBack').value.trim();
  const deck = document.getElementById('editProposalDeck').value;
  if (!front || !back) { showToast('Both fields are required'); return; }
  if (state.sb) {
    await state.sb.from('flashcard_notes').update({ proposed_front: front, proposed_back: back, proposed_deck: deck }).eq('id', id);
  }
  const draft = allDrafts.find(d => d.id === id);
  if (draft) { draft.proposed_front = front; draft.proposed_back = back; draft.proposed_deck = deck; }
  closeEditProposalModal();
  renderAllBuckets();
  showToast('Proposal updated');
};

window.updateProposedDeck = async function(id, deck) {
  if (state.sb) {
    await state.sb.from('flashcard_notes').update({ proposed_deck: deck }).eq('id', id);
  }
  const draft = allDrafts.find(d => d.id === id);
  if (draft) draft.proposed_deck = deck;
};

// ── Flashcard CRUD ──
window.openAddFlashcardModal = function(deck) {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addFlashcardModal" style="display:flex;" onclick="if(event.target===this)closeAddFlashcardModal()">
    <div class="modal">
      <h2>${lucideIcon('plus', 18, '#8b5cf6')} Add Flashcard</h2>
      <input type="hidden" id="newFlashDeck" value="${esc(deck || 'Général')}">
      <label>Front (Question)</label>
      <textarea id="newFlashFront" rows="3" placeholder="Question…"></textarea>
      <label>Back (Answer)</label>
      <textarea id="newFlashBack" rows="3" placeholder="Answer…"></textarea>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeAddFlashcardModal()">Cancel</button>
        <button class="modal-save" onclick="saveNewFlashcard()">Save</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('newFlashFront').focus();
};

window.closeAddFlashcardModal = function() {
  const m = document.getElementById('addFlashcardModal'); if (m) m.remove();
};

window.saveNewFlashcard = async function() {
  const deck = document.getElementById('newFlashDeck').value.trim();
  const front = document.getElementById('newFlashFront').value.trim();
  const back = document.getElementById('newFlashBack').value.trim();
  if (!front || !back) { showToast('Front and back required'); return; }
  if (state.sb) await state.sb.from('flashcards').insert({ deck, front, back });
  closeAddFlashcardModal();
  await refreshFlashcards();
  showToast('Card added');
};

window.openEditFlashcardModal = function(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  closeAllFlashModals();
  const decks = [...new Set(allCards.map(c => c.deck))].sort();
  const deckOptions = decks.map(d => `<option value="${esc(d)}" ${d === card.deck ? 'selected' : ''}>${esc(d)}</option>`).join('');
  const html = `<div class="modal-overlay" id="editFlashcardModal" style="display:flex;" onclick="if(event.target===this)closeEditFlashcardModal()">
    <div class="modal">
      <h2>${lucideIcon('pencil', 18, '#f59e0b')} Edit Flashcard</h2>
      <input type="hidden" id="editFlashId" value="${id}">
      <label>Deck</label>
      <select id="editFlashDeck">${deckOptions}</select>
      <label>Front (Question)</label>
      <textarea id="editFlashFront" rows="3">${esc(card.front)}</textarea>
      <label>Back (Answer)</label>
      <textarea id="editFlashBack" rows="3">${esc(card.back)}</textarea>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeEditFlashcardModal()">Cancel</button>
        <button class="modal-save" onclick="saveEditFlashcard()">Save</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.closeEditFlashcardModal = function() {
  const m = document.getElementById('editFlashcardModal'); if (m) m.remove();
};

window.saveEditFlashcard = async function() {
  const id = document.getElementById('editFlashId').value;
  const deck = document.getElementById('editFlashDeck').value.trim();
  const front = document.getElementById('editFlashFront').value.trim();
  const back = document.getElementById('editFlashBack').value.trim();
  if (!front || !back) { showToast('Front and back required'); return; }
  if (state.sb) await state.sb.from('flashcards').update({ deck, front, back }).eq('id', id);
  closeEditFlashcardModal();
  await refreshFlashcards();
  showToast('Card updated');
};

window.deleteFlashcard = function(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  showDeleteConfirm('Delete Flashcard', 'Are you sure?', async () => {
    if (state.sb) await state.sb.from('flashcards').delete().eq('id', id);
    await refreshFlashcards();
    showToast('Card deleted');
  });
};

// ── New Deck ──
window.openAddFlashDeckModal = function() {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addFlashDeckModal" style="display:flex;" onclick="if(event.target===this)closeAddFlashDeckModal()">
    <div class="modal">
      <h2>${lucideIcon('book-open', 18, '#06b6d4')} New Deck</h2>
      <label>Deck Name</label>
      <input type="text" id="newDeckName" placeholder="e.g. Histoire, Vocabulaire…">
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeAddFlashDeckModal()">Cancel</button>
        <button class="modal-save" onclick="saveNewFlashDeck()">Create</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('newDeckName').focus();
};

window.closeAddFlashDeckModal = function() {
  const m = document.getElementById('addFlashDeckModal'); if (m) m.remove();
};

window.saveNewFlashDeck = function() {
  const name = document.getElementById('newDeckName').value.trim();
  if (!name) { showToast('Name required'); return; }
  closeAddFlashDeckModal();
  openAddFlashcardModal(name);
};

function closeAllFlashModals() {
  ['addFlashcardModal', 'editFlashcardModal', 'addDraftModal', 'addFlashDeckModal'].forEach(id => {
    const m = document.getElementById(id); if (m) m.remove();
  });
}

// ── Practice Session ──
function startPractice(deckFilter) {
  const now = new Date();
  let pool = allCards.filter(c => !c.next_review || new Date(c.next_review) <= now);
  if (deckFilter && deckFilter !== '__all') pool = pool.filter(c => c.deck === deckFilter);
  if (pool.length === 0) { showToast('No cards due for review!'); return; }

  const SESSION_SIZE = 10;
  const failed = pool.filter(c => c.last_review && c.stability > 0 && c.stability <= 2);
  const overdue = pool.filter(c => c.last_review && c.stability > 2)
    .sort((a, b) => new Date(a.next_review || 0) - new Date(b.next_review || 0));
  const fresh = pool.filter(c => !c.last_review).sort(() => Math.random() - 0.5);

  let selected = [];
  for (const group of [failed, overdue, fresh]) {
    for (const card of group) {
      if (selected.length >= SESSION_SIZE) break;
      if (!selected.find(s => s.id === card.id)) selected.push(card);
    }
    if (selected.length >= SESSION_SIZE) break;
  }
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
  if (sessionQueue.length === 0) { showSessionSummary(); return; }

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
    </div>`;
}

window.revealCard = function() {
  const card = document.getElementById('practiceCard');
  if (!card || card.classList.contains('flipped')) return;
  card.classList.add('flipped');
  document.getElementById('practiceHint').style.display = 'none';
  document.getElementById('practiceButtons').style.display = 'flex';
};

window.rateCard = async function(rating) {
  if (sessionQueue.length === 0) return;
  const card = sessionQueue.shift();
  const now = new Date();
  const updates = fsrsUpdate(card, rating, now);
  Object.assign(card, updates);
  const idx = allCards.findIndex(c => c.id === card.id);
  if (idx >= 0) Object.assign(allCards[idx], updates);
  if (state.sb) await state.sb.from('flashcards').update(updates).eq('id', card.id);
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
      <div class="practice-summary-emoji">${accuracy >= 80 ? lucideIcon('trophy', 32) : accuracy >= 50 ? lucideIcon('flame', 32) : lucideIcon('book-open', 32)}</div>
      <h2>Session Complete</h2>
      <div class="practice-summary-stats">
        <div class="practice-summary-stat"><span class="practice-stat-val">${sessionDone}</span><span class="practice-stat-lbl">Reviewed</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${sessionCorrect}</span><span class="practice-stat-lbl">Good+</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${accuracy}%</span><span class="practice-stat-lbl">Accuracy</span></div>
      </div>
      <button class="btn practice-done-btn" onclick="endPractice()">Done</button>
    </div>`;
}

// ── Keyboard shortcuts in practice ──
document.addEventListener('keydown', (e) => {
  if (!sessionActive) return;
  const card = document.getElementById('practiceCard');
  if (!card) return;
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (!card.classList.contains('flipped')) window.revealCard();
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
function initFlashcardModals() {}
function getFlashcardCounts() {
  return { cards: allCards.length, drafts: allDrafts.length };
}

export { refreshFlashcards, renderFlashcards, initFlashcardModals, getFlashcardCounts };
window.renderFlashcards = renderFlashcards;
window.refreshFlashcards = refreshFlashcards;

window.promptFlashShortname = promptFlashShortname;
