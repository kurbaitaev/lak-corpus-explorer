'use strict';

// Deterministic source-relationship proposals for the private research layers.
//
// What this module does
//   * builds an evidence profile for every private source (path, family,
//     script/language classification, structure, numbers, headings,
//     punctuation, near-duplicate sketch, public-corpus overlap)
//   * proposes relationships between sources — translation, parallel text,
//     transliteration, alternate edition, duplicate — from that evidence only
//   * records exactly which signals fired, with the measurements behind them
//
// What it never does
//   * it never translates anything and never calls a model
//   * it never marks a proposal validated: every row it writes is a candidate
//     with review_state 'source_import_unreviewed' until a human accepts it
//   * it never merges two sources, and it never touches the public corpus
//
// Determinism: the same staged sources always produce the same proposals, in
// the same order, with the same ids and confidences. A repeated scan is a
// no-op, recorded in private_relationship_runs by (generator, input digest).

const crypto = require('crypto');

const GENERATOR_VERSION = 'source-intelligence-v1';

// How much of a source is sampled for its profile. Sampling is ordered and
// capped so a huge source cannot make the scan unbounded, and so two sources
// are always compared on the same amount of evidence.
const SAMPLE_UNITS_PER_SOURCE = 120;
const SAMPLE_CHARS_PER_SOURCE = 40000;
const SKETCH_SIZE = 512;
const SKETCH_BANDS = 8;
const SHINGLE_WORDS = 5;
const MAX_BUCKET_MEMBERS = 40;
const MAX_PAIRS_EXAMINED = 40000;
const MIN_CONFIDENCE = 0.35;
const MIN_SIGNALS = 2;

const RELATIONSHIP_TYPES = [
  'translation', 'parallel_text', 'transliteration', 'alternate_edition', 'duplicate',
];

// Lak-specific Cyrillic digraphs and the palochka. Russian orthography does
// not use these sequences, so their rate separates a Lak text from a Russian
// one without any wordlist.
const LAK_MARKERS = [
  'къ', 'кь', 'кӏ', 'гъ', 'гь', 'гӏ', 'хъ', 'хь', 'хӏ',
  'цӏ', 'чӏ', 'тӏ', 'пӏ', 'ссa', 'сса', 'ттт', 'ӏ',
];
// Common Russian function words, matched on word boundaries.
const RU_MARKERS = [
  'и', 'в', 'не', 'на', 'что', 'с', 'по', 'как', 'это', 'для', 'был', 'была',
  'было', 'от', 'до', 'же', 'они', 'она', 'но', 'я', 'мы', 'вы', 'к', 'у',
  'за', 'из', 'о', 'при', 'так', 'все', 'еще', 'уже', 'его', 'ее', 'их',
];

// Filename roots that say nothing about which work a file belongs to.
const GENERIC_ROOTS = new Set([
  'ds-store', 'ds', 'doc', 'docs', 'document', 'documents', 'file', 'files',
  'img', 'image', 'images', 'scan', 'scans', 'text', 'txt', 'untitled', 'new',
  'old', 'copy', 'final', 'draft', 'temp', 'tmp', 'page', 'pages', 'part',
  'index', 'readme', 'notes', 'note', 'book', 'test', 'data', 'output',
]);

// Files a desktop operating system writes next to real material.
const SYSTEM_ARTEFACT = /^(\.DS_Store|\._.*|Thumbs\.db|desktop\.ini|\.localized)$/i;

// Suffixes that mark an edition/rendering of the same work rather than a
// different work.
const EDITION_SUFFIX = new RegExp(
  '-(copy|final|draft|corrected|uncorrected|ocr|scan|scanned|clean|new|old|orig|' +
  'original|edit|edited|ru|rus|russian|lak|eng|en|lat|latin|cyr|cyrillic|' +
  'translit|transliteration|perevod|v\\d+|\\d{4})$');

// ── Small helpers ─────────────────────────────────────────────
const clamp01 = n => Math.max(0, Math.min(0.99, n));
const round4 = n => Math.round(n * 10000) / 10000;

function stripDiacritics(value) {
  try { return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); }
  catch { return String(value); }
}

