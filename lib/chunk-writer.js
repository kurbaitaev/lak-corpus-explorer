'use strict';

// Chunked, resumable bulk writing.
//
// A host that suspends the process between requests cannot run a
// quarter-of-a-million-row import as one all-or-nothing transaction: the
// transaction is rolled back on every interruption and the work never lands.
// The answer is always the same shape — write rows in batches, COMMIT often,
// and record how far you got *in the same transaction as the rows that
// progress describes*, so a boot that dies mid-chunk can never leave an offset
// claiming more than was actually staged.
//
// That shape is used by both the private v1.3 staging import and the public
// projection derivation, so it lives here once rather than being copied.
//
// The writer knows nothing about which table it is filling or where progress
// is recorded: the caller supplies the INSERT and a `recordProgress` callback
// that runs on the same client, inside the same transaction, immediately
// before COMMIT.

// Rows per INSERT statement.
const BATCH_ROWS = 500;

// Rows per committed chunk. Large enough that the progress writes are
// negligible, small enough that an interruption costs little work.
const COMMIT_ROWS = 2000;

// ...and a wall-clock ceiling on top of it. Row count alone is the wrong unit
// when the host decides when the process runs: a slow chunk can leave an open
// transaction for a long time and lose all of it. Committing at least this
// often bounds what an interruption can cost, in time rather than in rows.
const COMMIT_INTERVAL_MS = 2000;

async function insertBatch(client, sql, columns, rows) {
  if (!rows.length) return;
  const values = [];
  const placeholders = rows.map((row, i) => {
    values.push(...row);
    const base = i * columns;
    return '(' + Array.from({ length: columns }, (_, k) => '$' + (base + k + 1)).join(',') + ')';
  });
  await client.query(sql.replace('__VALUES__', placeholders.join(',')), values);
}

class ChunkWriter {
  // options:
  //   sql            — INSERT with a literal `__VALUES__` placeholder
  //   columns        — number of columns per row
  //   resumeFrom     — records an earlier run already committed
  //   recordProgress — async (client, index, final) => void, called inside the
  //                    transaction right before COMMIT
  constructor(pool, { sql, columns, resumeFrom = 0, recordProgress }) {
    this.pool = pool;
    this.sql = sql;
    this.columns = columns;
    this.resumeFrom = resumeFrom;
    this.recordProgress = recordProgress;
    this.index = 0;        // records seen in this run, counting earlier runs
    this.pending = [];     // rows buffered for the next INSERT
    this.sinceCommit = 0;  // rows written since the last COMMIT
    this.lastCommit = Date.now();
    this.client = null;
  }

  // Call once per record. False means an earlier run already committed it, so
  // the caller can skip rebuilding a row it would only discard.
  next() {
    this.index += 1;
    return this.index > this.resumeFrom;
  }

  async open() {
    if (this.client) return;
    this.client = await this.pool.connect();
    await this.client.query('BEGIN');
  }

  async push(row) {
    this.pending.push(row);
    if (this.pending.length >= BATCH_ROWS) await this.flush();
    const due = this.sinceCommit >= COMMIT_ROWS ||
      (this.sinceCommit > 0 && Date.now() - this.lastCommit >= COMMIT_INTERVAL_MS);
    if (due) await this.commit(false);
  }

  async flush() {
    if (!this.pending.length) return;
    await this.open();
    await insertBatch(this.client, this.sql, this.columns, this.pending);
    this.sinceCommit += this.pending.length;
    this.pending = [];
  }

  // The progress marker is written in the same transaction as the rows it
  // describes, so a boot that dies mid-chunk can never leave an offset that
  // claims more than was actually staged.
  async commit(final) {
    await this.flush();
    await this.open();
    if (this.recordProgress) await this.recordProgress(this.client, this.index, !!final);
    await this.client.query('COMMIT');
    this.client.release();
    this.client = null;
    this.sinceCommit = 0;
    this.lastCommit = Date.now();
  }

  async abort() {
    if (!this.client) return;
    await this.client.query('ROLLBACK').catch(() => {});
    this.client.release();
    this.client = null;
  }
}

module.exports = { ChunkWriter, insertBatch, BATCH_ROWS, COMMIT_ROWS, COMMIT_INTERVAL_MS };
