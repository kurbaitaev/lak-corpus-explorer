CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS corpus_sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  creator_credit TEXT,
  canonical_url TEXT,
  persistent_id TEXT,
  spdx_license TEXT,
  license_url TEXT,
  rights_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (rights_status IN ('unknown','open_license','public_domain','permission_recorded','permission_scope_unverified','restricted')),
  access_status TEXT NOT NULL DEFAULT 'restricted'
    CHECK (access_status IN ('restricted','private_research','authenticated','public')),
  review_status TEXT NOT NULL DEFAULT 'source_import_unreviewed'
    CHECK (review_status IN ('source_import_unreviewed','source_verified','rights_verified')),
  attribution_text TEXT,
  share_alike BOOLEAN NOT NULL DEFAULT FALSE,
  public_search_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  training_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT public_search_allowed OR (
    access_status = 'public' AND rights_status IN ('open_license','public_domain','permission_recorded')
  )),
  CHECK (NOT training_allowed OR rights_status IN ('open_license','public_domain','permission_recorded'))
);

CREATE TABLE IF NOT EXISTS corpus_import_batches (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES corpus_sources(id),
  schema_version TEXT NOT NULL,
  importer_version TEXT NOT NULL,
  input_manifest_sha256 TEXT NOT NULL,
  artifact_sha256 JSONB NOT NULL,
  expected_counts JSONB NOT NULL,
  observed_counts JSONB,
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing','validated','imported','failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (source_id, input_manifest_sha256, importer_version)
);

CREATE TABLE IF NOT EXISTS corpus_documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES corpus_sources(id),
  source_document_ref TEXT NOT NULL,
  title TEXT,
  author TEXT,
  editor TEXT,
  bibliography TEXT,
  year TEXT,
  genre TEXT,
  variety TEXT,
  script TEXT,
  raw_metadata JSONB NOT NULL DEFAULT '{}',
  source_file TEXT NOT NULL,
  source_file_sha256 TEXT NOT NULL,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES corpus_import_batches(id),
  UNIQUE (source_id, source_document_ref)
);

CREATE TABLE IF NOT EXISTS corpus_segments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES corpus_documents(id),
  source_segment_ref TEXT NOT NULL,
  forest_id TEXT,
  legacy_record_id TEXT,
  paragraph TEXT,
  section TEXT,
  ordinal INT NOT NULL CHECK (ordinal > 0),
  text_original TEXT NOT NULL,
  text_normalized TEXT NOT NULL,
  text_parallel_cyrillic TEXT,
  translation_en TEXT,
  content_hash TEXT NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES corpus_import_batches(id),
  UNIQUE (document_id, source_segment_ref),
  UNIQUE (legacy_record_id)
);
CREATE INDEX IF NOT EXISTS corpus_segments_normalized_idx ON corpus_segments (text_normalized text_pattern_ops);

CREATE TABLE IF NOT EXISTS corpus_wordforms (
  id TEXT PRIMARY KEY,
  language_code TEXT NOT NULL DEFAULT 'lbe',
  normalized_form TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  display_form TEXT NOT NULL,
  UNIQUE (language_code, normalization_version, normalized_form)
);
CREATE INDEX IF NOT EXISTS corpus_wordforms_normalized_idx ON corpus_wordforms (normalized_form text_pattern_ops);

CREATE TABLE IF NOT EXISTS corpus_tokens (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES corpus_segments(id),
  wordform_id TEXT NOT NULL REFERENCES corpus_wordforms(id),
  ordinal INT NOT NULL CHECK (ordinal > 0),
  source_token_ref TEXT NOT NULL,
  surface_original TEXT NOT NULL,
  source_from TEXT,
  source_to TEXT,
  raw_tag TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES corpus_import_batches(id),
  UNIQUE (segment_id, ordinal),
  UNIQUE (segment_id, source_token_ref)
);
CREATE INDEX IF NOT EXISTS corpus_tokens_wordform_idx ON corpus_tokens (wordform_id, segment_id);
CREATE INDEX IF NOT EXISTS corpus_tokens_raw_tag_idx ON corpus_tokens (raw_tag, segment_id);

CREATE TABLE IF NOT EXISTS corpus_lemma_keys (
  id TEXT PRIMARY KEY,
  language_code TEXT NOT NULL DEFAULT 'lbe',
  normalized_form TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  display_form TEXT NOT NULL,
  UNIQUE (language_code, normalization_version, normalized_form)
);
CREATE INDEX IF NOT EXISTS corpus_lemma_keys_normalized_idx ON corpus_lemma_keys (normalized_form text_pattern_ops);

