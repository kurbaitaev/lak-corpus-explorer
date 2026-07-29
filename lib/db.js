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

  // ══ Translation Lab ═══════════════════════════════════════════
  // A "translation request" is a query someone asked the lab to translate,
  // in either direction. It anchors proposals, evidence, and — once a human
  // approves — parallel pairs destined for the dataset.
  `CREATE TABLE IF NOT EXISTS translation_requests (
     id TEXT PRIMARY KEY,
     direction TEXT NOT NULL CHECK (direction IN ('ru2lak','lak2ru')),
     source_text TEXT NOT NULL,
     source_norm TEXT NOT NULL,
     requested_by TEXT REFERENCES contributors(id),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS translation_requests_norm ON translation_requests (direction, source_norm)`,

  // A "proposal" is the lab's evidence-only answer to a request. Because no
  // generative model key exists, the provider NEVER invents target text — it
  // reports the retrieved evidence and its classification. A proposal is the
  // starting draft a human then confirms/edits into a parallel pair.
  `CREATE TABLE IF NOT EXISTS translation_proposals (
     id TEXT PRIMARY KEY,
     request_id TEXT NOT NULL REFERENCES translation_requests(id),
     provider TEXT NOT NULL DEFAULT 'evidence-only',
     evidence_only BOOLEAN NOT NULL DEFAULT TRUE,
     classification TEXT NOT NULL
       CHECK (classification IN ('exact_dictionary','corpus_supported','attested_usage','partial','no_evidence')),
     suggested_target TEXT,
     alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
     unknowns JSONB NOT NULL DEFAULT '[]'::jsonb,
     coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
     model_version TEXT NOT NULL DEFAULT 'none',
     prompt_version TEXT NOT NULL DEFAULT 'evidence-only-v1',
     confidence REAL,
     rationale TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS translation_proposals_request ON translation_proposals (request_id, created_at)`,

  // The individual evidence rows behind a proposal, ranked. Each cites the
  // corpus record it came from so nothing is fabricated.
  `CREATE TABLE IF NOT EXISTS proposal_evidence (
     id BIGSERIAL PRIMARY KEY,
     proposal_id TEXT NOT NULL REFERENCES translation_proposals(id),
     rank INT NOT NULL,
     evidence_type TEXT NOT NULL
       CHECK (evidence_type IN ('dictionary_sense','corpus_example','alias')),
     lak_text TEXT,
     gloss TEXT,
     source TEXT,
     variety TEXT,
     record_ref TEXT,
     record_url TEXT,
     is_ocr BOOLEAN NOT NULL DEFAULT FALSE,
     validated BOOLEAN NOT NULL DEFAULT FALSE,
     score REAL NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS proposal_evidence_proposal ON proposal_evidence (proposal_id, rank)`,

  // A "parallel pair" is a human-owned RU↔LAK sentence pair — the dataset unit.
  // Head row holds the current head version + lifecycle/split assignment.
  `CREATE TABLE IF NOT EXISTS parallel_pairs (
     id TEXT PRIMARY KEY,
     request_id TEXT REFERENCES translation_requests(id),
     proposal_id TEXT REFERENCES translation_proposals(id),
     direction TEXT NOT NULL CHECK (direction IN ('ru2lak','lak2ru')),
     ru_text TEXT NOT NULL,
     lak_text TEXT NOT NULL,
     literal_target TEXT,
     natural_target TEXT,
     variety TEXT NOT NULL DEFAULT 'standard',
     orthography TEXT NOT NULL DEFAULT 'cyrillic',
     source_type TEXT NOT NULL DEFAULT 'human',
     source_provenance TEXT,
     rights_status TEXT NOT NULL DEFAULT 'unknown',
     access_status TEXT NOT NULL DEFAULT 'public',
     evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
     abstained BOOLEAN NOT NULL DEFAULT FALSE,
     error_category TEXT,
     notes TEXT,
     provenance TEXT NOT NULL DEFAULT 'human'
       CHECK (provenance IN ('human','human_from_evidence','synthetic')),
     status TEXT NOT NULL DEFAULT 'pending'
       CHECK (status IN ('pending','under_review','approved','rejected','withdrawn')),
     split TEXT CHECK (split IN ('train','dev','test')),
     is_private BOOLEAN NOT NULL DEFAULT FALSE,
     head_version INT NOT NULL DEFAULT 1,
     owner_id TEXT REFERENCES contributors(id),
     owner_name TEXT,
     approved_by TEXT,
     approved_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS parallel_pairs_status ON parallel_pairs (status, split)`,
  `CREATE INDEX IF NOT EXISTS parallel_pairs_owner ON parallel_pairs (owner_id, created_at)`,

  // Immutable version history for every pair edit (never overwrite content).
  `CREATE TABLE IF NOT EXISTS parallel_pair_versions (
     id BIGSERIAL PRIMARY KEY,
     pair_id TEXT NOT NULL REFERENCES parallel_pairs(id),
     version INT NOT NULL,
     ru_text TEXT NOT NULL,
     lak_text TEXT NOT NULL,
     literal_target TEXT,
     natural_target TEXT,
     variety TEXT,
     orthography TEXT,
     notes TEXT,
     edited_by TEXT,
     edited_by_name TEXT,
     edit_summary TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (pair_id, version)
   )`,
  `CREATE INDEX IF NOT EXISTS parallel_pair_versions_pair ON parallel_pair_versions (pair_id, version)`,

  // Independent peer reviews of a pair. One review per contributor per pair;
  // self-review is blocked in the router. A review targets the version it saw.
  `CREATE TABLE IF NOT EXISTS pair_reviews (
     id BIGSERIAL PRIMARY KEY,
     pair_id TEXT NOT NULL REFERENCES parallel_pairs(id),
     pair_version INT NOT NULL,
     reviewer_id TEXT NOT NULL REFERENCES contributors(id),
     reviewer_name TEXT,
     verdict TEXT NOT NULL CHECK (verdict IN ('accept','revise','reject')),
     suggested_lak TEXT,
     comment TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (pair_id, reviewer_id)
   )`,
  `CREATE INDEX IF NOT EXISTS pair_reviews_pair ON pair_reviews (pair_id, created_at)`,

  // Expert adjudication that sets a pair's final status/split. Idempotent
  // points: at most one adjudication row per (pair, version) actually applies.
  `CREATE TABLE IF NOT EXISTS pair_adjudications (
     id BIGSERIAL PRIMARY KEY,
     pair_id TEXT NOT NULL REFERENCES parallel_pairs(id),
     pair_version INT NOT NULL,
     adjudicator_id TEXT,
     adjudicator_name TEXT NOT NULL,
     adjudicator_role TEXT NOT NULL,
     decision TEXT NOT NULL CHECK (decision IN ('approve','reject','withdraw')),
     split TEXT CHECK (split IN ('train','dev','test')),
     note TEXT,
     resulting_status TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (pair_id, pair_version)
   )`,
  `CREATE INDEX IF NOT EXISTS pair_adjudications_pair ON pair_adjudications (pair_id)`,

  // Expert-authored benchmark items (held-out test queries) grouped by split.
  `CREATE TABLE IF NOT EXISTS benchmark_items (
     id TEXT PRIMARY KEY,
     split TEXT NOT NULL DEFAULT 'test' CHECK (split IN ('train','dev','test')),
     direction TEXT NOT NULL CHECK (direction IN ('ru2lak','lak2ru')),
     source_text TEXT NOT NULL,
     reference_text TEXT NOT NULL,
     variety TEXT NOT NULL DEFAULT 'standard',
     category TEXT,
     difficulty TEXT CHECK (difficulty IN ('easy','medium','hard')),
     notes TEXT,
     is_private BOOLEAN NOT NULL DEFAULT TRUE,
     created_by TEXT,
     created_by_name TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS benchmark_items_split ON benchmark_items (split, direction)`,

  // Recorded evaluation runs. The evidence-only provider produces no target
  // text, so runs record that the item was NOT scorable by a model — this is
  // the honest record that no generation happened.
  `CREATE TABLE IF NOT EXISTS model_runs (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL DEFAULT 'evidence-only',
     split TEXT NOT NULL CHECK (split IN ('train','dev','test')),
     direction TEXT CHECK (direction IN ('ru2lak','lak2ru')),
     items_total INT NOT NULL DEFAULT 0,
     items_with_evidence INT NOT NULL DEFAULT 0,
     items_scored INT NOT NULL DEFAULT 0,
     evidence_only BOOLEAN NOT NULL DEFAULT TRUE,
     summary JSONB,
     run_by TEXT,
     run_by_name TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS model_runs_split ON model_runs (split, created_at)`,
  // Backward-compatible additions for databases where early lab migrations ran.
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS alternatives JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS unknowns JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS coverage JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS model_version TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS prompt_version TEXT NOT NULL DEFAULT 'evidence-only-v1'`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS literal_target TEXT`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS natural_target TEXT`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS orthography TEXT NOT NULL DEFAULT 'cyrillic'`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'human'`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS source_provenance TEXT`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS rights_status TEXT NOT NULL DEFAULT 'unknown'`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'public'`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS abstained BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE parallel_pairs ADD COLUMN IF NOT EXISTS error_category TEXT`,
  `ALTER TABLE parallel_pair_versions ADD COLUMN IF NOT EXISTS literal_target TEXT`,
  `ALTER TABLE parallel_pair_versions ADD COLUMN IF NOT EXISTS natural_target TEXT`,
  `ALTER TABLE parallel_pair_versions ADD COLUMN IF NOT EXISTS orthography TEXT`,
  // Allow the 'attested_usage' classification (corpus usage only, lab abstains)
  // on databases created before this class existed. Idempotent: drop-then-add.
  `ALTER TABLE translation_proposals DROP CONSTRAINT IF EXISTS translation_proposals_classification_check`,
  `ALTER TABLE translation_proposals ADD CONSTRAINT translation_proposals_classification_check
     CHECK (classification IN ('exact_dictionary','corpus_supported','attested_usage','partial','no_evidence'))`,
];

async function migrate() {
  for (const sql of MIGRATIONS) {
    await pool.query(sql);
  }
  console.log('Validation, gamification & translation-lab schema ready');
}

module.exports = { pool, migrate };
