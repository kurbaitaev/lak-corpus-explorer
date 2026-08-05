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
function localeString(iso) {
  const I = window.I18n;
  const tag = (I && typeof I.getLanguage === 'function' && I.getLanguage() === 'ru') ? 'ru-RU' : 'en-GB';
  try { return new Date(iso).toLocaleString(tag); } catch { return new Date(iso).toLocaleString(); }
}
// Display labels (canonical role/status/kind values preserved).
function roleLabel(role) {
  return t('role.' + String(role), String(role || '').replace(/_/g, ' '));
}
function taskStatusLabel(status) {
  return t('validate.taskStatus.' + String(status || '').toLowerCase(), String(status || '').replace(/_/g, ' '));
}
function kindLabel(kind) {
  return t('validate.kind.' + String(kind), String(kind || '').replace(/_/g, ' '));
}
// Reliability band display (canonical band value preserved). Uses the
// centralized reliability.band.<canonical> keys with an English fallback.
function bandLabel(band) {
  const canonical = String(band || '').toLowerCase();
  const fallback = { high: 'High', established: 'Established', developing: 'Developing', new: 'New' };
  return t('reliability.band.' + canonical, fallback[canonical] || String(band || '').replace(/_/g, ' '));
}
function directionArrow(direction) {
  if (direction === 'ru2lak') return t('lab.direction.ru2lak', 'RU→LAK');
  if (direction === 'lak2ru') return t('lab.direction.lak2ru', 'LAK→RU');
  return String(direction).replace('_', ' → ');
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('dashboard.requestFailed', 'Request failed'));
  return data;
}

function msg(id, text, ok) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.style.color = ok ? 'var(--ok)' : '#c0392b';
  setTimeout(() => { el.textContent = ''; }, 6000);
}

let dCache = null;
let labPairsCache = null;

document.addEventListener('DOMContentLoaded', async () => {
  await window.fetchIdentity();
  // Show the "needs a role" notice from the identity alone. Calling the admin
  // route first would work too, but it makes every signed-out visitor's
  // console log a 401 for a request that was never going to be answered.
  if (!window.hasTrustedRole()) {
    document.getElementById('denied').style.display = '';
    return;
  }
  const res = await fetch('/api/admin/overview');
  if (!res.ok) {
    document.getElementById('denied').style.display = '';
    return;
  }
  dCache = await res.json();
  document.getElementById('dash').style.display = '';
  renderDashboard();

  try {
    const pairRes = await fetch('/api/lab/review-queue');
    const pairData = await pairRes.json();
    labPairsCache = pairData.pairs || [];
    renderLabPairs();
  } catch {
    document.getElementById('lab-pairs').innerHTML = `<p style="color:var(--text3); font-size:13px;">${esc(t('dashboard.labQueueUnavailable', 'Translation queue is temporarily unavailable.'))}</p>`;
  }

  wireAdjudication();

  if (dCache.myRole === 'administrator') {
    document.getElementById('admin-only').style.display = '';
    document.getElementById('g-btn').addEventListener('click', async () => {
      try {
        const out = await post(`/api/admin/contributors/${encodeURIComponent(document.getElementById('g-cid').value.trim())}/role`, {
          role: document.getElementById('g-role').value,
          basis: document.getElementById('g-basis').value.trim(),
        });
        msg('g-msg', t('dashboard.granted', `Granted ${roleLabel(out.contributor.role)} to ${out.contributor.display_name} ✓`, { role: roleLabel(out.contributor.role), name: out.contributor.display_name }), true);
      } catch (e) { msg('g-msg', e.message, false); }
    });
    document.getElementById('i-btn').addEventListener('click', async () => {
      try {
        const out = await post('/api/admin/invites', {
          role: document.getElementById('i-role').value,
          expertise_note: document.getElementById('i-note').value.trim(),
        });
        msg('i-msg', t('dashboard.inviteToken', `Invite token: ${out.token}`, { token: out.token }), true);
      } catch (e) { msg('i-msg', e.message, false); }
    });
    document.getElementById('x-btn').addEventListener('click', async () => {
      try {
        const out = await post('/api/admin/points/invalidate', {
          contributor_id: document.getElementById('x-cid').value.trim(),
          reason: document.getElementById('x-reason').value.trim(),
          all_provisional: !document.getElementById('x-all').checked ? true : false,
        });
        msg('x-msg', t('dashboard.revoked', `Revoked ${out.revoked} point entries ✓`, { count: out.revoked }), true);
      } catch (e) { msg('x-msg', e.message, false); }
    });
    document.getElementById('t-btn').addEventListener('click', async () => {
      try {
        const out = await post('/api/admin/tasks', {
          id: document.getElementById('t-id').value.trim() || undefined,
          kind: document.getElementById('t-kind').value,
          prompt_ru: document.getElementById('t-ru').value.trim() || undefined,
          lak_text: document.getElementById('t-lak').value.trim() || undefined,
          options: document.getElementById('t-options').value.split(',').map(s => s.trim()).filter(Boolean),
          is_gold: document.getElementById('t-gold').checked,
          gold_answer: document.getElementById('t-answer').value.trim() || undefined,
          priority: document.getElementById('t-priority').value || 0,
        });
        msg('t-msg', t('dashboard.taskAdded', `Task ${out.task.id} added ✓`, { id: out.task.id }), true);
      } catch (e) { msg('t-msg', e.message, false); }
    });
  }

  wireAppeals();

  // ── Re-render on language change ──────────────────────────
  function relocalize() {
    if (dCache) { renderDashboard(); wireAdjudication(); wireAppeals(); }
    if (labPairsCache) renderLabPairs();
  }
  if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(relocalize);
  else window.addEventListener('i18n:change', relocalize);
});

