'use strict';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

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

async function loadStats() {
  try {
    const res = await fetch('/api/stats/reviews');
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('cnt-approved').textContent   = (data.approved  || 0).toLocaleString();
    document.getElementById('cnt-flagged').textContent    = (data.flagged   || 0).toLocaleString();
    document.getElementById('cnt-unreviewed').textContent = (data.unreviewed|| 0).toLocaleString();
  } catch { /* silent */ }
}

async function loadReviews(reset = false) {
  if (reset) { currentOffset = 0; allRows = []; }

  const state = document.getElementById('filter-state').value;
  const url = `/api/reviews?limit=${LIMIT}&offset=${currentOffset}${state ? '&state=' + encodeURIComponent(state) : ''}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Server error');
    const data = await res.json();
    const rows = data.reviews || [];

    if (reset) allRows = rows;
    else allRows = allRows.concat(rows);

    currentOffset += rows.length;

    renderTable();

    const loadMore = document.getElementById('load-more-btn');
    loadMore.style.display = rows.length === LIMIT ? '' : 'none';

    document.getElementById('queue-count-label').textContent =
      allRows.length > 0 ? `${allRows.length.toLocaleString()} reviews loaded` : '';

  } catch (err) {
    document.getElementById('queue-tbody').innerHTML = `<tr><td colspan="5">
      <div class="empty-state">
        <div class="icon">⚠️</div>
        <h3>Could not load reviews</h3>
        <p>${esc(err.message)}</p>
      </div>
    </td></tr>`;
  }
}

function renderTable() {
  const tbody = document.getElementById('queue-tbody');

  if (!allRows.length) {
    tbody.innerHTML = `<tr><td colspan="5">
      <div class="empty-state">
        <div class="icon">📋</div>
        <h3>No reviews yet</h3>
        <p>Reviews submitted from the search page appear here.</p>
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = allRows.map(r => {
    let stateBadge = '';
    if (r.state === 'approved')   stateBadge = `<span class="quality-badge q-approved">Approved</span>`;
    else if (r.state === 'flagged') stateBadge = `<span class="quality-badge q-flagged">Flagged</span>`;
    else                            stateBadge = `<span class="quality-badge q-unreviewed">Unreviewed</span>`;

    const correction = r.correction ? `<div style="font-size:13px; margin-top:4px;"><b>Correction:</b> ${esc(r.correction)}</div>` : '';
    const note       = r.note       ? `<div style="font-size:13px; margin-top:2px; color:var(--text2);"><b>Note:</b> ${esc(r.note)}</div>` : '';

    const dt = r.updated_at
      ? new Date(r.updated_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
      : '—';

    return `<tr>
      <td><span style="font-family:var(--font-mono); font-size:12.5px;">${esc(r.record_id)}</span></td>
      <td>${stateBadge}</td>
      <td style="font-size:13px; color:var(--text2);">${esc(r.reviewer_name || '—')}${r.reviewer_verified ? ' <span class="quality-badge q-approved" title="Submitted by a logged-in reviewer" style="font-size:10.5px;">✓ verified</span>' : ''}</td>
      <td>${correction}${note}${!correction && !note ? '<span style="color:var(--text3); font-size:13px;">—</span>' : ''}</td>
      <td style="font-size:13px; color:var(--text2); white-space:nowrap;">${dt}</td>
    </tr>`;
  }).join('');
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (window.fetchReviewer) window.fetchReviewer();
  loadStats();
  loadReviews(true);

  document.getElementById('filter-state').addEventListener('change', () => loadReviews(true));
  document.getElementById('load-more-btn').addEventListener('click', () => loadReviews(false));
});
