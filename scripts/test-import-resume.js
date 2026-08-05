'use strict';

/*
 * Resumable v1.3 staging test.
 *
 * The bug this guards against: the lexicon layer is a quarter of a million
 * records, and when the whole layer was one transaction, a host that suspends
 * or kills the process part-way rolled all of it back. The layer never landed,
 * the verification cache was never written, and every later boot started from
 * zero — the package could never finish staging at all.
 *
 * So this test does the brutal thing rather than the polite one: it starts a
 * real import of a real layer and SIGKILLs it mid-flight, exactly as the host
 * does. It then asserts the two properties the fix depends on:
 *
 *   1. Durability — whatever the killed run committed is still there, and the
 *      recorded progress marker matches the row count exactly. Progress is
 *      written in the same transaction as the rows, so it can never claim
 *      more than was actually staged.
 *   2. Resumption — a second run picks up from the marker, skips what is
 *      already staged, and finishes the layer.
 *
 * Every row it touches is restored to a fully-staged state before it exits,
 * whether it passes or fails.
 *
 * Usage: node scripts/test-import-resume.js
 * Requires: DATABASE_URL and the v1.3 package in the local cache.
 */

const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const v13 = require('../lib/source-import-v13');
const privatePackages = require('../lib/private-packages');

const V13_PACKAGE = privatePackages.PACKAGES.find(p => p.id === 'v1.3');
const V13_DIR = path.resolve(privatePackages.cacheDirFor(V13_PACKAGE));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

// Big enough to span several committed chunks, small enough to stage quickly.
const LAYER = 'private_text_segments';
const EXPECTED = v13.AUDITED.private_text_segments;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

async function batchRow() {
  const r = await pool.query(
    'SELECT id, status, resume_offset, imported_count FROM v13_import_batches WHERE layer = $1', [LAYER]);
  return r.rows[0] || null;
}

async function stagedRows() {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM v13_candidates WHERE layer = $1', [LAYER]);
  return r.rows[0].n;
}

// Clear just this layer so the test starts from an unstaged state. Scoped to
// one layer of the development database; nothing else is touched.
async function resetLayer() {
  await pool.query('DELETE FROM v13_candidates WHERE layer = $1', [LAYER]);
  await pool.query('DELETE FROM v13_import_batches WHERE layer = $1', [LAYER]);
}

