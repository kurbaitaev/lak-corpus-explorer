'use strict';

// The projection boundary for the v1.3 research batch.
//
// The batch itself stays private: 293 substantive files that were received for
// research under permissions that have not been cleared. What *can* be public
// is a description of the collection — what kind of material each source is,
// what language it is in, what role it plays in the project, what rights state
// it is in — plus a derived index of Lak word forms. None of that requires
// republishing a single line of restricted source text.
//
// This module is the only place that decides what may cross that line, and it
// fails closed: a value that is not explicitly permitted is not emitted, it
// throws. Adding a field to a public payload without declaring it here is a
// build error, not a silent leak.
//
// ── What is never published, and why ──────────────────────────────────────
//   absolute_source_path   the sender's own filesystem layout
//   relative_path          directory names that group and identify material
//   sha256                 lets a holder of a file confirm we have that file
//   extracted_text_relpath names our private extraction artefacts
//   received_from          one individual across all 320 records — personal data
//   file_description       prose describing what a restricted file *says*
//   author                 see publishableAuthor(): the PDF "author" field is a
//                          document-creator slot, and in this batch it holds
//                          account usernames as often as it holds authorship
//   any source text        the whole point of the restriction
//
// Published in their place are `corpus_role` and `recommended_use`, which
// describe how this project handles a source rather than what the source says.

const WITHHELD_MANIFEST_KEYS = Object.freeze([
  'absolute_source_path', 'relative_path', 'sha256', 'extracted_text_relpath',
  'received_from', 'file_description', 'source_path', 'source_sha256',
  'text', 'extracted_text', 'body', 'content', 'notes',
]);

// Fragments that identify the private holding rather than the work. A
// bibliographic string containing one of these is not published, whatever else
// it looks like. Kept here so the release gate can assert the same list.
const PRIVATE_PATH_MARKERS = Object.freeze([
  '_laktextmaterials', 'laktextmaterials', '/users/', 'c:\\', 'kurbaitaev',
  'source_relative_path', 'extracted_text_relpath', '.jsonl',
]);

/* ── Canonical vocabularies ──────────────────────────────────────────────
 * Every enumerated value the projection may emit, exactly as the audit
 * recorded it. These are canonical data values, not display strings: the
 * interface localizes them by key. A source carrying a value that is not
 * listed here is a package that changed under us, and the derivation stops
 * rather than guessing.
 */
const VOCAB = Object.freeze({
  material_type: Object.freeze([
    'translation_or_parallel_text', 'academic_reference', 'grammar_or_linguistic_analysis',
    'primary_text_or_folklore', 'educational_material', 'dictionary_or_lexicon',
    'non_lak_comparative', 'historical_cultural_reference', 'research_administration',
    'fieldwork_transcript', 'elicitation_questionnaire', 'archive_container',
    'system_metadata',
  ]),
  language_scope: Object.freeze([
    'Lak-Russian mixed', 'Latin-script/English or transliteration',
    'Lak-dominant or Lak examples', 'Lak-related, text signal insufficient',
    'Russian-dominant', 'non-Lak Caucasian/comparative', 'undetermined',
  ]),
  extraction_status: Object.freeze([
    'full_text', 'full_text_layer', 'ocr_full_document', 'ocr_full_image',
    'archive_member_list', 'empty_document_verified',
  ]),
  extraction_quality: Object.freeze([
    'usable_private_extraction', 'not_applicable', 'very_short',
  ]),
  rights_state: Object.freeze([
    'pending_permission', 'public_domain_candidate_review',
  ]),
  priority: Object.freeze(['P0', 'P1', 'P2', 'P3']),
  file_format: Object.freeze(['pdf', 'doc', 'djvu', 'tiff', 'jpg', 'rtf', 'archive', 'other']),
  script_profile: Object.freeze(['cyrillic', 'latin', 'mixed', 'none']),
  name_source: Object.freeze(['document_title', 'source_family', 'material_type']),
  contribution: Object.freeze([
    'word_forms', 'alignment_candidate', 'reference_only', 'withheld_pending_review',
  ]),
  confidence: Object.freeze(['high', 'medium', 'low']),
  // corpus_role and recommended_use are curated sentences written by the audit,
  // one per material type. They are published verbatim because they describe
  // the project's handling of a source, never its contents.
  corpus_role: Object.freeze([
    'private alignment candidate', 'bibliographic and linguistic reference',
    'grammar evidence and search-rule source', 'private sentence and genre candidate',
    'curriculum and controlled-language evidence', 'private lexicon candidate',
    'comparative reference and negative control',
    'cultural context and named-entity reference',
    'project provenance and research-history record',
    'elicitation design and expert benchmark source',
    'private elicitation and aligned-gloss candidate', 'preservation and member inventory',
    'non-content inventory record',
  ]),
  // The system-metadata receipts the audit counted alongside the substantive
  // sources. Which system wrote the file is a fixed answer, never a string
  // read from the private path.
  receipt_kind: Object.freeze(['macos_folder_metadata']),
  receipt_disposition: Object.freeze(['no_extractable_text', 'provenance_witness_only']),
});