function renderDashboard() {
  const d = dCache;
  document.getElementById('dash-sub').textContent =
    t('dashboard.signedInAs', `Signed in as ${roleLabel(d.myRole)}. Consensus confidence and reliability are transparent by design.`, { role: roleLabel(d.myRole) });

  const bs = d.backlogByStatus || {};
  const bands = d.reliabilityBands || {};
  document.getElementById('dash-cards').innerHTML = `
    <div class="card dash-card"><b>${bs.pending || 0}</b><span>${esc(t('dashboard.card.pending', 'pending'))}</span></div>
    <div class="card dash-card"><b>${bs.community_consensus || 0}</b><span>${esc(t('dashboard.card.communityConsensus', 'community consensus'))}</span></div>
    <div class="card dash-card"><b>${bs.expert_verified || 0}</b><span>${esc(t('dashboard.card.expertVerified', 'expert verified'))}</span></div>
    <div class="card dash-card"><b>${bs.disputed || 0}</b><span>${esc(t('dashboard.card.disputed', 'disputed'))}</span></div>
    <div class="card dash-card"><b>${d.consensus?.avg_confidence ?? '—'}</b><span>${esc(t('dashboard.card.avgConsensus', `avg consensus confidence (${d.consensus?.n || 0})`, { n: d.consensus?.n || 0 }))}</span></div>
    <div class="card dash-card"><b>${Object.entries(bands).map(([k, n]) => `${bandLabel(k)}: ${n}`).join(' · ') || '—'}</b><span>${esc(t('dashboard.card.reliabilityBands', 'reliability bands'))}</span></div>`;

  document.getElementById('disputes').innerHTML = (d.disputes || []).map(task => `
    <div class="dispute-row" data-id="${esc(task.id)}">
      <div style="flex:1; min-width:200px;">
        <span class="badge">${esc(kindLabel(task.kind))}</span>
        <b>${esc(task.prompt_ru || '')}</b> ${task.lak_text ? '→ <span style="font-family:var(--font-serif);">' + esc(task.lak_text) + '</span>' : ''}
        <span style="color:var(--text3); font-size:12px;"> · ${t('dashboard.dispute.meta', `${task.votes} votes · v${task.version} · ${esc(task.id)}`, { votes: task.votes, version: task.version, id: esc(task.id) })}</span>
      </div>
      <input type="text" class="adj-decision" placeholder="${esc(t('dashboard.dispute.decisionPlaceholder', 'decision (e.g. correct / moon)'))}" style="width:170px;">
      <input type="text" class="adj-note" placeholder="${esc(t('dashboard.dispute.notePlaceholder', 'note (optional)'))}" style="width:170px;">
      <button class="btn btn-ok adj-btn">${esc(t('dashboard.adjudicate', 'Adjudicate'))}</button>
    </div>`).join('') || `<p style="color:var(--text3); font-size:13px;">${esc(t('dashboard.noDisputes', 'No disputed items. 🎉'))}</p>`;

  document.getElementById('high-priority').innerHTML = (d.highPriority || []).map(task => `
    <div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:14px;">
      <span class="badge">P${task.priority}</span> <span class="badge">${esc(kindLabel(task.kind))}</span>
      <b>${esc(task.prompt_ru || '')}</b> ${task.lak_text ? '→ ' + esc(task.lak_text) : ''}
      <span style="color:var(--text3); font-size:12px;"> · ${esc(taskStatusLabel(task.status))} · ${esc(task.id)}</span>
    </div>`).join('') || `<p style="color:var(--text3); font-size:13px;">${esc(t('dashboard.noHighPriority', 'No unresolved high-priority queries.'))}</p>`;

  document.getElementById('gold-perf').innerHTML = (d.goldPerformance || []).length ? `
    <table class="lb-table"><thead><tr><th>${esc(t('dashboard.gold.task', 'Task'))}</th><th>${esc(t('dashboard.gold.kind', 'Kind'))}</th><th>${esc(t('dashboard.gold.votes', 'Votes'))}</th><th>${esc(t('dashboard.gold.hits', 'Hits'))}</th><th>${esc(t('dashboard.gold.hitRate', 'Hit rate'))}</th></tr></thead>
    <tbody>${d.goldPerformance.map(g => `
      <tr><td data-label="${esc(t('dashboard.gold.task', 'Task'))}">${esc(g.prompt_ru || g.id)}</td><td data-label="${esc(t('dashboard.gold.kind', 'Kind'))}">${esc(kindLabel(g.kind))}</td>
      <td data-label="${esc(t('dashboard.gold.votes', 'Votes'))}">${g.votes}</td><td data-label="${esc(t('dashboard.gold.hits', 'Hits'))}">${g.hits}</td>
      <td data-label="${esc(t('dashboard.gold.hitRate', 'Hit rate'))}">${g.votes ? Math.round((g.hits / g.votes) * 100) + '%' : '—'}</td></tr>`).join('')}
    </tbody></table>` : `<p style="color:var(--text3); font-size:13px;">${esc(t('dashboard.noGoldVotes', 'No gold-task votes yet.'))}</p>`;

  document.getElementById('suspicion').innerHTML = (d.suspiciousActivity || []).map(s => `
    <div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:13px;">
      <span class="badge" style="background:var(--warn-lt); color:var(--warn);">${esc(t('dashboard.suspicion.' + String(s.kind || '').toLowerCase(), String(s.kind || '').replace(/_/g, ' ')))}</span>
      ${esc(s.display_name)} <span style="color:var(--text3);">(${esc(s.contributor_id)})</span> — ${esc(s.detail || '')}
      <span style="color:var(--text3); font-size:12px;"> · ${esc(localeString(s.created_at))}</span>
    </div>`).join('') || `<p style="color:var(--text3); font-size:13px;">${esc(t('dashboard.noSuspicion', 'Nothing suspicious detected.'))}</p>`;

  document.getElementById('appeals').innerHTML = (d.openAppeals || []).map(a => `
    <div class="dispute-row" data-appeal="${a.id}">
      <div style="flex:1; min-width:200px; font-size:13px;">
        <b>${esc(a.display_name)}</b>: ${esc(a.reason)}
        <span style="color:var(--text3); font-size:12px;"> · ${esc(localeString(a.created_at))}</span>
      </div>
      <input type="text" class="ap-resolution" placeholder="${esc(t('dashboard.appeal.resolutionPlaceholder', 'resolution note'))}" style="width:200px;">
      <button class="btn ap-btn">${esc(t('dashboard.resolve', 'Resolve'))}</button>
    </div>`).join('') || `<p style="color:var(--text3); font-size:13px;">${esc(t('dashboard.noAppeals', 'No open appeals.'))}</p>`;
}