function slug(value) {
  return stripDiacritics(String(value == null ? '' : value))
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hash32(value) {
  return crypto.createHash('sha1').update(value, 'utf8').digest().readUInt32BE(0);
}

function rowId(prefix, ...parts) {
  return prefix + crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function pathParts(sourcePath) {
  const parts = String(sourcePath || '').split('/').filter(Boolean);
  const file = parts.pop() || '';
  const ext = (file.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  return {
    file,
    stem: ext ? file.slice(0, -ext.length) : file,
    ext,
    folder: parts.join('/'),
    folderName: parts.length ? parts[parts.length - 1] : '',
  };
}

// "War-1a.doc" → normalized "war-1a", base "war-1", root "war".
function titleVariants(stem) {
  const normalized = slug(stem);
  const markers = [];
  let base = normalized;
  for (;;) {
    const match = base.match(EDITION_SUFFIX);
    if (!match) break;
    markers.push(match[1]);
    base = base.slice(0, -match[0].length);
  }
  const withoutLetter = base.replace(/(\d+)[a-z]$/, '$1');
  if (withoutLetter !== base) markers.push('edition-letter');
  const root = withoutLetter.replace(/[-_ ]?\d+$/, '') || withoutLetter;
  return { normalized, base: withoutLetter, root, markers };
}

function familyKeyFor(sourcePath) {
  const { stem, folder, folderName } = pathParts(sourcePath);
  const { root } = titleVariants(stem);
  if (root && root.length >= 3 && !GENERIC_ROOTS.has(root) && !/^\d+$/.test(root)) {
    return 'title:' + root;
  }
  const folderKey = slug(folderName || folder);
  return folderKey ? 'folder:' + folderKey : 'path:' + slug(sourcePath);
}

// ── Text measurements ─────────────────────────────────────────
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) { count += 1; index = haystack.indexOf(needle, index + needle.length); }
  return count;
}

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}\u0400-\u04ff]+/gu) || [];
}

function scriptProfile(text) {
  const cyrillic = (text.match(/[\u0400-\u04ff]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const arabic = (text.match(/[\u0600-\u06ff]/g) || []).length;
  let script = 'unknown';
  if (arabic > cyrillic && arabic > latin) script = 'arabic';
  else if (cyrillic > latin * 2) script = 'cyrillic';
  else if (latin > cyrillic * 2) script = 'latin';
  else if (cyrillic + latin > 0) script = 'mixed';
  return { cyrillic, latin, arabic, script };
}

function languageProfile(text, script) {
  const lower = text.toLowerCase();
  const chars = Math.max(lower.length, 1);
  let lakHits = 0;
  for (const marker of LAK_MARKERS) lakHits += countOccurrences(lower, marker);
  const words = tokenize(lower);
  const ruWordSet = new Set(RU_MARKERS);
  let ruHits = 0;
  for (const word of words) if (ruWordSet.has(word)) ruHits += 1;
  const lakRate = round4((lakHits / chars) * 1000);
  const ruRate = round4((ruHits / chars) * 1000);
  let language = 'undetermined';
  if (script === 'latin') language = 'latin_or_transliteration';
  else if (script === 'arabic') language = 'arabic_script';
  else if (lakRate >= 1 && lakRate >= ruRate * 2) language = 'lak';
  else if (ruRate >= 1 && ruRate > lakRate) language = 'russian';
  else if (lakRate > 0 && lakRate > ruRate) language = 'lak';
  else if (ruRate > 0) language = 'russian';
  return { language, lak_marker_rate: lakRate, russian_marker_rate: ruRate };
}

const PUNCT_KEYS = ['.', ',', ';', ':', '!', '?', '—', '«', '»', '"', '(', ')', '-'];
function punctuationProfile(text) {
  const counts = {};
  let total = 0;
  for (const key of PUNCT_KEYS) {
    const n = countOccurrences(text, key);
    counts[key] = n;
    total += n;
  }
  const profile = {};
  for (const key of PUNCT_KEYS) profile[key] = total ? round4(counts[key] / total) : 0;
  return { profile, total };
}

function punctuationSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const key of PUNCT_KEYS) {
    const x = a[key] || 0, y = b[key] || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (!na || !nb) return 0;
  return round4(dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

function shingleSketch(tokens) {
  const hashes = [];
  for (let i = 0; i + SHINGLE_WORDS <= tokens.length; i += 1) {
    hashes.push(hash32(tokens.slice(i, i + SHINGLE_WORDS).join(' ')));
  }
  return Array.from(new Set(hashes)).sort((a, b) => a - b).slice(0, SKETCH_SIZE);
}

// Bottom-k sketch Jaccard estimate: exact for small documents, bounded for
// large ones, and identical for identical inputs.
function sketchJaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const merged = Array.from(new Set(a.concat(b))).sort((x, y) => x - y).slice(0, SKETCH_SIZE);
  let shared = 0;
  for (const value of merged) if (setA.has(value) && setB.has(value)) shared += 1;
  return merged.length ? round4(shared / merged.length) : 0;
}

function setJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) shared += 1;
  return round4(shared / (a.size + b.size - shared));
}

function headingKeys(units) {
  const keys = [];
  for (const unit of units) {
    const line = String(unit).trim();
    if (!line || line.length > 90) continue;
    if (/[.!?]$/.test(line)) continue;
    const key = slug(tokenize(line).slice(0, 6).join(' '));
    if (key) keys.push(key);
    if (keys.length >= 30) break;
  }
  return new Set(keys);
}

function numberTokens(text) {
  const found = String(text).match(/\d{1,4}/g) || [];
  return new Set(found.slice(0, 400));
}

