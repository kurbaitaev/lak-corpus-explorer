'use strict';

// Validation workspace: one small task at a time, blind voting, consensus
// revealed only after submission.

const KIND_LABELS = {
  translation_correctness: 'Translation correctness',
  sense_choice: 'Sense choice',
  moon_vs_month: 'Moon or month?',
  dialect: 'Dialect / variety',
  spelling: 'Spelling',
  ocr_quality: 'OCR quality',
  example_usefulness: 'Example usefulness',
  source_reliability: 'Source reliability',
};
const KIND_QUESTIONS = {
  translation_correctness: 'Is this Russian→Lak translation correct?',
  sense_choice: 'Which sense fits this context best?',
  moon_vs_month: 'Here, does this word mean “moon” or “month”?',
  dialect: 'Which dialect or variety does this form belong to?',
  spelling: 'Is the spelling correct?',
  ocr_quality: 'How clean is this OCR-scanned text?',
  example_usefulness: 'Is this example sentence useful for learners and researchers?',
  source_reliability: 'How reliable is this source for this record?',
};

let currentTask = null;
let taskShownAt = 0;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderStats(stats, extra) {
  const el = document.getElementById('val-stats');
  const quests = (stats.quests || []).map(q => {
    const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
    return `<div class="quest">
      <span>${esc(q.label)} — ${q.progress}/${q.target}${q.done ? ' ✓' : ''}</span>
      <span class="quest-bar"><span style="width:${pct}%"></span></span>
    </div>`;
  }).join('');
  el.innerHTML = `
    <div class="val-stat"><b>${stats.streak ?? 0}</b><span>day streak</span></div>
    <div class="val-stat"><b>${stats.pointsToday ?? 0}</b><span>points today</span></div>
    ${extra?.band ? `<div class="val-stat"><b>${esc(extra.band)}</b><span>reliability</span></div>` : ''}
    <div class="val-quests">${quests}</div>`;
}

async function loadNext() {
  document.getElementById('result-card').style.display = 'none';
  document.getElementById('empty-card').style.display = 'none';
  const res = await fetch('/api/validation/next');
  if (res.status === 401) {
    document.getElementById('workspace').style.display = 'none';
    document.getElementById('need-login').style.display = '';
    return;
  }
  const data = await res.json();
  document.getElementById('need-login').style.display = 'none';
  document.getElementById('workspace').style.display = '';
  renderStats(data.stats || {});
  if (!data.task) {
    document.getElementById('task-card').style.display = 'none';
    document.getElementById('empty-card').style.display = '';
    return;
  }
  currentTask = data.task;
  taskShownAt = Date.now();
  document.getElementById('empty-card').style.display = 'none';
  const card = document.getElementById('task-card');
  card.style.display = '';
  document.getElementById('task-kind').textContent = KIND_LABELS[data.task.kind] || data.task.kind;
  document.getElementById('task-id').textContent = 'task ' + data.task.id;
  document.getElementById('task-question').textContent = KIND_QUESTIONS[data.task.kind] || 'Your assessment:';
  const ctx = data.task.context || {};
  document.getElementById('task-prompt').innerHTML = `
    ${data.task.prompt_ru ? `<div class="val-prompt"><span class="val-lang">Russian</span> ${esc(data.task.prompt_ru)}</div>` : ''}
    ${data.task.lak_text ? `<div class="val-prompt lak"><span class="val-lang">Lak</span> ${esc(data.task.lak_text)}</div>` : ''}
    ${ctx.note ? `<div style="color:var(--text3); font-size:12px; margin-top:6px;">${esc(ctx.note)}</div>` : ''}
    ${ctx.source ? `<div style="color:var(--text3); font-size:12px;">Source: ${esc(ctx.source)}</div>` : ''}`;
  const options = Array.isArray(data.task.options) && data.task.options.length
    ? data.task.options : ['correct', 'incorrect', 'uncertain'];
  document.getElementById('options').innerHTML = options.map(o => `
    <label class="val-option">
      <input type="radio" name="vote" value="${esc(o)}">
      <span>${esc(o)}</span>
    </label>`).join('');
  document.getElementById('submit-btn').disabled = true;
  document.getElementById('vote-form').reset();
}

function renderDistribution(dist, taskStatus, gold) {
  const max = Math.max(...dist.map(d => d.weight), 0.001);
  document.getElementById('dist-bars').innerHTML = dist.map(d => `
    <div class="dist-row">
      <span class="dist-value">${esc(d.value)}</span>
      <span class="dist-bar"><span style="width:${Math.round((d.weight / max) * 100)}%"></span></span>
      <span class="dist-n">${d.votes} vote${d.votes === 1 ? '' : 's'}</span>
    </div>`).join('') || '<p style="color:var(--text3); font-size:13px;">No other votes yet — yours is the first.</p>';
  const sub = document.getElementById('result-sub');
  if (gold && gold.isGold) {
    sub.textContent = gold.correct
      ? 'This was a calibration task — your answer matched the reference answer.'
      : 'This was a calibration task — the reference answer differed. These tasks keep reliability scores honest.';
  } else if (taskStatus === 'community_consensus') {
    sub.textContent = 'Community consensus reached. This is not expert verification yet — an expert may still review it.';
  } else if (taskStatus === 'disputed') {
    sub.textContent = 'Opinions diverged — this item now goes to trusted validators and experts.';
  } else {
    sub.textContent = 'Your assessment is recorded. Consensus forms as more contributors answer independently.';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.fetchIdentity();

  document.getElementById('options').addEventListener('change', () => {
    document.getElementById('submit-btn').disabled = false;
  });

  document.getElementById('vote-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentTask) return;
    const chosen = document.querySelector('input[name="vote"]:checked');
    if (!chosen) return;
    const btn = document.getElementById('submit-btn');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/validation/tasks/${encodeURIComponent(currentTask.id)}/vote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: chosen.value,
          correction: document.getElementById('f-correction').value.trim() || undefined,
          evidence_note: document.getElementById('f-evidence').value.trim() || undefined,
          source_ref: document.getElementById('f-source').value.trim() || undefined,
          time_to_vote_ms: Date.now() - taskShownAt,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Vote failed');
      document.getElementById('task-card').style.display = 'none';
      const rc = document.getElementById('result-card');
      rc.style.display = '';
      renderDistribution(data.distribution || [], data.taskStatus, data.gold);
      const p = data.points || {};
      document.getElementById('points-line').innerHTML =
        (data.flagged_spam
          ? '<span style="color:var(--warn);">Submitted too fast to count — slow down and read each task carefully.</span>'
          : `+${p.provisional || 0} provisional points <span style="color:var(--text3); font-size:12px;">(confirmed when consensus, a reference answer, or an expert agrees)</span>`) +
        ((p.questsCompleted || []).length ? `<br><span style="color:var(--ok);">Quest completed! Bonus points added.</span>` : '');
      document.getElementById('achv-line').textContent =
        (data.achievements || []).map(k => '🏅 Achievement: ' + k.replace(/_/g, ' ')).join(' · ');
      document.getElementById('val-stats').innerHTML = '';
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });

  document.getElementById('next-btn').addEventListener('click', loadNext);
  loadNext();
});
