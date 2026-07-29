'use strict';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const ROLE_LABELS = {
  contributor: 'Contributor', trusted_validator: 'Trusted validator',
  verified_expert: 'Verified expert', administrator: 'Administrator',
};
const BAND_CLASS = { high: 'band-high', established: 'band-established', developing: 'band-developing', new: 'band-new' };

document.addEventListener('DOMContentLoaded', async () => {
  await window.fetchIdentity();
  if (!window.ACCOUNT) {
    document.getElementById('need-login').style.display = '';
    return;
  }
  document.getElementById('content').style.display = '';

  const res = await fetch('/api/profile');
  if (!res.ok) return;
  const data = await res.json();
  const p = data.profile, s = data.stats;

  document.getElementById('p-role').textContent = ROLE_LABELS[p.role] || p.role;
  document.getElementById('p-band').innerHTML =
    `<span class="band ${BAND_CLASS[s.reliabilityBand] || ''}">${esc(s.reliabilityBand)} reliability</span>`;
  document.getElementById('p-name').value = p.display_name || '';
  document.getElementById('p-affil').value = p.affiliation || '';
  document.getElementById('p-langs').value = p.languages || '';
  document.getElementById('p-exp').value = p.expertise || '';
  document.getElementById('p-public').checked = !!p.public_profile;
  document.getElementById('p-lb').checked = !!p.leaderboard_opt_in;

  document.getElementById('p-stats').innerHTML = `
    <div class="val-stat"><b>${s.confirmedPoints}</b><span>confirmed points</span></div>
    <div class="val-stat"><b>${s.provisionalPoints}</b><span>provisional</span></div>
    <div class="val-stat"><b>${s.streak > 0 ? '🔥 ' + s.streak : 0}</b><span>day streak</span></div>`;
  const breakdown = Object.entries(s.reliabilityBreakdown || {})
    .map(([k, n]) => `${k.replace(/_/g, ' ')}: ${n}`).join(' · ');
  if (breakdown) {
    document.getElementById('p-stats').insertAdjacentHTML('afterend',
      `<p style="color:var(--text3); font-size:12px; margin-top:8px;">Reliability basis — ${esc(breakdown)}</p>`);
  }
  document.getElementById('p-achv').innerHTML = (data.achievements || []).map(a =>
    `<span class="quest-chip done">🏅 ${esc(a.label)}</span>`).join(' ');
  document.getElementById('p-quests').innerHTML = (data.quests || []).map(q =>
    `<span class="quest-chip${q.done ? ' done' : ''}">${esc(q.label)} ${q.progress}/${q.target}${q.done ? ' ✓' : ''}</span>`).join(' ');

  const pairBox = document.getElementById('p-pairs');
  try {
    const pairRes = await fetch('/api/lab/my-pairs');
    const pairData = await pairRes.json();
    const pairs = pairData.pairs || [];
    pairBox.innerHTML = pairs.length ? pairs.slice(0, 8).map(pair => `
      <div class="pair-status-row">
        <div><b>${esc(pair.source_text)}</b><span>${esc(pair.direction).replace('_', ' → ')} · v${pair.current_version}</span></div>
        <span class="quality-badge ${pair.status === 'approved' ? 'q-approved' : pair.status === 'rejected' ? 'q-flagged' : 'q-unreviewed'}">${esc(pair.status)}</span>
      </div>`).join('') : '<p style="color:var(--text3); font-size:13px;">No translation pairs submitted yet.</p>';
  } catch {
    pairBox.innerHTML = '<p style="color:var(--text3); font-size:13px;">Translation status is temporarily unavailable.</p>';
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
    document.getElementById('save-msg').textContent = res2.ok ? 'Saved ✓' : 'Save failed';
    setTimeout(() => document.getElementById('save-msg').textContent = '', 3000);
  });

  document.getElementById('appeal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res3 = await fetch('/api/appeals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_type: 'points', reason: document.getElementById('a-reason').value.trim() }),
    });
    document.getElementById('appeal-msg').textContent = res3.ok ? 'Appeal submitted ✓' : 'Failed to submit';
    if (res3.ok) document.getElementById('a-reason').value = '';
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/account-logout', { method: 'POST' });
    location.href = '/';
  });
});