// ── Profiles ──────────────────────────────────────────────────
// One profile per staged private source. Text is read from the staged
// candidate rows, never from the public corpus and never from disk, so the
// profile is reproducible from the database alone.
async function buildProfiles(pool, options = {}) {
  const publicForms = options.publicForms instanceof Set ? options.publicForms : new Set();
  const sources = await pool.query(
    `SELECT id, source_sequence, source_path, source_sha256, material_type, language_scope,
            extraction_quality, extraction_status, derived_route, duplicate_group,
            canonical_duplicate, bytes, text_chars, word_count, priority, extension,
            rights_status, review_state, access_status, training_ready
       FROM v13_sources
      ORDER BY source_sequence`);

  const samples = await pool.query(
    `SELECT source_sequence, text
       FROM (
         SELECT source_sequence, text,
                row_number() OVER (
                  PARTITION BY source_sequence
                  ORDER BY source_unit NULLS LAST, source_line NULLS LAST, candidate_ref
                ) AS rn
           FROM v13_candidates
          WHERE text IS NOT NULL AND btrim(text) <> ''
       ) sampled
      WHERE rn <= $1
      ORDER BY source_sequence, rn`,
    [SAMPLE_UNITS_PER_SOURCE]);

  const unitsBySequence = new Map();
  for (const row of samples.rows) {
    let units = unitsBySequence.get(row.source_sequence);
    if (!units) { units = []; unitsBySequence.set(row.source_sequence, units); }
    const soFar = units.reduce((sum, unit) => sum + unit.length, 0);
    if (soFar >= SAMPLE_CHARS_PER_SOURCE) continue;
    units.push(String(row.text));
  }

  const profiles = [];
  for (const row of sources.rows) {
    const parts = pathParts(row.source_path);
    // Operating-system artefacts the sender's disk contributed (.DS_Store,
    // Thumbs.db, desktop.ini) are received files and stay listed in the source
    // browser, but they are not works: pairing them produces byte-identical
    // "duplicates" that carry nothing a reviewer can align.
    if (SYSTEM_ARTEFACT.test(parts.file)) continue;
    const variants = titleVariants(parts.stem);
    const units = unitsBySequence.get(row.source_sequence) || [];
    const text = units.join('\n');
    const tokens = tokenize(text);
    const script = scriptProfile(text);
    const language = languageProfile(text, script.script);
    const punctuation = punctuationProfile(text);
    const tokenSet = new Set(tokens);
    let publicOverlap = 0;
    if (publicForms.size) {
      for (const token of tokenSet) if (publicForms.has(token)) publicOverlap += 1;
    }
    profiles.push({
      id: row.id,
      kind: 'v13_source',
      ref: String(row.source_sequence),
      source_sequence: row.source_sequence,
      source_path: row.source_path,
      source_sha256: row.source_sha256,
      label: parts.file,
      folder: parts.folder,
      folder_name: parts.folderName,
      extension: row.extension || parts.ext,
      material_type: row.material_type,
      language_scope: row.language_scope,
      extraction_quality: row.extraction_quality,
      derived_route: row.derived_route,
      duplicate_group: row.duplicate_group,
      canonical_duplicate: row.canonical_duplicate,
      family_key: familyKeyFor(row.source_path),
      title: variants.normalized,
      title_base: variants.base,
      title_root: variants.root,
      title_markers: variants.markers,
      bytes: Number(row.bytes || 0),
      text_chars: Number(row.text_chars || 0),
      word_count: Number(row.word_count || 0),
      sampled_units: units.length,
      sampled_chars: text.length,
      script: script.script,
      script_counts: { cyrillic: script.cyrillic, latin: script.latin, arabic: script.arabic },
      language: language.language,
      lak_marker_rate: language.lak_marker_rate,
      russian_marker_rate: language.russian_marker_rate,
      punctuation: punctuation.profile,
      sketch: shingleSketch(tokens),
      numbers: numberTokens(text),
      headings: headingKeys(units),
      public_overlap: publicOverlap,
      token_count: tokens.length,
    });
  }
  return profiles;
}

