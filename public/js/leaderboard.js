'use strict';

// Public leaderboard + personal progress. Ranked by confirmed quality points,
// with verified validations, reliability band, streak, and expert badges.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Localization helper (canonical dictionary in i18n.js) ──
function t(key, def, vars) {
  const I = window.I18n;
  if (I && typeof I.t === 'function') {
    const out = I.t(key, vars);
    if (out != null && out !== key) return out;
  }
  return def;
}

// Role badges: CSS classes are canonical; only the visible label is localized.
function roleBadge(role) {
  if (role === 'verified_expert')   return `<span class="badge badge-expert">${esc(t('role.badge.expert', 'expert'))}</span>`;
  if (role === 'administrator')     return `<span class="badge badge-admin">${esc(t('role.badge.admin', 'admin'))}</span>`;
  if (role === 'trusted_validator') return `<span class="badge badge-trusted">${esc(t('role.badge.trusted', 'trusted'))}</span>`;
  return '';
}
const BAND_CLASS = { high: 'band-high', established: 'band-established', developing: 'band-developing', new: 'band-new' };
// Localized reliability band display (canonical value preserved).
function bandLabel(band) {
  return t('reliability.band.' + String(band || '').toLowerCase(), band);
}
// Localized reliability event names.
function eventLabel(key) {
  return t('reliability.event.' + String(key), String(key).replace(/_/g, ' '));
}
// Localized quest labels.
function questLabel(q) {
  if (q.key) return t('quest.' + String(q.key), q.label);
  return q.label;
}

let period = 'all';
let lastEntries = null;
let lastMe = null;

function rowHtml(e, rank, highlight) {
  return `<tr${highlight ? ' class="lb-me"' : ''}>
    <td data-label="${esc(t('leaderboard.col.rank', 'Rank'))}">${rank}</td>
    <td data-label="${esc(t('leaderboard.col.contributor', 'Contributor'))}">${esc(e.display_name)} ${roleBadge(e.role)}</td>
    <td data-label="${esc(t('leaderboard.col.verifiedValidations', 'Verified validations'))}">${e.verified_validations}</td>
    <td data-label="${esc(t('leaderboard.col.reliability', 'Reliability'))}"><span class="band ${BAND_CLASS[e.reliability_band] || ''}">${esc(bandLabel(e.reliability_band))}</span></td>
    <td data-label="${esc(t('leaderboard.col.streak', 'Streak'))}">${e.streak > 0 ? '🔥 ' + e.streak : '—'}</td>
    <td data-label="${esc(t('leaderboard.col.confirmedPoints', 'Confirmed points'))}"><b>${e.points}</b></td>
  </tr>`;
}

async function loadBoard() {
  const res = await fetch(`/api/leaderboard?period=${period}`);
  const data = await res.json();
  lastEntries = data.entries || [];
  renderBoard();
}
function renderBoard() {
  const body = document.getElementById('lb-body');
  if (!lastEntries) return;
  if (!lastEntries.length) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text3); padding:24px;">
      ${esc(t('leaderboard.empty', 'No opted-in contributors for this period yet — be the first.'))}</td></tr>`;
    return;
  }
  body.innerHTML = lastEntries.map((e, i) => {
    const mine = window.ACCOUNT && e.id === window.ACCOUNT.id;
    return rowHtml(e, i + 1, mine);
  }).join('');
}

async function loadMe() {
  if (!window.ACCOUNT) return;
  const res = await fetch(`/api/leaderboard/me?period=${period}`);
  if (!res.ok) return;
  lastMe = await res.json();
  renderMe();
}
function renderMe() {
  const me = lastMe;
  if (!me) return;
  const panel = document.getElementById('me-panel');
  panel.style.display = '';
  const rel = me.reliability_explanation || {};
  const evCounts = Object.entries(rel.events || {}).map(([k, n]) => `${eventLabel(k)}: ${n}`).join(' · ') || t('leaderboard.noEvents', 'no events yet');
  const quests = (me.quests || []).map(q =>
    `<span class="quest-chip${q.done ? ' done' : ''}">${esc(questLabel(q))} ${q.progress}/${q.target}${q.done ? ' ✓' : ''}</span>`).join(' ');
  const achv = (me.achievements || []).slice(0, 8).map(a =>
    `<span class="quest-chip done" title="${esc(a.key)}">🏅 ${esc(t('achievement.' + String(a.key), a.label))}</span>`).join(' ');
  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
      <h2 style="font-size:16px;">${esc(t('leaderboard.me.yourProgress', 'Your progress'))}</h2>
      ${me.opted_in ? '' : `<a href="/profile.html" style="font-size:13px; color:var(--accent);">${esc(t('leaderboard.me.notListed', 'You are not publicly listed — opt in on your profile'))}</a>`}
    </div>
    <div class="me-grid">
      <div class="val-stat"><b>${me.rank ? '#' + me.rank : '—'}</b><span>${esc(t('leaderboard.me.rank', 'rank'))}${me.percentile != null ? ' · ' + t('leaderboard.me.topPercent', `top ${100 - me.percentile}%`, { pct: 100 - me.percentile }) : ''}</span></div>
      <div class="val-stat"><b>${me.confirmed_points}</b><span>${esc(t('leaderboard.me.confirmedPoints', 'confirmed points'))}</span></div>
      <div class="val-stat"><b>${me.verified_validations}</b><span>${esc(t('leaderboard.me.verifiedValidations', 'verified validations'))}</span></div>
      <div class="val-stat"><b>${me.streak > 0 ? '🔥 ' + me.streak : 0}</b><span>${esc(t('leaderboard.me.dayStreak', 'day streak'))}</span></div>
      <div class="val-stat"><b class="band ${BAND_CLASS[me.reliability_band] || ''}">${esc(bandLabel(me.reliability_band))}</b><span>${esc(t('leaderboard.me.reliability', 'reliability'))}</span></div>
    </div>
    <details style="margin-top:12px;">
      <summary style="cursor:pointer; color:var(--accent); font-size:13px;">${esc(t('leaderboard.me.howCalculated', 'How is my reliability calculated?'))}</summary>
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

  // ── Re-render on language change ──────────────────────────
  function relocalize() {
    renderBoard();
    if (lastMe) renderMe();
  }
  if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(relocalize);
  else window.addEventListener('i18n:change', relocalize);

  await Promise.all([loadBoard(), loadMe()]);
});
