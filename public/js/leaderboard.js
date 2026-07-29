'use strict';

// Public leaderboard + personal progress. Ranked by confirmed quality points,
// with verified validations, reliability band, streak, and expert badges.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const BADGES = {
  verified_expert: '<span class="badge badge-expert">expert</span>',
  administrator: '<span class="badge badge-admin">admin</span>',
  trusted_validator: '<span class="badge badge-trusted">trusted</span>',
};
const BAND_CLASS = { high: 'band-high', established: 'band-established', developing: 'band-developing', new: 'band-new' };

let period = 'all';

function rowHtml(e, rank, highlight) {
  return `<tr${highlight ? ' class="lb-me"' : ''}>
    <td data-label="Rank">${rank}</td>
    <td data-label="Contributor">${esc(e.display_name)} ${BADGES[e.role] || ''}</td>
    <td data-label="Verified validations">${e.verified_validations}</td>
    <td data-label="Reliability"><span class="band ${BAND_CLASS[e.reliability_band] || ''}">${esc(e.reliability_band)}</span></td>
    <td data-label="Streak">${e.streak > 0 ? '🔥 ' + e.streak : '—'}</td>
    <td data-label="Confirmed points"><b>${e.points}</b></td>
  </tr>`;
}

async function loadBoard() {
  const res = await fetch(`/api/leaderboard?period=${period}`);
  const data = await res.json();
  const body = document.getElementById('lb-body');
  if (!data.entries.length) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text3); padding:24px;">
      No opted-in contributors for this period yet — be the first.</td></tr>`;
    return;
  }
  body.innerHTML = data.entries.map((e, i) => {
    const mine = window.ACCOUNT && e.id === window.ACCOUNT.id;
    return rowHtml(e, i + 1, mine);
  }).join('');
}

async function loadMe() {
  if (!window.ACCOUNT) return;
  const res = await fetch(`/api/leaderboard/me?period=${period}`);
  if (!res.ok) return;
  const me = await res.json();
  const panel = document.getElementById('me-panel');
  panel.style.display = '';
  const rel = me.reliability_explanation || {};
  const evCounts = Object.entries(rel.events || {}).map(([k, n]) => `${k.replace(/_/g, ' ')}: ${n}`).join(' · ') || 'no events yet';
  const quests = (me.quests || []).map(q =>
    `<span class="quest-chip${q.done ? ' done' : ''}">${esc(q.label)} ${q.progress}/${q.target}${q.done ? ' ✓' : ''}</span>`).join(' ');
  const achv = (me.achievements || []).slice(0, 8).map(a =>
    `<span class="quest-chip done" title="${esc(a.key)}">🏅 ${esc(a.label)}</span>`).join(' ');
  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
      <h2 style="font-size:16px;">Your progress</h2>
      ${me.opted_in ? '' : '<a href="/profile.html" style="font-size:13px; color:var(--accent);">You are not publicly listed — opt in on your profile</a>'}
    </div>
    <div class="me-grid">
      <div class="val-stat"><b>${me.rank ? '#' + me.rank : '—'}</b><span>rank${me.percentile != null ? ` · top ${100 - me.percentile}%` : ''}</span></div>
      <div class="val-stat"><b>${me.confirmed_points}</b><span>confirmed points</span></div>
      <div class="val-stat"><b>${me.verified_validations}</b><span>verified validations</span></div>
      <div class="val-stat"><b>${me.streak > 0 ? '🔥 ' + me.streak : 0}</b><span>day streak</span></div>
      <div class="val-stat"><b class="band ${BAND_CLASS[me.reliability_band] || ''}">${esc(me.reliability_band)}</b><span>reliability</span></div>
    </div>
    <details style="margin-top:12px;">
      <summary style="cursor:pointer; color:var(--accent); font-size:13px;">How is my reliability calculated?</summary>
      <p style="font-size:13px; color:var(--text2); margin-top:8px;">${esc(rel.basis || '')}</p>
      <p style="font-size:12px; color:var(--text3); margin-top:6px;">${esc(evCounts)}</p>
    </details>
    ${quests ? `<div style="margin-top:12px;">${quests}</div>` : ''}
    ${achv ? `<div style="margin-top:10px;">${achv}</div>` : ''}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.fetchIdentity();
  document.querySelectorAll('.lb-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.lb-tab').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      period = btn.dataset.period;
      await Promise.all([loadBoard(), loadMe()]);
    });
  });
  await Promise.all([loadBoard(), loadMe()]);
});