// ── Candidate pair generation ─────────────────────────────────
// Pairs are only examined when something cheap already links them: the same
// file digest, a declared duplicate group, the same title base or root, the
// same folder, or a shared near-duplicate band. Nothing is compared blindly.
function bucketPairs(profiles) {
  const buckets = new Map();
  const add = (key, profile) => {
    if (!key) return;
    let list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    list.push(profile);
  };
  for (const profile of profiles) {
    add('digest:' + profile.source_sha256, profile);
    if (profile.duplicate_group) add('dupgroup:' + slug(profile.duplicate_group), profile);
    if (profile.title_base) add('titlebase:' + profile.title_base, profile);
    if (profile.title_root && profile.title_root.length >= 3 && !GENERIC_ROOTS.has(profile.title_root)) {
      add('titleroot:' + profile.title_root, profile);
    }
    if (profile.folder) add('folder:' + slug(profile.folder), profile);
    add('family:' + profile.family_key, profile);
    for (const band of profile.sketch.slice(0, SKETCH_BANDS)) add('band:' + band, profile);
  }

  const pairs = new Map();
  const bucketKeys = Array.from(buckets.keys()).sort();
  for (const key of bucketKeys) {
    const members = buckets.get(key);
    if (members.length < 2 || members.length > MAX_BUCKET_MEMBERS) continue;
    const ordered = members.slice().sort((a, b) => a.source_sequence - b.source_sequence);
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const pairKey = ordered[i].ref + '|' + ordered[j].ref;
        let entry = pairs.get(pairKey);
        if (!entry) {
          entry = { left: ordered[i], right: ordered[j], buckets: [] };
          pairs.set(pairKey, entry);
        }
        if (!entry.buckets.includes(key.split(':')[0])) entry.buckets.push(key.split(':')[0]);
      }
    }
    if (pairs.size >= MAX_PAIRS_EXAMINED) break;
  }
  return Array.from(pairs.values())
    .sort((a, b) => (a.left.source_sequence - b.left.source_sequence) ||
      (a.right.source_sequence - b.right.source_sequence));
}

// Signal weights. Each signal is an independent piece of evidence; the
// confidence is their capped sum, never a model score.
const SIGNAL_WEIGHTS = {
  identical_file_digest: 0.95,
  declared_duplicate_group: 0.55,
  declared_canonical_duplicate: 0.55,
  normalised_title_base: 0.25,
  title_root_family: 0.12,
  edition_marker: 0.1,
  folder_family: 0.15,
  near_duplicate_text: 0.35,
  partial_text_overlap: 0.15,
  script_contrast: 0.18,
  language_contrast: 0.25,
  same_language: 0.08,
  paragraph_structure: 0.18,
  length_ratio: 0.14,
  number_overlap: 0.15,
  heading_overlap: 0.12,
  punctuation_profile: 0.1,
  dictionary_anchor: 0.12,
  public_corpus_overlap: 0.08,
};

const LANGUAGES_CONTRASTING = (a, b) => {
  if (a === b) return false;
  const known = ['lak', 'russian', 'latin_or_transliteration', 'arabic_script'];
  return known.includes(a) && known.includes(b);
};

