'use strict';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function msg(id, text, ok) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.style.color = ok ? 'var(--ok)' : '#c0392b';
  setTimeout(() => { el.textContent = ''; }, 6000);
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.fetchIdentity();
  const res = await fetch('/api/admin/overview');
  if (!res.ok) {
    document.getElementById('denied').style.display = '';
    return;
  }
  const d = await res.json();
  document.getElementById('dash').style.display = '';
  document.getElementById('dash-sub').textContent =
    `Signed in as ${d.myRole.replace(/_/g, ' ')}. Consensus confidence and reliability are transparent by design.`;

  const bs = d.backlogByStatus || {};
  const bands = d.reliabilityBands || {};
  document.getElementById('dash-cards').innerHTML = `
    <div class="card dash-card"><b>${bs.pending || 0}</b><span>pending</span></div>
    <div class="card dash-card"><b>${bs.community_consensus || 0}</b><span>community consensus</span></div>
    <div class="card dash-card"><b>${bs.expert_verified || 0}</b><span>expert verified</span></div>
    <div class="card dash-card"><b>${bs.disputed || 0}</b><span>disputed</span></div>
    <div class="card dash-card"><b>${d.consensus?.avg_confidence ?? '—'}</b><span>avg consensus confidence (${d.consensus?.n || 0})</span></div>
    <div class="card dash-card"><b>${Object.entries(bands).map(([k, n]) => `${k}: ${n}`).join(' · ') || '—'}</b><span>reliability bands</span></div>`;

  document.getElementById('disputes').innerHTML = (d.disputes || []).map(t => `
    <div class="dispute-row" data-id="${esc(t.id)}">
      <div style="flex:1; min-width:200px;">
        <span class="badge">${esc(t.kind)}</span>
        <b>${esc(t.prompt_ru || '')}</b> ${t.lak_text ? '→ <span style="font-family:var(--font-serif);">' + esc(t.lak_text) + '</span>' : ''}
        <span style="color:var(--text3); font-size:12px;"> · ${t.votes} votes · v${t.version} · ${esc(t.id)}</span>
      </div>
      <input type="text" class="adj-decision" placeholder="decision (e.g. correct / moon)" style="width:170px;">
      <input type="text" class="adj-note" placeholder="note (optional)" style="width:170px;">
      <button class="btn btn-ok adj-btn">Adjudicate</button>
    </div>`).join('') || '<p style="color:var(--text3); font-size:13px;">No disputed items. 🎉</p>';

  document.getElementById('high-priority').innerHTML = (d.highPriority || []).map(t => `
    <div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:14px;">
      <span class="badge">P${t.priority}</span> <span class="badge">${esc(t.kind)}</span>
      <b>${esc(t.prompt_ru || '')}</b> ${t.lak_text ? '→ ' + esc(t.lak_text) : ''}
      <span style="color:var(--text3); font-size:12px;"> · ${esc(t.status)} · ${esc(t.id)}</span>
    </div>`).join('') || '<p style="color:var(--text3); font-size:13px;">No unresolved high-priority queries.</p>';

  document.getElementById('gold-perf').innerHTML = (d.goldPerformance || []).length ? `
    <table class="lb-table"><thead><tr><th>Task</th><th>Kind</th><th>Votes</th><th>Hits</th><th>Hit rate</th></tr></thead>
    <tbody>${d.goldPerformance.map(g => `
      <tr><td data-label="Task">${esc(g.prompt_ru || g.id)}</td><td data-label="Kind">${esc(g.kind)}</td>
      <td data-label="Votes">${g.votes}</td><td data-label="Hits">${g.hits}</td>
      <td data-label="Hit rate">${g.votes ? Math.round((g.hits / g.votes) * 100) + '%' : '—'}</td></tr>`).join('')}
    </tbody></table>` : '<p style="color:var(--text3); font-size:13px;">No gold-task votes yet.</p>';

  document.getElementById('suspicion').innerHTML = (d.suspiciousActivity || []).map(s => `
    <div style="padding:6px 0; border-bottom:1px solid var(--border); font-size:13px;">
      <span class="badge" style="background:var(--warn-lt); color:var(--warn);">${esc(s.kind)}</span>
      ${esc(s.display_name)} <span style="color:var(--text3);">(${esc(s.contributor_id)})</span> — ${esc(s.detail || '')}
      <span style="color:var(--text3); font-size:12px;"> · ${new Date(s.created_at).toLocaleString()}</span>
    </div>`).join('') || '<p style="color:var(--text3); font-size:13px;">Nothing suspicious detected.</p>';

  document.getElementById('appeals').innerHTML = (d.openAppeals || []).map(a => `
    <div class="dispute-row" data-appeal="${a.id}">
      <div style="flex:1; min-width:200px; font-size:13px;">
        <b>${esc(a.display_name)}</b>: ${esc(a.reason)}
        <span style="color:var(--text3); font-size:12px;"> · ${new Date(a.created_at).toLocaleString()}</span>
      </div>
      <input type="text" class="ap-resolution" placeholder="resolution note" style="width:200px;">
      <button class="btn ap-btn">Resolve</button>
    </div>`).join('') || '<p style="color:var(--text3); font-size:13px;">No open appeals.</p>';

  document.querySelectorAll('.adj-btn').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('.dispute-row');
    try {
      const out = await post(`/api/validation/tasks/${encodeURIComponent(row.dataset.id)}/adjudicate`, {
        decision: row.querySelector('.adj-decision').value.trim(),
        note: row.querySelector('.adj-note').value.trim() || undefined,
      });
      row.style.opacity = '0.4';
      btn.disabled = true;
      btn.textContent = out.status.replace(/_/g, ' ') + ' ✓';
    } catch (e) { alert(e.message); }
  }));

  if (d.myRole === 'administrator') {
    document.getElementById('admin-only').style.display = '';
    document.getElementById('g-btn').addEventListener('click', async () => {
      try {
        const out = await post(`/api/admin/contributors/${encodeURIComponent(document.getElementById('g-cid').value.trim())}/role`, {
          role: document.getElementById('g-role').value,
          basis: document.getElementById('g-basis').value.trim(),
        });
        msg('g-msg', `Granted ${out.contributor.role} to ${out.contributor.display_name} ✓`, true);
      } catch (e) { msg('g-msg', e.message, false); }
    });
    document.getElementById('i-btn').addEventListener('click', async () => {
      try {
        const out = await post('/api/admin/invites', {
          role: document.getElementById('i-role').value,
          expertise_note: document.getElementById('i-note').value.trim(),
        });
        msg('i-msg', `Invite token: ${out.token}`, true);
      } catch (e) { msg('i-msg', e.message, false); }
    });
    document.getElementById('x-btn').addEventListener('click', async () => {
      try {
        const out = await post('/api/admin/points/invalidate', {
          contributor_id: document.getElementById('x-cid').value.trim(),
          reason: document.getElementById('x-reason').value.trim(),
          all_provisional: !document.getElementById('x-all').checked ? true : false,
        });
        msg('x-msg', `Revoked ${out.revoked} point entries ✓`, true);
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
        msg('t-msg', `Task ${out.task.id} added ✓`, true);
      } catch (e) { msg('t-msg', e.message, false); }
    });
  }

  document.querySelectorAll('.ap-btn').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('.dispute-row');
    try {
      await post(`/api/admin/appeals/${row.dataset.appeal}/resolve`, {
        resolution: row.querySelector('.ap-resolution').value.trim(),
      });
      row.style.opacity = '0.4';
      btn.disabled = true;
      btn.textContent = 'Resolved ✓';
    } catch (e) { alert(e.message); }
  }));
});