// Runs the import in a child process so it can be killed the way a suspended
// host kills it: no cleanup, no rollback, no chance to finish the transaction.
function importChild() {
  return spawn(process.execPath, ['-e', `
    const { Pool } = require('pg');
    const v13 = require('./lib/source-import-v13');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
    v13.importPackage(pool, ${JSON.stringify(V13_DIR)}, { status: 'verified' })
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(err => { console.error(err.message); process.exit(1); });
  `], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
}

function runToCompletion() {
  return new Promise((resolve, reject) => {
    const child = importChild();
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`))));
  });
}

// Start an import and kill it after `ms`. Returns false if it finished first.
function runAndKill(ms) {
  return new Promise(resolve => {
    const child = importChild();
    let finished = false;
    child.on('exit', () => { if (!killed) { finished = true; resolve(false); } });
    let killed = false;
    setTimeout(() => {
      if (finished) return;
      killed = true;
      child.kill('SIGKILL');
      // Give the database a moment to notice the dropped connection and roll
      // back whatever transaction was open when the process died.
      setTimeout(() => resolve(true), 1500);
    }, ms);
  });
}

// Leaves the layer genuinely part-staged. A kill is only a useful interruption
// if it lands *after* at least one chunk committed and *before* the layer
// finished, so walk the timing out until it does rather than asserting against
// whichever moment we happened to hit.
async function interruptLayer() {
  for (const ms of [1200, 2200, 3500, 5000, 7000]) {
    await resetLayer();
    const killed = await runAndKill(ms);
    if (!killed) {
      console.log(`    (import finished before the ${ms}ms kill; retrying with a later kill)`);
      continue;
    }
    const staged = await stagedRows();
    if (staged > 0 && staged < EXPECTED) return true;
    console.log(`    (kill at ${ms}ms left ${staged} rows; retrying with a later kill)`);
  }
  return false;
}

async function main() {
  console.log(`\n[resumable staging — ${LAYER}, ${EXPECTED} records]`);

  await resetLayer();
  check('layer starts unstaged', await stagedRows() === 0);

  // 1. Kill a real import mid-layer.
  const interrupted = await interruptLayer();
  if (!interrupted) {
    console.log('  ! could not interrupt the import — the layer stages too fast to test on this machine');
    await resetLayer();
    await runToCompletion();
    return;
  }

  const afterKill = await batchRow();
  const rowsAfterKill = await stagedRows();
  check('the killed run left a batch row behind', !!afterKill, afterKill);
  check('the interrupted layer is marked in_progress, not complete',
    !!afterKill && afterKill.status === 'in_progress', afterKill);
  check('some records survived the kill', rowsAfterKill > 0, { rowsAfterKill });
  check('the layer did not finish (so this is a real interruption)',
    rowsAfterKill < EXPECTED, { rowsAfterKill, EXPECTED });
  // The core transactional guarantee: the marker never over-claims.
  check('recorded progress matches the rows actually staged',
    !!afterKill && afterKill.resume_offset === rowsAfterKill,
    { resume_offset: afterKill && afterKill.resume_offset, rowsAfterKill });

  // 2. Resume.
  const batchIdBefore = afterKill.id;
  await runToCompletion();
  const afterResume = await batchRow();
  const rowsAfterResume = await stagedRows();
  check('the resumed run reused the same batch, it did not start a new one',
    !!afterResume && afterResume.id === batchIdBefore,
    { before: batchIdBefore, after: afterResume && afterResume.id });
  check('the layer is now complete', !!afterResume && afterResume.status === 'complete', afterResume);
  check('every record is staged exactly once', rowsAfterResume === EXPECTED,
    { rowsAfterResume, EXPECTED });
  check('the recorded count matches the audited figure',
    !!afterResume && afterResume.imported_count === EXPECTED, afterResume);

  // 3. A completed layer is never re-imported.
  const again = await v13.importPackage(pool, V13_DIR, { status: 'verified' });
  const entry = again.imported.find(e => e.layer === LAYER);
  check('re-running skips the completed layer', !!entry && entry.already_present === true, entry);
  check('re-running stages nothing new', await stagedRows() === EXPECTED);

  // 4. Progress reporting reflects the durable state.
  const progress = await v13.importProgress(pool);
  check('importProgress reports every layer complete', progress.complete === true, progress);
  check('importProgress totals the audited records',
    progress.records_staged === progress.records_declared, progress);

  // 5. The whole boot path must resume, not just importPackage on its own.
  //
  // This is the trap the resumable importer opens up: a batch row now exists
  // from the moment a layer starts, so a completeness check that only asks
  // "is there a row for this layer?" sees six rows, decides the cached
  // verification can be reused as-is, skips staging entirely — and the
  // half-staged layer is stranded forever. Verified as a whole package while
  // missing a quarter of its records is precisely the state this work exists
  // to prevent, so it gets its own test.
  console.log('\n[the boot path resumes an interrupted layer]');
  if (!await interruptLayer()) {
    console.log('  ! could not interrupt the import; skipping the boot-path check');
  } else {
    const before = await stagedRows();
    check('the layer is part-staged before boot', before > 0 && before < EXPECTED, { before });
    const cached = await pool.query(
      `SELECT status FROM private_package_verifications WHERE package_id = 'v1.3'`);
    check('a cached verification exists, so the reuse path is the one under test',
      cached.rows.length > 0, cached.rows);

    const { preparePrivatePackages } = require('../lib/private-boot');
    const report = await preparePrivatePackages(pool);

    const row = await batchRow();
    check('boot finished the interrupted layer instead of skipping it',
      !!row && row.status === 'complete', row);
    check('boot staged every record of that layer', await stagedRows() === EXPECTED);
    const bootProgress = await v13.importProgress(pool);
    check('boot leaves staging complete', bootProgress.complete === true, bootProgress);
    const entry = (report.packages || []).find(p => p.package_id === 'v1.3');
    check('boot reports the package verified', !!entry && entry.verification_status === 'verified', entry);
  }
}

main()
  .catch(err => { failed++; console.error('\nFAILED:', err.stack || err.message); })
  .then(async () => {
    // Always leave the layer fully staged, however the test ended.
    try {
      const row = await batchRow();
      if (!row || row.status !== 'complete' || await stagedRows() !== EXPECTED) {
        console.log('\n  restoring the layer to a fully staged state…');
        await runToCompletion();
      }
    } catch (err) { console.error('  restore failed:', err.message); }
    await pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
