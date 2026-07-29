'use strict';

// Quality-weighted gamification: points ledger, contributor reliability,
// streaks, achievements, quests, rate/anomaly helpers.
// Points are PROVISIONAL when a validation completes and only become
// CONFIRMED when the response later agrees with consensus, a gold-standard
// answer, or expert adjudication. Spam earns nothing confirmed.

const POINTS = {
  validation: 3,            // provisional per completed validation
  validationDiminished: 1,  // after daily diminishing-returns threshold
  goldBonus: 2,             // correct gold-standard answer
  evidence: 2,              // evidence-backed note confirmed at resolution
  correction: 5,            // correction adopted at consensus/adjudication
  disputedResolution: 4,    // vote matched final adjudication on a disputed item
  adjudication: 6,          // performing an expert adjudication
  dailyQuest: 5,
  weeklyQuest: 15,
};

// Env overrides exist so the test-suite can run fast; production uses defaults.
const DAILY_CAP       = parseInt(process.env.VALIDATION_DAILY_CAP || '100', 10);
const DIMINISH_AFTER  = parseInt(process.env.VALIDATION_DIMINISH_AFTER || '15', 10);
const MIN_INTERVAL_MS = parseInt(process.env.VALIDATION_MIN_INTERVAL_MS || '4000', 10);
const RAPID_MS        = parseInt(process.env.VALIDATION_RAPID_MS || '1500', 10);
const BURST_MAX       = 10;          // votes per BURST_WINDOW before anomaly flag
const BURST_WINDOW_MS = 5 * 60 * 1000;

const RELIABILITY_PRIOR = 5;   // pseudo-events pulling new contributors toward 0.5
const RELIABILITY_BANDS = [
  { min: 0.7, label: 'high' },
  { min: 0.4, label: 'established' },
  { min: 0,   label: 'developing' },
];

const ACHIEVEMENTS = {
  first_expert_correction: 'First expert-confirmed correction',
  ten_quality_validations: 'Ten high-quality validations',
  dialect_specialist:      'Dialect specialist',
  ocr_restorer:            'OCR restorer',
  source_detective:        'Source detective',
  consensus_builder:       'Consensus builder',
  sustained_7:             'Seven-day contributor',
  sustained_30:            'Thirty-day contributor',
};

const DAILY_QUESTS = [
  { key: 'ocr3',      label: 'Check the OCR quality of 3 records',  kind: 'ocr_quality', target: 3 },
  { key: 'dialect2',  label: 'Assess 2 dialect questions',          kind: 'dialect',     target: 2 },
  { key: 'sense3',    label: 'Resolve 3 sense choices',             kind: 'sense_choice',target: 3 },
  { key: 'evidence2', label: 'Add 2 evidence-backed notes',         special: 'evidence', target: 2 },
  { key: 'any5',      label: 'Complete 5 validations',              kind: null,          target: 5 },
];
const WEEKLY_QUESTS = [
  { key: 'any15',     label: 'Complete 15 validations this week',   kind: null,          target: 15 },
  { key: 'gold5',     label: 'Answer 5 calibration tasks',          special: 'gold',     target: 5 },
  { key: 'evidence5', label: 'Add 5 evidence-backed notes',         special: 'evidence', target: 5 },
];

