'use strict';

/*
 * Seed the validation & evaluation task collection.
 *
 * Tasks live in scripts/gold-set.json — an array of objects:
 *   { id, kind, prompt_ru, lak_text, options, is_gold, gold_answer, priority, context }
 *
 * This is the expansion path toward the 100–200-query gold evaluation set:
 * simply add more entries to gold-set.json (mark reference-answer tasks with
 * "is_gold": true and a "gold_answer") and re-run this script. It is idempotent
 * (ON CONFLICT DO NOTHING) and never modifies existing tasks or votes.
 *
 * Usage: node scripts/seed-validation.js
 */

const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

const KINDS = ['translation_correctness', 'sense_choice', 'moon_vs_month', 'dialect',
               'spelling', 'ocr_quality', 'example_usefulness', 'source_reliability'];

async function main() {
  const file = path.join(__dirname, 'gold-set.json');
  const tasks = JSON.parse(fs.readFileSync(file, 'utf8'));
  let inserted = 0, skipped = 0, errors = 0;

  for (const t of tasks) {
    if (!t.id || !KINDS.includes(t.kind)) {
      console.error(`✗ invalid entry (missing id or bad kind): ${JSON.stringify(t).slice(0, 80)}`);
      errors++;
      continue;
    }
    if (t.is_gold && !t.gold_answer) {
      console.error(`✗ gold task without gold_answer: ${t.id}`);
      errors++;
      continue;
    }
    const r = await pool.query(
      `INSERT INTO validation_tasks (id, kind, prompt_ru, lak_text, context, options, is_gold, gold_answer, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'seed')
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [t.id, t.kind, t.prompt_ru || null, t.lak_text || null,
       t.context ? JSON.stringify(t.context) : null,
       Array.isArray(t.options) ? JSON.stringify(t.options) : null,
       !!t.is_gold, t.gold_answer || null,
       Math.min(Math.max(parseInt(t.priority || '0', 10) || 0, 0), 100)]);
    if (r.rows[0]) { inserted++; } else { skipped++; }
  }

  const stats = await pool.query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_gold) AS gold FROM validation_tasks`);
  console.log(`Seed complete: ${inserted} inserted, ${skipped} already present, ${errors} invalid.`);
  console.log(`Collection now holds ${stats.rows[0].total} tasks (${stats.rows[0].gold} gold-standard).`);
  await pool.end();
}

main().catch(err => { console.error('Seed failed:', err.message); process.exit(1); });
