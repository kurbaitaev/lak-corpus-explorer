'use strict';

const assert = require('assert');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createCorpusV2Bootstrap, strictTrue } = require('../lib/corpus-v2-bootstrap');

const root = path.join(__dirname, '..');
const BOTH_TRUE = { CORPUS_V2_AUTO_IMPORT: 'true', CORPUS_V2_ENABLED: 'true' };

// Opt-in is the exact string "true" — deliberately stricter than the route
// gate's truthy parsing.
assert(strictTrue('true'));
for (const value of ['', undefined, '0', 'off', '1', 'yes', 'YES', 'True', ' true']) {
  assert(!strictTrue(value), `unexpected opt-in for ${JSON.stringify(value)}`);
}

function recorder(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      env: {},
      migrateFiles: async () => { calls.push('migrate'); },
      importLexiconBundle: async (bundle, options) => { calls.push(`lexicon:${JSON.stringify(options)}`); return { batchId: 'lex1', idempotent: true }; },
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

// Spawn server.js and resolve with { code, output } once it exits, or once
// `listenFor` appears in its output (then kill it). Rejects on timeout.
function bootServer(env, listenFor, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server boot timed out; output:\n${output.slice(-2000)}`)); }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (listenFor && output.includes(listenFor)) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve({ code: null, output });
      }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function main() {
  // Default off: nothing runs.
  {
    const r = recorder();
    const out = await createCorpusV2Bootstrap(r.deps)();
    assert.strictEqual(out.ran, false);
    assert.deepStrictEqual(r.calls, [], 'no step may run without the opt-in flags');
  }

  // Feature gating: auto-import alone does nothing. Enabling corpus v2 always
  // applies additive migrations, but non-exact values do not arm anything.
  for (const env of [
    { CORPUS_V2_AUTO_IMPORT: 'true' },
    { CORPUS_V2_AUTO_IMPORT: 'yes', CORPUS_V2_ENABLED: 'yes' },
  ]) {
    const r = recorder();
    r.deps.env = env;
    const out = await createCorpusV2Bootstrap(r.deps)();
    assert.strictEqual(out.ran, false, JSON.stringify(env));
    assert.deepStrictEqual(r.calls, [], `steps ran without both exact flags: ${JSON.stringify(env)}`);
  }

  // Enabled without PCMLBE auto-import: migrate and reconcile the public
  // source-backed lexicon, but do not rerun the PCMLBE importer.
  {
    const r = recorder();
    r.deps.env = { CORPUS_V2_ENABLED: 'true' };
    const out = await createCorpusV2Bootstrap(r.deps)();
    assert.deepStrictEqual(r.calls, ['migrate','lexicon:{"migrate":false}']);
    assert.strictEqual(out.ran, true);
    assert.strictEqual(out.migrated, true);
  }

  {
    const r = recorder();
    r.deps.env = { CORPUS_V2_AUTO_IMPORT: '1', CORPUS_V2_ENABLED: 'true' };
    const out = await createCorpusV2Bootstrap(r.deps)();
    assert.deepStrictEqual(r.calls, ['migrate','lexicon:{"migrate":false}']);
    assert.strictEqual(out.migrated, true);
  }

  // Both flags: the legacy startup migration (`before`) finishes first, then
  // migrate → import (internal migrate disabled) → reconcile, in order,
  // client released, and the shared pool is never ended.
  {
    let startupMigrationDone = false;
    const before = new Promise(resolve => setTimeout(() => { startupMigrationDone = true; resolve(); }, 25));
    const r = recorder({
      migrateFiles: async () => {
        assert(startupMigrationDone, 'versioned migration ran before the legacy startup migration finished');
        r.calls.push('migrate');
      },
    });
    r.deps.env = BOTH_TRUE;
    const out = await createCorpusV2Bootstrap(r.deps)({ before });
    assert.deepStrictEqual(r.calls, ['migrate','lexicon:{"migrate":false}', 'import:{"migrate":false}', 'reconcile', 'release']);
    assert.strictEqual(out.ran, true);
    assert(!r.calls.includes('POOL_END'), 'server must never end the shared pool');
  }

  // A rejected startup migration, migration, import, or reconciliation rejects
  // the bootstrap. The server exposes no corpus-v2 data until this resolves.
  for (const [step, overrides, options, pattern] of [
    ['startup migration', {}, { before: Promise.reject(new Error('legacy ddl failed')) }, /legacy ddl failed/],
    ['migration', { migrateFiles: async () => { throw new Error('ddl failed'); } }, {}, /ddl failed/],
    ['lexicon', { importLexiconBundle: async () => { throw new Error('lexicon mismatch'); } }, {}, /lexicon mismatch/],
    ['import', { importBundle: async () => { throw new Error('bundle hash mismatch'); } }, {}, /bundle hash mismatch/],
    ['reconcile', { reconcile: async () => { throw new Error('count mismatch'); } }, {}, /count mismatch/],
  ]) {
    const r = recorder(overrides);
    r.deps.env = BOTH_TRUE;
    await assert.rejects(createCorpusV2Bootstrap(r.deps)(options), pattern, `${step} failure must reject`);
  }

  // Integration, failure path: server.js opens its health-check port promptly,
  // but an unreachable database still makes it exit non-zero.
  {
    const badDb = 'postgres://127.0.0.1:1/corpus_v2_unreachable';
    const { code, output } = await bootServer({ PORT: '5191', ...BOTH_TRUE, DATABASE_URL: badDb }, null, 90000);
    assert.notStrictEqual(code, 0, `server must exit non-zero on bootstrap failure (got ${code})`);
    assert(output.includes('stopping server'), `expected fail-closed log, got:\n${output.slice(-1500)}`);
    assert(output.includes('running on port 5191'), 'server did not open its health-check port before bootstrap');
  }

  // Integration, success path: with both flags against the already-imported
  // development database, the server listens first and the bootstrap then
  // reconciles idempotently before corpus-v2 routes become ready.
  if (process.env.DATABASE_URL) {
    const { output } = await bootServer({ PORT: '5192', ...BOTH_TRUE }, 'Corpus v2 bootstrap: batch');
    const bootstrapAt = output.indexOf('Corpus v2 bootstrap: batch');
    const listenAt = output.indexOf('running on port 5192');
    assert(bootstrapAt !== -1, `bootstrap did not run; output:\n${output.slice(-1500)}`);
    assert(output.includes('idempotent'), 'second boot must report the batch already imported');
    assert(listenAt < bootstrapAt, 'server health-check port waited for the bulk import');
  } else {
    console.log('corpus v2 autostart: live database success path skipped (DATABASE_URL is not configured)');
  }

  console.log('corpus v2 autostart: default-off, prompt health-check listener, exact import gating, fail-closed data readiness, and idempotent import checks passed');
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
