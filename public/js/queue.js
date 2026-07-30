'use strict';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ── Localization helper (canonical dictionary in i18n.js) ──
function t(key, def, vars) {
  const I = window.I18n;
  if (I && typeof I.t === 'function') {
    const out = I.t(key, vars);
    if (out != null && out !== key) return out;
  }
  return def;
}
function tp(key, count, def, vars) {
  const I = window.I18n;
  if (I && typeof I.plural === 'function') {
    const out = I.plural(key, count, vars);
    if (out != null && out !== key) return out;
  }
  return def;
}
function localeTag() {
  const I = window.I18n;
  if (I && typeof I.getLanguage === 'function') return I.getLanguage() === 'ru' ? 'ru-RU' : 'en-GB';
  return 'en-GB';
}
// Localized display labels for review states (canonical values preserved).
function reviewStateLabel(state) {
  if (state === 'approved')   return t('review.state.approved', 'Approved');
  if (state === 'flagged')    return t('review.state.flagged', 'Flagged');
  return t('review.state.unreviewed', 'Unreviewed');
}

function toast(msg, type = 'ok') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

let currentOffset = 0;
const LIMIT = 100;
let allRows = [];
let lastReviewStats = null;

async function loadStats() {
  try {
    const res = await fetch('/api/stats/reviews');
    if (!res.ok) return;
    const data = await res.json();
    lastReviewStats = data;
    document.getElementById('cnt-approved').textContent   = (data.approved  || 0).toLocaleString(localeTag());
    document.getElementById('cnt-flagged').textContent    = (data.flagged   || 0).toLocaleString(localeTag());
    document.getElementById('cnt-unreviewed').textContent = (data.unreviewed|| 0).toLocaleString(localeTag());
  } catch { /* silent */ }
}

async function loadReviews(reset = false) {
  if (reset) { currentOffset = 0; allRows = []; }

  const state = document.getElementById('filter-state').value;
  const url = `/api/reviews?limit=${LIMIT}&offset=${currentOffset}${state ? '&state=' + encodeURIComponent(state) : ''}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(t('queue.error.server', 'Server error'));
    const data = await res.json();
    const rows = data.reviews || [];

    if (reset) allRows = rows;
    else allRows = allRows.concat(rows);

    currentOffset += rows.length;

    renderTable();

    const loadMore = document.getElementById('load-more-btn');
    loadMore.style.display = rows.length === LIMIT ? '' : 'none';

    renderCountLabel();

  } catch (err) {
    document.getElementById('queue-tbody').innerHTML = `<tr><td colspan="5">
      <div class="empty-state">
        <div class="icon">⚠️</div>
        <h3>${esc(t('queue.error.title', 'Could not load reviews'))}</h3>
        <p>${esc(err.message)}</p>
      </div>
    </td></tr>`;
  }
}

function renderCountLabel() {
  document.getElementById('queue-count-label').textContent =
    allRows.length > 0
      ? tp('queue.reviewsLoaded', allRows.length, `${allRows.length.toLocaleString(localeTag())} reviews loaded`, { count: allRows.length.toLocaleString(localeTag()) })
      : '';
}

function renderTable() {
  const tbody = document.getElementById('queue-tbody');

  if (!allRows.length) {
    tbody.innerHTML = `<tr><td colspan="5">
      <div class="empty-state">
        <div class="icon">📋</div>
        <h3>${esc(t('queue.empty.title', 'No reviews yet'))}</h3>
        <p>${esc(t('queue.empty.body', 'Reviews submitted from the search page appear here.'))}</p>
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = allRows.map(r => {
    let stateBadge = '';
    if (r.state === 'approved')   stateBadge = `<span class="quality-badge q-approved">${esc(reviewStateLabel('approved'))}</span>`;
    else if (r.state === 'flagged') stateBadge = `<span class="quality-badge q-flagged">${esc(reviewStateLabel('flagged'))}</span>`;
    else                            stateBadge = `<span class="quality-badge q-unreviewed">${esc(reviewStateLabel('unreviewed'))}</span>`;

    const correction = r.correction ? `<div style="font-size:13px; margin-top:4px;"><b>${esc(t('queue.correctionLabel', 'Correction:'))}</b> ${esc(r.correction)}</div>` : '';
    const note       = r.note       ? `<div style="font-size:13px; margin-top:2px; color:var(--text2);"><b>${esc(t('queue.noteLabel', 'Note:'))}</b> ${esc(r.note)}</div>` : '';

    const dt = r.updated_at
      ? new Date(r.updated_at).toLocaleDateString(localeTag(), { day:'numeric', month:'short', year:'numeric' })
      : '—';

    return `<tr>
      <td data-label="${esc(t('queue.col.recordId', 'Record ID'))}"><span style="font-family:var(--font-mono); font-size:12.5px;">${esc(r.record_id)}</span></td>
      <td data-label="${esc(t('queue.col.state', 'State'))}">${stateBadge}</td>
      <td data-label="${esc(t('queue.col.reviewer', 'Reviewer'))}" style="font-size:13px; color:var(--text2);">${esc(r.reviewer_name || '—')}${r.reviewer_verified ? ` <span class="quality-badge q-approved" title="${esc(t('queue.verifiedTooltip', 'Submitted by a logged-in reviewer'))}" style="font-size:10.5px;">${esc(t('queue.verified', '✓ verified'))}</span>` : ''}</td>
      <td data-label="${esc(t('queue.col.correctionNote', 'Correction / Note'))}">${correction}${note}${!correction && !note ? '<span style="color:var(--text3); font-size:13px;">—</span>' : ''}</td>
      <td data-label="${esc(t('queue.col.updated', 'Updated'))}" style="font-size:13px; color:var(--text2); white-space:nowrap;">${dt}</td>
    </tr>`;
  }).join('');
}

// ── Re-render on language change ──────────────────────────────
function relocalize() {
  if (lastReviewStats) {
    document.getElementById('cnt-approved').textContent   = (lastReviewStats.approved  || 0).toLocaleString(localeTag());
    document.getElementById('cnt-flagged').textContent    = (lastReviewStats.flagged   || 0).toLocaleString(localeTag());
    document.getElementById('cnt-unreviewed').textContent = (lastReviewStats.unreviewed|| 0).toLocaleString(localeTag());
  }
  renderTable();
  renderCountLabel();
}
(function () {
  if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(relocalize);
  else window.addEventListener('i18n:change', relocalize);
})();

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (window.fetchReviewer) window.fetchReviewer();
  loadStats();
  loadReviews(true);

  document.getElementById('filter-state').addEventListener('change', () => loadReviews(true));
  document.getElementById('load-more-btn').addEventListener('click', () => loadReviews(false));
});
