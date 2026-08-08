'use strict';

// Fail-closed corpus v2 deployment bootstrap.
//
// When — and only when — BOTH CORPUS_V2_AUTO_IMPORT and CORPUS_V2_ENABLED are
// explicitly true, the server runs the versioned migration, the checksummed
// PCMLBE import (with its internal migrate step disabled), and the exact
// database reconciliation BEFORE listening. Any failure rejects; server.js
// then exits without listening so the platform keeps the previous healthy
// deployment serving. With the flag off this resolves immediately and
// start-up is byte-for-byte unchanged. The shared pool is never ended here.

function flagOn(value) {
  return /^(1|true|yes)$/i.test(value || '');
}

function createCorpusV2Bootstrap({ env = process.env, migrateFiles, importBundle, reconcile, pool } = {}) {
  return async function bootstrap() {
    if (!flagOn(env.CORPUS_V2_AUTO_IMPORT)) return { ran: false, reason: 'CORPUS_V2_AUTO_IMPORT not set' };
    if (!flagOn(env.CORPUS_V2_ENABLED)) return { ran: false, reason: 'CORPUS_V2_ENABLED not set' };
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
async function runCorpusV2Bootstrap() {
  if (!flagOn(process.env.CORPUS_V2_AUTO_IMPORT)) return { ran: false, reason: 'CORPUS_V2_AUTO_IMPORT not set' };
  if (!flagOn(process.env.CORPUS_V2_ENABLED)) return { ran: false, reason: 'CORPUS_V2_ENABLED not set' };
  return createCorpusV2Bootstrap({ env: process.env, ...defaultDeps() })();
}

module.exports = { createCorpusV2Bootstrap, runCorpusV2Bootstrap, flagOn };
