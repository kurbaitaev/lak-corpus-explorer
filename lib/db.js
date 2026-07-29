'use strict';

// Shared PostgreSQL pool + backward-compatible migrations for the
// expert-validation and gamification schema. Every statement is
// CREATE TABLE/INDEX IF NOT EXISTS or ALTER ... IF NOT EXISTS, so
// running them never erases existing user or corpus data.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS contributors (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     display_name TEXT NOT NULL,
     affiliation TEXT,
     languages TEXT,
     expertise TEXT,
     role TEXT NOT NULL DEFAULT 'contributor'
       CHECK (role IN ('contributor','trusted_validator','verified_expert','administrator')),
     public_profile BOOLEAN NOT NULL DEFAULT FALSE,
     leaderboard_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
     reliability REAL NOT NULL DEFAULT 0.5,
     reliability_events_count INT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS contributors_email_lower ON contributors (lower(email))`,

  `CREATE TABLE IF NOT EXISTS expert_grants (
     id BIGSERIAL PRIMARY KEY,
     contributor_id TEXT NOT NULL REFERENCES contributors(id),
     granted_role TEXT NOT NULL,
     basis TEXT NOT NULL,
     granted_by TEXT NOT NULL,
     invite_token TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS invites (
     token TEXT PRIMARY KEY,
     role TEXT NOT NULL CHECK (role IN ('trusted_validator','verified_expert','administrator')),
     expertise_note TEXT,
     created_by TEXT NOT NULL,
     used_by TEXT,
     expires_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS validation_tasks (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN
       ('translation_correctness','sense_choice','moon_vs_month','dialect',
        'spelling','ocr_quality','example_usefulness','source_reliability')),
     prompt_ru TEXT,
     lak_text TEXT,
     context JSONB,
     options JSONB,
     is_gold BOOLEAN NOT NULL DEFAULT FALSE,
     gold_answer TEXT,
     priority INT NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending'
       CHECK (status IN ('pending','community_consensus','expert_verified','disputed','rejected')),
     consensus_value TEXT,
     consensus_confidence REAL,
     version INT NOT NULL DEFAULT 1,
     created_by TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS validation_tasks_status ON validation_tasks (status, priority)`,

  `CREATE TABLE IF NOT EXISTS validation_votes (
     id BIGSERIAL PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES validation_tasks(id),
     task_version INT NOT NULL,
     contributor_id TEXT NOT NULL REFERENCES contributors(id),
     value TEXT NOT NULL,
     correction TEXT,
     evidence_note TEXT,
     source_ref TEXT,
     time_to_vote_ms INT,
     flagged_spam BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (task_id, contributor_id)
   )`,
  `CREATE INDEX IF NOT EXISTS validation_votes_contributor ON validation_votes (contributor_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS adjudications (
     id BIGSERIAL PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES validation_tasks(id),
     adjudicator_id TEXT,
     adjudicator_name TEXT NOT NULL,
     adjudicator_role TEXT NOT NULL,
     decision TEXT NOT NULL,
     note TEXT,
     resulting_status TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS points_ledger (
     id BIGSERIAL PRIMARY KEY,
     contributor_id TEXT NOT NULL REFERENCES contributors(id),
     task_id TEXT,
     kind TEXT NOT NULL,
     points INT NOT NULL,
     status TEXT NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional','confirmed','revoked')),
     reason TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     resolved_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS points_contributor ON points_ledger (contributor_id, status, created_at)`,

  `CREATE TABLE IF NOT EXISTS reliability_events (
     id BIGSERIAL PRIMARY KEY,
     contributor_id TEXT NOT NULL REFERENCES contributors(id),
     task_id TEXT,
     kind TEXT NOT NULL CHECK (kind IN
       ('gold_hit','gold_miss','consensus_agree','consensus_disagree','reversal','expert_confirmed')),
     outcome SMALLINT NOT NULL CHECK (outcome IN (0,1)),
     weight REAL NOT NULL DEFAULT 1,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS reliability_contributor ON reliability_events (contributor_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS contribution_days (
     contributor_id TEXT NOT NULL REFERENCES contributors(id),
     day DATE NOT NULL,
     substantive_count INT NOT NULL DEFAULT 0,
     PRIMARY KEY (contributor_id, day)
   )`,

  `CREATE TABLE IF NOT EXISTS achievements (
     contributor_id TEXT NOT NULL REFERENCES contributors(id),
     key TEXT NOT NULL,
     awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (contributor_id, key)
   )`,

  `CREATE TABLE IF NOT EXISTS quests (
     contributor_id TEXT NOT NULL REFERENCES contributors(id),
     scope TEXT NOT NULL CHECK (scope IN ('daily','weekly')),
     period TEXT NOT NULL,
     quest_key TEXT NOT NULL,
     target INT NOT NULL,
     progress INT NOT NULL DEFAULT 0,
     done BOOLEAN NOT NULL DEFAULT FALSE,
     PRIMARY KEY (contributor_id, scope, period)
   )`,

  `CREATE TABLE IF NOT EXISTS suspicion_flags (
     id BIGSERIAL PRIMARY KEY,
     contributor_id TEXT NOT NULL REFERENCES contributors(id),
     kind TEXT NOT NULL,
     detail TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS appeals (
     id BIGSERIAL PRIMARY KEY,
     contributor_id TEXT NOT NULL REFERENCES contributors(id),
     target_type TEXT NOT NULL,
     target_id TEXT,
     reason TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
     resolution TEXT,
     resolved_by TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     resolved_at TIMESTAMPTZ
   )`,

  `CREATE TABLE IF NOT EXISTS audit_events (
     id BIGSERIAL PRIMARY KEY,
     actor_type TEXT NOT NULL,
     actor_id TEXT,
     actor_name TEXT,
     event_type TEXT NOT NULL,
     target_type TEXT,
     target_id TEXT,
     payload JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS audit_target ON audit_events (target_type, target_id)`,
];

async function migrate() {
  for (const sql of MIGRATIONS) {
    await pool.query(sql);
  }
  console.log('Validation & gamification schema ready');
}

module.exports = { pool, migrate };
