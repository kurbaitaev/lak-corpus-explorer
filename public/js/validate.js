'use strict';

// Validation workspace: one small task at a time, blind voting, consensus
// revealed only after submission.

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

// English fallbacks for validation-kind display labels/questions. The canonical
// translations live in i18n.js; these are only used when a key is missing.
const KIND_LABELS_FALLBACK = {
  translation_correctness: 'Translation correctness',
  sense_choice: 'Sense choice',
  moon_vs_month: 'Moon or month?',
  dialect: 'Dialect / variety',
  spelling: 'Spelling',
  ocr_quality: 'OCR quality',
  example_usefulness: 'Example usefulness',
  source_reliability: 'Source reliability',
};
const KIND_QUESTIONS_FALLBACK = {
  translation_correctness: 'Is this Russian→Lak translation correct?',
  sense_choice: 'Which sense fits this context best?',
  moon_vs_month: 'Here, does this word mean “moon” or “month”?',
  dialect: 'Which dialect or variety does this form belong to?',
  spelling: 'Is the spelling correct?',
  ocr_quality: 'How clean is this OCR-scanned text?',
  example_usefulness: 'Is this example sentence useful for learners and researchers?',
  source_reliability: 'How reliable is this source for this record?',
};
function kindLabel(kind) {
  return t('validate.kind.' + kind, KIND_LABELS_FALLBACK[kind] || kind);
}
function kindQuestion(kind) {
  return t('validate.question.' + kind, KIND_QUESTIONS_FALLBACK[kind] || t('validate.question.default', 'Your assessment:'));
}
// Localized display for vote option values. The submitted value stays canonical.
function optionLabel(value) {
  const key = 'validate.option.' + String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return t(key, String(value));
}

let currentTask = null;
let taskShownAt = 0;
let lastStats = null;
let lastExtra = null;
let lastResult = null; // { distribution, taskStatus, gold, points, achievements, flagged_spam }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderStats(stats, extra) {
  lastStats = stats; lastExtra = extra;
  const el = document.getElementById('val-stats');
  const quests = (stats.quests || []).map(q => {
    const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
    return `<div class="quest">
      <span>${esc(questLabel(q))} — ${q.progress}/${q.target}${q.done ? ' ✓' : ''}</span>
      <span class="quest-bar"><span style="width:${pct}%"></span></span>
    </div>`;
  }).join('');
  el.innerHTML = `
    <div class="val-stat"><b>${stats.streak ?? 0}</b><span>${esc(t('validate.stat.dayStreak', 'day streak'))}</span></div>
    <div class="val-stat"><b>${stats.pointsToday ?? 0}</b><span>${esc(t('validate.stat.pointsToday', 'points today'))}</span></div>
    ${extra?.band ? `<div class="val-stat"><b>${esc(bandLabel(extra.band))}</b><span>${esc(t('validate.stat.reliability', 'reliability'))}</span></div>` : ''}
    <div class="val-quests">${quests}</div>`;
}
// Localized display for quest labels / reliability band. Canonical keys preserved.
function questLabel(q) {
  if (q.key) return t('validate.quest.' + String(q.key), q.label);
  return q.label;
}
function bandLabel(band) {
  return t('validate.band.' + String(band || '').toLowerCase(), band);
}

async function loadNext() {
  document.getElementById('result-card').style.display = 'none';
  document.getElementById('empty-card').style.display = 'none';
  // Ask the public identity route first. A signed-out visitor gets the
  // sign-in card without the browser logging a 401 for a request that was
  // never going to be answered; the server-side gate is still the real one.
  const identity = await window.fetchIdentity();
  if (!identity.account) {
    document.getElementById('workspace').style.display = 'none';
    document.getElementById('need-login').style.display = '';
    return;
  }
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
  renderTaskCard();
}

function renderTaskCard() {
  if (!currentTask) return;
  const card = document.getElementById('task-card');
  card.style.display = '';
  document.getElementById('task-kind').textContent = kindLabel(currentTask.kind);
  document.getElementById('task-id').textContent = t('validate.taskId', 'task ' + currentTask.id, { id: currentTask.id });
  document.getElementById('task-question').textContent = kindQuestion(currentTask.kind);
  const ctx = currentTask.context || {};
  document.getElementById('task-prompt').innerHTML = `
    ${currentTask.prompt_ru ? `<div class="val-prompt"><span class="val-lang">${esc(t('validate.lang.russian', 'Russian'))}</span> ${esc(currentTask.prompt_ru)}</div>` : ''}
    ${currentTask.lak_text ? `<div class="val-prompt lak"><span class="val-lang">${esc(t('validate.lang.lak', 'Lak'))}</span> ${esc(currentTask.lak_text)}</div>` : ''}
    ${ctx.note ? `<div style="color:var(--text3); font-size:12px; margin-top:6px;">${esc(ctx.note)}</div>` : ''}
    ${ctx.source ? `<div style="color:var(--text3); font-size:12px;">${esc(t('validate.sourceLabel', 'Source:'))} ${esc(ctx.source)}</div>` : ''}`;
  const options = Array.isArray(currentTask.options) && currentTask.options.length
    ? currentTask.options : ['correct', 'incorrect', 'uncertain'];
  document.getElementById('options').innerHTML = options.map(o => `
    <label class="val-option">
      <input type="radio" name="vote" value="${esc(o)}">
      <span>${esc(optionLabel(o))}</span>
    </label>`).join('');
  document.getElementById('submit-btn').disabled = true;
  document.getElementById('vote-form').reset();
}