// Pure function: same inputs → same proposal. No database, no clock.
function scorePair(left, right, context = {}) {
  const signals = [];
  const evidence = {};
  const fire = (name, detail) => {
    signals.push({ signal: name, weight: SIGNAL_WEIGHTS[name], detail: detail == null ? null : detail });
  };

  const identicalDigest = left.source_sha256 === right.source_sha256;
  if (identicalDigest) fire('identical_file_digest', left.source_sha256);
  if (left.duplicate_group && left.duplicate_group === right.duplicate_group) {
    fire('declared_duplicate_group', left.duplicate_group);
  }
  if ((left.canonical_duplicate && left.canonical_duplicate === right.source_path) ||
      (right.canonical_duplicate && right.canonical_duplicate === left.source_path)) {
    fire('declared_canonical_duplicate', left.canonical_duplicate || right.canonical_duplicate);
  }
  if (left.title_base && left.title_base === right.title_base) {
    fire('normalised_title_base', left.title_base);
  } else if (left.title_root && left.title_root === right.title_root &&
             left.title_root.length >= 3 && !GENERIC_ROOTS.has(left.title_root)) {
    fire('title_root_family', left.title_root);
  }
  if ((left.title_markers.length || right.title_markers.length) &&
      (left.title_base === right.title_base || left.title_root === right.title_root)) {
    fire('edition_marker', left.title_markers.concat(right.title_markers).join(','));
  }
  if (left.folder && left.folder === right.folder) fire('folder_family', left.folder_name || left.folder);

  const jaccard = sketchJaccard(left.sketch, right.sketch);
  evidence.text_similarity = jaccard;
  if (jaccard >= 0.55) fire('near_duplicate_text', jaccard);
  else if (jaccard >= 0.12) fire('partial_text_overlap', jaccard);

  evidence.left_language = left.language;
  evidence.right_language = right.language;
  evidence.left_script = left.script;
  evidence.right_script = right.script;
  const scriptContrast = left.script !== right.script &&
    ['cyrillic', 'latin', 'arabic'].includes(left.script) &&
    ['cyrillic', 'latin', 'arabic'].includes(right.script);
  if (scriptContrast) fire('script_contrast', left.script + '/' + right.script);
  const languageContrast = LANGUAGES_CONTRASTING(left.language, right.language);
  if (languageContrast) fire('language_contrast', left.language + '/' + right.language);
  else if (left.language === right.language && left.language !== 'undetermined') {
    fire('same_language', left.language);
  }

  const unitsLeft = left.sampled_units;
  const unitsRight = right.sampled_units;
  if (unitsLeft && unitsRight) {
    const structure = round4(Math.min(unitsLeft, unitsRight) / Math.max(unitsLeft, unitsRight));
    evidence.paragraph_ratio = structure;
    if (structure >= 0.85) fire('paragraph_structure', structure);
  }

  const charsLeft = left.text_chars || left.sampled_chars;
  const charsRight = right.text_chars || right.sampled_chars;
  if (charsLeft && charsRight) {
    const ratio = round4(Math.min(charsLeft, charsRight) / Math.max(charsLeft, charsRight));
    evidence.length_ratio = ratio;
    if (ratio >= 0.6) fire('length_ratio', ratio);
  }

  const numberOverlap = setJaccard(left.numbers, right.numbers);
  evidence.number_overlap = numberOverlap;
  if (numberOverlap >= 0.25) fire('number_overlap', numberOverlap);

  const headingOverlap = setJaccard(left.headings, right.headings);
  evidence.heading_overlap = headingOverlap;
  if (headingOverlap >= 0.2) fire('heading_overlap', headingOverlap);

  const punctuation = punctuationSimilarity(left.punctuation, right.punctuation);
  evidence.punctuation_similarity = punctuation;
  if (punctuation >= 0.9) fire('punctuation_profile', punctuation);

  // Dictionary anchors: both sides are attested in the public dictionary /
  // phrasebook layer, so the pair is anchored to evidence outside itself.
  if (left.public_overlap > 0 && right.public_overlap > 0) {
    const anchored = Math.min(left.public_overlap, right.public_overlap);
    evidence.dictionary_anchor_forms = anchored;
    if (anchored >= 20) fire('dictionary_anchor', anchored);
    else fire('public_corpus_overlap', anchored);
  }

  if (signals.length < MIN_SIGNALS) return null;

  const names = new Set(signals.map(signal => signal.signal));
  const confidence = round4(clamp01(signals.reduce((sum, signal) => sum + signal.weight, 0)));
  if (confidence < MIN_CONFIDENCE) return null;

  // Type decision, most specific first. Every branch is evidence-driven.
  let type;
  let roleNote;
  if (identicalDigest || names.has('declared_duplicate_group') || names.has('declared_canonical_duplicate')) {
    type = 'duplicate';
    roleNote = identicalDigest
      ? 'Byte-identical received files.'
      : 'The package declares these files as duplicates of one another.';
  } else if (scriptContrast && (names.has('number_overlap') || names.has('length_ratio')) &&
             (names.has('normalised_title_base') || names.has('title_root_family') || names.has('folder_family'))) {
    type = 'transliteration';
    roleNote = 'Same work in two scripts: the structure matches while the script differs.';
  } else if (languageContrast && (names.has('paragraph_structure') || names.has('number_overlap') ||
             names.has('heading_overlap'))) {
    type = 'translation';
    roleNote = 'Different languages with matching structure — a translation candidate.';
  } else if (languageContrast) {
    type = 'parallel_text';
    roleNote = 'Different languages in the same family — a parallel-text candidate.';
  } else if (names.has('near_duplicate_text')) {
    type = 'alternate_edition';
    roleNote = 'Near-duplicate text in the same language — an alternate edition candidate.';
  } else {
    type = 'parallel_text';
    roleNote = 'Same family and comparable structure — a parallel-text candidate.';
  }

  return {
    type,
    confidence,
    signals: signals.sort((a, b) => (b.weight - a.weight) || a.signal.localeCompare(b.signal)),
    evidence,
    role_note: roleNote,
    left_role: roleFor(left, type, right),
    right_role: roleFor(right, type, left),
  };
}

function roleFor(profile, type, other) {
  if (type === 'duplicate') return 'duplicate_member';
  if (type === 'transliteration') return profile.script === 'latin' ? 'transliteration' : 'source_script';
  if (profile.language === 'lak') {
    return type === 'alternate_edition'
      ? (profile.text_chars >= other.text_chars ? 'lak_primary' : 'lak_alternate')
      : 'lak_side';
  }
  if (profile.language === 'russian') return 'russian_side';
  if (profile.language === 'latin_or_transliteration') return 'latin_side';
  return 'undetermined_side';
}

// Deterministic proposal list for a set of profiles. Exported so tests can
// check determinism without touching the database.
function proposeRelationships(profiles) {
  const pairs = bucketPairs(profiles);
  const proposals = [];
  for (const pair of pairs) {
    const scored = scorePair(pair.left, pair.right);
    if (!scored) continue;
    const pairKey = pair.left.kind + ':' + pair.left.ref + '|' + pair.right.kind + ':' + pair.right.ref;
    proposals.push({
      id: rowId('psr_', GENERATOR_VERSION, pairKey),
      pair_key: pairKey,
      family_key: pair.left.family_key === pair.right.family_key
        ? pair.left.family_key
        : (pair.left.family_key < pair.right.family_key ? pair.left.family_key : pair.right.family_key),
      relationship_type: scored.type,
      method: 'deterministic_signal_scan',
      generator_version: GENERATOR_VERSION,
      origin: 'deterministic_scan',
      left: pair.left,
      right: pair.right,
      left_role: scored.left_role,
      right_role: scored.right_role,
      role_note: scored.role_note,
      signals: scored.signals,
      evidence: { ...scored.evidence, buckets: pair.buckets.slice().sort() },
      confidence: scored.confidence,
    });
    if (proposals.length >= MAX_PAIRS_EXAMINED) break;
  }
  return {
    generator_version: GENERATOR_VERSION,
    sources_scanned: profiles.length,
    pairs_examined: pairs.length,
    proposals: proposals.sort((a, b) => a.pair_key.localeCompare(b.pair_key)),
  };
}