CREATE TABLE IF NOT EXISTS corpus_token_analyses (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES corpus_tokens(id),
  lemma_key_id TEXT NOT NULL REFERENCES corpus_lemma_keys(id),
  lemma_original TEXT NOT NULL,
  raw_tag TEXT NOT NULL,
  source_pos TEXT,
  source_feature_atoms TEXT[] NOT NULL DEFAULT '{}',
  definition TEXT,
  evidence_class TEXT NOT NULL CHECK (evidence_class = 'source_annotation'),
  source_reference TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'source_import_unreviewed'
    CHECK (review_status IN ('source_import_unreviewed','community_supported','expert_verified','rejected')),
  content_hash TEXT NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES corpus_import_batches(id),
  UNIQUE (token_id, evidence_class, source_reference)
);
CREATE INDEX IF NOT EXISTS corpus_analyses_lemma_idx ON corpus_token_analyses (lemma_key_id, token_id);
CREATE INDEX IF NOT EXISTS corpus_analyses_tag_idx ON corpus_token_analyses (raw_tag, token_id);
CREATE INDEX IF NOT EXISTS corpus_analyses_pos_idx ON corpus_token_analyses (source_pos, token_id);
CREATE INDEX IF NOT EXISTS corpus_analyses_features_idx ON corpus_token_analyses USING GIN (source_feature_atoms);

CREATE TABLE IF NOT EXISTS corpus_lexical_evidence (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES corpus_sources(id),
  source_entry_ref TEXT NOT NULL,
  lemma_key_id TEXT REFERENCES corpus_lemma_keys(id),
  original_form TEXT NOT NULL,
  normalized_form TEXT NOT NULL,
  latin_form TEXT,
  source_pos TEXT,
  gloss_ru TEXT,
  gloss_en TEXT,
  variety TEXT,
  evidence_class TEXT NOT NULL,
  rights_status TEXT NOT NULL DEFAULT 'unknown',
  access_status TEXT NOT NULL DEFAULT 'restricted',
  review_status TEXT NOT NULL DEFAULT 'source_import_unreviewed',
  raw_payload JSONB NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  UNIQUE (source_id, source_entry_ref)
);

CREATE TABLE IF NOT EXISTS corpus_grammar_evidence (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES corpus_sources(id),
  source_record_ref TEXT NOT NULL,
  table_name TEXT,
  feature_name TEXT,
  variety TEXT,
  example TEXT,
  transliteration TEXT,
  gloss TEXT,
  translation_ru TEXT,
  translation_en TEXT,
  source_citation TEXT,
  source_page TEXT,
  feature_values JSONB NOT NULL DEFAULT '{}',
  feature_atoms TEXT[] NOT NULL DEFAULT '{}',
  rights_status TEXT NOT NULL DEFAULT 'unknown',
  access_status TEXT NOT NULL DEFAULT 'restricted',
  review_status TEXT NOT NULL DEFAULT 'source_import_unreviewed',
  raw_payload JSONB NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  UNIQUE (source_id, source_record_ref)
);
CREATE INDEX IF NOT EXISTS corpus_grammar_features_idx ON corpus_grammar_evidence USING GIN (feature_atoms);

CREATE TABLE IF NOT EXISTS morphology_proposals (
  id TEXT PRIMARY KEY,
  wordform_id TEXT NOT NULL REFERENCES corpus_wordforms(id),
  proposed_lemma_key_id TEXT NOT NULL REFERENCES corpus_lemma_keys(id),
  proposed_raw_tag TEXT,
  method TEXT NOT NULL CHECK (method IN ('observed_same_wordform','exact_dictionary_headword','learned_suffix_transformation')),
  rule JSONB,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  support_count INT NOT NULL CHECK (support_count >= 0),
  frequency INT NOT NULL CHECK (frequency > 0),
  generator_version TEXT NOT NULL,
  evaluation_run_ref TEXT,
  evidence_class TEXT NOT NULL CHECK (evidence_class = 'deterministic_prediction'),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','community_supported','disputed','expert_accepted','corrected','rejected','uncertain')),
  access_status TEXT NOT NULL DEFAULT 'authenticated'
    CHECK (access_status IN ('authenticated','restricted')),
  rights_status TEXT NOT NULL DEFAULT 'mixed_or_unverified',
  public_search_eligible BOOLEAN NOT NULL DEFAULT FALSE CHECK (public_search_eligible = FALSE),
  training_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  proposal_version INT NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES corpus_import_batches(id)
);
CREATE INDEX IF NOT EXISTS morphology_proposals_queue_idx ON morphology_proposals (state, confidence DESC, frequency DESC);