function renderLabPairs() {
  document.getElementById('lab-pairs').innerHTML = (labPairsCache || []).map(p => `
    <div class="pair-status-row">
      <div><b>${esc(p.source_text)}</b><span>${esc(directionArrow(p.direction))} · ${esc(p.contributor_name || t('dashboard.contributor', 'contributor'))} · v${p.current_version}</span></div>
      <a class="btn" href="/lab.html?pair=${encodeURIComponent(p.id)}">${esc(t('dashboard.review', 'Review'))}</a>
    </div>`).join('') || `<p style="color:var(--text3); font-size:13px;">${esc(t('dashboard.noPairsAwaitReview', 'No translation pairs await review.'))}</p>`;
}

function wireAdjudication() {
  document.querySelectorAll('.adj-btn').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const row = btn.closest('.dispute-row');
      try {
        const out = await post(`/api/validation/tasks/${encodeURIComponent(row.dataset.id)}/adjudicate`, {
          decision: row.querySelector('.adj-decision').value.trim(),
          note: row.querySelector('.adj-note').value.trim() || undefined,
        });
        row.style.opacity = '0.4';
        btn.disabled = true;
        btn.textContent = taskStatusLabel(out.status) + ' ✓';
      } catch (e) { alert(e.message); }
    });
  });
}

function wireAppeals() {
  document.querySelectorAll('.ap-btn').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const row = btn.closest('.dispute-row');
      try {
        await post(`/api/admin/appeals/${row.dataset.appeal}/resolve`, {
          resolution: row.querySelector('.ap-resolution').value.trim(),
        });
        row.style.opacity = '0.4';
        btn.disabled = true;
        btn.textContent = t('dashboard.resolved', 'Resolved ✓');
      } catch (e) { alert(e.message); }
    });
  });
}
