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
  // ══ Private source-import layer (audited v1.2 research sources) ═══
  // Staging for candidates that are NOT corpus records. Everything here is
  // private research by default; rights, access, review and training are four
  // SEPARATE decisions, and duplicates are linked as corroboration rather
  // than merged. Ordinary corpus search never reads these tables.
  `CREATE TABLE IF NOT EXISTS source_import_batches (
     id TEXT PRIMARY KEY,
     source_id TEXT NOT NULL,
     layer TEXT NOT NULL CHECK (layer IN
       ('lexical_candidate','ocr_candidate','audio_inventory','reference_metadata')),
     provenance_granularity TEXT NOT NULL CHECK (provenance_granularity IN
       ('row','page','collection','work')),
     manifest_file TEXT NOT NULL,
     manifest_sha256 TEXT NOT NULL,
     records_sha256 TEXT NOT NULL,
     declared_count INT NOT NULL,
     expected_count INT NOT NULL,
     imported_count INT NOT NULL DEFAULT 0,
     verification_status TEXT NOT NULL
       CHECK (verification_status IN ('verified','awaiting_manifest','rejected')),
     verification_error TEXT,
     metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (source_id, manifest_sha256)
   )`,

  // A candidate is a private research lead, never a canonical corpus record.
  // provenance is written once at import and never updated.
  `CREATE TABLE IF NOT EXISTS source_import_candidates (
     id TEXT PRIMARY KEY,
     batch_id TEXT NOT NULL REFERENCES source_import_batches(id),
     source_id TEXT NOT NULL,
     layer TEXT NOT NULL,
     candidate_ref TEXT NOT NULL,
     lak_text TEXT,
     ru_text TEXT,
     gloss TEXT,
     ocr_text TEXT,
     title TEXT,
     row_ref TEXT,
     page_ref TEXT,
     collection_ref TEXT,
     normalized_form TEXT,
     provenance JSONB NOT NULL,
     content_sha256 TEXT NOT NULL,
     access_status TEXT NOT NULL DEFAULT 'private_research'
       CHECK (access_status IN ('private_research','restricted','public')),
     rights_status TEXT NOT NULL DEFAULT 'permission_pending'
       CHECK (rights_status IN ('permission_pending','permission_granted','public_domain','restricted')),
     review_state TEXT NOT NULL DEFAULT 'source_import_unreviewed'
       CHECK (review_state IN ('source_import_unreviewed','in_review','accepted_candidate','rejected')),
     consent_status TEXT NOT NULL DEFAULT 'unknown'
       CHECK (consent_status IN ('unknown','not_applicable','documented','withheld')),
     training_ready BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (source_id, candidate_ref)
   )`,
  `CREATE INDEX IF NOT EXISTS source_import_candidates_batch
     ON source_import_candidates (batch_id, candidate_ref)`,
  `CREATE INDEX IF NOT EXISTS source_import_candidates_state
     ON source_import_candidates (review_state, access_status, training_ready)`,
  // Columns added after the first release of this table.
  `ALTER TABLE source_import_candidates ADD COLUMN IF NOT EXISTS ocr_text TEXT`,
  `ALTER TABLE source_import_candidates ADD COLUMN IF NOT EXISTS title TEXT`,
  `ALTER TABLE source_import_candidates ADD COLUMN IF NOT EXISTS normalized_form TEXT`,
  // Exact-spelling overlap lookups for corroboration links.
  `CREATE INDEX IF NOT EXISTS source_import_candidates_form
     ON source_import_candidates (normalized_form) WHERE normalized_form IS NOT NULL`,

  // Immutable log of every rights/access/review/training decision.
  `CREATE TABLE IF NOT EXISTS source_import_decisions (
     id BIGSERIAL PRIMARY KEY,
     candidate_id TEXT NOT NULL REFERENCES source_import_candidates(id),
     decision_type TEXT NOT NULL
       CHECK (decision_type IN ('rights','access','review','training')),
     from_value TEXT,
     to_value TEXT NOT NULL,
     note TEXT,
     decided_by TEXT,
     decided_by_name TEXT NOT NULL,
     decided_by_role TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS source_import_decisions_candidate
     ON source_import_decisions (candidate_id, created_at)`,

  // Duplicates are corroboration links, never silent merges. related_key
  // mirrors the candidate/record reference so the pair stays unique.
  `CREATE TABLE IF NOT EXISTS source_import_corroborations (
     id BIGSERIAL PRIMARY KEY,
     candidate_id TEXT NOT NULL REFERENCES source_import_candidates(id),
     related_kind TEXT NOT NULL CHECK (related_kind IN ('candidate','corpus_record')),
     related_candidate_id TEXT REFERENCES source_import_candidates(id),
     related_record_id TEXT,
     related_key TEXT NOT NULL,
     relation TEXT NOT NULL DEFAULT 'corroborates'
       CHECK (relation IN ('corroborates','conflicts')),
     note TEXT,
     linked_by TEXT,
     linked_by_name TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (candidate_id, related_kind, related_key, relation)
   )`,
  `CREATE INDEX IF NOT EXISTS source_import_corroborations_candidate
     ON source_import_corroborations (candidate_id, created_at)`,

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
  // and 'reviewed_memory' (an expert-approved pair answered the request) on
  // databases created before these classes existed. Idempotent: drop-then-add.
  `ALTER TABLE translation_proposals DROP CONSTRAINT IF EXISTS translation_proposals_classification_check`,
  `ALTER TABLE translation_proposals ADD CONSTRAINT translation_proposals_classification_check
     CHECK (classification IN ('reviewed_memory','exact_dictionary','corpus_supported','attested_usage','partial','no_evidence'))`,

  // ── Reviewed translation memory + evaluation isolation ───────
  // Every answer records what kind of evidence produced it, that evidence's
  // review state, and whether the lab abstained — so no stored proposal can
  // later be read as a validated translation when it was a candidate match.
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS evidence_type TEXT`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS evidence_class TEXT`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS review_state TEXT`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS gold_used BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS abstained BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS abstain_reason TEXT`,
  `ALTER TABLE translation_proposals ADD COLUMN IF NOT EXISTS certainty TEXT`,

  // Evidence rows carry their class, review state and gold eligibility, so the
  // gold rule is auditable per row and not only at answer time.
  `ALTER TABLE proposal_evidence ADD COLUMN IF NOT EXISTS evidence_class TEXT`,
  `ALTER TABLE proposal_evidence ADD COLUMN IF NOT EXISTS review_state TEXT`,
  `ALTER TABLE proposal_evidence ADD COLUMN IF NOT EXISTS gold_eligible BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE proposal_evidence DROP CONSTRAINT IF EXISTS proposal_evidence_evidence_type_check`,
  `ALTER TABLE proposal_evidence ADD CONSTRAINT proposal_evidence_evidence_type_check
     CHECK (evidence_type IN ('approved_parallel_pair','dictionary_sense','alias',
                              'validated_parallel','attested_public_example',
                              'corpus_example','monolingual_example'))`,

  // Evaluation runs distinguish retrieval-only from model+retrieval and record
  // abstentions and gold coverage. fine_tuned is FALSE by construction: no
  // model is trained or fine-tuned anywhere in this project.
  `ALTER TABLE model_runs ADD COLUMN IF NOT EXISTS config TEXT NOT NULL DEFAULT 'retrieval_only'`,
  `ALTER TABLE model_runs DROP CONSTRAINT IF EXISTS model_runs_config_check`,
  `ALTER TABLE model_runs ADD CONSTRAINT model_runs_config_check
     CHECK (config IN ('retrieval_only','model_plus_retrieval'))`,
  `ALTER TABLE model_runs ADD COLUMN IF NOT EXISTS items_with_gold INT NOT NULL DEFAULT 0`,
  `ALTER TABLE model_runs ADD COLUMN IF NOT EXISTS items_abstained INT NOT NULL DEFAULT 0`,
  `ALTER TABLE model_runs ADD COLUMN IF NOT EXISTS model_version TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE model_runs ADD COLUMN IF NOT EXISTS fine_tuned BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE model_runs DROP CONSTRAINT IF EXISTS model_runs_no_fine_tuning`,
  `ALTER TABLE model_runs ADD CONSTRAINT model_runs_no_fine_tuning CHECK (fine_tuned = FALSE)`,

  // ── Persistent private storage ───────────────────────────────
  // The private research packages are gitignored, so the workspace copy does
  // not survive a rebuild. Their archives are held here as ordered binary
  // chunks; `private/` is only a cache that is restored from them on boot.
  // Reachable through the server-side pool only — never through a route.
  `CREATE TABLE IF NOT EXISTS private_storage_objects (
     key TEXT PRIMARY KEY,
     byte_size BIGINT NOT NULL,
     sha256 TEXT NOT NULL,
     chunk_count INT NOT NULL DEFAULT 0,
     chunk_bytes INT NOT NULL,
     content_type TEXT NOT NULL DEFAULT 'application/zip',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS private_storage_chunks (
     key TEXT NOT NULL REFERENCES private_storage_objects(key) ON DELETE CASCADE,
     seq INT NOT NULL,
     data BYTEA NOT NULL,
     PRIMARY KEY (key, seq)
   )`,

  // Verification results, keyed by a digest over every file the verifier
  // reads. An unchanged package hits this cache instead of being re-parsed;
  // a changed, missing or tampered file produces a different content_key, so
  // a stale entry can never resurrect a package that would now fail.
  `CREATE TABLE IF NOT EXISTS private_package_verifications (
     package_id TEXT NOT NULL,
     content_key TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('verified','blocked')),
     blocked_reason TEXT,
     declared JSONB NOT NULL DEFAULT '{}'::jsonb,
     observed JSONB NOT NULL DEFAULT '{}'::jsonb,
     archive_sha256 TEXT,
     verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (package_id, content_key)
   )`,

  // ── v1.3 private staging ─────────────────────────────────────
  // One batch per imported layer, keyed by the digest of the file it read.
  // Re-running the import with the same package matches an existing batch and
  // stages nothing new.
  `CREATE TABLE IF NOT EXISTS v13_import_batches (
     id TEXT PRIMARY KEY,
     package_id TEXT NOT NULL,
     layer TEXT NOT NULL,
     file_name TEXT NOT NULL,
     file_sha256 TEXT NOT NULL,
     declared_count INT NOT NULL,
     imported_count INT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (layer, file_sha256)
   )`,

  // Resumable staging. A layer the size of the lexicon cannot be imported as
  // one all-or-nothing transaction on a host that suspends the process between
  // requests: the transaction is rolled back on every interruption and the
  // layer never lands. Instead each layer commits in chunks and records how far
  // it got, so the next boot resumes rather than starting over.
  //
  // `status` defaults to 'complete' so that batches written by the earlier
  // all-or-nothing importer — which only ever existed once committed — are
  // correctly read as finished, and are never re-imported or rolled back.
  `ALTER TABLE v13_import_batches
     ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete'`,
  `ALTER TABLE v13_import_batches
     ADD COLUMN IF NOT EXISTS resume_offset INT NOT NULL DEFAULT 0`,
  `ALTER TABLE v13_import_batches
     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `ALTER TABLE v13_import_batches
     DROP CONSTRAINT IF EXISTS v13_import_batches_status_check`,
  `ALTER TABLE v13_import_batches
     ADD CONSTRAINT v13_import_batches_status_check
     CHECK (status IN ('in_progress','complete'))`,

  // The source registry: one corpus disposition per received file, including
  // the system-metadata receipts. These rows are inventory, not language
  // data, and are never public-search-eligible or training-ready.
  `CREATE TABLE IF NOT EXISTS v13_sources (
     id TEXT PRIMARY KEY,
     batch_id TEXT NOT NULL REFERENCES v13_import_batches(id),
     source_sequence INT NOT NULL UNIQUE,
     source_path TEXT NOT NULL,
     source_sha256 TEXT NOT NULL,
     material_type TEXT,
     language_scope TEXT,
     extraction_quality TEXT,
     extraction_status TEXT,
     derived_route TEXT,
     disposition TEXT,
     corpus_role TEXT,
     recommended_use TEXT,
     declared_rights_status TEXT,
     extracted_text_relpath TEXT,
     source_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
     bytes BIGINT,
     text_chars BIGINT,
     word_count BIGINT,
     priority TEXT,
     duplicate_group TEXT,
     canonical_duplicate TEXT,
     extension TEXT,
     access_status TEXT NOT NULL DEFAULT 'private_research'
       CHECK (access_status IN ('private_research','restricted','public')),
     rights_status TEXT NOT NULL DEFAULT 'permission_pending'
       CHECK (rights_status IN ('permission_pending','permission_granted','public_domain','restricted')),
     review_state TEXT NOT NULL DEFAULT 'source_import_unreviewed'
       CHECK (review_state IN ('source_import_unreviewed','in_review','accepted_candidate','rejected')),
     public_search_eligible BOOLEAN NOT NULL DEFAULT FALSE,
     training_ready BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS v13_sources_material
     ON v13_sources (material_type, extraction_quality)`,

  // One required rights/provenance action per substantive source.
  `CREATE TABLE IF NOT EXISTS v13_rights_reviews (
     id TEXT PRIMARY KEY,
     batch_id TEXT NOT NULL REFERENCES v13_import_batches(id),
     source_sequence INT NOT NULL UNIQUE,
     source_path TEXT NOT NULL,
     source_sha256 TEXT NOT NULL,
     material_type TEXT,
     required_action TEXT NOT NULL,
     declared_rights_status TEXT,
     source_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
     canonical_duplicate TEXT,
     rights_status TEXT NOT NULL DEFAULT 'permission_pending'
       CHECK (rights_status IN ('permission_pending','permission_granted','public_domain','restricted')),
     review_state TEXT NOT NULL DEFAULT 'source_import_unreviewed'
       CHECK (review_state IN ('source_import_unreviewed','in_review','accepted_candidate','rejected')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // The four v1.3 candidate layers. Every row keeps its own source path, file
  // digest, extraction quality, material type, language scope, rights status
  // and review status, so a reviewer never has to trust a join to know where
  // a candidate came from. Large extracted-text bodies are NOT copied here:
  // the row keeps the pointer and the body stays in the package archive in
  // persistent storage.
  `CREATE TABLE IF NOT EXISTS v13_candidates (
     id TEXT PRIMARY KEY,
     batch_id TEXT NOT NULL REFERENCES v13_import_batches(id),
     layer TEXT NOT NULL CHECK (layer IN
       ('private_lexicon_lines','private_text_segments','private_grammar_examples','private_reference_index')),
     candidate_ref TEXT NOT NULL,
     candidate_kind TEXT,
     intended_layer TEXT,
     text TEXT,
     word_count INT,
     source_sequence INT NOT NULL,
     source_path TEXT NOT NULL,
     source_sha256 TEXT NOT NULL,
     source_unit INT,
     source_line INT,
     extraction_quality TEXT,
     material_type TEXT,
     language_scope TEXT,
     declared_rights_status TEXT,
     extracted_text_relpath TEXT,
     text_chars BIGINT,
     content_sha256 TEXT NOT NULL,
     access_status TEXT NOT NULL DEFAULT 'private_research'
       CHECK (access_status IN ('private_research','restricted','public')),
     rights_status TEXT NOT NULL DEFAULT 'permission_pending'
       CHECK (rights_status IN ('permission_pending','permission_granted','public_domain','restricted')),
     review_state TEXT NOT NULL DEFAULT 'source_import_unreviewed'
       CHECK (review_state IN ('source_import_unreviewed','in_review','accepted_candidate','rejected')),
     consent_status TEXT NOT NULL DEFAULT 'unknown'
       CHECK (consent_status IN ('unknown','not_applicable','documented','withheld')),
     public_search_eligible BOOLEAN NOT NULL DEFAULT FALSE,
     training_ready BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (layer, candidate_ref)
   )`,
  `CREATE INDEX IF NOT EXISTS v13_candidates_layer_state
     ON v13_candidates (layer, review_state, public_search_eligible, training_ready)`,
  `CREATE INDEX IF NOT EXISTS v13_candidates_source
     ON v13_candidates (source_sequence)`,

  // ══ Private alignment lab & source intelligence ══════════════
  // Relationships between sources are PROPOSALS produced from deterministic
  // evidence. Nothing here is a validated translation: a row stays a
  // candidate until a human with the right role accepts it, and the text it
  // points at never leaves the authenticated private routes.
  //
  // A family_key groups sources that plausibly belong to the same work
  // (e.g. the War family). It is derived from the received path, so it is
  // stable across imports.
  `ALTER TABLE v13_sources ADD COLUMN IF NOT EXISTS family_key TEXT`,
  `CREATE INDEX IF NOT EXISTS v13_sources_family ON v13_sources (family_key)`,

  // One row per proposed source pair. `signals` records exactly which pieces
  // of evidence fired, `evidence` the measurements behind them, so a reviewer
  // can see why the pair was proposed rather than trusting a score.
  `CREATE TABLE IF NOT EXISTS private_source_relationships (
     id TEXT PRIMARY KEY,
     pair_key TEXT NOT NULL UNIQUE,
     family_key TEXT,
     relationship_type TEXT NOT NULL CHECK (relationship_type IN
       ('translation','parallel_text','transliteration','alternate_edition','duplicate')),
     method TEXT NOT NULL,
     generator_version TEXT NOT NULL,
     origin TEXT NOT NULL DEFAULT 'deterministic_scan'
       CHECK (origin IN ('deterministic_scan','war_family_seed','reviewer')),
     left_source_kind TEXT NOT NULL
       CHECK (left_source_kind IN ('v13_source','v12_source','public_corpus')),
     left_source_ref TEXT NOT NULL,
     left_source_label TEXT,
     left_language TEXT,
     left_role TEXT,
     right_source_kind TEXT NOT NULL
       CHECK (right_source_kind IN ('v13_source','v12_source','public_corpus')),
     right_source_ref TEXT NOT NULL,
     right_source_label TEXT,
     right_language TEXT,
     right_role TEXT,
     role_note TEXT,
     signals JSONB NOT NULL DEFAULT '[]'::jsonb,
     evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
     confidence NUMERIC(6,4) NOT NULL DEFAULT 0,
     access_status TEXT NOT NULL DEFAULT 'private_research'
       CHECK (access_status IN ('private_research','restricted','public')),
     rights_status TEXT NOT NULL DEFAULT 'permission_pending'
       CHECK (rights_status IN ('permission_pending','permission_granted','public_domain','restricted')),
     review_state TEXT NOT NULL DEFAULT 'source_import_unreviewed'
       CHECK (review_state IN ('source_import_unreviewed','in_review','accepted_candidate','rejected')),
     training_ready BOOLEAN NOT NULL DEFAULT FALSE,
     decided_by_name TEXT,
     decided_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS private_source_relationships_family
     ON private_source_relationships (family_key, relationship_type)`,
  `CREATE INDEX IF NOT EXISTS private_source_relationships_state
     ON private_source_relationships (review_state, relationship_type, confidence DESC)`,

  // The hierarchical alignment a candidate pair produces: section →
  // paragraph → sentence. left_refs/right_refs hold the indices of the source
  // units a row covers, so 1:1, 1:many, many:1 and explicitly unmatched
  // segments are all representable and correctable.
  `CREATE TABLE IF NOT EXISTS private_alignment_units (
     id TEXT PRIMARY KEY,
     relationship_id TEXT NOT NULL
       REFERENCES private_source_relationships(id) ON DELETE CASCADE,
     level TEXT NOT NULL CHECK (level IN ('section','paragraph','sentence')),
     parent_id TEXT REFERENCES private_alignment_units(id) ON DELETE CASCADE,
     ordinal INT NOT NULL,
     cardinality TEXT NOT NULL CHECK (cardinality IN
       ('one_to_one','one_to_many','many_to_one','unmatched_left','unmatched_right')),
     left_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
     right_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
     left_text TEXT,
     right_text TEXT,
     method TEXT NOT NULL,
     signals JSONB NOT NULL DEFAULT '[]'::jsonb,
     confidence NUMERIC(6,4) NOT NULL DEFAULT 0,
     review_state TEXT NOT NULL DEFAULT 'source_import_unreviewed'
       CHECK (review_state IN ('source_import_unreviewed','in_review','accepted_candidate','rejected')),
     adjusted BOOLEAN NOT NULL DEFAULT FALSE,
     reviewer_note TEXT,
     decided_by TEXT,
     decided_by_name TEXT,
     decided_by_role TEXT,
     decided_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (relationship_id, level, ordinal)
   )`,
  `CREATE INDEX IF NOT EXISTS private_alignment_units_rel
     ON private_alignment_units (relationship_id, level, ordinal)`,
  `CREATE INDEX IF NOT EXISTS private_alignment_units_parent
     ON private_alignment_units (parent_id)`,

  // Immutable log of every rights/access/review/training decision taken on a
  // private source, a relationship candidate or an alignment unit.
  `CREATE TABLE IF NOT EXISTS private_review_decisions (
     id BIGSERIAL PRIMARY KEY,
     subject_kind TEXT NOT NULL
       CHECK (subject_kind IN ('v13_source','relationship','alignment_unit')),
     subject_id TEXT NOT NULL,
     decision_type TEXT NOT NULL
       CHECK (decision_type IN ('rights','access','review','training')),
     from_value TEXT,
     to_value TEXT NOT NULL,
     note TEXT,
     decided_by TEXT,
     decided_by_name TEXT NOT NULL,
     decided_by_role TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS private_review_decisions_subject
     ON private_review_decisions (subject_kind, subject_id, created_at)`,

  // Bookkeeping for the deterministic scanner: the same inputs and the same
  // generator produce the same proposals, so a repeated run is a no-op.
  `CREATE TABLE IF NOT EXISTS private_relationship_runs (
     id TEXT PRIMARY KEY,
     generator_version TEXT NOT NULL,
     input_key TEXT NOT NULL,
     sources_scanned INT NOT NULL,
     pairs_examined INT NOT NULL,
     proposed INT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (generator_version, input_key)
   )`,

  // ── Public projection of the v1.3 batch ──────────────────────
  // The staged v1.3 material stays private. What these tables hold is the
  // part that can be public without republishing a restricted line: a
  // description of each source, and a derived index of word forms attested
  // across several sources. Every value written here has passed the
  // allowlist in lib/public-projection.js.
  //
  // The derivation runs in resumable stages for the same reason the private
  // staging does — the process is suspended between requests, so a stage that
  // cannot be interrupted is a stage that never finishes.
  `CREATE TABLE IF NOT EXISTS public_projection_stages (
     id TEXT PRIMARY KEY,
     stage TEXT NOT NULL,
     input_key TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'in_progress'
       CHECK (status IN ('in_progress','complete')),
     resume_offset BIGINT NOT NULL DEFAULT 0,
     produced_count BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (stage, input_key)
   )`,
  // Stages that walk an alphabetical key rather than a numeric one resume from
  // the last key they committed.
  `ALTER TABLE public_projection_stages
     ADD COLUMN IF NOT EXISTS resume_cursor TEXT NOT NULL DEFAULT ''`,

  // One row per substantive source, in its published form. `ref` is the only
  // identifier that leaves the server; the private sequence it derives from
  // stays a column so the derivation can be resumed and re-run idempotently.
  `CREATE TABLE IF NOT EXISTS public_sources (
     ref TEXT PRIMARY KEY,
     source_sequence INT NOT NULL UNIQUE,
     title TEXT,
     attributed_to TEXT,
     document_year INT,
     name_source TEXT NOT NULL
       CHECK (name_source IN ('document_title','source_family','material_type')),
     family_id TEXT,
     group_id TEXT,
     material_type TEXT NOT NULL,
     language_scope TEXT NOT NULL,
     corpus_role TEXT,
     recommended_use TEXT,
     extraction_status TEXT,
     extraction_quality TEXT,
     rights_state TEXT NOT NULL,
     priority TEXT,
     file_format TEXT NOT NULL,
     script_profile TEXT NOT NULL,
     contribution TEXT NOT NULL,
     urls JSONB NOT NULL DEFAULT '[]'::jsonb,
     pages INT,
     word_count BIGINT,
     text_chars BIGINT,
     bytes BIGINT,
     candidate_rows INT NOT NULL DEFAULT 0,
     word_form_count INT NOT NULL DEFAULT 0,
     is_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
     is_canonical_copy BOOLEAN NOT NULL DEFAULT FALSE,
     consent_withheld BOOLEAN NOT NULL DEFAULT FALSE,
     text_published BOOLEAN NOT NULL DEFAULT FALSE,
     search_text TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS public_sources_facets
     ON public_sources (material_type, language_scope, rights_state)`,
  `CREATE INDEX IF NOT EXISTS public_sources_group
     ON public_sources (group_id)`,
  // No trigram index here on purpose: the library is 293 rows, so a sequential
  // ILIKE scan is faster than the planner's alternatives and does not make the
  // schema depend on an extension the production role may not be able to
  // install.

  // Intermediate tallies: one row per (form, source). This is the stage that
  // makes the re-identification guard possible — a form is only published once
  // this table shows it in more than one source — and it is also the stage that
  // has to survive interruption, so it is written in committed chunks keyed by
  // the source sequence it has reached.
  `CREATE TABLE IF NOT EXISTS public_word_form_tallies (
     form TEXT NOT NULL,
     source_sequence INT NOT NULL,
     occurrences INT NOT NULL,
     PRIMARY KEY (form, source_sequence)
   )`,

  // The published index. Forms attested in a single source never reach it.
  `CREATE TABLE IF NOT EXISTS public_word_forms (
     form TEXT PRIMARY KEY,
     occurrences BIGINT NOT NULL,
     sources INT NOT NULL,
     script_profile TEXT NOT NULL,
     lak_marker BOOLEAN NOT NULL DEFAULT FALSE,
     confidence TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS public_word_forms_rank
     ON public_word_forms (sources DESC, occurrences DESC)`,
  `CREATE INDEX IF NOT EXISTS public_word_forms_facets
     ON public_word_forms (script_profile, lak_marker)`,
  `CREATE INDEX IF NOT EXISTS public_word_forms_prefix
     ON public_word_forms (form text_pattern_ops)`,
];

async function migrate() {
  for (const sql of MIGRATIONS) {
    await pool.query(sql);
  }
  console.log('Validation, gamification & translation-lab schema ready');
}

module.exports = { pool, migrate };
