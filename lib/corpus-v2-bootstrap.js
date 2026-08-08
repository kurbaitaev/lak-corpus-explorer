'use strict';

// Fail-closed corpus v2 deployment bootstrap.
//
// When — and only when — BOTH CORPUS_V2_AUTO_IMPORT and CORPUS_V2_ENABLED are
// set to exactly "true", the server runs the versioned migration, the
// checksummed PCMLBE import (with its internal migrate step disabled), and
// the exact database reconciliation BEFORE listening. The caller passes the
// server's legacy startup-migration promise as `before` so no DDL runs
// concurrently with the versioned migration and import. Any failure rejects;
// server.js then exits without listening so the platform keeps the previous
// healthy deployment serving. With the flag off this resolves immediately
// and start-up is unchanged. The shared pool is never ended here.

function strictTrue(value) {
  // Deliberately stricter than the route gate's truthy parsing: this
  // deployment bootstrap may only be armed by the exact string "true".
  return value === 'true';
}

function createCorpusV2Bootstrap({ env = process.env, migrateFiles, importBundle, reconcile, pool } = {}) {
  return async function bootstrap({ before } = {}) {
    if (!strictTrue(env.CORPUS_V2_AUTO_IMPORT)) return { ran: false, reason: 'CORPUS_V2_AUTO_IMPORT is not exactly "true"' };
    if (!strictTrue(env.CORPUS_V2_ENABLED)) return { ran: false, reason: 'CORPUS_V2_ENABLED is not exactly "true"' };
    // Serialize with the legacy startup migration: it must have finished
    // before the versioned migration and import begin.
    if (before) await before;
    await migrateFiles();
    const imported = await importBundle(undefined, { migrate: false });
    const client = await pool.connect();
    try {
      await reconcile(client);
    } finally {
      client.release();
    }
    return { ran: true, batchId: imported.batchId, idempotent: imported.idempotent === true };
  };
}

function defaultDeps() {
  const { migrateFiles } = require('../scripts/migrate');
  const { importBundle, reconcileInTransaction } = require('../scripts/import-pcmlbe-v14');
  const { EXPECTED } = require('../scripts/reconcile-corpus-v2');
  const { pool } = require('./db');
  return {
    migrateFiles,
    importBundle,
    reconcile: client => reconcileInTransaction(client, EXPECTED),
    pool,
  };
}

// Lazy: with the opt-in flag off, none of the importer machinery is loaded.
async function runCorpusV2Bootstrap(options = {}) {
  if (!strictTrue(process.env.CORPUS_V2_AUTO_IMPORT)) return { ran: false, reason: 'CORPUS_V2_AUTO_IMPORT is not exactly "true"' };
  if (!strictTrue(process.env.CORPUS_V2_ENABLED)) return { ran: false, reason: 'CORPUS_V2_ENABLED is not exactly "true"' };
  return createCorpusV2Bootstrap({ env: process.env, ...defaultDeps() })(options);
}

module.exports = { createCorpusV2Bootstrap, runCorpusV2Bootstrap, strictTrue };
