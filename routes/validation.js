'use strict';

// Expert-validation & gamification API.
// Blind voting: GET /api/validation/next never exposes other votes; the
// consensus distribution is revealed only in the vote response (and via
// /result for those who already voted). Community consensus never becomes
// expert verification silently — only a verified_expert or administrator
// adjudication sets expert_verified.

const express = require('express');
const crypto = require('crypto');
const auth = require('../lib/auth');
const gam = require('../lib/gamification');

const MIN_VOTES = 3;
const AGREEMENT = 0.67;       // weighted share needed for community consensus
const DISPUTE_MINORITY = 0.25; // runner-up share that marks an item disputed

module.exports = function createValidationRouter({ pool }) {
  const router = express.Router();
  const { requireAccount, requireRole, makeRateLimiter } = auth.makeMiddleware(pool);

  const audit = (req, eventType, targetType, targetId, payload) => {
    const id = req.identity || auth.getIdentity(req) || { type: 'system', id: null, name: null };
    return pool.query(
      `INSERT INTO audit_events (actor_type, actor_id, actor_name, event_type, target_type, target_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id.type, id.id || null, id.name || null, eventType, targetType, targetId,
       payload ? JSON.stringify(payload) : null]);
  };

  const publicAccount = (row) => row && ({
    id: row.id, display_name: row.display_name, role: row.role,
    public_profile: row.public_profile, leaderboard_opt_in: row.leaderboard_opt_in,
  });

  // ══ Auth: accounts ═════════════════════════════════════════
  const AUTH_RATE_MAX = parseInt(process.env.AUTH_RATE_MAX || '10', 10);
  const authLimiter = makeRateLimiter(AUTH_RATE_MAX, 10 * 60 * 1000, 'Too many attempts. Please wait a few minutes.');

  router.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
      const { email, password, display_name, invite_token } = req.body || {};
      const cleanEmail = String(email || '').trim().toLowerCase().slice(0, 200);
      const cleanName = String(display_name || '').trim().slice(0, 100);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail))
        return res.status(400).json({ error: 'A valid email address is required.' });
      if (!cleanName) return res.status(400).json({ error: 'A display name is required.' });
      if (String(password || '').length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      // Self-registration always yields the contributor role. Trusted/expert
      // roles come only from an administrator grant or a valid invitation
      // that records the basis of the person's expertise.
      let role = 'contributor', grantBasis = null, invite = null;
      if (invite_token) {
        const inv = await pool.query(
          `SELECT * FROM invites WHERE token = $1 AND used_by IS NULL
             AND (expires_at IS NULL OR expires_at > now())`, [String(invite_token)]);
        invite = inv.rows[0] || null;
        if (invite) { role = invite.role; grantBasis = invite.expertise_note || 'Invitation'; }
      }

      const id = 'c_' + crypto.randomUUID();
      let row;
      try {
        const r = await pool.query(
          `INSERT INTO contributors (id, email, password_hash, display_name, role)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id, display_name, role, public_profile, leaderboard_opt_in`,
          [id, cleanEmail, auth.hashPassword(password), cleanName, role]);
        row = r.rows[0];
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' });
        throw e;
      }
      if (invite) {
        await pool.query('UPDATE invites SET used_by = $1 WHERE token = $2', [id, invite.token]);
      }
      if (grantBasis) {
        await pool.query(
          `INSERT INTO expert_grants (contributor_id, granted_role, basis, granted_by, invite_token)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, role, grantBasis, invite ? 'invite:' + invite.created_by : 'admin', invite ? invite.token : null]);
      }
      req.identity = { type: 'account', id, name: cleanName, role };
      await audit(req, 'register', 'contributor', id, { role, invited: !!invite });
      auth.setAccountCookie(res, { id, display_name: cleanName, role });
      res.json({ account: publicAccount(row) });
    } catch (err) {
      console.error('register:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/auth/account-login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const r = await pool.query(
        'SELECT * FROM contributors WHERE lower(email) = lower($1)', [String(email || '').trim()]);
      const row = r.rows[0];
      if (!row || !auth.verifyPassword(password, row.password_hash))
        return res.status(401).json({ error: 'Incorrect email or password.' });
      auth.setAccountCookie(res, row);
      res.json({ account: publicAccount(row) });
    } catch (err) {
      console.error('account-login:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/auth/account-logout', (req, res) => {
    auth.clearAccountCookie(res);
    res.json({ ok: true });
  });

  // ══ Profile ════════════════════════════════════════════════
  router.get('/api/profile', requireAccount, async (req, res) => {
    const r = await pool.query(
      `SELECT id, email, display_name, affiliation, languages, expertise, role,
              public_profile, leaderboard_opt_in, reliability, reliability_events_count, created_at
         FROM contributors WHERE id = $1`, [req.identity.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Account not found' });
    const c = r.rows[0];
    const [points, achievements, quests, streak] = await Promise.all([
      pool.query(
        `SELECT status, COALESCE(SUM(points),0) AS total, COUNT(*) AS entries
           FROM points_ledger WHERE contributor_id = $1 GROUP BY status`, [req.identity.id]),
      pool.query('SELECT key, awarded_at FROM achievements WHERE contributor_id = $1 ORDER BY awarded_at', [req.identity.id]),
      gam.ensureQuests(pool, req.identity.id),
      gam.getStreak(pool, req.identity.id),
    ]);
    const byStatus = Object.fromEntries(points.rows.map(p => [p.status, Number(p.total)]));
    const events = await pool.query(
      `SELECT kind, COUNT(*) AS n FROM reliability_events WHERE contributor_id = $1 GROUP BY kind`, [req.identity.id]);
    res.json({
      profile: { ...c, email: c.email }, // email is only ever returned to the owner
      stats: {
        confirmedPoints: byStatus.confirmed || 0,
        provisionalPoints: byStatus.provisional || 0,
        reliability: c.reliability,
        reliabilityBand: gam.reliabilityBand(c.reliability, c.reliability_events_count),
        reliabilityBreakdown: Object.fromEntries(events.rows.map(e => [e.kind, Number(e.n)])),
        streak,
      },
      achievements: achievements.rows.map(a => ({ ...a, label: gam.ACHIEVEMENTS[a.key] || a.key })),
      quests,
    });
  });

  router.patch('/api/profile', requireAccount, async (req, res) => {
    const { display_name, affiliation, languages, expertise, public_profile, leaderboard_opt_in } = req.body || {};
    const r = await pool.query(
      `UPDATE contributors SET
         display_name = COALESCE($2, display_name),
         affiliation = COALESCE($3, affiliation),
         languages = COALESCE($4, languages),
         expertise = COALESCE($5, expertise),
         public_profile = COALESCE($6, public_profile),
         leaderboard_opt_in = COALESCE($7, leaderboard_opt_in),
         updated_at = now()
       WHERE id = $1
       RETURNING id, display_name, affiliation, languages, expertise, role,
                 public_profile, leaderboard_opt_in`,
      [req.identity.id,
       display_name != null ? String(display_name).trim().slice(0, 100) : null,
       affiliation != null ? String(affiliation).slice(0, 200) : null,
       languages != null ? String(languages).slice(0, 300) : null,
       expertise != null ? String(expertise).slice(0, 500) : null,
       typeof public_profile === 'boolean' ? public_profile : null,
       typeof leaderboard_opt_in === 'boolean' ? leaderboard_opt_in : null]);
    await audit(req, 'profile_update', 'contributor', req.identity.id, null);
    res.json({ profile: r.rows[0] });
  });

  // Public profile — only what the contributor explicitly made public.
  // Email and private fields are never exposed here.
  router.get('/api/contributors/:id', async (req, res) => {
    const r = await pool.query(
      `SELECT id, display_name, affiliation, languages, expertise, role, reliability,
              reliability_events_count, public_profile
         FROM contributors WHERE id = $1`, [req.params.id]);
    const c = r.rows[0];
    if (!c || !c.public_profile) return res.status(404).json({ error: 'Profile is private or does not exist.' });
    const [achievements, points] = await Promise.all([
      pool.query('SELECT key FROM achievements WHERE contributor_id = $1 ORDER BY awarded_at', [c.id]),
      pool.query(`SELECT COALESCE(SUM(points),0) AS total FROM points_ledger
                   WHERE contributor_id = $1 AND status = 'confirmed'`, [c.id]),
    ]);
    res.json({
      profile: {
        id: c.id, display_name: c.display_name, affiliation: c.affiliation,
        languages: c.languages, expertise: c.expertise, role: c.role,
        reliabilityBand: gam.reliabilityBand(c.reliability, c.reliability_events_count),
        confirmedPoints: Number(points.rows[0].total),
        achievements: achievements.rows.map(a => ({ key: a.key, label: gam.ACHIEVEMENTS[a.key] || a.key })),
      },
    });
  });

  // ══ Validation workspace ═══════════════════════════════════
  const taskPublic = (t) => ({
    id: t.id, kind: t.kind, prompt_ru: t.prompt_ru, lak_text: t.lak_text,
    context: t.context, options: t.options, priority: t.priority, version: t.version,
    // Deliberately NO votes, consensus, status resolution or gold answer here.
  });

  router.get('/api/validation/next', requireAccount, async (req, res) => {
    try {
      const isTrusted = auth.TRUSTED_PLUS.includes(
        (await pool.query('SELECT role FROM contributors WHERE id=$1', [req.identity.id])).rows[0]?.role);
      // Gold calibration tasks are interleaved (~25%) to keep reliability honest.
      const wantGold = Math.random() < 0.25;
      const pick = async (gold) => pool.query(
        `SELECT * FROM validation_tasks t
          WHERE NOT EXISTS (SELECT 1 FROM validation_votes v WHERE v.task_id = t.id AND v.contributor_id = $1)
            AND t.is_gold = $2
            AND (t.status = 'pending' OR (t.status = 'disputed' AND $3))
          ORDER BY t.priority DESC, random() LIMIT 1`,
        [req.identity.id, gold, isTrusted]);
      let r = await pick(wantGold);
      if (!r.rows[0]) r = await pick(!wantGold);
      const [streak, quests, today] = await Promise.all([
        gam.getStreak(pool, req.identity.id),
        gam.ensureQuests(pool, req.identity.id),
        gam.dailyPointsTotal(pool, req.identity.id),
      ]);
      res.json({ task: r.rows[0] ? taskPublic(r.rows[0]) : null, stats: { streak, quests, pointsToday: today } });
    } catch (err) {
      console.error('validation/next:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  async function distribution(taskId) {
    const r = await pool.query(
      `SELECT v.value, COUNT(*) AS n,
              ROUND(SUM(gam_w.w)::numeric, 2) AS weight
         FROM validation_votes v
         JOIN (SELECT id, (0.3 + GREATEST(0, LEAST(1, reliability))) AS w FROM contributors) gam_w
           ON gam_w.id = v.contributor_id
        WHERE v.task_id = $1 AND NOT v.flagged_spam
        GROUP BY v.value ORDER BY weight DESC`, [taskId]);
    const totalW = r.rows.reduce((s, x) => s + Number(x.weight), 0) || 1;
    return r.rows.map(x => ({
      value: x.value, votes: Number(x.n), weight: Number(x.weight),
      share: Math.round((Number(x.weight) / totalW) * 1000) / 1000,
    }));
  }

  async function resolveConsensus(req, task) {
    const dist = await distribution(task.id);
    const totalVotes = dist.reduce((s, d) => s + d.votes, 0);
    if (totalVotes < MIN_VOTES) return null;
    const top = dist[0];
    const runnerUp = dist[1];
    if (top.share >= AGREEMENT) {
      await pool.query(
        `UPDATE validation_tasks SET status='community_consensus', consensus_value=$2,
           consensus_confidence=$3, version=version+1, updated_at=now() WHERE id=$1`,
        [task.id, top.value, top.share]);
      await audit(req, 'status_change', 'validation_task', task.id,
        { from: task.status, to: 'community_consensus', value: top.value, confidence: top.share, task_version: task.version + 1 });
      await settleVoters(req, task, top.value, 'consensus');
      return 'community_consensus';
    }
    if (runnerUp && runnerUp.share >= DISPUTE_MINORITY) {
      await pool.query(
        `UPDATE validation_tasks SET status='disputed', version=version+1, updated_at=now() WHERE id=$1`,
        [task.id]);
      await audit(req, 'status_change', 'validation_task', task.id,
        { from: task.status, to: 'disputed', task_version: task.version + 1, distribution: dist });
      return 'disputed';
    }
    return null;
  }

  // Confirm/revoke provisional points and record reliability for every
  // voter once a value is final (consensus or adjudication).
  async function settleVoters(req, task, finalValue, via) {
    const votes = await pool.query(
      `SELECT v.*, c.reliability FROM validation_votes v
        JOIN contributors c ON c.id = v.contributor_id
       WHERE v.task_id = $1 AND NOT v.flagged_spam`, [task.id]);
    const wasDisputed = task.status === 'disputed' || via === 'adjudication-disputed';
    for (const v of votes.rows) {
      const agreed = v.value === finalValue;
      await gam.resolvePoints(pool, v.contributor_id, task.id, agreed ? 'confirmed' : 'revoked',
        agreed ? `Agreed with ${via} outcome` : `Overturned by ${via} outcome`);
      if (agreed) {
        if (v.source_ref) await gam.awardPoints(pool, {
          contributorId: v.contributor_id, taskId: task.id, kind: 'evidence',
          points: gam.POINTS.evidence, status: 'confirmed', reason: 'Evidence-backed note supported the outcome' });
        if (v.correction && v.correction.trim() && v.correction.trim() === finalValue) await gam.awardPoints(pool, {
          contributorId: v.contributor_id, taskId: task.id, kind: 'correction',
          points: gam.POINTS.correction, status: 'confirmed', reason: 'Correction adopted' });
        if (via.startsWith('adjudication') && wasDisputed) await gam.awardPoints(pool, {
          contributorId: v.contributor_id, taskId: task.id, kind: 'disputed_resolution',
          points: gam.POINTS.disputedResolution, status: 'confirmed', reason: 'Helped resolve a disputed item' });
        await gam.addReliabilityEvent(pool, {
          contributorId: v.contributor_id, taskId: task.id,
          kind: via.startsWith('adjudication') ? 'expert_confirmed' : 'consensus_agree', outcome: 1 });
      } else {
        await gam.addReliabilityEvent(pool, {
          contributorId: v.contributor_id, taskId: task.id,
          kind: via.startsWith('adjudication') ? 'reversal' : 'consensus_disagree', outcome: 0 });
      }
      await gam.checkAchievements(pool, v.contributor_id);
    }
  }

  router.post('/api/validation/tasks/:id/vote', requireAccount, async (req, res) => {
    try {
      const cid = req.identity.id;
      const { value, correction, evidence_note, source_ref, time_to_vote_ms } = req.body || {};
      const cleanValue = String(value || '').trim().slice(0, 200);
      if (!cleanValue) return res.status(400).json({ error: 'A value is required.' });

      const tr = await pool.query('SELECT * FROM validation_tasks WHERE id = $1', [req.params.id]);
      const task = tr.rows[0];
      if (!task) return res.status(404).json({ error: 'Task not found.' });
      if (['expert_verified', 'rejected'].includes(task.status))
        return res.status(409).json({ error: 'This task is already closed.' });
      if (Array.isArray(task.options) && task.options.length && !task.options.includes(cleanValue))
        return res.status(400).json({ error: 'Value must be one of the offered options.' });

      // Duplicate prevention
      const dup = await pool.query(
        'SELECT 1 FROM validation_votes WHERE task_id=$1 AND contributor_id=$2', [task.id, cid]);
      if (dup.rows[0]) return res.status(409).json({ error: 'You have already voted on this task.' });

      // Rate limit: minimum interval between votes
      const last = await pool.query(
        'SELECT created_at FROM validation_votes WHERE contributor_id=$1 ORDER BY created_at DESC LIMIT 1', [cid]);
      if (last.rows[0] && Date.now() - new Date(last.rows[0].created_at).getTime() < gam.MIN_INTERVAL_MS)
        return res.status(429).json({ error: 'Please take a moment to read each task — you are voting too quickly.' });

      // Anomaly detection: rapid submissions and bursts earn no points
      let flagged = false;
      if (typeof time_to_vote_ms === 'number' && time_to_vote_ms >= 0 && time_to_vote_ms < gam.RAPID_MS) {
        flagged = true;
        await gam.flagSuspicion(pool, cid, 'rapid_submission', `${time_to_vote_ms}ms on task ${task.id}`);
      }
      const burst = await pool.query(
        `SELECT COUNT(*) AS n FROM validation_votes
          WHERE contributor_id=$1 AND created_at > now() - interval '5 minutes'`, [cid]);
      if (Number(burst.rows[0].n) >= gam.BURST_MAX) {
        flagged = true;
        await gam.flagSuspicion(pool, cid, 'burst', 'More than 10 votes within 5 minutes');
      }

      let vote;
      try {
        const vr = await pool.query(
          `INSERT INTO validation_votes
             (task_id, task_version, contributor_id, value, correction, evidence_note, source_ref, time_to_vote_ms, flagged_spam)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, created_at`,
          [task.id, task.version, cid, cleanValue,
           correction ? String(correction).slice(0, 500) : null,
           evidence_note ? String(evidence_note).slice(0, 1000) : null,
           source_ref ? String(source_ref).slice(0, 300) : null,
           typeof time_to_vote_ms === 'number' ? Math.round(time_to_vote_ms) : null,
           flagged]);
        vote = vr.rows[0];
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'You have already voted on this task.' });
        throw e;
      }
      await audit(req, 'vote', 'validation_task', task.id, {
        value: cleanValue, task_version: task.version,
        has_correction: !!correction, has_evidence: !!evidence_note, flagged_spam: flagged });

      await gam.bumpContributionDay(pool, cid, !flagged);

      // Provisional points — only confirmed later by consensus/gold/expert
      let provisional = null;
      if (!flagged) {
        const n = await gam.validationsToday(pool, cid);
        const pts = n > gam.DIMINISH_AFTER ? gam.POINTS.validationDiminished : gam.POINTS.validation;
        provisional = await gam.awardPoints(pool, {
          contributorId: cid, taskId: task.id, kind: 'validation', points: pts,
          reason: 'Completed validation (provisional until consensus/gold/expert confirms)' });
      }
      const completedQuests = flagged ? [] : await gam.questTick(pool, cid, {
        kind: task.kind, isGold: task.is_gold, hasEvidence: !!(evidence_note || source_ref) });

      // Resolution
      let goldResult = null, newStatus = null;
      if (task.is_gold) {
        const correct = cleanValue === task.gold_answer;
        await gam.resolvePoints(pool, cid, task.id, correct ? 'confirmed' : 'revoked',
          correct ? 'Matched gold-standard answer' : 'Did not match gold-standard answer');
        if (correct) await gam.awardPoints(pool, {
          contributorId: cid, taskId: task.id, kind: 'gold_bonus',
          points: gam.POINTS.goldBonus, status: 'confirmed', reason: 'Gold-standard answer correct' });
        await gam.addReliabilityEvent(pool, {
          contributorId: cid, taskId: task.id, kind: correct ? 'gold_hit' : 'gold_miss', outcome: correct ? 1 : 0 });
        goldResult = { isGold: true, correct };
      } else {
        newStatus = await resolveConsensus(req, task);
      }
      const awarded = await gam.checkAchievements(pool, cid);

      const dist = await distribution(task.id);
      const me = (await pool.query('SELECT reliability, reliability_events_count FROM contributors WHERE id=$1', [cid])).rows[0];
      res.json({
        ok: true, flagged_spam: flagged,
        distribution: dist,                       // revealed only now, after voting
        taskStatus: newStatus || task.status,
        gold: goldResult,
        points: { provisional: provisional ? provisional.points : 0, questsCompleted: completedQuests },
        achievements: awarded,
        reliabilityBand: gam.reliabilityBand(me.reliability, me.reliability_events_count),
      });
    } catch (err) {
      console.error('vote:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Consensus distribution — only for those who already voted.
  router.get('/api/validation/tasks/:id/result', requireAccount, async (req, res) => {
    const voted = await pool.query(
      'SELECT 1 FROM validation_votes WHERE task_id=$1 AND contributor_id=$2', [req.params.id, req.identity.id]);
    if (!voted.rows[0])
      return res.status(403).json({ error: 'Submit your own assessment first — votes stay blind until then.' });
    const t = (await pool.query('SELECT id, status, consensus_value, consensus_confidence FROM validation_tasks WHERE id=$1', [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    res.json({ distribution: await distribution(req.params.id), task: t });
  });

  // Adjudication by trusted validators / verified experts / administrators.
  // Only verified experts and administrators can set expert_verified; a
  // trusted validator's decision raises an item to community_consensus.
  router.post('/api/validation/tasks/:id/adjudicate', requireRole(auth.TRUSTED_PLUS), async (req, res) => {
    try {
      const { decision, note } = req.body || {};
      const cleanDecision = String(decision || '').trim().slice(0, 200);
      if (!cleanDecision) return res.status(400).json({ error: 'A decision is required.' });
      const tr = await pool.query('SELECT * FROM validation_tasks WHERE id=$1', [req.params.id]);
      const task = tr.rows[0];
      if (!task) return res.status(404).json({ error: 'Task not found.' });

      const isExpert = auth.EXPERT_PLUS.includes(req.identity.role);
      const newStatus = cleanDecision === 'reject'
        ? 'rejected'
        : (isExpert ? 'expert_verified' : 'community_consensus');
      await pool.query(
        `UPDATE validation_tasks SET status=$2, consensus_value=$3, consensus_confidence=1.0,
           version=version+1, updated_at=now() WHERE id=$1`,
        [task.id, newStatus, cleanDecision === 'reject' ? null : cleanDecision]);
      await pool.query(
        `INSERT INTO adjudications (task_id, adjudicator_id, adjudicator_name, adjudicator_role, decision, note, resulting_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [task.id, req.identity.id, req.identity.name, req.identity.role,
         cleanDecision, note ? String(note).slice(0, 1000) : null, newStatus]);
      await audit(req, 'adjudication', 'validation_task', task.id, {
        decision: cleanDecision, resulting_status: newStatus, task_version: task.version + 1,
        adjudicator_role: req.identity.role });
      if (cleanDecision !== 'reject') {
        const via = task.status === 'disputed' ? 'adjudication-disputed' : 'adjudication';
        await settleVoters(req, task, cleanDecision, via);
      } else {
        await settleVoters(req, task, '__never_matches__', 'adjudication');
      }
      if (req.identity.type === 'account') {
        await gam.awardPoints(pool, {
          contributorId: req.identity.id, taskId: task.id, kind: 'adjudication',
          points: gam.POINTS.adjudication, status: 'confirmed',
          reason: `Adjudicated as ${req.identity.role}` });
      }
      res.json({ ok: true, status: newStatus });
    } catch (err) {
      console.error('adjudicate:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Audit trail for a target — visible to trusted roles and above.
  router.get('/api/audit', requireRole(auth.TRUSTED_PLUS), async (req, res) => {
    const { target_type, target_id } = req.query;
    const r = await pool.query(
      `SELECT id, actor_type, actor_name, event_type, target_type, target_id, payload, created_at
         FROM audit_events
        WHERE ($1::text IS NULL OR target_type = $1) AND ($2::text IS NULL OR target_id = $2)
        ORDER BY created_at DESC LIMIT 200`,
      [target_type || null, target_id || null]);
    res.json({ events: r.rows });
  });

  // ══ Leaderboard & personal progress ════════════════════════
  const PERIOD_SQL = {
    week:  "p.created_at >= date_trunc('week', now())",
    month: "p.created_at >= date_trunc('month', now())",
    all:   'TRUE',
  };

  async function leaderboardRows(period) {
    const cond = PERIOD_SQL[period] || PERIOD_SQL.all;
    const r = await pool.query(
      `SELECT c.id, c.display_name, c.role, c.reliability, c.reliability_events_count,
              COALESCE(SUM(CASE WHEN p.status='confirmed' AND ${cond} THEN p.points END),0) AS points,
              COUNT(DISTINCT CASE WHEN p.status='confirmed' AND ${cond}
                   AND p.kind IN ('validation','gold_bonus') THEN p.task_id END) AS verified_validations
         FROM contributors c
         LEFT JOIN points_ledger p ON p.contributor_id = c.id
        WHERE c.leaderboard_opt_in
        GROUP BY c.id
        ORDER BY points DESC, verified_validations DESC, c.display_name
        LIMIT 50`, []);
    return Promise.all(r.rows.map(async (row) => ({
      id: row.id,
      display_name: row.display_name,                    // pseudonyms allowed
      role: row.role,                                    // expert badge shown when expert/admin
      points: Number(row.points),
      verified_validations: Number(row.verified_validations),
      reliability_band: gam.reliabilityBand(row.reliability, row.reliability_events_count),
      streak: await gam.getStreak(pool, row.id),
      // Never: email, affiliation, or any private profile field.
    })));
  }

  router.get('/api/leaderboard', async (req, res) => {
    const period = ['week', 'month', 'all'].includes(req.query.period) ? req.query.period : 'all';
    res.json({ period, entries: await leaderboardRows(period) });
  });

  router.get('/api/leaderboard/me', requireAccount, async (req, res) => {
    const cid = req.identity.id;
    const rows = await leaderboardRows(req.query.period || 'all');
    const myIdx = rows.findIndex(r => r.id === cid);
    const mine = myIdx >= 0 ? rows[myIdx] : null;
    // Personal totals count even when the contributor is not publicly listed.
    const totals = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN status='confirmed' THEN points END),0) AS confirmed,
              COUNT(DISTINCT CASE WHEN status='confirmed' AND kind IN ('validation','gold_bonus') THEN task_id END) AS verified
         FROM points_ledger WHERE contributor_id=$1`, [cid]);
    const totalListed = rows.length;
    const rank = mine ? myIdx + 1 : null;
    const neighbors = mine
      ? rows.slice(Math.max(0, myIdx - 2), myIdx + 3).map((r, i) => ({ ...r, rank: Math.max(0, myIdx - 2) + i + 1 }))
      : rows.slice(0, 3).map((r, i) => ({ ...r, rank: i + 1 }));
    const meRow = (await pool.query(
      'SELECT reliability, reliability_events_count, leaderboard_opt_in FROM contributors WHERE id=$1', [cid])).rows[0];
    const events = await pool.query(
      'SELECT kind, COUNT(*) AS n FROM reliability_events WHERE contributor_id=$1 GROUP BY kind', [cid]);
    await gam.checkAchievements(pool, cid);
    const [achievements, quests, streak] = await Promise.all([
      pool.query('SELECT key, awarded_at FROM achievements WHERE contributor_id=$1 ORDER BY awarded_at DESC', [cid]),
      gam.ensureQuests(pool, cid),
      gam.getStreak(pool, cid),
    ]);
    res.json({
      opted_in: meRow.leaderboard_opt_in,
      rank, total_listed: totalListed,
      percentile: rank && totalListed ? Math.round((1 - (rank - 1) / Math.max(totalListed, 1)) * 100) : null,
      confirmed_points: Number(totals.rows[0].confirmed),
      verified_validations: Number(totals.rows[0].verified),
      reliability_band: gam.reliabilityBand(meRow.reliability, meRow.reliability_events_count),
      reliability_explanation: {
        band: gam.reliabilityBand(meRow.reliability, meRow.reliability_events_count),
        score: meRow.reliability,
        basis: 'Reliability weighs your votes in consensus. It grows with gold-task hits, ' +
               'agreement with later consensus, and expert-confirmed work; it drops with misses ' +
               'and reversals. New contributors start near the middle.',
        events: Object.fromEntries(events.rows.map(e => [e.kind, Number(e.n)])),
      },
      streak,
      neighbors,
      achievements: achievements.rows.map(a => ({ ...a, label: gam.ACHIEVEMENTS[a.key] || a.key })),
      quests,
    });
  });

  router.get('/api/quests', requireAccount, async (req, res) => {
    res.json({ quests: await gam.ensureQuests(pool, req.identity.id) });
  });

  // ══ Appeals ════════════════════════════════════════════════
  router.post('/api/appeals', requireAccount, async (req, res) => {
    const { target_type, target_id, reason } = req.body || {};
    if (!reason || !String(reason).trim())
      return res.status(400).json({ error: 'Please explain what you are appealing and why.' });
    const r = await pool.query(
      `INSERT INTO appeals (contributor_id, target_type, target_id, reason)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [req.identity.id, String(target_type || 'points').slice(0, 50),
       target_id ? String(target_id).slice(0, 100) : null, String(reason).slice(0, 2000)]);
    await audit(req, 'appeal', 'appeal', String(r.rows[0].id), { target_type, target_id });
    res.json({ appeal: r.rows[0] });
  });

  // ══ Admin & expert dashboard ═══════════════════════════════
  router.get('/api/admin/overview', requireRole(auth.TRUSTED_PLUS), async (req, res) => {
    const [byStatus, byKind, disputes, confidence, goldPerf, bands, suspicion, highPriority, appeals] = await Promise.all([
      pool.query(`SELECT status, COUNT(*) AS n FROM validation_tasks GROUP BY status`),
      pool.query(`SELECT kind, status, COUNT(*) AS n FROM validation_tasks GROUP BY kind, status ORDER BY kind`),
      pool.query(`SELECT t.id, t.kind, t.prompt_ru, t.lak_text, t.priority, t.version, COUNT(v.id) AS votes
                    FROM validation_tasks t LEFT JOIN validation_votes v ON v.task_id = t.id
                   WHERE t.status = 'disputed' GROUP BY t.id ORDER BY t.priority DESC, votes DESC LIMIT 20`),
      pool.query(`SELECT ROUND(AVG(consensus_confidence)::numeric,3) AS avg_confidence, COUNT(*) AS n
                    FROM validation_tasks WHERE status = 'community_consensus'`),
      pool.query(`SELECT t.id, t.prompt_ru, t.kind,
                    COUNT(v.id) AS votes,
                    COUNT(*) FILTER (WHERE v.value = t.gold_answer) AS hits
                    FROM validation_tasks t JOIN validation_votes v ON v.task_id = t.id
                   WHERE t.is_gold GROUP BY t.id ORDER BY t.id LIMIT 50`),
      pool.query(`SELECT CASE
                      WHEN reliability_events_count < 10 THEN 'new'
                      WHEN reliability >= 0.7 THEN 'high'
                      WHEN reliability >= 0.4 THEN 'established'
                      ELSE 'developing' END AS band, COUNT(*) AS n
                    FROM contributors GROUP BY 1`),
      pool.query(`SELECT s.id, s.contributor_id, c.display_name, s.kind, s.detail, s.created_at
                    FROM suspicion_flags s JOIN contributors c ON c.id = s.contributor_id
                   ORDER BY s.created_at DESC LIMIT 20`),
      pool.query(`SELECT id, kind, prompt_ru, lak_text, status, priority FROM validation_tasks
                   WHERE priority > 0 AND status IN ('pending','disputed') ORDER BY priority DESC LIMIT 20`),
      pool.query(`SELECT a.*, c.display_name FROM appeals a JOIN contributors c ON c.id = a.contributor_id
                   WHERE a.status = 'open' ORDER BY a.created_at LIMIT 20`),
    ]);
    res.json({
      backlogByStatus: Object.fromEntries(byStatus.rows.map(r => [r.status, Number(r.n)])),
      backlogByKind: byKind.rows,
      disputes: disputes.rows,
      consensus: confidence.rows[0],
      goldPerformance: goldPerf.rows.map(g => ({ ...g, votes: Number(g.votes), hits: Number(g.hits) })),
      reliabilityBands: Object.fromEntries(bands.rows.map(r => [r.band, Number(r.n)])),
      suspiciousActivity: suspicion.rows,
      highPriority: highPriority.rows,
      openAppeals: appeals.rows,
      myRole: req.identity.role,
    });
  });

  // Role grants — administrators only, and the basis of expertise is recorded.
  router.post('/api/admin/contributors/:id/role', requireRole(['administrator']), async (req, res) => {
    const { role, basis } = req.body || {};
    if (!auth.ROLES.includes(role))
      return res.status(400).json({ error: `Role must be one of: ${auth.ROLES.join(', ')}` });
    if (['trusted_validator', 'verified_expert'].includes(role) && !String(basis || '').trim())
      return res.status(400).json({
        error: 'Granting trusted/expert status requires recording the basis of expertise ' +
               '(linguistic, native-speaker, community, or academic).' });
    const r = await pool.query(
      `UPDATE contributors SET role=$2, updated_at=now() WHERE id=$1
       RETURNING id, display_name, role`, [req.params.id, role]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Contributor not found.' });
    await pool.query(
      `INSERT INTO expert_grants (contributor_id, granted_role, basis, granted_by)
       VALUES ($1,$2,$3,$4)`,
      [req.params.id, role, String(basis || 'Administrative change').slice(0, 1000), req.identity.name]);
    await audit(req, 'role_grant', 'contributor', req.params.id, { role, basis });
    res.json({ contributor: r.rows[0] });
  });

  router.post('/api/admin/invites', requireRole(['administrator']), async (req, res) => {
    const { role, expertise_note, expires_days } = req.body || {};
    if (!auth.TRUSTED_PLUS.includes(role))
      return res.status(400).json({ error: 'Invites are for trusted_validator, verified_expert, or administrator roles.' });
    if (!String(expertise_note || '').trim())
      return res.status(400).json({ error: 'Record the invitee\u2019s expertise basis (linguistic, native-speaker, community, or academic).' });
    const token = crypto.randomBytes(18).toString('base64url');
    const days = Math.min(Math.max(parseInt(expires_days || '30', 10) || 30, 1), 365);
    await pool.query(
      `INSERT INTO invites (token, role, expertise_note, created_by, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
      [token, role, String(expertise_note).slice(0, 1000), req.identity.name, String(days)]);
    await audit(req, 'invite_create', 'invite', token, { role, expertise_note });
    res.json({ token, role, expires_days: days });
  });

  router.get('/api/admin/invites', requireRole(['administrator']), async (req, res) => {
    const r = await pool.query(
      `SELECT token, role, expertise_note, created_by, used_by, expires_at, created_at
         FROM invites ORDER BY created_at DESC LIMIT 50`);
    res.json({ invites: r.rows });
  });

  // Invalidate abusive points WITHOUT deleting them: rows are revoked and
  // the action is written to the audit trail.
  router.post('/api/admin/points/invalidate', requireRole(['administrator']), async (req, res) => {
    const { contributor_id, reason, all_provisional } = req.body || {};
    if (!contributor_id) return res.status(400).json({ error: 'contributor_id is required.' });
    if (!String(reason || '').trim()) return res.status(400).json({ error: 'A reason is required for the audit trail.' });
    const r = await pool.query(
      `UPDATE points_ledger SET status='revoked', resolved_at=now(),
         reason = COALESCE(reason || ' · ','') || $2
       WHERE contributor_id=$1 AND status <> 'revoked'
         AND ($3::boolean OR status = 'provisional')
       RETURNING id`,
      [String(contributor_id), `Admin invalidation: ${String(reason).slice(0, 500)}`, !all_provisional]);
    await gam.addReliabilityEvent(pool, { contributorId: String(contributor_id), kind: 'reversal', outcome: 0 });
    await audit(req, 'points_invalidate', 'contributor', String(contributor_id),
      { revoked: r.rowCount, reason });
    res.json({ revoked: r.rowCount });
  });

  // Create/extend validation tasks — the path toward a 100–200-query gold set.
  router.post('/api/admin/tasks', requireRole(['administrator']), async (req, res) => {
    const { id, kind, prompt_ru, lak_text, context, options, is_gold, gold_answer, priority } = req.body || {};
    const KINDS = ['translation_correctness', 'sense_choice', 'moon_vs_month', 'dialect',
                   'spelling', 'ocr_quality', 'example_usefulness', 'source_reliability'];
    if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` });
    if (is_gold && !gold_answer) return res.status(400).json({ error: 'Gold tasks require gold_answer.' });
    const taskId = String(id || 't_' + crypto.randomUUID()).slice(0, 100);
    const r = await pool.query(
      `INSERT INTO validation_tasks (id, kind, prompt_ru, lak_text, context, options, is_gold, gold_answer, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [taskId, kind, prompt_ru || null, lak_text || null,
       context ? JSON.stringify(context) : null,
       Array.isArray(options) ? JSON.stringify(options.map(String)) : null,
       !!is_gold, gold_answer || null, Math.min(Math.max(parseInt(priority || '0', 10) || 0, 0), 100),
       req.identity.name]);
    if (!r.rows[0]) return res.status(409).json({ error: 'A task with this id already exists.' });
    await audit(req, 'task_create', 'validation_task', taskId, { kind, is_gold: !!is_gold });
    res.json({ task: { id: taskId } });
  });

  router.get('/api/admin/appeals', requireRole(auth.TRUSTED_PLUS), async (req, res) => {
    const r = await pool.query(
      `SELECT a.*, c.display_name FROM appeals a JOIN contributors c ON c.id = a.contributor_id
        ORDER BY a.status = 'resolved', a.created_at DESC LIMIT 50`);
    res.json({ appeals: r.rows });
  });

  router.post('/api/admin/appeals/:id/resolve', requireRole(['administrator']), async (req, res) => {
    const { resolution } = req.body || {};
    if (!String(resolution || '').trim())
      return res.status(400).json({ error: 'A resolution note is required.' });
    const r = await pool.query(
      `UPDATE appeals SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now()
        WHERE id=$1 AND status='open' RETURNING id`,
      [req.params.id, String(resolution).slice(0, 2000), req.identity.name]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Open appeal not found.' });
    await audit(req, 'appeal_resolve', 'appeal', String(req.params.id), { resolution });
    res.json({ ok: true });
  });

  return router;
};
