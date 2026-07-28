'use strict';

// ── Utilities ────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const fmt = n => typeof n === 'number' ? n.toLocaleString() : String(n ?? '');

function toast(msg, type = 'ok') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Review cache ─────────────────────────────────────────────
const reviewCache = {};

function qualityBadgeHtml(recordId, source, reviewData) {
  if (reviewData) {
    if (reviewData.state === 'approved')   return `<span class="quality-badge q-approved">Approved</span>`;
    if (reviewData.state === 'flagged')    return `<span class="quality-badge q-flagged">Flagged</span>`;
    if (reviewData.state === 'unreviewed') return `<span class="quality-badge q-unreviewed">Unreviewed</span>`;
  }
  if (source === 'Uslar 1890') return `<span class="quality-badge q-ocr">OCR — unreviewed</span>`;
  return `<span class="quality-badge q-unreviewed">Unreviewed</span>`;
}

// ── State ────────────────────────────────────────────────────
let currentPage   = 1;
let currentTotal  = 0;
let currentPages  = 1;
let currentExpanded = [];
let currentSenses   = [];
let openReviewId  = null;
let searchPending = false;

// ── DOM refs ─────────────────────────────────────────────────
const $q       = document.getElementById('q');
const $kind    = document.getElementById('kind');
const $source  = document.getElementById('source');
const $variety = document.getElementById('variety');
const $concept = document.getElementById('concept-card');
const $tbody   = document.getElementById('tbody');
const $count   = document.getElementById('count-label');
const $page    = document.getElementById('page-label');
const $page2   = document.getElementById('page-label2');
const $prev    = document.getElementById('prev-btn');
const $next    = document.getElementById('next-btn');
const $prev2   = document.getElementById('prev-btn2');
const $next2   = document.getElementById('next-btn2');

// ── Populate stats from server ────────────────────────────────
async function loadStats() {
  try {
    const res  = await fetch('/api/corpus/stats');
    const data = await res.json();
    const s    = data.stats;
    const row  = document.getElementById('stats-row');
    row.innerHTML = [
      ['Documents', s.documents],
      ['Segments',  s.sentences],
      ['Tokens',    fmt(s.tokens)],
      ['Lexicon',   fmt(s.lexicon_rows)],
    ].map(([l, v]) =>
      `<div class="stat-chip"><span class="val">${v}</span><span class="lbl">${l}</span></div>`
    ).join('');
  } catch { /* silent */ }
}