CREATE TABLE IF NOT EXISTS morphology_proposal_occurrences (
  proposal_id TEXT NOT NULL REFERENCES morphology_proposals(id),
  token_id TEXT NOT NULL REFERENCES corpus_tokens(id),
  PRIMARY KEY (proposal_id, token_id)
);
CREATE INDEX IF NOT EXISTS morphology_occurrences_token_idx ON morphology_proposal_occurrences (token_id);

CREATE TABLE IF NOT EXISTS morphology_proposal_evidence (
  id BIGSERIAL PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES morphology_proposals(id),
  source_id TEXT,
  source_label TEXT NOT NULL,
  source_record_ref TEXT NOT NULL DEFAULT '',
  evidence_type TEXT NOT NULL,
  rights_status TEXT NOT NULL DEFAULT 'unknown',
  access_status TEXT NOT NULL DEFAULT 'restricted',
  content_visible BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (proposal_id, source_label, source_record_ref)
);

CREATE TABLE IF NOT EXISTS morphology_validation_links (
  proposal_id TEXT PRIMARY KEY REFERENCES morphology_proposals(id),
  validation_task_id TEXT NOT NULL UNIQUE REFERENCES validation_tasks(id),
  proposal_version INT NOT NULL
);

CREATE TABLE IF NOT EXISTS morphology_decisions (
  id BIGSERIAL PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES morphology_proposals(id),
  validation_task_id TEXT REFERENCES validation_tasks(id),
  proposal_version INT NOT NULL,
  task_version INT,
  verdict TEXT NOT NULL CHECK (verdict IN ('accept','reject','uncertain','correct')),
  corrected_lemma TEXT,
  corrected_tag TEXT,
  contributor_id TEXT REFERENCES contributors(id),
  contributor_role TEXT NOT NULL,
  evidence_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (verdict <> 'correct' OR corrected_lemma IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS morphology_decisions_proposal_idx ON morphology_decisions (proposal_id, created_at);

CREATE TABLE IF NOT EXISTS corpus_wordform_lemma_relations (
  id BIGSERIAL PRIMARY KEY,
  wordform_id TEXT NOT NULL REFERENCES corpus_wordforms(id),
  lemma_key_id TEXT NOT NULL REFERENCES corpus_lemma_keys(id),
  basis TEXT NOT NULL CHECK (basis IN ('expert_proposal_decision','source_generalization')),
  proposal_id TEXT REFERENCES morphology_proposals(id),
  review_status TEXT NOT NULL CHECK (review_status IN ('expert_verified','source_verified')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wordform_id, lemma_key_id, basis)
);

-- Broaden the existing validation kind exactly once. The named check created
-- by PostgreSQL can differ across older databases, so locate only the check
-- that contains the established validation kinds and replace it in this
-- versioned transaction. No rows or review history are rewritten.
DO $$
DECLARE existing_check TEXT;
BEGIN
  SELECT c.conname INTO existing_check
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
   WHERE t.relname='validation_tasks' AND c.contype='c'
     AND pg_get_constraintdef(c.oid) LIKE '%translation_correctness%'
   LIMIT 1;
  IF existing_check IS NOT NULL
     AND pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname=existing_check AND conrelid='validation_tasks'::regclass)) NOT LIKE '%lemma_analysis%' THEN
    EXECUTE format('ALTER TABLE validation_tasks DROP CONSTRAINT %I', existing_check);
    ALTER TABLE validation_tasks ADD CONSTRAINT validation_tasks_kind_check_v2
      CHECK (kind IN ('translation_correctness','sense_choice','moon_vs_month','dialect',
        'spelling','ocr_quality','example_usefulness','source_reliability','lemma_analysis')) NOT VALID;
    ALTER TABLE validation_tasks VALIDATE CONSTRAINT validation_tasks_kind_check_v2;
  END IF;
END $$;

ALTER TABLE validation_tasks ADD COLUMN IF NOT EXISTS subject_type TEXT;
ALTER TABLE validation_tasks ADD COLUMN IF NOT EXISTS subject_id TEXT;
CREATE INDEX IF NOT EXISTS validation_tasks_subject_idx ON validation_tasks (subject_type, subject_id);
ALTER TABLE validation_votes ADD COLUMN IF NOT EXISTS response JSONB;