// A digest of exactly the inputs the scan depends on. A changed staging set
// produces a different key, so a cached run can never hide new sources.
function inputKeyFor(profiles) {
  const hash = crypto.createHash('sha256');
  for (const profile of profiles) {
    hash.update([
      profile.ref, profile.source_sha256, profile.source_path,
      profile.sampled_units, profile.sampled_chars, profile.language, profile.script,
    ].join('\u0000'));
    hash.update('\u0001');
  }
  return hash.digest('hex');
}

// ── Persistence ───────────────────────────────────────────────
async function persistProposals(pool, result, options = {}) {
  const origin = options.origin || 'deterministic_scan';
  let inserted = 0;
  let refreshed = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const proposal of result.proposals) {
      const values = [
        proposal.id, proposal.pair_key, proposal.family_key, proposal.relationship_type,
        proposal.method, proposal.generator_version, origin,
        proposal.left.kind, proposal.left.ref, proposal.left.label, proposal.left.language, proposal.left_role,
        proposal.right.kind, proposal.right.ref, proposal.right.label, proposal.right.language, proposal.right_role,
        proposal.role_note, JSON.stringify(proposal.signals), JSON.stringify(proposal.evidence),
        proposal.confidence,
      ];
      const result2 = await client.query(
        `INSERT INTO private_source_relationships
           (id, pair_key, family_key, relationship_type, method, generator_version, origin,
            left_source_kind, left_source_ref, left_source_label, left_language, left_role,
            right_source_kind, right_source_ref, right_source_label, right_language, right_role,
            role_note, signals, evidence, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (pair_key) DO UPDATE SET
           -- Evidence is refreshed, human decisions are not touched.
           family_key = EXCLUDED.family_key,
           relationship_type = CASE
             WHEN private_source_relationships.review_state = 'source_import_unreviewed'
               AND private_source_relationships.origin <> 'war_family_seed'
             THEN EXCLUDED.relationship_type
             ELSE private_source_relationships.relationship_type END,
           signals = EXCLUDED.signals,
           evidence = EXCLUDED.evidence,
           confidence = EXCLUDED.confidence,
           generator_version = EXCLUDED.generator_version,
           updated_at = now()
         RETURNING (xmax = 0) AS is_insert`,
        values);
      if (result2.rows[0] && result2.rows[0].is_insert) inserted += 1; else refreshed += 1;
    }
    await client.query(
      `INSERT INTO private_relationship_runs
         (id, generator_version, input_key, sources_scanned, pairs_examined, proposed)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (generator_version, input_key) DO NOTHING`,
      [rowId('prr_', result.generator_version, options.input_key || ''),
       result.generator_version, options.input_key || '',
       result.sources_scanned, result.pairs_examined, result.proposals.length]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { inserted, refreshed };
}

async function writeFamilyKeys(pool, profiles) {
  if (!profiles.length) return 0;
  const sequences = profiles.map(profile => profile.source_sequence);
  const keys = profiles.map(profile => profile.family_key);
  const result = await pool.query(
    `UPDATE v13_sources AS s
        SET family_key = data.family_key
       FROM (SELECT unnest($1::int[]) AS source_sequence, unnest($2::text[]) AS family_key) AS data
      WHERE s.source_sequence = data.source_sequence
        AND s.family_key IS DISTINCT FROM data.family_key`,
    [sequences, keys]);
  return result.rowCount;
}

// ── The War family ────────────────────────────────────────────
// The reference example the Alignment Lab is exercised against:
//   War-1.doc   — the Lak text
//   War-1a.doc  — an alternate, near-duplicate Lak version of War-1
//   War-2.doc   — the Russian parallel/translation candidate
// Seeding asserts these three relationships exist with those roles. It never
// invents content and never marks anything validated.
const WAR_FILES = { primary: 'War-1.doc', alternate: 'War-1a.doc', russian: 'War-2.doc' };
const WAR_FAMILY_KEY = 'title:war';

async function loadWarSources(pool) {
  const result = await pool.query(
    `SELECT source_sequence, source_path, source_sha256, text_chars, word_count
       FROM v13_sources
      WHERE source_path LIKE '%/War-1.doc' OR source_path LIKE '%/War-1a.doc'
         OR source_path LIKE '%/War-2.doc' OR source_path IN ('War-1.doc','War-1a.doc','War-2.doc')
      ORDER BY source_sequence`);
  const byFile = {};
  for (const row of result.rows) {
    const file = pathParts(row.source_path).file;
    for (const [role, name] of Object.entries(WAR_FILES)) {
      if (file === name) byFile[role] = row;
    }
  }
  return byFile;
}