// ── Search (calls server API) ─────────────────────────────────
async function search(page = 1) {
  if (searchPending) return;
  searchPending = true;
  currentPage = page;

  const q       = $q.value.trim();
  const kind    = $kind.value;
  const source  = $source.value;
  const variety = $variety.value;

  const params = new URLSearchParams({ page, limit: 50 });
  if (q)       params.set('q', q);
  if (kind)    params.set('kind', kind);
  if (source)  params.set('source', source);
  if (variety) params.set('variety', variety);

  $tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text3);">Searching…</td></tr>`;
  [$prev,$prev2,$next,$next2].forEach(b => b.disabled = true);

  try {
    const res  = await fetch(`/api/corpus/search?${params}`);
    if (!res.ok) throw new Error('Search failed');
    const data = await res.json();

    currentTotal    = data.total;
    currentPages    = data.pages;
    currentPage     = data.page;
    currentExpanded = data.expanded || [];
    currentSenses   = data.senses   || [];

    renderConceptCard(q, currentExpanded, currentSenses);
    renderResults(data.rows);
    renderPagination();

    // Fetch review badges for visible records
    const ids = data.rows.map(r => r[5]).filter(Boolean);
    if (ids.length) {
      fetchBulkReviews(ids).then(revMap => updateBadges(data.rows, revMap));
    }
  } catch (err) {
    $tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
      <div class="icon">⚠️</div><h3>Search error</h3><p>${esc(err.message)}</p>
    </div></td></tr>`;
  } finally {
    searchPending = false;
  }
}

function renderConceptCard(q, expanded, senses) {
  if (!expanded.length) {
    $concept.classList.remove('visible');
    $concept.innerHTML = '';
    return;
  }
  $concept.innerHTML = `
    <div>
      <div class="concept-label">Russian query</div>
      <div class="concept-val">${esc(q)}</div>
    </div>
    <div class="concept-arrow">→</div>
    <div>
      <div class="concept-label">Lak translation</div>
      <div class="concept-val" lang="lbe">${expanded.map(esc).join(' · ')}</div>
      ${senses.length ? `<div class="concept-senses">Dictionary senses: ${senses.map(esc).join(', ')}</div>` : ''}
    </div>`;
  $concept.classList.add('visible');
}

function renderPagination() {
  const prefix = currentExpanded.length && $kind.value !== 'lexicon' ? 'Corpus occurrences · ' : '';
  $count.innerHTML = `${prefix}<b>${currentTotal.toLocaleString()}</b> records`;
  const text = `Page ${currentPage} of ${currentPages}`;
  $page.textContent = $page2.textContent = text;
  [$prev,$prev2].forEach(b => b.disabled = currentPage <= 1);
  [$next,$next2].forEach(b => b.disabled = currentPage >= currentPages);
}

function renderResults(rows) {
  if (!rows.length) {
    $tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
      <div class="icon">🔍</div><h3>No records match</h3>
      <p>Try a different query, or clear the filters above.</p>
    </div></td></tr>`;
    return;
  }

  $tbody.innerHTML = rows.map(r => {
    const [type, lak, meaning, source, variety, recordId, url] = r;
    const typeTag = type === 'text'
      ? `<span class="tag tag-text">Text</span>`
      : `<span class="tag tag-lexicon">Lexicon</span>`;

    const review  = reviewCache[recordId];
    const badge   = qualityBadgeHtml(recordId, source, review);
    const ocrWarn = (source === 'Uslar 1890' && !review)
      ? `<span class="quality-badge q-ocr" style="margin-top:5px;">OCR — unreviewed</span>` : '';

    const sourceCell = url
      ? `<a href="${esc(url)}" class="source-link" target="_blank" rel="noreferrer">${esc(source)}</a>`
      : esc(source);

    const varietyLabel = variety ? variety.charAt(0).toUpperCase() + variety.slice(1) : '—';

    return `<tr data-record="${esc(recordId)}">
      <td class="td-type">${typeTag}${badge}${ocrWarn}<div class="record-meta">${esc(recordId)}</div></td>
      <td class="td-lak"><span class="lak-text" lang="lbe">${esc(lak)}</span></td>
      <td class="td-meaning">${esc(meaning)}</td>
      <td>${sourceCell}</td>
      <td>${varietyLabel}</td>
      <td class="td-actions"><button class="btn btn-sm" data-id="${esc(recordId)}" onclick="toggleReview(this)">Review</button></td>
    </tr>`;
  }).join('');
}

