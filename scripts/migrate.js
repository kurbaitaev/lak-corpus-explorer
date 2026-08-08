'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, migrate: migrateLegacy } = require('../lib/db');

async function migrateFiles() {
  await migrateLegacy();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const existing = await pool.query('SELECT checksum FROM schema_migrations WHERE id=$1', [id]);
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Migration ${id} changed after it was applied`);
      console.log(`Migration ${id} already applied`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1,$2)', [id, checksum]);
      await client.query('COMMIT');
      console.log(`Applied migration ${id}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  migrateFiles().then(() => pool.end()).catch(async err => {
    console.error(err.stack || err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}

module.exports = { migrateFiles };
