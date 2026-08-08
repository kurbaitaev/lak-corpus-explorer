'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCorpusV2Bootstrap, flagOn } = require('../lib/corpus-v2-bootstrap');

// Flag semantics mirror CORPUS_V2_ENABLED exactly.
assert(flagOn('true') && flagOn('1') && flagOn('YES'));
assert(!flagOn('') && !flagOn(undefined) && !flagOn('0') && !flagOn('off'));

function recorder(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      env: {},
      migrateFiles: async () => { calls.push('migrate'); },
      importBundle: async (bundle, options) => { calls.push(`import:${JSON.stringify(options)}`); return { batchId: 'b1', idempotent: true }; },
      reconcile: async () => { calls.push('reconcile'); },
      pool: {
        connect: async () => ({ release: () => calls.push('release') }),
        end: () => calls.push('POOL_END'),
      },
      ...overrides,
    },
  };
}

async function main() {
  // Default off: nothing runs.
  {
    const r = recorder();
    const out = await createCorpusV2Bootstrap(r.deps)();
    assert.strictEqual(out.ran, false);
    assert.deepStrictEqual(r.calls, [], 'no step may run without the opt-in flags');
  }

  // Opt-in gating: each flag alone is not enough.
  for (const env of [{ CORPUS_V2_AUTO_IMPORT: 'true' }, { CORPUS_V2_ENABLED: 'true' }]) {
    const r = recorder();
    r.deps.env = env;
    const out = await createCorpusV2Bootstrap(r.deps)();
    assert.strictEqual(out.ran, false, JSON.stringify(env));
    assert.deepStrictEqual(r.calls, [], `steps ran with only one flag: ${JSON.stringify(env)}`);
  }

  // Both flags: migrate → import (internal migrate disabled) → reconcile, in
  // order, client released, and the shared pool is never ended.
  {
    const r = recorder();
    r.deps.env = { CORPUS_V2_AUTO_IMPORT: 'true', CORPUS_V2_ENABLED: 'true' };
    const out = await createCorpusV2Bootstrap(r.deps)();
    assert.deepStrictEqual(r.calls, ['migrate', 'import:{"migrate":false}', 'reconcile', 'release']);
    assert.strictEqual(out.ran, true);
    assert(!r.calls.includes('POOL_END'), 'server must never end the shared pool');
  }

  // Failure prevents listen: an import failure or a reconciliation mismatch
  // rejects, so the server exits without listening.
  for (const [step, overrides, pattern] of [
    ['import', { importBundle: async () => { throw new Error('bundle hash mismatch'); } }, /bundle hash mismatch/],
    ['reconcile', { reconcile: async () => { throw new Error('count mismatch'); } }, /count mismatch/],
    ['migrate', { migrateFiles: async () => { throw new Error('ddl failed'); } }, /ddl failed/],
  ]) {
    const r = recorder(overrides);
    r.deps.env = { CORPUS_V2_AUTO_IMPORT: 'true', CORPUS_V2_ENABLED: 'true' };
    await assert.rejects(createCorpusV2Bootstrap(r.deps)(), pattern, `${step} failure must reject`);
  }

  // Idempotent success against the real migrated + imported development
  // database: a boot with both flags set completes and reports the batch was
  // already imported.
  const run = spawnSync(process.execPath, ['-e',
    "require('./lib/corpus-v2-bootstrap').runCorpusV2Bootstrap()" +
    ".then(r => { console.log(JSON.stringify(r)); process.exit(r.ran && r.idempotent ? 0 : 2); })" +
    ".catch(e => { console.error(e.message); process.exit(1); })"],
    {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, CORPUS_V2_ENABLED: 'true', CORPUS_V2_AUTO_IMPORT: 'true' },
      encoding: 'utf8',
    });
  if (run.status !== 0) {
    throw new Error(`idempotent boot check failed (status ${run.status}): ${run.stdout}${run.stderr}`);
  }

  console.log('corpus v2 autostart: default-off, opt-in gating, fail-closed, ordering, and idempotent boot checks passed');
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