async function seedWarFamily(pool, options = {}) {
  const war = await loadWarSources(pool);
  const missing = Object.keys(WAR_FILES).filter(role => !war[role]);
  if (missing.length) {
    return { seeded: 0, missing: missing.map(role => WAR_FILES[role]), relationships: [] };
  }

  await pool.query(
    `UPDATE v13_sources SET family_key = $1, updated_at = now()
      WHERE source_sequence = ANY($2::int[]) AND family_key IS DISTINCT FROM $1`,
    [WAR_FAMILY_KEY, Object.values(war).map(row => row.source_sequence)]);

  const profiles = options.profiles || null;
  const profileFor = sequence => (profiles || []).find(p => p.source_sequence === sequence) || null;

  const spec = [
    {
      a: war.primary, b: war.alternate, type: 'alternate_edition',
      roles: ['lak_primary', 'lak_alternate_near_duplicate'],
      note: 'War-1 is the Lak text; War-1a is an alternate, near-duplicate Lak version of it.',
      languages: ['lak', 'lak'],
    },
    {
      a: war.primary, b: war.russian, type: 'translation',
      roles: ['lak_primary', 'russian_translation_candidate'],
      note: 'War-2 is the Russian parallel/translation candidate for the Lak War-1 text.',
      languages: ['lak', 'russian'],
    },
    {
      a: war.alternate, b: war.russian, type: 'parallel_text',
      roles: ['lak_alternate_near_duplicate', 'russian_translation_candidate'],
      note: 'The alternate Lak version paired with the Russian parallel text.',
      languages: ['lak', 'russian'],
    },
  ];

  const relationships = [];
  for (const entry of spec) {
    const [left, right] = entry.a.source_sequence <= entry.b.source_sequence
      ? [entry.a, entry.b] : [entry.b, entry.a];
    const flipped = left !== entry.a;
    const roles = flipped ? [entry.roles[1], entry.roles[0]] : entry.roles;
    const languages = flipped ? [entry.languages[1], entry.languages[0]] : entry.languages;
    const pairKey = 'v13_source:' + left.source_sequence + '|v13_source:' + right.source_sequence;
    const id = rowId('psr_', GENERATOR_VERSION, pairKey);
    const leftProfile = profileFor(left.source_sequence);
    const rightProfile = profileFor(right.source_sequence);
    const scored = (leftProfile && rightProfile) ? scorePair(leftProfile, rightProfile) : null;
    const signals = scored ? scored.signals : [];
    const evidence = {
      ...(scored ? scored.evidence : {}),
      seeded_roles: roles,
      left_file: pathParts(left.source_path).file,
      right_file: pathParts(right.source_path).file,
    };
    const confidence = scored ? scored.confidence : 0.5;

    const result = await pool.query(
      `INSERT INTO private_source_relationships
         (id, pair_key, family_key, relationship_type, method, generator_version, origin,
          left_source_kind, left_source_ref, left_source_label, left_language, left_role,
          right_source_kind, right_source_ref, right_source_label, right_language, right_role,
          role_note, signals, evidence, confidence)
       VALUES ($1,$2,$3,$4,'war_family_seed',$5,'war_family_seed',
               'v13_source',$6,$7,$8,$9,'v13_source',$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (pair_key) DO UPDATE SET
         family_key = EXCLUDED.family_key,
         relationship_type = EXCLUDED.relationship_type,
         method = EXCLUDED.method,
         origin = EXCLUDED.origin,
         left_role = EXCLUDED.left_role,
         right_role = EXCLUDED.right_role,
         left_language = EXCLUDED.left_language,
         right_language = EXCLUDED.right_language,
         role_note = EXCLUDED.role_note,
         signals = CASE WHEN jsonb_array_length(EXCLUDED.signals) > 0
                        THEN EXCLUDED.signals ELSE private_source_relationships.signals END,
         evidence = EXCLUDED.evidence,
         confidence = GREATEST(private_source_relationships.confidence, EXCLUDED.confidence),
         updated_at = now()
       RETURNING id, relationship_type, left_source_ref, right_source_ref, left_role, right_role`,
      [id, pairKey, WAR_FAMILY_KEY, entry.type, GENERATOR_VERSION,
       String(left.source_sequence), pathParts(left.source_path).file, languages[0], roles[0],
       String(right.source_sequence), pathParts(right.source_path).file, languages[1], roles[1],
       entry.note, JSON.stringify(signals), JSON.stringify(evidence), confidence]);
    relationships.push(result.rows[0]);
  }
  return { seeded: relationships.length, missing: [], relationships };
}