// The curated public family names, shared with the research update. Only one
// of these seven may stand in for a missing document title: they were written
// for publication. A family key derived from the private directory layout is
// never published, because the directory names are part of what is withheld.
const { FAMILY_IDS, FAMILY_TITLES, familyIdForPath } = require('./source-families');

// Material whose filenames and metadata can name the people who were recorded.
// These sources appear in the library as counts and canonical facets only: no
// display name, no title, no date, no link. Consent to be catalogued by name
// was never given, and the audit cannot infer it.
const CONSENT_SENSITIVE_TYPES = Object.freeze([
  'fieldwork_transcript', 'elicitation_questionnaire',
]);

/* ── Field rules ─────────────────────────────────────────────────────────
 * Every key that may appear in a public payload, with the check its value
 * must pass. `assertPublicSafe` walks a payload against this table and throws
 * on anything it does not recognise.
 */
const FIELD_RULES = Object.freeze({
  // Identity
  ref:                { kind: 'ref' },
  family_id:          { kind: 'slug', nullable: true },
  group_id:           { kind: 'opaque', nullable: true },

  // Receipts (system-metadata records, published as canonical facets only)
  receipt_kind:       { kind: 'canonical', vocab: 'receipt_kind' },
  disposition:        { kind: 'canonical', vocab: 'receipt_disposition' },

  // Canonical facets
  material_type:      { kind: 'canonical', vocab: 'material_type' },
  language_scope:     { kind: 'canonical', vocab: 'language_scope' },
  extraction_status:  { kind: 'canonical', vocab: 'extraction_status', nullable: true },
  extraction_quality: { kind: 'canonical', vocab: 'extraction_quality', nullable: true },
  rights_state:       { kind: 'canonical', vocab: 'rights_state' },
  priority:           { kind: 'canonical', vocab: 'priority', nullable: true },
  file_format:        { kind: 'canonical', vocab: 'file_format' },
  script_profile:     { kind: 'canonical', vocab: 'script_profile' },
  name_source:        { kind: 'canonical', vocab: 'name_source' },
  contribution:       { kind: 'canonical', vocab: 'contribution' },
  confidence:         { kind: 'canonical', vocab: 'confidence' },
  corpus_role:        { kind: 'canonical', vocab: 'corpus_role', nullable: true },
  recommended_use:    { kind: 'curated_sentence', nullable: true },

  // Bibliographic metadata, published only when it survives sanitisation
  title:              { kind: 'bibliographic', nullable: true },
  attributed_to:      { kind: 'bibliographic', nullable: true },
  document_year:      { kind: 'year', nullable: true },
  urls:               { kind: 'list', of: 'url' },

  // Aggregates. A count describes the collection, never its contents.
  pages:              { kind: 'count', nullable: true },
  word_count:         { kind: 'count', nullable: true },
  text_chars:         { kind: 'count', nullable: true },
  bytes:              { kind: 'count', nullable: true },
  candidate_rows:     { kind: 'count' },
  word_form_count:    { kind: 'count' },
  group_size:         { kind: 'count' },
  sources:            { kind: 'count' },
  occurrences:        { kind: 'count' },
  form_occurrences:   { kind: 'count' },
  line:               { kind: 'count' },
  total:              { kind: 'count' },
  page:               { kind: 'count' },
  pages_total:        { kind: 'count' },
  limit:              { kind: 'count' },
  count:              { kind: 'count' },
  items_total:        { kind: 'count' },
  sources_total:      { kind: 'count' },
  receipts_total:     { kind: 'count' },

  // Flags
  is_duplicate:       { kind: 'bool' },
  is_canonical_copy:  { kind: 'bool' },
  consent_withheld:   { kind: 'bool' },
  text_published:     { kind: 'bool' },
  lak_marker:         { kind: 'bool' },
  ready:              { kind: 'bool' },

  // Word-form index
  form:               { kind: 'wordform' },
  snippet:            { kind: 'excerpt' },

  // Envelope. `items`, `related` and `review_queue` are arrays of records that
  // are themselves walked; `facets` is a map of facet name to counted options,
  // where each option carries the canonical value under its own field name so
  // it is checked against the same vocabulary as the records are.
  status:             { kind: 'enum', values: ['ok', 'preparing', 'unavailable'] },
  sort:               { kind: 'enum', values: ['sources', 'occurrences', 'alphabetical'] },
  source:             { kind: 'nested' },
  library:            { kind: 'nested' },
  forms:              { kind: 'nested' },
  items:              { kind: 'records' },
  related:            { kind: 'records' },
  review_queue:       { kind: 'records' },
  receipts:           { kind: 'records' },
  contexts:           { kind: 'records' },
  facets:             { kind: 'group' },
  has_more:           { kind: 'bool' },
  stages_complete:    { kind: 'count' },
  stages_total:       { kind: 'count' },
});

