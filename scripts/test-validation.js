'use strict';

/*
 * Comprehensive test-suite for the expert-validation & gamification release.
 *
 * Spawns an isolated server instance on port 5055 with test-friendly
 * thresholds (fast rate limits, low diminishing-returns threshold), exercises
 * the API end-to-end against the real database, verifies state directly via
 * SQL where needed, then removes every artifact it created (contributors,
 * tasks, votes, points, audit rows tagged test-val:*). Seeded eval:* tasks and
 * all real data are left untouched.
 *
 * Usage: node scripts/test-validation.js
 * Requires: DATABASE_URL, REVIEWER_PASSPHRASE in the environment.
 */

const { spawn } = require('child_process');
const path = require('path');
const { Pool } = require('pg');

const BASE = 'http://127.0.0.1:5055';
const PASSPHRASE = process.env.REVIEWER_PASSPHRASE;
if (!PASSPHRASE) { console.error('REVIEWER_PASSPHRASE is required'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra).slice(0, 200) : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

// ── HTTP client with a private cookie jar ────────────────────
function client() {
  let cookie = '';
  return {
    async req(method, p, body) {
      const res = await fetch(BASE + p, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      let data = null;
      const text = await res.text();
      try { data = JSON.parse(text); } catch { data = { _raw: text }; }
      return { status: res.status, data };
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b); },
    patch(p, b) { return this.req('PATCH', p, b); },
  };
}

const CID = `(SELECT id FROM contributors WHERE email LIKE 'test-val-%@example.com')`;
const CLEANUP = [
  `DELETE FROM appeals WHERE contributor_id IN ${CID}`,
  `DELETE FROM suspicion_flags WHERE contributor_id IN ${CID}`,
  `DELETE FROM quests WHERE contributor_id IN ${CID}`,
  `DELETE FROM achievements WHERE contributor_id IN ${CID}`,
  `DELETE FROM contribution_days WHERE contributor_id IN ${CID}`,
  `DELETE FROM reliability_events WHERE contributor_id IN ${CID} OR task_id LIKE 'test-val:%'`,
  `DELETE FROM points_ledger WHERE contributor_id IN ${CID} OR task_id LIKE 'test-val:%'`,
  `DELETE FROM adjudications WHERE task_id LIKE 'test-val:%'`,
  `DELETE FROM validation_votes WHERE task_id LIKE 'test-val:%' OR contributor_id IN ${CID}`,
  `DELETE FROM audit_events WHERE actor_id IN ${CID} OR (target_id LIKE 'test-val:%')`,
  `DELETE FROM expert_grants WHERE contributor_id IN ${CID}`,
  `DELETE FROM invites WHERE expertise_note LIKE 'test-val:%'`,
  `DELETE FROM validation_tasks WHERE id LIKE 'test-val:%'`,
  `DELETE FROM contributors WHERE email LIKE 'test-val-%@example.com'`,
];

async function cleanup() {
  for (const sql of CLEANUP) await pool.query(sql);
}

async function insertTask(id, kind, options, extra = {}) {
  await pool.query(
    `INSERT INTO validation_tasks (id, kind, prompt_ru, lak_text, options, is_gold, gold_answer, priority, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,'test')`,
    [id, kind, extra.prompt || 'test', extra.lak || 'test',
     JSON.stringify(options), !!extra.gold, extra.gold || null]);
}

async function dbOne(sql, params) {
  const r = await pool.query(sql, params);
  return r.rows[0];
}

async function register(name, extra = {}) {
  const c = client();
  const r = await c.post('/api/auth/register', {
    email: `test-val-${name}@example.com`,
    password: 'test-password-123',
    display_name: `Test ${name}`,
    ...extra,
  });
  return { c, r };
}

async function main() {
  console.log('Cleaning up any previous test artifacts…');
  await cleanup();

  // ── Spawn isolated server ──────────────────────────────────
  console.log('Starting isolated test server on :5055 …');
  const child = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: '5055',
      VALIDATION_MIN_INTERVAL_MS: '250',
      VALIDATION_DIMINISH_AFTER: '3',
      AUTH_RATE_MAX: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });
  const deadline = Date.now() + 30000;
  while (!serverLog.includes('running on port 5055')) {
    if (Date.now() > deadline) throw new Error('Test server did not start:\n' + serverLog);
    await sleep(200);
  }

  try {
    // ── Setup tasks ──────────────────────────────────────────
    await insertTask('test-val:t1', 'translation_correctness', ['correct', 'incorrect']);
    await insertTask('test-val:t2', 'moon_vs_month', ['moon', 'month']);
    await insertTask('test-val:rl1', 'spelling', ['correct', 'incorrect']);
    await insertTask('test-val:rl2', 'spelling', ['correct', 'incorrect']);
    await insertTask('test-val:gold1', 'translation_correctness', ['correct', 'incorrect'], { gold: 'correct' });
    await insertTask('test-val:gold2', 'ocr_quality', ['clean', 'ocr_noise'], { gold: 'ocr_noise' });
    await insertTask('test-val:spam1', 'spelling', ['correct', 'incorrect']);
    await insertTask('test-val:cap1', 'spelling', ['correct', 'incorrect']);
    for (let i = 0; i <= 10; i++) await insertTask(`test-val:b${i}`, 'spelling', ['correct', 'incorrect']);
    for (let i = 1; i <= 4; i++) await insertTask(`test-val:d${i}`, 'spelling', ['correct', 'incorrect']);

    // ── Anonymous restrictions ───────────────────────────────
    group('anonymous restrictions');
    const anon = client();
    check('anonymous vote → 401', (await anon.post('/api/validation/tasks/test-val:t1/vote', { value: 'correct' })).status === 401);
    check('anonymous admin overview → 401', (await anon.get('/api/admin/overview')).status === 401);
    check('anonymous leaderboard → 200 (public)', (await anon.get('/api/leaderboard')).status === 200);
    check('anonymous corpus search → 200 (public)', (await anon.get('/api/corpus/search?q=test&limit=1')).status === 200);
    check('anonymous profile → 401', (await anon.get('/api/profile')).status === 401);

    // ── Registration & roles ─────────────────────────────────
    group('registration, roles, expertise gating');
    const { c: A, r: regA } = await register('a');
    check('register → 200', regA.status === 200, regA.data);
    check('self-registration yields contributor role (not expert)', regA.data.account?.role === 'contributor', regA.data);
    check('duplicate email → 409', (await register('a')).r.status === 409);
    check('weak password → 400', (await client().post('/api/auth/register', {
      email: 'test-val-weak@example.com', password: 'short', display_name: 'Weak' })).status === 400);
    const { c: B } = await register('b');
    const { c: C } = await register('c');
    const bad = client();
    check('wrong password login → 401', (await bad.post('/api/auth/account-login', {
      email: 'test-val-a@example.com', password: 'wrong-password' })).status === 401);
    check('correct login → 200', (await bad.post('/api/auth/account-login', {
      email: 'test-val-a@example.com', password: 'test-password-123' })).status === 200);

    // Admin identity = legacy reviewer session
    const admin = client();
    const adminLogin = await admin.post('/api/auth/login', { name: 'Test Reviewer', passphrase: PASSPHRASE });
    check('reviewer (admin) login → 200', adminLogin.status === 200, adminLogin.data);

    const grantNoBasis = await admin.post(`/api/admin/contributors/${regA.data.account.id}/role`, { role: 'trusted_validator' });
    check('trusted/expert grant without recorded basis → 400', grantNoBasis.status === 400);
    const cId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-c@example.com'`)).id;
    const grantC = await admin.post(`/api/admin/contributors/${cId}/role`, {
      role: 'verified_expert', basis: 'test-val: native speaker, field linguistics' });
    check('admin grants verified_expert with basis → 200', grantC.status === 200, grantC.data);
    check('expert_grants row recorded', !!(await dbOne(
      `SELECT 1 FROM expert_grants WHERE contributor_id=$1 AND granted_role='verified_expert'`, [cId])));

    const invite = await admin.post('/api/admin/invites', {
      role: 'trusted_validator', expertise_note: 'test-val: community language worker' });
    check('admin creates invite → token', invite.status === 200 && !!invite.data.token, invite.data);
    const { c: T, r: regT } = await register('t', { invite_token: invite.data.token });
    check('registration with invite yields invited role', regT.data.account?.role === 'trusted_validator', regT.data);

    // ── Blind voting ─────────────────────────────────────────
    group('independent / blind voting');
    const { c: R } = await register('r');
    const next = await R.get('/api/validation/next');
    check('GET next → 200 with task', next.status === 200 && !!next.data.task, next.data);
    const t = next.data.task || {};
    check('task payload hides votes', !('votes' in t) && !('distribution' in t));
    check('task payload hides gold answer', !('gold_answer' in t) && !('is_gold' in t));
    check('result before voting → 403 (blind)', (await R.get('/api/validation/tasks/test-val:t1/result')).status === 403);

    // ── Rate limiting ────────────────────────────────────────
    group('rate limiting & anomaly detection');
    const v1 = await R.post('/api/validation/tasks/test-val:rl1/vote', { value: 'correct' });
    check('first vote → 200', v1.status === 200, v1.data);
    const v2 = await R.post('/api/validation/tasks/test-val:rl2/vote', { value: 'correct' });
    check('immediate second vote → 429 (min interval)', v2.status === 429, v2.data);

    const { c: F } = await register('f');
    const rapid = await F.post('/api/validation/tasks/test-val:spam1/vote', { value: 'correct', time_to_vote_ms: 100 });
    check('rapid submission flagged as spam', rapid.status === 200 && rapid.data.flagged_spam === true, rapid.data);
    check('rapid submission earns no provisional points', rapid.data.points?.provisional === 0, rapid.data);
    const fId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-f@example.com'`)).id;
    check('suspicion flag recorded', !!(await dbOne(
      `SELECT 1 FROM suspicion_flags WHERE contributor_id=$1 AND kind='rapid_submission'`, [fId])));
    const fDay = await dbOne(`SELECT substantive_count FROM contribution_days WHERE contributor_id=$1 AND day=now()::date`, [fId]);
    check('spam vote does not count as substantive (streak day)', !fDay || Number(fDay.substantive_count) === 0, fDay);
    const fMe = await F.get('/api/leaderboard/me');
    check('spam does not extend streak', fMe.data.streak === 0, fMe.data.streak);

    const { c: G } = await register('g');
    const gId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-g@example.com'`)).id;
    for (let i = 0; i < 10; i++) {
      await pool.query(
        `INSERT INTO validation_votes (task_id, task_version, contributor_id, value, created_at)
         VALUES ($1,1,$2,'correct', now() - interval '10 seconds')`, [`test-val:b${i}`, gId]);
    }
    const burst = await G.post('/api/validation/tasks/test-val:b10/vote', { value: 'correct' });
    check('burst (>10 votes/5min) flagged as anomalous', burst.status === 200 && burst.data.flagged_spam === true, burst.data);

    // ── Consensus ────────────────────────────────────────────
    group('consensus calculation & point confirmation');
    const av1 = await A.post('/api/validation/tasks/test-val:t1/vote', { value: 'correct' });
    check('vote response reveals distribution after submit', Array.isArray(av1.data.distribution), av1.data);
    check('vote response includes reliability band', typeof av1.data.reliabilityBand === 'string');
    await B.post('/api/validation/tasks/test-val:t1/vote', { value: 'correct' });
    const cv1 = await C.post('/api/validation/tasks/test-val:t1/vote', { value: 'correct' });
    check('3 agreeing votes → community_consensus', cv1.data.taskStatus === 'community_consensus', cv1.data);
    const t1Row = await dbOne(`SELECT status, consensus_value, consensus_confidence FROM validation_tasks WHERE id='test-val:t1'`);
    check('status persisted as community_consensus', t1Row.status === 'community_consensus', t1Row);
    check('community consensus ≠ expert verification', t1Row.status !== 'expert_verified');
    check('consensus value + confidence recorded', t1Row.consensus_value === 'correct' && Number(t1Row.consensus_confidence) >= 0.67, t1Row);
    const aProfile = await A.get('/api/profile');
    check('agreeing voter provisional points confirmed', aProfile.data.stats.confirmedPoints >= 3, aProfile.data.stats);
    check('duplicate vote → 409', (await A.post('/api/validation/tasks/test-val:t1/vote', { value: 'correct' })).status === 409);
    check('result after voting → 200', (await A.get('/api/validation/tasks/test-val:t1/result')).status === 200);

    // ── Dispute & adjudication ───────────────────────────────
    group('dispute routing & adjudication');
    await sleep(300); await A.post('/api/validation/tasks/test-val:t2/vote', { value: 'moon' });
    await sleep(300); await B.post('/api/validation/tasks/test-val:t2/vote', { value: 'month' });
    await sleep(300);
    const cv2 = await C.post('/api/validation/tasks/test-val:t2/vote', { value: 'moon' });
    check('split votes (2/3 vs 1/3) → disputed', cv2.data.taskStatus === 'disputed', cv2.data);

    const adjT = await T.post('/api/validation/tasks/test-val:t2/adjudicate', { decision: 'moon', note: 'context is night sky' });
    check('trusted validator adjudication → 200', adjT.status === 200, adjT.data);
    check('trusted adjudication yields community_consensus, NOT expert_verified', adjT.data.status === 'community_consensus', adjT.data);
    const adjC = await C.post('/api/validation/tasks/test-val:t2/adjudicate', { decision: 'moon', note: 'confirmed by expert' });
    check('verified expert adjudication → expert_verified', adjC.status === 200 && adjC.data.status === 'expert_verified', adjC.data);
    check('adjudication row recorded', !!(await dbOne(
      `SELECT 1 FROM adjudications WHERE task_id='test-val:t2' AND adjudicator_role='verified_expert'`)));
    const aId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-a@example.com'`)).id;
    check('disputed-resolution bonus to matching voter', !!(await dbOne(
      `SELECT 1 FROM points_ledger WHERE contributor_id=$1 AND task_id='test-val:t2' AND kind='disputed_resolution' AND status='confirmed' AND points=4`, [aId])));
    const bId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-b@example.com'`)).id;
    check('overturned voter records reversal', !!(await dbOne(
      `SELECT 1 FROM reliability_events WHERE contributor_id=$1 AND kind='reversal'`, [bId])));
    const adjAnon = await anon.post('/api/validation/tasks/test-val:t2/adjudicate', { decision: 'moon' });
    check('anonymous adjudication → 401', adjAnon.status === 401);
    const adjA = await A.post('/api/validation/tasks/test-val:t2/adjudicate', { decision: 'moon' });
    check('plain contributor adjudication → 403', adjA.status === 403);

    // ── Gold-standard tasks ──────────────────────────────────
    group('gold-standard tasks & reliability');
    const { c: D } = await register('d');
    const goldHit = await D.post('/api/validation/tasks/test-val:gold1/vote', { value: 'correct' });
    check('gold correct → gold.correct true', goldHit.data.gold?.correct === true, goldHit.data);
    const dProfile = await D.get('/api/profile');
    check('gold correct confirms points + bonus (≥5)', dProfile.data.stats.confirmedPoints >= 5, dProfile.data.stats);
    const { c: E } = await register('e');
    const goldMiss = await E.post('/api/validation/tasks/test-val:gold2/vote', { value: 'clean' });
    check('gold wrong → gold.correct false', goldMiss.data.gold?.correct === false, goldMiss.data);
    const eProfile = await E.get('/api/profile');
    check('gold wrong revokes provisional (0 confirmed)', eProfile.data.stats.confirmedPoints === 0, eProfile.data.stats);
    const eId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-e@example.com'`)).id;
    check('gold_miss reliability event recorded', !!(await dbOne(
      `SELECT 1 FROM reliability_events WHERE contributor_id=$1 AND kind='gold_miss'`, [eId])));

    // ── Daily cap & diminishing returns ──────────────────────
    group('daily cap & diminishing returns');
    const { c: H } = await register('h');
    const hId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-h@example.com'`)).id;
    await pool.query(
      `INSERT INTO points_ledger (contributor_id, kind, points, status, reason) VALUES ($1,'validation',100,'confirmed','test cap')`, [hId]);
    const capped = await H.post('/api/validation/tasks/test-val:cap1/vote', { value: 'correct' });
    check('daily cap reached → no new provisional points', capped.data.points?.provisional === 0, capped.data);

    const { c: I } = await register('i');
    let lastVote;
    for (let i = 1; i <= 4; i++) {
      if (i > 1) await sleep(300);
      lastVote = await I.post(`/api/validation/tasks/test-val:d${i}/vote`, { value: 'correct' });
    }
    check('diminishing returns: 4th validation today yields reduced points', lastVote.data.points?.provisional === 1, lastVote.data);
    const quests = await I.get('/api/quests');
    check('daily quest assigned with target and label',
      quests.status === 200 && quests.data.quests.some(q => q.scope === 'daily' && q.target > 0 && q.label), quests.data);

    // ── Leaderboard & privacy ────────────────────────────────
    group('leaderboard, opt-in, privacy');
    const { c: J } = await register('j');
    const jId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-j@example.com'`)).id;
    await pool.query(`INSERT INTO points_ledger (contributor_id, kind, points, status) VALUES ($1,'validation',50,'confirmed')`, [jId]);
    const { c: K } = await register('k');
    const kId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-k@example.com'`)).id;
    await pool.query(`INSERT INTO points_ledger (contributor_id, kind, points, status) VALUES ($1,'validation',50,'confirmed')`, [kId]);
    await K.patch('/api/profile', { leaderboard_opt_in: true });

    const lb = await anon.get('/api/leaderboard?period=all');
    const names = (lb.data.entries || []).map(e => e.display_name);
    check('opt-in contributor appears on leaderboard', names.includes('Test k'), names);
    check('opt-out contributor absent from leaderboard', !names.includes('Test j'), names);
    check('leaderboard exposes no email field', (lb.data.entries || []).every(e => !('email' in e) && !('affiliation' in e)));
    check('leaderboard shows quality fields',
      (lb.data.entries || []).every(e => 'reliability_band' in e && 'streak' in e && 'verified_validations' in e && 'role' in e));
    check('weekly period works', (await anon.get('/api/leaderboard?period=week')).status === 200);

    const me = await K.get('/api/leaderboard/me');
    check('personal view has rank, percentile, neighbors',
      typeof me.data.rank === 'number' && typeof me.data.percentile === 'number' && Array.isArray(me.data.neighbors), me.data);
    check('personal view has transparent reliability explanation',
      !!me.data.reliability_explanation?.basis && typeof me.data.reliability_explanation?.score === 'number');

    // ── Achievements ─────────────────────────────────────────
    group('achievements');
    const { c: L } = await register('l');
    const lId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-l@example.com'`)).id;
    for (let i = 0; i < 10; i++) {
      await pool.query(`INSERT INTO points_ledger (contributor_id, kind, points, status) VALUES ($1,'validation',3,'confirmed')`, [lId]);
    }
    const lMe = await L.get('/api/leaderboard/me');
    check('ten confirmed validations → achievement awarded',
      (lMe.data.achievements || []).some(a => a.key === 'ten_quality_validations'), lMe.data.achievements);

    // ── Privacy: public profile ──────────────────────────────
    group('privacy & public profile');
    check('private profile → 404', (await anon.get(`/api/contributors/${lId}`)).status === 404);
    await L.patch('/api/profile', { public_profile: true, affiliation: 'Test Institute' });
    const pub = await anon.get(`/api/contributors/${lId}`);
    check('public profile → 200 after opt-in', pub.status === 200);
    check('public profile never exposes email', pub.status === 200 && !('email' in (pub.data.profile || {})), pub.data);
    check('public profile shows display name + band',
      pub.data.profile?.display_name === 'Test l' && typeof pub.data.profile?.reliabilityBand === 'string');

    // ── Admin: invalidate points, appeals, tasks ─────────────
    group('admin: point invalidation, appeals, task creation');
    const { c: M } = await register('m');
    const mId = (await dbOne(`SELECT id FROM contributors WHERE email='test-val-m@example.com'`)).id;
    await pool.query(`INSERT INTO points_ledger (contributor_id, kind, points, status) VALUES ($1,'validation',3,'provisional'),($1,'validation',3,'provisional')`, [mId]);
    const inv = await admin.post('/api/admin/points/invalidate', {
      contributor_id: mId, reason: 'test-val: abusive pattern', all_provisional: true });
    check('admin invalidate → revoked count 2', inv.status === 200 && inv.data.revoked === 2, inv.data);
    const mRows = await dbOne(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status='revoked') AS r FROM points_ledger WHERE contributor_id=$1`, [mId]);
    check('revoked points are NOT deleted (audit preserved)', Number(mRows.n) === 2 && Number(mRows.r) === 2, mRows);
    check('invalidation written to audit trail', !!(await dbOne(
      `SELECT 1 FROM audit_events WHERE event_type='points_invalidate' AND target_id=$1`, [mId])));
    check('contributor cannot invalidate points → 403',
      (await A.post('/api/admin/points/invalidate', { contributor_id: mId, reason: 'x', all_provisional: true })).status === 403);

    const appeal = await M.post('/api/appeals', { target_type: 'points', reason: 'test-val: please reconsider my points' });
    check('appeal created', appeal.status === 200 && !!appeal.data.appeal, appeal.data);
    const appealList = await admin.get('/api/admin/appeals');
    check('admin sees open appeal', (appealList.data.appeals || []).some(a => a.reason.includes('reconsider')), appealList.data);
    const resolve = await admin.post(`/api/admin/appeals/${appeal.data.appeal.id}/resolve`, { resolution: 'test-val: reviewed, points stay revoked' });
    check('appeal resolved', resolve.status === 200, resolve.data);
    check('appeal status persisted', (await dbOne(`SELECT status FROM appeals WHERE id=$1`, [appeal.data.appeal.id])).status === 'resolved');

    const mkTask = await admin.post('/api/admin/tasks', {
      id: 'test-val:admin1', kind: 'spelling', is_gold: true, gold_answer: 'correct', options: ['correct', 'incorrect'] });
    check('admin creates gold task → 200', mkTask.status === 200, mkTask.data);
    check('duplicate task id → 409', (await admin.post('/api/admin/tasks', {
      id: 'test-val:admin1', kind: 'spelling', is_gold: true, gold_answer: 'correct' })).status === 409);
    check('gold task without answer → 400', (await admin.post('/api/admin/tasks', {
      kind: 'spelling', is_gold: true })).status === 400);

    // ── Audit trail ──────────────────────────────────────────
    group('audit trail');
    const auditRes = await C.get('/api/audit?target_type=validation_task&target_id=test-val:t2');
    const events = (auditRes.data.events || []).map(e => e.event_type);
    check('audit contains vote, status_change, adjudication',
      ['vote', 'status_change', 'adjudication'].every(x => events.includes(x)), events);
    const sc = (auditRes.data.events || []).find(e => e.event_type === 'status_change');
    check('status change records task version', sc && sc.payload && typeof sc.payload.task_version === 'number', sc);
    check('audit events carry timestamps and actors',
      (auditRes.data.events || []).every(e => e.created_at && e.actor_type), auditRes.data.events?.[0]);
    check('contributor cannot read audit → 403', (await A.get('/api/audit?target_type=validation_task&target_id=test-val:t2')).status === 403);

    // ── Reviewer safeguard on canonical reviews ──────────────
    group('canonical review safeguard (preserved)');
    check('anonymous approve still → 403',
      (await anon.post('/api/reviews', { record_id: 'test-val:rec1', state: 'approved' })).status === 403);
    check('anonymous flag still allowed',
      (await anon.post('/api/reviews', { record_id: 'test-val:rec1', state: 'flagged', note: 'test' })).status === 200);
    await pool.query(`DELETE FROM reviews WHERE record_id = 'test-val:rec1'`);
    check('reviewer approve still works',
      (await admin.post('/api/reviews', { record_id: 'test-val:rec2', state: 'approved' })).status === 200);
    check('plain contributor approve still → 403',
      (await A.post('/api/reviews', { record_id: 'test-val:rec3', state: 'approved' })).status === 403);
    const expertApprove = await C.post('/api/reviews', { record_id: 'test-val:rec4', state: 'approved' });
    check('verified expert CAN approve canonical record', expertApprove.status === 200, expertApprove.data);
    await pool.query(`DELETE FROM reviews WHERE record_id IN ('test-val:rec2','test-val:rec3','test-val:rec4')`);

    // ── Pages & mobile basics ────────────────────────────────
    group('pages, navigation, mobile');
    const val = await anon.get('/validate.html');
    check('validate page serves + viewport meta', val.status === 200 && val.data._raw.includes('width=device-width'));
    check('validate page links leaderboard', val.data._raw.includes('leaderboard.html'));
    const lbPage = await anon.get('/leaderboard.html');
    check('leaderboard page serves + viewport meta', lbPage.status === 200 && lbPage.data._raw.includes('width=device-width'));
    check('how-it-works page explains consensus', (await anon.get('/how-it-works.html')).data._raw.includes('consensus'));
    check('register page serves', (await anon.get('/register.html')).status === 200);
    check('dashboard page serves', (await anon.get('/dashboard.html')).status === 200);
    const css = await anon.get('/css/app.css?v=1');
    check('mobile card layout rules served', css.data._raw.includes('max-width: 600px') && css.data._raw.includes('.val-option'));

  } finally {
    child.kill('SIGTERM');
  }

  console.log('\nCleaning up test artifacts…');
  await cleanup();
  await pool.end();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('FATAL:', err.message);
  try { await cleanup(); await pool.end(); } catch {}
  process.exit(1);
});