function renderDistribution(dist, taskStatus, gold) {
  const max = Math.max(...dist.map(d => d.weight), 0.001);
  document.getElementById('dist-bars').innerHTML = dist.map(d => `
    <div class="dist-row">
      <span class="dist-value">${esc(optionLabel(d.value))}</span>
      <span class="dist-bar"><span style="width:${Math.round((d.weight / max) * 100)}%"></span></span>
      <span class="dist-n">${tp('validate.votesCount', d.votes, `${d.votes} vote${d.votes === 1 ? '' : 's'}`, { count: d.votes })}</span>
    </div>`).join('') || `<p style="color:var(--text3); font-size:13px;">${esc(t('validate.noOtherVotes', 'No other votes yet — yours is the first.'))}</p>`;
  const sub = document.getElementById('result-sub');
  if (gold && gold.isGold) {
    sub.textContent = gold.correct
      ? t('validate.consensus.goldMatch', 'This was a calibration task — your answer matched the reference answer.')
      : t('validate.consensus.goldDiffered', 'This was a calibration task — the reference answer differed. These tasks keep reliability scores honest.');
  } else if (taskStatus === 'community_consensus') {
    sub.textContent = t('validate.consensus.community', 'Community consensus reached. This is not expert verification yet — an expert may still review it.');
  } else if (taskStatus === 'disputed') {
    sub.textContent = t('validate.consensus.disputed', 'Opinions diverged — this item now goes to trusted validators and experts.');
  } else {
    sub.textContent = t('validate.consensus.recorded', 'Your assessment is recorded. Consensus forms as more contributors answer independently.');
  }
}

function renderResult() {
  if (!lastResult) return;
  renderDistribution(lastResult.distribution || [], lastResult.taskStatus, lastResult.gold);
  const p = lastResult.points || {};
  document.getElementById('points-line').innerHTML =
    (lastResult.flagged_spam
      ? `<span style="color:var(--warn);">${esc(t('validate.points.tooFast', 'Submitted too fast to count — slow down and read each task carefully.'))}</span>`
      : t('validate.points.provisional',
          `+${p.provisional || 0} provisional points <span style="color:var(--text3); font-size:12px;">(confirmed when consensus, a reference answer, or an expert agrees)</span>`,
          { points: p.provisional || 0 })) +
    ((p.questsCompleted || []).length ? `<br><span style="color:var(--ok);">${esc(t('validate.points.questCompleted', 'Quest completed! Bonus points added.'))}</span>` : '');
  document.getElementById('achv-line').textContent =
    (lastResult.achievements || []).map(k => t('validate.achievementPrefix', '🏅 Achievement: ', {}) + achievementLabel(k)).join(' · ');
}
// Localized display for achievement keys.
function achievementLabel(key) {
  return t('validate.achievement.' + String(key), String(key).replace(/_/g, ' '));
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
      if (!res.ok) throw new Error(data.error || t('validate.voteFailed', 'Vote failed'));
      document.getElementById('task-card').style.display = 'none';
      const rc = document.getElementById('result-card');
      rc.style.display = '';
      lastResult = {
        distribution: data.distribution || [],
        taskStatus: data.taskStatus,
        gold: data.gold,
        points: data.points || {},
        achievements: data.achievements || [],
        flagged_spam: data.flagged_spam,
      };
      renderResult();
      document.getElementById('val-stats').innerHTML = '';
      lastStats = null;
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });

  document.getElementById('next-btn').addEventListener('click', loadNext);

  // ── Re-render on language change ──────────────────────────
  function relocalize() {
    if (lastStats) renderStats(lastStats, lastExtra);
    if (document.getElementById('task-card').style.display !== 'none' && currentTask) renderTaskCard();
    if (document.getElementById('result-card').style.display !== 'none' && lastResult) renderResult();
  }
  if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(relocalize);
  else window.addEventListener('i18n:change', relocalize);

  loadNext();
});