// ── Full scan ─────────────────────────────────────────────────
async function scan(pool, options = {}) {
  const profiles = await buildProfiles(pool, options);
  if (!profiles.length) {
    return { ran: false, reason: 'no private sources are staged', sources_scanned: 0, proposals: 0 };
  }
  const inputKey = inputKeyFor(profiles);
  if (!options.force) {
    const existing = await pool.query(
      'SELECT proposed FROM private_relationship_runs WHERE generator_version = $1 AND input_key = $2',
      [GENERATOR_VERSION, inputKey]);
    if (existing.rows[0]) {
      const war = await seedWarFamily(pool, { profiles });
      return {
        ran: false, reason: 'already scanned', cached: true,
        sources_scanned: profiles.length, proposals: existing.rows[0].proposed,
        war_family: war,
      };
    }
  }
  await writeFamilyKeys(pool, profiles);
  const result = proposeRelationships(profiles);
  const written = await persistProposals(pool, result, { input_key: inputKey });
  const dropped = await dropStaleProposals(pool, profiles);
  const war = await seedWarFamily(pool, { profiles });
  return {
    ran: true,
    generator_version: GENERATOR_VERSION,
    sources_scanned: result.sources_scanned,
    pairs_examined: result.pairs_examined,
    proposals: result.proposals.length,
    inserted: written.inserted,
    refreshed: written.refreshed,
    dropped,
    war_family: war,
  };
}

// A proposal whose sides are no longer scanned sources (a file withdrawn from
// the package, or an artefact the scanner no longer treats as a work) is
// removed — but only while it is still untouched machine output. Anything a
// human has moved or seeded stays, so no review is ever silently discarded.
async function dropStaleProposals(pool, profiles) {
  const refs = profiles.map(profile => profile.ref);
  const result = await pool.query(
    `DELETE FROM private_source_relationships
      WHERE origin = 'deterministic_scan'
        AND review_state = 'source_import_unreviewed'
        AND NOT EXISTS (SELECT 1 FROM private_alignment_units u WHERE u.relationship_id = id)
        AND (NOT (left_source_ref = ANY($1::text[])) OR NOT (right_source_ref = ANY($1::text[])))`,
    [refs]);
  return result.rowCount;
}

// ── Corroborating spellings ───────────────────────────────────
// Spellings from a private source that also occur in the audited v1.2 lexical
// layer or in the public corpus. They corroborate a source's provenance; they
// are never merged into it and never rewrite either side.
async function corroboratingSpellings(pool, sourceSequence, options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
  const publicForms = options.publicForms instanceof Set ? options.publicForms : new Set();
  const rows = await pool.query(
    `SELECT text FROM v13_candidates
      WHERE source_sequence = $1 AND text IS NOT NULL AND btrim(text) <> ''
      ORDER BY source_unit NULLS LAST, source_line NULLS LAST, candidate_ref
      LIMIT 200`,
    [sourceSequence]);
  const forms = new Set();
  for (const row of rows.rows) {
    for (const token of tokenize(row.text)) {
      if (token.length >= 4 && /[\u0400-\u04ff]/.test(token)) forms.add(token);
    }
    if (forms.size > 4000) break;
  }
  if (!forms.size) return [];
  const ordered = Array.from(forms).sort();
  const matches = await pool.query(
    `SELECT normalized_form, source_id, COUNT(*)::int AS occurrences
       FROM source_import_candidates
      WHERE normalized_form = ANY($1::text[])
      GROUP BY normalized_form, source_id
      ORDER BY normalized_form, source_id`,
    [ordered]);
  const byForm = new Map();
  for (const row of matches.rows) {
    let entry = byForm.get(row.normalized_form);
    if (!entry) {
      entry = { form: row.normalized_form, private_sources: [], public_corpus: publicForms.has(row.normalized_form) };
      byForm.set(row.normalized_form, entry);
    }
    entry.private_sources.push({ source_id: row.source_id, occurrences: row.occurrences });
  }
  if (publicForms.size) {
    for (const form of ordered) {
      if (byForm.has(form) || !publicForms.has(form)) continue;
      byForm.set(form, { form, private_sources: [], public_corpus: true });
      if (byForm.size >= limit * 4) break;
    }
  }
  return Array.from(byForm.values())
    .sort((a, b) => (b.private_sources.length - a.private_sources.length) || a.form.localeCompare(b.form))
    .slice(0, limit);
}

module.exports = {
  GENERATOR_VERSION,
  RELATIONSHIP_TYPES,
  SIGNAL_WEIGHTS,
  WAR_FILES,
  WAR_FAMILY_KEY,
  slug,
  pathParts,
  titleVariants,
  familyKeyFor,
  scriptProfile,
  languageProfile,
  sketchJaccard,
  buildProfiles,
  proposeRelationships,
  scorePair,
  inputKeyFor,
  persistProposals,
  writeFamilyKeys,
  seedWarFamily,
  scan,
  corroboratingSpellings,
  tokenize,
};