// ── Points ───────────────────────────────────────────────────
async function dailyPointsTotal(pool, cid) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(points),0) AS total FROM points_ledger
      WHERE contributor_id = $1 AND status IN ('provisional','confirmed')
        AND created_at::date = now()::date`, [cid]);
  return Number(r.rows[0].total);
}

async function validationsToday(pool, cid) {
  const r = await pool.query(
    `SELECT COUNT(*) AS n FROM validation_votes
      WHERE contributor_id = $1 AND created_at::date = now()::date`, [cid]);
  return Number(r.rows[0].n);
}

async function awardPoints(pool, { contributorId, taskId = null, kind, points, status = 'provisional', reason = null }) {
  if (points <= 0) return null;
  if (await dailyPointsTotal(pool, contributorId) >= DAILY_CAP) return null; // daily cap
  const r = await pool.query(
    `INSERT INTO points_ledger (contributor_id, task_id, kind, points, status, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, points, status`,
    [contributorId, taskId, kind, points, status, reason]);
  return r.rows[0];
}

async function resolvePoints(pool, contributorId, taskId, resolution, reason) {
  // resolution: 'confirmed' | 'revoked'
  await pool.query(
    `UPDATE points_ledger SET status = $1, resolved_at = now(),
       reason = COALESCE(reason || ' · ','') || $2
      WHERE contributor_id = $3 AND task_id = $4 AND status = 'provisional'`,
    [resolution, reason, contributorId, taskId]);
}

// ── Reliability ──────────────────────────────────────────────
const EVENT_WEIGHTS = {
  gold_hit: 2, gold_miss: 2,
  consensus_agree: 1, consensus_disagree: 1,
  reversal: 1.5, expert_confirmed: 1.5,
};

async function addReliabilityEvent(pool, { contributorId, taskId = null, kind, outcome }) {
  await pool.query(
    `INSERT INTO reliability_events (contributor_id, task_id, kind, outcome, weight)
     VALUES ($1,$2,$3,$4,$5)`,
    [contributorId, taskId, kind, outcome, EVENT_WEIGHTS[kind] || 1]);
  await recomputeReliability(pool, contributorId);
}

async function recomputeReliability(pool, cid) {
  const r = await pool.query(
    `SELECT outcome, weight FROM (
       SELECT outcome, weight FROM reliability_events
        WHERE contributor_id = $1 ORDER BY created_at DESC LIMIT 100) e`, [cid]);
  let sumW = RELIABILITY_PRIOR, sumO = RELIABILITY_PRIOR * 0.5;
  for (const row of r.rows) { sumW += row.weight; sumO += row.outcome * row.weight; }
  const score = Math.round((sumO / sumW) * 1000) / 1000;
  await pool.query(
    'UPDATE contributors SET reliability = $1, reliability_events_count = $2, updated_at = now() WHERE id = $3',
    [score, r.rows.length, cid]);
  return score;
}

function reliabilityBand(score, eventsCount) {
  if ((eventsCount || 0) < 10) return 'new';
  for (const b of RELIABILITY_BANDS) if (score >= b.min) return b.label;
  return 'developing';
}

// Weight a contributor's vote inside consensus: new/low-reliability votes
// count less, high-reliability votes count more. Transparent, bounded.
function consensusWeight(reliability) {
  return 0.3 + Math.max(0, Math.min(1, reliability));
}

// ── Streaks ──────────────────────────────────────────────────
async function bumpContributionDay(pool, cid, substantive) {
  await pool.query(
    `INSERT INTO contribution_days (contributor_id, day, substantive_count)
     VALUES ($1, now()::date, $2)
     ON CONFLICT (contributor_id, day) DO UPDATE
       SET substantive_count = contribution_days.substantive_count + $2`,
    [cid, substantive ? 1 : 0]);
}

async function getStreak(pool, cid) {
  const r = await pool.query(
    `SELECT DISTINCT day FROM contribution_days
      WHERE contributor_id = $1 AND substantive_count > 0
      ORDER BY day DESC LIMIT 400`, [cid]);
  const days = new Set(r.rows.map(row => row.day.toISOString().slice(0, 10)));
  let streak = 0;
  const d = new Date();
  const key = dt => dt.toISOString().slice(0, 10);
  if (!days.has(key(d))) d.setUTCDate(d.getUTCDate() - 1); // today not done yet — count from yesterday
  while (days.has(key(d))) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
  return streak;
}

// ── Quests ───────────────────────────────────────────────────
function isoWeekKey(d = new Date()) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function hashPick(str, n) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % n;
}

async function ensureQuests(pool, cid) {
  const day = new Date().toISOString().slice(0, 10);
  const week = isoWeekKey();
  const dPick = DAILY_QUESTS[hashPick(cid + day, DAILY_QUESTS.length)];
  const wPick = WEEKLY_QUESTS[hashPick(cid + week, WEEKLY_QUESTS.length)];
  await pool.query(
    `INSERT INTO quests (contributor_id, scope, period, quest_key, target)
     VALUES ($1,'daily',$2,$3,$4), ($1,'weekly',$5,$6,$7)
     ON CONFLICT DO NOTHING`,
    [cid, day, dPick.key, dPick.target, week, wPick.key, wPick.target]);
  const r = await pool.query(
    `SELECT scope, period, quest_key, target, progress, done FROM quests
      WHERE contributor_id = $1 AND ((scope='daily' AND period=$2) OR (scope='weekly' AND period=$3))`,
    [cid, day, week]);
  const defs = [...DAILY_QUESTS, ...WEEKLY_QUESTS];
  return r.rows.map(q => ({
    ...q,
    label: (defs.find(d => d.key === q.quest_key) || {}).label || q.quest_key,
  }));
}

function questMatches(def, ctx) {
  if (def.special === 'evidence') return !!ctx.hasEvidence;
  if (def.special === 'gold') return !!ctx.isGold;
  return def.kind === null || def.kind === ctx.kind;
}

async function questTick(pool, cid, ctx) {
  const defs = [...DAILY_QUESTS, ...WEEKLY_QUESTS];
  const quests = await ensureQuests(pool, cid);
  const completed = [];
  for (const q of quests) {
    if (q.done) continue;
    const def = defs.find(d => d.key === q.quest_key);
    if (!def || !questMatches(def, ctx)) continue;
    const upd = await pool.query(
      `UPDATE quests SET progress = progress + 1,
         done = (progress + 1) >= target
       WHERE contributor_id=$1 AND scope=$2 AND period=$3 AND done = FALSE
       RETURNING progress, done, target`,
      [cid, q.scope, q.period]);
    if (upd.rows[0] && upd.rows[0].done) {
      await awardPoints(pool, {
        contributorId: cid, kind: 'quest',
        points: q.scope === 'daily' ? POINTS.dailyQuest : POINTS.weeklyQuest,
        status: 'confirmed', reason: `Quest completed: ${q.label}`,
      });
      completed.push(q.quest_key);
    }
  }
  return completed;
}

// ── Achievements ─────────────────────────────────────────────
async function checkAchievements(pool, cid) {
  const owned = new Set((await pool.query(
    'SELECT key FROM achievements WHERE contributor_id = $1', [cid])).rows.map(r => r.key));
  const award = [];
  const grant = async (key) => {
    if (owned.has(key)) return;
    await pool.query(
      'INSERT INTO achievements (contributor_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [cid, key]);
    owned.add(key);
    award.push(key);
  };

  const q = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);

  if (await q(`SELECT COUNT(*) n FROM points_ledger WHERE contributor_id=$1 AND kind='validation' AND status='confirmed'`, [cid]) >= 10)
    await grant('ten_quality_validations');
  if (await q(`SELECT COUNT(*) n FROM points_ledger WHERE contributor_id=$1 AND kind='correction' AND status='confirmed'`, [cid]) >= 1)
    await grant('first_expert_correction');
  if (await q(`SELECT COUNT(*) n FROM points_ledger p JOIN validation_tasks t ON t.id=p.task_id
               WHERE p.contributor_id=$1 AND p.kind='validation' AND p.status='confirmed' AND t.kind='dialect'`, [cid]) >= 10)
    await grant('dialect_specialist');
  if (await q(`SELECT COUNT(*) n FROM points_ledger p JOIN validation_tasks t ON t.id=p.task_id
               WHERE p.contributor_id=$1 AND p.kind='validation' AND p.status='confirmed' AND t.kind='ocr_quality'`, [cid]) >= 10)
    await grant('ocr_restorer');
  if (await q(`SELECT COUNT(*) n FROM validation_votes v
               WHERE v.contributor_id=$1 AND v.source_ref IS NOT NULL AND NOT v.flagged_spam
                 AND EXISTS (SELECT 1 FROM points_ledger p WHERE p.contributor_id=v.contributor_id
                             AND p.task_id=v.task_id AND p.status='confirmed')`, [cid]) >= 5)
    await grant('source_detective');
  if (await q(`SELECT COUNT(*) n FROM reliability_events WHERE contributor_id=$1 AND kind='consensus_agree'`, [cid]) >= 20)
    await grant('consensus_builder');
  const streak = await getStreak(pool, cid);
  if (streak >= 7) await grant('sustained_7');
  if (streak >= 30) await grant('sustained_30');

  return award;
}

// ── Anomaly detection ────────────────────────────────────────
async function flagSuspicion(pool, cid, kind, detail) {
  await pool.query(
    'INSERT INTO suspicion_flags (contributor_id, kind, detail) VALUES ($1,$2,$3)',
    [cid, kind, String(detail || '').slice(0, 500)]);
}

module.exports = {
  POINTS, DAILY_CAP, DIMINISH_AFTER, MIN_INTERVAL_MS, RAPID_MS, BURST_MAX, BURST_WINDOW_MS,
  ACHIEVEMENTS,
  dailyPointsTotal, validationsToday, awardPoints, resolvePoints,
  addReliabilityEvent, recomputeReliability, reliabilityBand, consensusWeight,
  bumpContributionDay, getStreak,
  isoWeekKey, ensureQuests, questTick,
  checkAchievements, flagSuspicion,
};
