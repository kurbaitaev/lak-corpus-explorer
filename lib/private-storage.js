'use strict';

// Persistent, access-controlled storage for private research package archives.
//
// Why this exists: the audited packages are deliberately gitignored, so they
// live nowhere except the workspace filesystem. A container rebuild wipes
// `private/` and `attached_assets/`, and the app then comes up with nothing
// staged. This module gives the archives a home that survives a rebuild.
//
// Backend selection
// -----------------
// The intended backend is Replit App Storage (Object Storage). This project
// has no bucket provisioned — the object-storage sidecar reports an empty
// default bucket id — so the active backend is the already-provisioned
// PostgreSQL database, which stores each archive as ordered binary chunks.
// Both backends sit behind the same four operations (`head`, `put`,
// `restoreToFile`, `list`), so wiring a bucket later is a new entry in
// BACKENDS plus a `PRIVATE_STORAGE_BACKEND=object_storage` setting; nothing
// else in the app changes.
//
// Access control: every operation needs the server-side database credentials.
// Nothing here is mounted under `public/`, and no route streams an archive.

const fs = require('fs');
const crypto = require('crypto');

// 4 MiB chunks: comfortably under PostgreSQL's 1 GB field limit and small
// enough that a single row never dominates a transaction.
const CHUNK_BYTES = 4 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;

class PrivateStorageError extends Error {}

function sha256Stream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// ── PostgreSQL chunked-blob backend ────────────────────────────
const postgresBackend = {
  name: 'postgres_chunked_blob',

  async head(pool, key) {
    const rows = await pool.query(
      `SELECT key, byte_size, sha256, chunk_count, chunk_bytes, content_type, created_at, updated_at
         FROM private_storage_objects WHERE key = $1`, [key]);
    return rows.rows[0] || null;
  },

  async list(pool) {
    const rows = await pool.query(
      `SELECT key, byte_size, sha256, chunk_count, created_at, updated_at
         FROM private_storage_objects ORDER BY key`);
    return rows.rows;
  },

  // Stores the file as ordered chunks. The digest is recomputed from the
  // bytes that are actually written, never taken on trust from the caller.
  async put(pool, key, filePath, options = {}) {
    const digest = await sha256Stream(filePath);
    if (options.expectedSha256 && options.expectedSha256 !== digest) {
      throw new PrivateStorageError(
        `refusing to store ${key}: the file digest ${digest} does not match the recorded ${options.expectedSha256}`);
    }
    const existing = await this.head(pool, key);
    if (existing && existing.sha256 === digest) {
      return { key, sha256: digest, byte_size: Number(existing.byte_size), stored: false };
    }

    const size = fs.statSync(filePath).size;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM private_storage_chunks WHERE key = $1', [key]);
      await client.query('DELETE FROM private_storage_objects WHERE key = $1', [key]);
      await client.query(
        `INSERT INTO private_storage_objects
           (key, byte_size, sha256, chunk_count, chunk_bytes, content_type)
         VALUES ($1,$2,$3,0,$4,$5)`,
        [key, size, digest, CHUNK_BYTES, options.contentType || 'application/zip']);

      let seq = 0;
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        for (;;) {
          const read = fs.readSync(fd, buffer, 0, CHUNK_BYTES, null);
          if (read <= 0) break;
          await client.query(
            'INSERT INTO private_storage_chunks (key, seq, data) VALUES ($1,$2,$3)',
            [key, seq, buffer.subarray(0, read)]);
          seq += 1;
        }
      } finally {
        fs.closeSync(fd);
      }
      await client.query('UPDATE private_storage_objects SET chunk_count = $2, updated_at = now() WHERE key = $1',
        [key, seq]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { key, sha256: digest, byte_size: size, stored: true };
  },

  // Streams the chunks back to disk and re-verifies the digest. A partial or
  // corrupted restore removes the destination rather than leaving a file that
  // would later look like a valid package.
  async restoreToFile(pool, key, destPath) {
    const info = await this.head(pool, key);
    if (!info) throw new PrivateStorageError(`no stored archive for ${key}`);

    const out = fs.createWriteStream(destPath);
    const hash = crypto.createHash('sha256');
    try {
      for (let seq = 0; seq < info.chunk_count; seq += 1) {
        const chunk = await pool.query(
          'SELECT data FROM private_storage_chunks WHERE key = $1 AND seq = $2', [key, seq]);
        if (!chunk.rows[0]) throw new PrivateStorageError(`stored archive ${key} is missing chunk ${seq}`);
        const data = chunk.rows[0].data;
        hash.update(data);
        if (!out.write(data)) await new Promise(resolve => out.once('drain', resolve));
      }
      await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
      const digest = hash.digest('hex');
      if (digest !== info.sha256) {
        throw new PrivateStorageError(
          `restored archive ${key} hashes to ${digest}, not the stored ${info.sha256}`);
      }
      return { key, sha256: digest, byte_size: Number(info.byte_size) };
    } catch (err) {
      out.destroy();
      fs.rmSync(destPath, { force: true });
      throw err;
    }
  },
};

const BACKENDS = { postgres: postgresBackend };

function activeBackend() {
  const requested = process.env.PRIVATE_STORAGE_BACKEND || 'postgres';
  const backend = BACKENDS[requested];
  if (!backend) {
    throw new PrivateStorageError(
      `unknown PRIVATE_STORAGE_BACKEND ${JSON.stringify(requested)}; available: ${Object.keys(BACKENDS).join(', ')}`);
  }
  return backend;
}

module.exports = {
  CHUNK_BYTES,
  SHA256_RE,
  PrivateStorageError,
  sha256Stream,
  backendName: () => activeBackend().name,
  head: (pool, key) => activeBackend().head(pool, key),
  list: pool => activeBackend().list(pool),
  put: (pool, key, filePath, options) => activeBackend().put(pool, key, filePath, options),
  restoreToFile: (pool, key, destPath) => activeBackend().restoreToFile(pool, key, destPath),
};