class ProjectionError extends Error {}

const CURATED_SENTENCES = new Set([
  'Convert prompts into a reviewed elicitation and morphology benchmark; do not treat prompt prose as attested Lak usage.',
  'Extract cited Lak examples and grammatical analyses for lemma/morphology rules and expert benchmarks; keep prose out of the sentence corpus.',
  'Index metadata and relevant comparisons; exclude non-Lak sentences from the Lak corpus.',
  'Index metadata, citations and any reviewed Lak examples; do not ingest article prose as Lak corpus data.',
  'Index people, places, dates and Lak cultural context; do not mix Russian historical prose into the Lak sentence corpus.',
  'Preserve document structure and align Lak with the corresponding Russian/Latin/English version after human verification.',
  'Preserve names, dates and project context; exclude administrative prose from linguistic candidate layers.',
  'Preserve speaker/session cues and align Lak transcription with supplied translations; require speaker-consent and encoding review before any release.',
  'Retain unchanged; reconcile members against separately received files before extraction.',
  'Segment headwords, translations, examples and morphology; reconcile against existing Khaydakov, Dzhidalaev, Gadzhiyev and Digiev layers.',
  'Segment into documents, paragraphs and sentences for concordance and genre coverage; retain author, translator and edition metadata.',
  'Use privately for orthography, graded vocabulary and benchmark design; extract examples only after rights review.',
  'Preserve only as receipt evidence; exclude from linguistic processing.',
]);

/* ── Value checks ────────────────────────────────────────────────────── */

const MAX_BIBLIOGRAPHIC = 240;
const FILE_EXTENSION = /\.(doc|docx|pdf|djvu|rtf|txt|tif|tiff|jpe?g|indd|rar|zip|mak|orig|xls|xlsx|ppt|pptx)\b/i;
const TOOL_PREFIX = /^(microsoft\s+word|microsoft\s+powerpoint|powerpoint|word|untitled|slide\s*\d*|document\d*|presentation\d*|no\s*title|print|scan|copy\s+of)\b/i;
const PATHLIKE = /[\\/]|^[a-z0-9_]+:[a-z0-9_:.-]+$/i;
const HEXRUN = /[0-9a-f]{16,}/i;
// A run of Latin-1 supplement letters with no Latin words around them is
// almost always Cyrillic that was decoded with the wrong code page. Publishing
// it would be publishing noise.
const MOJIBAKE = /[\u00c0-\u00ff]{4,}/;

function looksPrivate(text) {
  const lower = text.toLowerCase();
  return PRIVATE_PATH_MARKERS.some(m => lower.includes(m));
}

function isFinitePositiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function checkValue(key, value, rule) {
  if (value === null || value === undefined) {
    if (rule.nullable || rule.kind === 'list') return;
    throw new ProjectionError(`public projection: "${key}" may not be null`);
  }
  switch (rule.kind) {
    case 'ref':
      // `s` numbers are substantive sources, `r` numbers are receipts.
      if (typeof value !== 'string' || !/^[sr]\d{1,6}$/.test(value)) {
        throw new ProjectionError(`public projection: "${key}" is not a public source ref`);
      }
      return;
    case 'slug':
      if (typeof value !== 'string' || !FAMILY_IDS.includes(value)) {
        throw new ProjectionError(`public projection: "${key}" is not a curated public family`);
      }
      return;
    case 'opaque':
      if (typeof value !== 'string' || !/^g[0-9a-f]{12}$/.test(value)) {
        throw new ProjectionError(`public projection: "${key}" is not an opaque group id`);
      }
      return;
    case 'canonical':
      if (!VOCAB[rule.vocab].includes(value)) {
        throw new ProjectionError(`public projection: "${key}" carries an undeclared value`);
      }
      return;
    case 'curated_sentence':
      if (!CURATED_SENTENCES.has(value)) {
        throw new ProjectionError(`public projection: "${key}" is not a curated handling note`);
      }
      return;
    case 'enum':
      if (!rule.values.includes(value)) {
        throw new ProjectionError(`public projection: "${key}" carries an undeclared value`);
      }
      return;
    case 'bibliographic':
      if (typeof value !== 'string' || !value.trim()) {
        throw new ProjectionError(`public projection: "${key}" must be a non-empty string`);
      }
      if (value.length > MAX_BIBLIOGRAPHIC || looksPrivate(value) ||
          PATHLIKE.test(value) || HEXRUN.test(value) || FILE_EXTENSION.test(value)) {
        throw new ProjectionError(`public projection: "${key}" did not pass sanitisation`);
      }
      return;
    case 'url':
      if (typeof value !== 'string' || !/^https?:\/\/[^\s<>"']+$/.test(value) ||
          value.length > 500 || looksPrivate(value)) {
        throw new ProjectionError(`public projection: "${key}" is not a publishable URL`);
      }
      return;
    case 'wordform':
      if (typeof value !== 'string' || !isPublishableForm(value)) {
        throw new ProjectionError(`public projection: "${key}" is not a publishable word form`);
      }
      return;
    case 'excerpt':
      if (typeof value !== 'string' || !value.trim() || value.length > 360 ||
          looksPrivate(value) || /[\r\n]/.test(value)) {
        throw new ProjectionError(`public projection: "${key}" is not a bounded concordance excerpt`);
      }
      return;
    case 'year':
      if (!isFinitePositiveInt(value) || value < 1500 || value > 2100) {
        throw new ProjectionError(`public projection: "${key}" is not a plausible year`);
      }
      return;
    case 'count':
      if (!isFinitePositiveInt(value)) {
        throw new ProjectionError(`public projection: "${key}" must be a non-negative whole number`);
      }
      return;
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new ProjectionError(`public projection: "${key}" must be a boolean`);
      }
      return;
    case 'list':
      if (!Array.isArray(value)) {
        throw new ProjectionError(`public projection: "${key}" must be an array`);
      }
      for (const item of value) checkValue(key, item, { kind: rule.of });
      return;
    case 'passthrough':
      return;
    default:
      throw new ProjectionError(`public projection: "${key}" has no declared rule`);
  }
}

// Recursively validate a payload about to be sent to an anonymous visitor.
// Arrays are walked; objects are walked key by key; anything whose key is not
// in FIELD_RULES throws. Nothing reaches a public response by accident.
function assertPublicSafe(payload, path = 'response') {
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertPublicSafe(item, `${path}[${i}]`));
    return payload;
  }
  if (typeof payload !== 'object') {
    throw new ProjectionError(`public projection: ${path} is a bare value with no declared key`);
  }
  for (const [key, value] of Object.entries(payload)) {
    if (WITHHELD_MANIFEST_KEYS.includes(key)) {
      throw new ProjectionError(`public projection: "${key}" is withheld and may never be published`);
    }
    const rule = FIELD_RULES[key];
    if (!rule) {
      throw new ProjectionError(`public projection: "${key}" is not declared in FIELD_RULES`);
    }
    if (rule.kind === 'records') {
      if (!Array.isArray(value)) {
        throw new ProjectionError(`public projection: "${key}" must be an array of records`);
      }
      assertPublicSafe(value, `${path}.${key}`);
      continue;
    }
    if (rule.kind === 'group') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProjectionError(`public projection: "${key}" must be a facet map`);
      }
      for (const [facet, options] of Object.entries(value)) {
        if (!FIELD_RULES[facet]) {
          throw new ProjectionError(`public projection: facet "${facet}" is not declared`);
        }
        assertPublicSafe(options, `${path}.${key}.${facet}`);
      }
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      assertPublicSafe(value, `${path}.${key}`);
      continue;
    }
    checkValue(key, value, rule);
  }
  return payload;
}

