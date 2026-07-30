'use strict';

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
// Role display labels (canonical role value preserved).
const ROLE_FALLBACK = {
  contributor: 'Contributor', trusted_validator: 'Trusted validator',
  verified_expert: 'Verified expert', administrator: 'Administrator',
};
function roleLabel(role) {
  return t('role.' + String(role), ROLE_FALLBACK[role] || role);
}
const BAND_CLASS = { high: 'band-high', established: 'band-established', developing: 'band-developing', new: 'band-new' };
function bandLabel(band) {
  return t('reliability.band.' + String(band || '').toLowerCase(), band);
}
function eventLabel(key) {
  return t('reliability.event.' + String(key), String(key).replace(/_/g, ' '));
}
function questLabel(q) {
  if (q.key) return t('quest.' + String(q.key), q.label);
  return q.label;
}
// Pair status display labels (canonical value preserved).
function pairStatusLabel(status) {
  return t('lab.status.' + String(status || '').toLowerCase(), status);
}
function directionArrow(direction) {
  if (direction === 'ru2lak') return t('lab.direction.ru2lak', 'RU→LAK');
  if (direction === 'lak2ru') return t('lab.direction.lak2ru', 'LAK→RU');
  return String(direction).replace('_', ' → ');
}

let dataCache = null;
let pairsCache = null;

document.addEventListener('DOMContentLoaded', async () => {
  await window.fetchIdentity();
  if (!window.ACCOUNT) {
    document.getElementById('need-login').style.display = '';
    return;
  }
  document.getElementById('content').style.display = '';

  const res = await fetch('/api/profile');
  if (!res.ok) return;
  dataCache = await res.json();

  renderProfile();
  document.getElementById('p-name').value = dataCache.profile.display_name || '';
  document.getElementById('p-affil').value = dataCache.profile.affiliation || '';
  document.getElementById('p-langs').value = dataCache.profile.languages || '';
  document.getElementById('p-exp').value = dataCache.profile.expertise || '';
  document.getElementById('p-public').checked = !!dataCache.profile.public_profile;
  document.getElementById('p-lb').checked = !!dataCache.profile.leaderboard_opt_in;

  const pairBox = document.getElementById('p-pairs');
  try {
    const pairRes = await fetch('/api/lab/my-pairs');
    const pairData = await pairRes.json();
    pairsCache = pairData.pairs || [];
    renderPairs();
  } catch {
    pairBox.innerHTML = `<p style="color:var(--text3); font-size:13px;">${esc(t('profile.pairs.unavailable', 'Translation status is temporarily unavailable.'))}</p>`;
  }

  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res2 = await fetch('/api/profile', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: document.getElementById('p-name').value.trim(),
        affiliation: document.getElementById('p-affil').value.trim(),
        languages: document.getElementById('p-langs').value.trim(),
        expertise: document.getElementById('p-exp').value.trim(),
        public_profile: document.getElementById('p-public').checked,
        leaderboard_opt_in: document.getElementById('p-lb').checked,
      }),
    });
    document.getElementById('save-msg').textContent = res2.ok ? t('profile.saved', 'Saved ✓') : t('profile.saveFailed', 'Save failed');
    setTimeout(() => document.getElementById('save-msg').textContent = '', 3000);
  });

  document.getElementById('appeal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res3 = await fetch('/api/appeals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_type: 'points', reason: document.getElementById('a-reason').value.trim() }),
    });
    document.getElementById('appeal-msg').textContent = res3.ok ? t('profile.appealSubmitted', 'Appeal submitted ✓') : t('profile.appealFailed', 'Failed to submit');
    if (res3.ok) document.getElementById('a-reason').value = '';
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/account-logout', { method: 'POST' });
    location.href = '/';
  });

  // ── Re-render on language change ──────────────────────────
  function relocalize() {
    if (dataCache) renderProfile();
    if (pairsCache) renderPairs();
  }
  if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(relocalize);
  else window.addEventListener('i18n:change', relocalize);
});

function renderProfile() {
  const data = dataCache;
  const p = data.profile, s = data.stats;

  document.getElementById('p-role').textContent = roleLabel(p.role);
  document.getElementById('p-band').innerHTML =
    `<span class="band ${BAND_CLASS[s.reliabilityBand] || ''}">${esc(t('profile.bandSuffix', `${bandLabel(s.reliabilityBand)} reliability`, { band: bandLabel(s.reliabilityBand) }))}</span>`;

  document.getElementById('p-stats').innerHTML = `
    <div class="val-stat"><b>${s.confirmedPoints}</b><span>${esc(t('profile.stat.confirmedPoints', 'confirmed points'))}</span></div>
    <div class="val-stat"><b>${s.provisionalPoints}</b><span>${esc(t('profile.stat.provisional', 'provisional'))}</span></div>
    <div class="val-stat"><b>${s.streak > 0 ? '🔥 ' + s.streak : 0}</b><span>${esc(t('profile.stat.dayStreak', 'day streak'))}</span></div>`;

  // Remove any previously injected reliability-basis note before re-adding.
  const existingBasis = document.getElementById('p-basis-note');
  if (existingBasis) existingBasis.remove();
  const breakdown = Object.entries(s.reliabilityBreakdown || {})
    .map(([k, n]) => `${eventLabel(k)}: ${n}`).join(' · ');
  if (breakdown) {
    document.getElementById('p-stats').insertAdjacentHTML('afterend',
      `<p id="p-basis-note" style="color:var(--text3); font-size:12px; margin-top:8px;">${esc(t('profile.reliabilityBasis', 'Reliability basis —'))} ${esc(breakdown)}</p>`);
  }
  document.getElementById('p-achv').innerHTML = (data.achievements || []).map(a =>
    `<span class="quest-chip done">🏅 ${esc(t('achievement.' + String(a.key), a.label))}</span>`).join(' ');
  document.getElementById('p-quests').innerHTML = (data.quests || []).map(q =>
    `<span class="quest-chip${q.done ? ' done' : ''}">${esc(questLabel(q))} ${q.progress}/${q.target}${q.done ? ' ✓' : ''}</span>`).join(' ');
}

function renderPairs() {
  const pairBox = document.getElementById('p-pairs');
  const pairs = pairsCache || [];
  pairBox.innerHTML = pairs.length ? pairs.slice(0, 8).map(pair => `
    <div class="pair-status-row">
      <div><b>${esc(pair.source_text)}</b><span>${esc(directionArrow(pair.direction))} · ${esc(t('profile.pairs.versionShort', `v${pair.current_version}`, { version: pair.current_version }))}</span></div>
      <span class="quality-badge ${pair.status === 'approved' ? 'q-approved' : pair.status === 'rejected' ? 'q-flagged' : 'q-unreviewed'}">${esc(pairStatusLabel(pair.status))}</span>
    </div>`).join('') : `<p style="color:var(--text3); font-size:13px;">${esc(t('profile.pairs.none', 'No translation pairs submitted yet.'))}</p>`;
}