// ── Review badge refresh after bulk fetch ─────────────────────
async function fetchBulkReviews(ids) {
  try {
    const res = await fetch('/api/reviews/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_ids: ids }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    Object.assign(reviewCache, data.reviews || {});
    return data.reviews || {};
  } catch { return {}; }
}

function updateBadges(rows, revMap) {
  for (const r of rows) {
    const [,, , source,, recordId] = r;
    const review = revMap[recordId];
    if (!review) continue;
    const dataRow = document.querySelector(`tr[data-record="${CSS.escape(recordId)}"]`);
    if (!dataRow) continue;
    dataRow.querySelectorAll('.quality-badge').forEach(b => b.remove());
    const newBadge = document.createElement('span');
    newBadge.className = review.state === 'approved' ? 'quality-badge q-approved'
                       : review.state === 'flagged'  ? 'quality-badge q-flagged'
                       : 'quality-badge q-unreviewed';
    newBadge.textContent = review.state === 'approved' ? 'Approved'
                         : review.state === 'flagged'  ? 'Flagged' : 'Unreviewed';
    dataRow.querySelector('.tag')?.insertAdjacentElement('afterend', newBadge);
  }
}

// ── Inline review panel ───────────────────────────────────────
window.toggleReview = function(btn) {
  const recordId = btn.dataset.id;
  const existing = document.querySelector('.review-row');
  if (existing && openReviewId === recordId) { existing.remove(); openReviewId = null; return; }
  existing?.remove();
  openReviewId = recordId;
  const row = btn.closest('tr');
  const review = reviewCache[recordId] || {};

  const panelRow = document.createElement('tr');
  panelRow.className = 'review-row';
  panelRow.innerHTML = `
    <td colspan="6">
      <div style="font-size:13px;font-weight:600;color:var(--text2);margin-bottom:10px;">
        Review — <span style="font-family:var(--font-mono);font-weight:400;">${esc(recordId)}</span>
      </div>
      <div class="review-panel">
        <div>
          <label style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;display:block;">Correction (optional)</label>
          <textarea id="rv-correction" rows="3" placeholder="Corrected Lak text or translation…">${esc(review.correction || '')}</textarea>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;display:block;">Note (optional)</label>
          <textarea id="rv-note" rows="3" placeholder="Describe the issue or your finding…">${esc(review.note || '')}</textarea>
        </div>
      </div>
      <div>
        <label style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;display:block;margin-top:8px;">Your name (optional)</label>
        <input type="text" id="rv-name" placeholder="Reviewer name or anonymous" value="${esc(review.reviewer_name || '')}" style="width:260px;">
      </div>
      <div class="review-actions">
        <button class="btn btn-ok" onclick="submitReview('${esc(recordId)}','approved')">✓ Approve</button>
        <button class="btn btn-warn" onclick="submitReview('${esc(recordId)}','flagged')">⚑ Flag</button>
        <button class="btn" onclick="submitReview('${esc(recordId)}','unreviewed')">↺ Mark unreviewed</button>
        <button class="btn" onclick="document.querySelector('.review-row')?.remove();openReviewId=null;">Cancel</button>
        ${review.state ? `<span style="font-size:12px;color:var(--text3);">Current: <b>${review.state}</b> · ${new Date(review.updated_at).toLocaleDateString()}</span>` : ''}
      </div>
    </td>`;
  row.insertAdjacentElement('afterend', panelRow);
};

window.submitReview = async function(recordId, state) {
  const correction    = document.getElementById('rv-correction')?.value.trim() || null;
  const note          = document.getElementById('rv-note')?.value.trim() || null;
  const reviewer_name = document.getElementById('rv-name')?.value.trim() || null;
  try {
    const res = await fetch('/api/reviews', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: recordId, state, correction, note, reviewer_name }),
    });
    if (!res.ok) throw new Error('Server error');
    const data = await res.json();
    reviewCache[recordId] = data.review;
    document.querySelector('.review-row')?.remove();
    openReviewId = null;

    // Update badge in visible row
    const dataRow = document.querySelector(`tr[data-record="${CSS.escape(recordId)}"]`);
    if (dataRow) {
      dataRow.querySelectorAll('.quality-badge').forEach(b => b.remove());
      const nb = document.createElement('span');
      nb.className = state === 'approved' ? 'quality-badge q-approved'
                   : state === 'flagged'  ? 'quality-badge q-flagged' : 'quality-badge q-unreviewed';
      nb.textContent = state === 'approved' ? 'Approved' : state === 'flagged' ? 'Flagged' : 'Unreviewed';
      dataRow.querySelector('.tag')?.insertAdjacentElement('afterend', nb);
    }
    toast(`Review saved: ${state}`, 'ok');
  } catch {
    toast('Failed to save review. Please try again.', 'err');
  }
};

// ── Pagination ────────────────────────────────────────────────
function prevPage() { if (currentPage > 1) { search(currentPage - 1); scrollTo(0, 0); } }
function nextPage() { if (currentPage < currentPages) { search(currentPage + 1); scrollTo(0, 0); } }
$prev.onclick = $prev2.onclick = prevPage;
$next.onclick = $next2.onclick = nextPage;

// ── Search wiring ─────────────────────────────────────────────
let debounceTimer;
$q.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => search(1), 300);
});
[$kind, $source, $variety].forEach(el => el.addEventListener('change', () => search(1)));

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  search(1);
});