/* ── Derivations ─────────────────────────────────────────────────────── */

// Letters that may appear inside a published word form. Cyrillic and Latin
// letters plus the palochka, which is a letter in Lak orthography and is
// written with several different code points in practice.
const FORM_LETTERS = /^[\p{L}\u04c0\u04cf\u0131\u2018\u2019'\u02bc-]+$/u;
const MIN_FORM = 2;
const MAX_FORM = 32;

// A form is publishable when it is a single word of letters. Anything carrying
// a digit, a space or punctuation is a fragment of a sentence rather than a
// word, and republishing sentence fragments from restricted sources is exactly
// what this whole boundary exists to prevent.
function isPublishableForm(form) {
  if (typeof form !== 'string') return false;
  const value = form.trim();
  if (value.length < MIN_FORM || value.length > MAX_FORM) return false;
  if (value !== form) return false;
  if (/\s/.test(value) || /\d/.test(value)) return false;
  if (!FORM_LETTERS.test(value)) return false;
  // A leading or trailing separator means the tokeniser cut mid-word.
  if (/^[-'\u2018\u2019\u02bc]|[-'\u2018\u2019\u02bc]$/.test(value)) return false;
  return true;
}

const CYRILLIC = /[\u0400-\u04ff]/;
const LATIN = /[A-Za-z]/;

function scriptProfileOf(cyrillicChars, latinChars) {
  const cyr = Number(cyrillicChars) > 0;
  const lat = Number(latinChars) > 0;
  if (cyr && lat) return 'mixed';
  if (cyr) return 'cyrillic';
  if (lat) return 'latin';
  return 'none';
}

function scriptOfForm(form) {
  const cyr = CYRILLIC.test(form);
  const lat = LATIN.test(form);
  if (cyr && lat) return 'mixed';
  if (cyr) return 'cyrillic';
  if (lat) return 'latin';
  return 'none';
}

// Digraphs and letters that only occur in Lak orthography, used as a facet so
// a reader can separate Lak forms from the Russian glosses that share the
// source files. It is a hint about the form, not a claim about the language.
const LAK_ORTHOGRAPHY = /\u04c0|\u04cf|(?:кь|къ|кӏ|гъ|гь|хъ|хь|хӏ|цӏ|чӏ|тӏ|пӏ|ттӏ|ккь)/i;

function hasLakMarker(form) {
  return LAK_ORTHOGRAPHY.test(form);
}

// Attestation breadth, not correctness. A form seen across many independent
// sources is a safer thing to show than one seen in two.
function confidenceForForm(sourceCount) {
  if (sourceCount >= 5) return 'high';
  if (sourceCount >= 3) return 'medium';
  return 'low';
}

// A word form is published only when at least two distinct sources attest it.
// A form unique to one restricted document is a fact about that document, and
// enough of those together would reconstruct it.
const MIN_ATTESTING_SOURCES = 2;

const EXTENSION_FORMATS = Object.freeze({
  '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc', '.djvu': 'djvu',
  '.tiff': 'tiff', '.tif': 'tiff', '.jpg': 'jpg', '.jpeg': 'jpg',
  '.rtf': 'rtf', '.rar': 'archive', '.zip': 'archive',
});

function fileFormatOf(extension) {
  if (!extension) return 'other';
  const key = String(extension).trim().toLowerCase().split(/\s+/)[0];
  return EXTENSION_FORMATS[key] || 'other';
}

// The PDF "title" field is a document-metadata slot, not a bibliographic one.
// Often it holds the real title of a work; often it holds whatever the editing
// tool put there, which can be the author's own filename. Only the first kind
// is published.
function publishableTitle(raw) {
  if (typeof raw !== 'string') return null;
  const title = raw.replace(/\s+/g, ' ').trim();
  if (title.length < 4 || title.length > MAX_BIBLIOGRAPHIC) return null;
  if (TOOL_PREFIX.test(title)) return null;
  if (PATHLIKE.test(title) || FILE_EXTENSION.test(title)) return null;
  if (HEXRUN.test(title) || MOJIBAKE.test(title)) return null;
  if (looksPrivate(title)) return null;
  // Anything ending in a short dotted suffix is the author's own filename in
  // the title slot, whatever the extension happens to be.
  if (/\.[a-z0-9]{1,4}$/i.test(title)) return null;
  // A catalogue number is not a title. Showing one as the name of a source
  // would be worse than showing no name at all.
  if (/^(issn|isbn|doi|udc|\u0443\u0434\u043a|\u0431\u0431\u043a)\b/i.test(title)) return null;
  // A "title" with no letters is a tool artefact.
  if (!/\p{L}/u.test(title)) return null;
  return title;
}

// Attribution is the riskiest bibliographic field in this batch, because the
// PDF "author" slot records whoever owned the editing session. It holds real
// scholars, and it also holds account names like a first name on its own or a
// login with a dot in it. Only a multi-word name with no login shape survives,
// and it is labelled "attributed to" rather than "author" because that is all
// the metadata actually supports.
function publishableAuthor(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value.length < 5 || value.length > MAX_BIBLIOGRAPHIC) return null;
  if (/[<>@\\/]|\d/.test(value)) return null;
  if (HEXRUN.test(value) || MOJIBAKE.test(value) || looksPrivate(value)) return null;
  const words = value.split(/[ ,]+/).filter(Boolean);
  if (words.length < 2) return null;
  // A dot inside a word is a login ("anna.mitina"), not a name. An initial
  // ("A." / "Ю.") is a dot at the end of a short word, which is fine.
  if (words.some(w => /\.\p{L}/u.test(w))) return null;
  if (!words.every(w => /^\p{L}[\p{L}'\u2019.-]*$/u.test(w))) return null;
  if (words.every(w => w === w.toUpperCase() && w.length <= 4)) return null;
  return value;
}

// PDF dates look like "D:20100315120000+03'00'". Only the year is published,
// and it is labelled as a file date: it records when the file was made, which
// for a scanned book is nothing like when the book was published.
function documentYear(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isInteger(year) || year < 1500 || year > 2100) return null;
  return year;
}

function publishableUrls(raw, limit = 3) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const url = item.trim();
    if (!/^https?:\/\/[^\s<>"']+$/.test(url)) continue;
    if (url.length > 500 || looksPrivate(url)) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

function isConsentSensitive(materialType) {
  return CONSENT_SENSITIVE_TYPES.includes(materialType);
}

// What this source contributes to the public surface. This is the honest
// answer to "why is this listed if I cannot read it".
function contributionOf({ materialType, derivedRoute, rightsState, consentWithheld, wordFormCount }) {
  // Only consent withholds a contribution. A source awaiting a *rights*
  // decision still feeds the word-form index: the open question there is
  // whether its text may be republished, and the index republishes no text.
  // Excluding exactly the three sources most likely to be free of restriction,
  // while every restricted source contributes, would be backwards — and it
  // would make `contribution` disagree with `word_form_count`.
  if (consentWithheld) return 'withheld_pending_review';
  if (wordFormCount > 0) return 'word_forms';
  if (derivedRoute === 'private_text_segments' && materialType === 'translation_or_parallel_text') {
    return 'alignment_candidate';
  }
  return 'reference_only';
}

module.exports = {
  ProjectionError,
  WITHHELD_MANIFEST_KEYS,
  PRIVATE_PATH_MARKERS,
  VOCAB,
  FIELD_RULES,
  FAMILY_IDS,
  FAMILY_TITLES,
  familyIdForPath,
  CONSENT_SENSITIVE_TYPES,
  CURATED_SENTENCES,
  MIN_ATTESTING_SOURCES,
  MIN_FORM,
  MAX_FORM,
  assertPublicSafe,
  isPublishableForm,
  scriptProfileOf,
  scriptOfForm,
  hasLakMarker,
  confidenceForForm,
  fileFormatOf,
  publishableTitle,
  publishableAuthor,
  documentYear,
  publishableUrls,
  isConsentSensitive,
  contributionOf,
  looksPrivate,
};
