-- Canonical bilingual lexicon synthesis. Source entries remain immutable and
-- separately citable; canonical Lak lemma keys only provide a shared index.

CREATE TABLE IF NOT EXISTS lexicon_import_batches (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  importer_version TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  expected_counts JSONB NOT NULL,
  observed_counts JSONB,
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing','imported','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (bundle_sha256, importer_version)
);

CREATE TABLE IF NOT EXISTS lexicon_entries (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES corpus_sources(id),
  source_entry_ref TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('ru_lbe','lbe_ru','lbe_en','multilingual')),
  headword_language TEXT NOT NULL,
  headword_original TEXT NOT NULL,
  headword_normalized TEXT NOT NULL,
  homonym_number INT,
  part_of_speech TEXT,
  noun_class TEXT,
  source_locator TEXT,
  source_url TEXT,
  raw_entry TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'source_import_unreviewed',
  content_hash TEXT NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES lexicon_import_batches(id),
  UNIQUE (source_id, source_entry_ref)
);
CREATE INDEX IF NOT EXISTS lexicon_entries_headword_idx
  ON lexicon_entries (headword_language, headword_normalized text_pattern_ops);

CREATE TABLE IF NOT EXISTS lexicon_senses (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES lexicon_entries(id) ON DELETE CASCADE,
  ordinal INT NOT NULL CHECK (ordinal > 0),
  gloss_ru TEXT,
  gloss_en TEXT,
  definition TEXT,
  usage_label TEXT,
  raw_sense TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (entry_id, ordinal)
);
CREATE INDEX IF NOT EXISTS lexicon_senses_entry_idx ON lexicon_senses (entry_id, ordinal);

CREATE TABLE IF NOT EXISTS lexicon_forms (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES lexicon_entries(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  form_original TEXT NOT NULL,
  form_normalized TEXT NOT NULL,
  form_role TEXT NOT NULL CHECK (form_role IN
    ('headword','inflected_form','translation_equivalent','variant','phrase')),
  feature_atoms TEXT[] NOT NULL DEFAULT '{}',
  source_explicit BOOLEAN NOT NULL DEFAULT TRUE,
  raw_note TEXT,
  content_hash TEXT NOT NULL,
  UNIQUE (entry_id, language_code, form_normalized, form_role)
);
CREATE INDEX IF NOT EXISTS lexicon_forms_lookup_idx
  ON lexicon_forms (language_code, form_normalized text_pattern_ops);
CREATE INDEX IF NOT EXISTS lexicon_forms_features_idx ON lexicon_forms USING GIN (feature_atoms);

CREATE TABLE IF NOT EXISTS lexicon_entry_lemmas (
  entry_id TEXT NOT NULL REFERENCES lexicon_entries(id) ON DELETE CASCADE,
  lemma_key_id TEXT NOT NULL REFERENCES corpus_lemma_keys(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN
    ('headword','translation_equivalent','paradigm_member','source_group')),
  source_form_normalized TEXT NOT NULL,
  source_explicit BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (entry_id, lemma_key_id, relation_type)
);
CREATE INDEX IF NOT EXISTS lexicon_entry_lemmas_lemma_idx
  ON lexicon_entry_lemmas (lemma_key_id, entry_id);

CREATE TABLE IF NOT EXISTS lexicon_search_terms (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES lexicon_entries(id) ON DELETE CASCADE,
  sense_id TEXT REFERENCES lexicon_senses(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  term_original TEXT NOT NULL,
  term_normalized TEXT NOT NULL,
  stem_key TEXT,
  term_type TEXT NOT NULL CHECK (term_type IN
    ('headword','inflected_form','translation_equivalent','gloss','definition','phrase')),
  weight INT NOT NULL CHECK (weight > 0),
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lexicon_search_terms_exact_idx
  ON lexicon_search_terms (language_code, term_normalized, weight DESC);
CREATE INDEX IF NOT EXISTS lexicon_search_terms_stem_idx
  ON lexicon_search_terms (language_code, stem_key, weight DESC) WHERE stem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS lexicon_search_terms_entry_idx ON lexicon_search_terms (entry_id, weight DESC);

ALTER TABLE corpus_wordform_lemma_relations
  ADD COLUMN IF NOT EXISTS source_entry_id TEXT REFERENCES lexicon_entries(id);
ALTER TABLE corpus_wordform_lemma_relations
  ADD COLUMN IF NOT EXISTS feature_atoms TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS corpus_wordform_lemma_relations_lemma_idx
  ON corpus_wordform_lemma_relations (lemma_key_id, wordform_id);
