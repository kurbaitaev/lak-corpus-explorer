-- Canonical evidence spine for page-addressable sources, assertion history,
-- reproducible datasets, and model evaluation. This migration is additive.

CREATE TABLE IF NOT EXISTS corpus_assets (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES corpus_sources(id),
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  storage_uri TEXT NOT NULL,
  original_name TEXT,
  parent_asset_id TEXT REFERENCES corpus_assets(id),
  rights_status TEXT NOT NULL DEFAULT 'unknown',
  access_status TEXT NOT NULL DEFAULT 'restricted',
  consent_status TEXT NOT NULL DEFAULT 'not_applicable',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, sha256)
);

CREATE TABLE IF NOT EXISTS corpus_canvases (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES corpus_documents(id),
  asset_id TEXT REFERENCES corpus_assets(id),
  ordinal INT NOT NULL CHECK (ordinal > 0),
  page_label TEXT,
  width INT CHECK (width IS NULL OR width > 0),
  height INT CHECK (height IS NULL OR height > 0),
  iiif_canvas_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal)
);

CREATE TABLE IF NOT EXISTS corpus_regions (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL REFERENCES corpus_canvases(id),
  parent_region_id TEXT REFERENCES corpus_regions(id),
  region_type TEXT NOT NULL DEFAULT 'text',
  ordinal INT NOT NULL CHECK (ordinal > 0),
  x REAL,
  y REAL,
  width REAL,
  height REAL,
  polygon JSONB,
  source_locator TEXT,
  CHECK ((x IS NULL AND y IS NULL AND width IS NULL AND height IS NULL)
    OR (x >= 0 AND y >= 0 AND width > 0 AND height > 0)),
  UNIQUE (canvas_id, ordinal)
);

ALTER TABLE corpus_segments ADD COLUMN IF NOT EXISTS canvas_id TEXT REFERENCES corpus_canvases(id);
ALTER TABLE corpus_segments ADD COLUMN IF NOT EXISTS region_id TEXT REFERENCES corpus_regions(id);
ALTER TABLE corpus_segments ADD COLUMN IF NOT EXISTS text_diplomatic TEXT;
ALTER TABLE corpus_segments ADD COLUMN IF NOT EXISTS language_code TEXT NOT NULL DEFAULT 'lbe';

CREATE TABLE IF NOT EXISTS corpus_assertions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN
    ('source','document','canvas','region','segment','token','wordform','lemma','analysis','translation','media_span')),
  target_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value JSONB NOT NULL,
  evidence_class TEXT NOT NULL CHECK (evidence_class IN
    ('source_text','source_annotation','expert_annotation','community_report',
     'deterministic_derivation','model_prediction','generated_hypothesis')),
  agent_type TEXT NOT NULL CHECK (agent_type IN ('source','person','rule','model','importer')),
  agent_id TEXT NOT NULL,
  method_name TEXT NOT NULL,
  method_version TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  review_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (review_status IN ('unreviewed','source_import_unreviewed','community_supported',
      'expert_verified','rejected','superseded')),
  source_reference TEXT,
  supersedes_id TEXT REFERENCES corpus_assertions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS corpus_assertions_target_idx
  ON corpus_assertions (target_type, target_id, predicate, review_status);
CREATE INDEX IF NOT EXISTS corpus_assertions_evidence_idx
  ON corpus_assertions (evidence_class, review_status);

CREATE TABLE IF NOT EXISTS corpus_assertion_decisions (
  id BIGSERIAL PRIMARY KEY,
  assertion_id TEXT NOT NULL REFERENCES corpus_assertions(id),
  decision TEXT NOT NULL CHECK (decision IN ('accept','reject','correct','uncertain','supersede')),
  corrected_value JSONB,
  reason TEXT,
  reviewer_id TEXT REFERENCES contributors(id),
  reviewer_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (decision <> 'correct' OR corrected_value IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS corpus_assertion_decisions_assertion_idx
  ON corpus_assertion_decisions (assertion_id, created_at);

CREATE TABLE IF NOT EXISTS corpus_translation_units (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES corpus_segments(id),
  target_language TEXT NOT NULL,
  text_original TEXT NOT NULL,
  text_normalized TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  source_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corpus_translation_units_segment_idx
  ON corpus_translation_units (segment_id, target_language, review_status);

CREATE TABLE IF NOT EXISTS corpus_alignments (
  id TEXT PRIMARY KEY,
  left_type TEXT NOT NULL CHECK (left_type IN ('segment','translation','media_span')),
  left_ids TEXT[] NOT NULL,
  right_type TEXT NOT NULL CHECK (right_type IN ('segment','translation','media_span')),
  right_ids TEXT[] NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('one_to_one','one_to_many','many_to_one','many_to_many','reordered')),
  evidence_class TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  source_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(left_ids) > 0 AND cardinality(right_ids) > 0)
);

CREATE TABLE IF NOT EXISTS corpus_media (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES corpus_sources(id),
  asset_id TEXT NOT NULL REFERENCES corpus_assets(id),
  duration_ms BIGINT NOT NULL CHECK (duration_ms > 0),
  channels INT CHECK (channels IS NULL OR channels > 0),
  sample_rate INT CHECK (sample_rate IS NULL OR sample_rate > 0),
  codec TEXT,
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  access_status TEXT NOT NULL DEFAULT 'restricted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS corpus_media_spans (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES corpus_media(id),
  start_ms BIGINT NOT NULL CHECK (start_ms >= 0),
  end_ms BIGINT NOT NULL CHECK (end_ms > start_ms),
  speaker_ref TEXT,
  segment_id TEXT REFERENCES corpus_segments(id),
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corpus_media_spans_time_idx
  ON corpus_media_spans (media_id, start_ms, end_ms);

CREATE TABLE IF NOT EXISTS corpus_dataset_snapshots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  task TEXT NOT NULL,
  query_spec JSONB NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  counts JSONB NOT NULL,
  split_policy JSONB NOT NULL,
  rights_policy JSONB NOT NULL,
  leakage_check JSONB NOT NULL,
  storage_uri TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','validated','released','withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS corpus_dataset_members (
  snapshot_id TEXT NOT NULL REFERENCES corpus_dataset_snapshots(id),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  split TEXT NOT NULL CHECK (split IN ('train','dev','test')),
  content_hash TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS corpus_dataset_members_split_idx
  ON corpus_dataset_members (snapshot_id, split);

CREATE TABLE IF NOT EXISTS corpus_pipeline_runs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  code_version TEXT NOT NULL,
  input_snapshot_id TEXT REFERENCES corpus_dataset_snapshots(id),
  base_model TEXT,
  model_version TEXT,
  parameters JSONB NOT NULL DEFAULT '{}',
  metrics JSONB NOT NULL DEFAULT '{}',
  artifact_uri TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS corpus_pipeline_runs_task_idx
  ON corpus_pipeline_runs (task, created_at DESC);
