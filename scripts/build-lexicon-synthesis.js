'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { stableId, normalizeLak } = require('../lib/corpus-v2');
const { stemKey } = require('../lib/russian-morphology');

const SOURCE_ROOT = process.env.LAK_SOURCE_ROOT || '/Users/kurbaitaev/Claude-Cowork/Projects/LAK LANGUAGE';
const OUTPUT = path.join(__dirname, '..', 'imports', 'lak-lexicon-v1');
const SCHEMA_VERSION = 'lexicon-synthesis-v1';
const GENERATOR_VERSION = 'build-lexicon-synthesis.js/1';

const PATHS = {
  gadzhiev: path.join(SOURCE_ROOT, '04_corpus/lak-corpus-v1.1/processed/gadzhiev_1958_lexicon.jsonl'),
  khaydakov: path.join(SOURCE_ROOT, '04_corpus/lak-corpus-v1.2/processed/khaydakov_1962_lexicon.jsonl'),
  lexcauc: path.join(SOURCE_ROOT, '04_corpus/lak-corpus-v1.2/processed/lexcauc_lak_lexicon.jsonl'),
  komen: path.join(SOURCE_ROOT, '04_corpus/lak-corpus-v1.4/processed/komen_lexicon.jsonl'),
  ids: path.join(SOURCE_ROOT, '04_corpus/lak-corpus-v1/processed/lexicon.jsonl'),
  corpus: path.join(__dirname, '..', 'public/data/corpus-data.json'),
};

const SOURCES = [
  { id: 'gadzhiev-1958', title: 'Russian-Lak School Dictionary', creator_credit: 'G. M. Gadzhiyev', canonical_url: 'http://www.lakkumaz.narod.ru/lakkumaz_gadzhiev_slovar.html', rights_status: 'permission_recorded', access_status: 'public', public_search_allowed: true, training_allowed: true, review_status: 'source_verified', attribution_text: 'Gadzhiyev 1958 Russian-Lak School Dictionary' },
  { id: 'khaydakov-1962', title: 'Lak-Russian Dictionary', creator_credit: 'S. M. Khaydakov', rights_status: 'permission_recorded', access_status: 'public', public_search_allowed: true, training_allowed: true, review_status: 'source_verified', attribution_text: 'Khaydakov 1962 Lak-Russian Dictionary' },
  { id: 'lexcauc-lak', title: 'LexCauc Lak lexical dataset', creator_credit: 'LexCauc contributors', rights_status: 'permission_recorded', access_status: 'public', public_search_allowed: true, training_allowed: true, review_status: 'source_verified', attribution_text: 'LexCauc Lak lexical dataset' },
  { id: 'komen-lakdict', title: 'Lak Dictionary', creator_credit: 'Erwin R. Komen', canonical_url: 'https://cls.ru.nl/staff/ekomen/lakdict/', rights_status: 'permission_recorded', access_status: 'public', public_search_allowed: true, training_allowed: true, review_status: 'source_verified', attribution_text: 'Komen Lak Dictionary' },
  { id: 'ids-lak', title: 'Intercontinental Dictionary Series: Lak', canonical_url: 'https://ids.clld.org/contributions/56', spdx_license: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', rights_status: 'open_license', access_status: 'public', public_search_allowed: true, training_allowed: true, review_status: 'rights_verified', attribution_text: 'IDS Lak, CC BY 4.0' },
  { id: 'uslar-1890', title: 'Lak language materials and historical lexicon', creator_credit: 'P. K. Uslar', rights_status: 'public_domain', access_status: 'public', public_search_allowed: true, training_allowed: true, review_status: 'rights_verified', attribution_text: 'Uslar 1890 historical Lak lexicon' },
  { id: 'digiev-2004', title: 'Russian-Lak Phrasebook', creator_credit: 'M. Digiev', rights_status: 'permission_recorded', access_status: 'public', public_search_allowed: true, training_allowed: true, review_status: 'source_verified', attribution_text: 'Digiev Russian-Lak Phrasebook' },
];

function hash(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function contentHash(record) {
  const clean = {};
  for (const key of Object.keys(record).sort()) if (key !== 'content_hash') clean[key] = record[key];
  return hash(JSON.stringify(clean) + '\n');
}

function readJsonl(filename) {
  return fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${filename}:${index + 1}: ${error.message}`); }
  });
}

function removeMarks(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

function normalizeRu(value) {
  return removeMarks(value).normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
    .replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, '');
}

function normalizeLbe(value) {
  return normalizeLak(removeMarks(value)).replace(/[`´]+\d*$/u, '').replace(/\s+/g, ' ').trim();
}

function singleWord(value) {
  return /^[\p{L}\p{M}ӀӏІі1'’-]+$/u.test(String(value || '').trim());
}

function cleanForm(value) {
  return String(value || '').replace(/^[\s,.;:]+|[\s,.;:]+$/g, '').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sourceRecord(sourceId) {
  const source = SOURCES.find(item => item.id === sourceId);
  if (!source) throw new Error(`Unknown source ${sourceId}`);
  return source;
}

const bundle = { sources: SOURCES, entries: [], senses: [], forms: [], relations: [], terms: [] };
const seen = { entry: new Set(), sense: new Set(), form: new Set(), relation: new Set(), term: new Set() };

function addEntry(input) {
  sourceRecord(input.source_id);
  const id = stableId('lexentry', input.source_id, input.source_entry_ref);
  const row = { id, ...input };
  row.content_hash = contentHash(row);
  if (seen.entry.has(id)) throw new Error(`Duplicate entry ${id}`);
  seen.entry.add(id);
  bundle.entries.push(row);
  return row;
}

function addSense(entry, input) {
  const ordinal = input.ordinal || 1;
  const id = stableId('lexsense', entry.id, String(ordinal));
  const row = { id, entry_id: entry.id, ordinal, gloss_ru: input.gloss_ru || null,
    gloss_en: input.gloss_en || null, definition: input.definition || null,
    usage_label: input.usage_label || null, raw_sense: input.raw_sense || input.gloss_ru || input.gloss_en || entry.raw_entry };
  row.content_hash = contentHash(row);
  if (!seen.sense.has(id)) { seen.sense.add(id); bundle.senses.push(row); }
  return row;
}

function addForm(entry, input) {
  const original = cleanForm(input.form_original);
  if (!original) return null;
  const normalized = input.language_code === 'ru' ? normalizeRu(original) : normalizeLbe(original);
  if (!normalized) return null;
  const id = stableId('lexform', entry.id, input.language_code, normalized, input.form_role);
  const row = { id, entry_id: entry.id, language_code: input.language_code,
    form_original: original, form_normalized: normalized, form_role: input.form_role,
    feature_atoms: unique(input.feature_atoms || []), source_explicit: input.source_explicit !== false,
    raw_note: input.raw_note || null };
  row.content_hash = contentHash(row);
  if (!seen.form.has(id)) { seen.form.add(id); bundle.forms.push(row); }
  return row;
}

function addRelation(entry, lemma, relationType, sourceExplicit = true, sourceForm = lemma) {
  const normalized = normalizeLbe(lemma);
  if (!normalized || !singleWord(normalized)) return null;
  const id = stableId('lexrel', entry.id, normalized, relationType);
  const row = { id, entry_id: entry.id, lemma_normalized: normalized,
    lemma_display: cleanForm(lemma), relation_type: relationType,
    source_form_normalized: normalizeLbe(sourceForm), source_explicit: sourceExplicit };
  if (!seen.relation.has(id)) { seen.relation.add(id); bundle.relations.push(row); }
  return row;
}

function addTerm(entry, input) {
  const original = cleanForm(input.term_original);
  if (!original) return;
  const normalized = input.language_code === 'ru' ? normalizeRu(original) : normalizeLbe(original);
  if (!normalized) return;
  const stem = input.language_code === 'ru' ? stemKey(normalized) : null;
  const senseId = input.sense ? input.sense.id : '';
  const id = stableId('lexterm', entry.id, senseId, input.language_code, normalized, input.term_type);
  const row = { id, entry_id: entry.id, sense_id: senseId || null, language_code: input.language_code,
    term_original: original, term_normalized: normalized, stem_key: stem || null,
    term_type: input.term_type, weight: input.weight };
  row.content_hash = contentHash(row);
  if (!seen.term.has(id)) { seen.term.add(id); bundle.terms.push(row); }
}

const RU_STOP = new Set('и в во на по с со к ко у о об от до за из для при или а но не это тот та те как что кто где когда его ее их он она они мы вы я ты быть был была были есть же ли бы мн нет ср муж жен прил нареч сов несов перен уст разг кого либо чем'.split(' '));

function addRussianGlossTerms(entry, sense, text, weight = 28) {
  const normalized = normalizeRu(text);
  const tokens = normalized.match(/[а-яё-]+/gu) || [];
  for (const token of unique(tokens)) {
    if (token.length < 3 || RU_STOP.has(token)) continue;
    addTerm(entry, { sense, language_code: 'ru', term_original: token, term_type: 'gloss', weight });
  }
}

function inferGadzhievPos(raw) {
  if (/\b(?:м\.|ж\.|ср\.|мн\.)/iu.test(raw)) return 'N';
  if (/\bприл\./iu.test(raw)) return 'ADJ';
  if (/\b(?:гл\.|сов\.|несов\.)/iu.test(raw)) return 'V';
  if (/\bнареч\./iu.test(raw)) return 'ADV';
  if (/\bчислит\./iu.test(raw)) return 'NUM';
  if (/\bмест/iu.test(raw)) return 'PRON';
  return null;
}

function parseGadzhievTranslation(row) {
  let rest = String(row.raw_entry || '');
  const display = String(row.russian_headword_display || row.russian_headword || '');
  if (rest.startsWith(display)) rest = rest.slice(display.length).trim();
  const forms = [];
  const plural = rest.match(/^мн\.\s+(?!нет\b)([^,.;]+)[,.;]\s*/iu);
  if (plural) { forms.push({ form: plural[1], features: ['PL'] }); rest = rest.slice(plural[0].length); }
  rest = rest.replace(/^мн\.\s+нет,?\s*/iu, '');
  let previous;
  const grammar = /^(?:м\.|ж\.|ср\.|мн\.|прил\.|нареч\.|гл\.|сов\.|несов\.|мест\.?|числит\.|предл\.|союз|межд\.|част\.|вводн\.\s*сл\.|предлог|частица|нескл\.?)\s*,?\s*/iu;
  do { previous = rest; rest = rest.replace(grammar, ''); } while (rest !== previous);
  return { translation: rest.trim(), russianForms: forms };
}

function gadzhievCandidates(text) {
  const beforeExamples = String(text || '').split(/\s+[—–]\s+/u)[0];
  const pieces = beforeExamples.split(/\s*[.;]\s*|\s*,\s*|\s+\d+\)\s*/u);
  return unique(pieces.map(piece => cleanForm(piece
    .replace(/^\d+\)\s*/u, '')
    .replace(/^(?:перен\.|уст\.|разг\.|букв\.|грам\.|бахх\.)\s*/iu, '')
    .replace(/^\([^)]*\)\s*/u, ''))))
    .filter(value => value && value.length <= 80 && !/\s/u.test(value));
}

function ingestGadzhiev() {
  for (const row of readJsonl(PATHS.gadzhiev)) {
    // One malformed HTML paragraph nests the remainder of the dictionary.
    // Every nested entry is also present as its own record, so retain only
    // the first complete entry here instead of duplicating 700k characters.
    const sourceRow = { ...row };
    if (String(sourceRow.raw_entry || '').length > 1000) {
      const stop = sourceRow.raw_entry.indexOf('.');
      sourceRow.raw_entry = stop >= 0 ? sourceRow.raw_entry.slice(0, stop + 1) : sourceRow.raw_entry.slice(0, 500);
    }
    const parsed = parseGadzhievTranslation(sourceRow);
    const entry = addEntry({ source_id: 'gadzhiev-1958', source_entry_ref: row.entry_id,
      direction: 'ru_lbe', headword_language: 'ru', headword_original: row.russian_headword_display || row.russian_headword,
      headword_normalized: normalizeRu(row.russian_headword), homonym_number: null,
      part_of_speech: inferGadzhievPos(sourceRow.raw_entry), noun_class: null,
      source_locator: `paragraph ${row.source_paragraph}`, source_url: row.source_url || null,
      raw_entry: sourceRow.raw_entry, review_status: row.review_status || 'source_import_unreviewed' });
    addForm(entry, { language_code: 'ru', form_original: row.russian_headword, form_role: 'headword' });
    addTerm(entry, { language_code: 'ru', term_original: row.russian_headword, term_type: 'headword', weight: 100 });
    for (const form of parsed.russianForms) {
      addForm(entry, { language_code: 'ru', form_original: form.form, form_role: 'inflected_form', feature_atoms: form.features });
      addTerm(entry, { language_code: 'ru', term_original: form.form, term_type: 'inflected_form', weight: 95 });
    }
    const senseChunks = parsed.translation.split(/\s+(?=\d+\)\s*)/u).filter(Boolean);
    const senses = senseChunks.length ? senseChunks : [parsed.translation || row.entry_text];
    senses.forEach((rawSense, index) => {
      const sense = addSense(entry, { ordinal: index + 1, raw_sense: rawSense, definition: rawSense });
      for (const candidate of gadzhievCandidates(rawSense)) {
        addForm(entry, { language_code: 'lbe', form_original: candidate, form_role: 'translation_equivalent' });
        addTerm(entry, { sense, language_code: 'lbe', term_original: candidate, term_type: 'translation_equivalent', weight: 90 });
        addRelation(entry, candidate, 'translation_equivalent');
      }
    });
  }
}

function khaydakovHeadword(value) {
  const original = cleanForm(value);
  const match = original.match(/^(.*?)[`´](\d+)$/u);
  return { base: cleanForm(match ? match[1] : original), homonym: match ? Number(match[2]) : null };
}

function khaydakovParadigm(base, text) {
  const start = String(text || '').match(/^\s*(?:[IVX]+\s*)?\(([^)]+)\)/u);
  if (!start) return [];
  const forms = [];
  for (let raw of start[1].split(/\s*,\s*/u)) {
    raw = cleanForm(raw.replace(/^(?:род\.\s*п\.\s*ед\.\s*ч\.|ед\.\s*ч\.|мн\.\s*ч\.)\s*/iu, ''));
    if (!raw || /\s/u.test(raw) || /[а-я]\./iu.test(raw)) continue;
    if (raw.startsWith('-')) raw = base + raw.slice(1);
    if (singleWord(raw)) forms.push(raw);
  }
  return unique(forms);
}

function ingestKhaydakov() {
  for (const row of readJsonl(PATHS.khaydakov)) {
    const head = khaydakovHeadword(row.lak_headword);
    const classMatch = String(row.russian_entry_text || '').match(/^\s*(I|II|III|IV)\b/u);
    const entry = addEntry({ source_id: 'khaydakov-1962', source_entry_ref: row.entry_id,
      direction: 'lbe_ru', headword_language: 'lbe', headword_original: row.lak_headword,
      headword_normalized: normalizeLbe(head.base), homonym_number: head.homonym,
      part_of_speech: null, noun_class: classMatch ? classMatch[1] : null,
      source_locator: `line ${row.source_line}`, source_url: null, raw_entry: row.raw_entry,
      review_status: row.review_status || 'source_import_unreviewed' });
    addForm(entry, { language_code: 'lbe', form_original: head.base, form_role: 'headword' });
    addTerm(entry, { language_code: 'lbe', term_original: head.base, term_type: 'headword', weight: 100 });
    addRelation(entry, head.base, 'headword');
    for (const form of khaydakovParadigm(head.base, row.russian_entry_text)) {
      const features = form.endsWith('ру') ? ['PL'] : [];
      addForm(entry, { language_code: 'lbe', form_original: form, form_role: 'inflected_form', feature_atoms: features, raw_note: 'Explicit Khaydakov paradigm' });
      addTerm(entry, { language_code: 'lbe', term_original: form, term_type: 'inflected_form', weight: 95 });
    }
    const chunks = String(row.russian_entry_text || '').split(/\s+(?=\d+\.\s*)/u).filter(Boolean);
    (chunks.length ? chunks : [row.russian_entry_text]).forEach((rawSense, index) => {
      const gloss = cleanForm(String(rawSense || '').replace(/^\d+\.\s*/u, ''));
      const sense = addSense(entry, { ordinal: index + 1, gloss_ru: gloss, raw_sense: rawSense || row.raw_entry });
      addRussianGlossTerms(entry, sense, gloss);
    });
  }
}

function ingestKomen() {
  for (const row of readJsonl(PATHS.komen)) {
    const entry = addEntry({ source_id: 'komen-lakdict', source_entry_ref: row.entry_id,
      direction: row.gloss_ru ? 'lbe_ru' : 'lbe_en', headword_language: 'lbe',
      headword_original: row.headword, headword_normalized: normalizeLbe(row.headword_key || row.headword),
      homonym_number: null, part_of_speech: row.pos || null, noun_class: null,
      source_locator: row.source_page || null, source_url: row.source_url || null,
      raw_entry: [row.headword, row.pos, row.gloss_ru, row.gloss_en].filter(Boolean).join(' | '),
      review_status: 'source_import_unreviewed' });
    addForm(entry, { language_code: 'lbe', form_original: row.headword, form_role: 'headword' });
    addTerm(entry, { language_code: 'lbe', term_original: row.headword, term_type: 'headword', weight: 100 });
    addRelation(entry, row.headword, 'headword');
    const sense = addSense(entry, { gloss_ru: row.gloss_ru, gloss_en: row.gloss_en,
      raw_sense: [row.gloss_ru, row.gloss_en].filter(Boolean).join(' | ') || row.headword });
    if (row.gloss_ru) addRussianGlossTerms(entry, sense, row.gloss_ru, 60);
    if (row.gloss_en) addTerm(entry, { sense, language_code: 'en', term_original: row.gloss_en, term_type: 'gloss', weight: 60 });
  }
}

function ingestLexCauc() {
  const rows = readJsonl(PATHS.lexcauc);
  const lemmaByLexId = new Map();
  for (const row of rows) if (row.lex_id && row.orthographic && !lemmaByLexId.has(String(row.lex_id))) lemmaByLexId.set(String(row.lex_id), row.orthographic);
  for (const row of rows) {
    const lemma = lemmaByLexId.get(String(row.lex_id)) || row.orthographic;
    const headword = row.orthographic || row.phonemic || '[no orthographic form]';
    const entry = addEntry({ source_id: 'lexcauc-lak', source_entry_ref: row.entry_id,
      direction: row.concept_ru || row.def_ru ? 'lbe_ru' : 'multilingual', headword_language: row.orthographic ? 'lbe' : (row.phonemic ? 'lbe-x-phonemic' : 'und'),
      headword_original: headword, headword_normalized: row.orthographic ? normalizeLbe(row.orthographic) : cleanForm(headword).toLowerCase(),
      homonym_number: null, part_of_speech: null, noun_class: row.gender || null,
      source_locator: `${row.source_sheet || 'lexcauc'} row ${row.source_row}`, source_url: null,
      raw_entry: JSON.stringify({ orthographic: row.orthographic, phonemic: row.phonemic, subentry: row.subentry,
        concept_ru: row.concept_ru, concept_en: row.concept_en, def_ru: row.def_ru, def_en: row.def_en,
        gloss: row.gloss, examples: [row.cx1, row.cx2, row.cx3].filter(Boolean) }),
      review_status: row.review_status || 'source_import_unreviewed' });
    const role = normalizeLbe(row.orthographic) === normalizeLbe(lemma) ? 'headword' : 'inflected_form';
    addForm(entry, { language_code: 'lbe', form_original: row.orthographic || lemma, form_role: role,
      feature_atoms: row.subentry ? [String(row.subentry).toUpperCase()] : [], raw_note: row.subentry || null });
    addTerm(entry, { language_code: 'lbe', term_original: row.orthographic || lemma, term_type: role, weight: role === 'headword' ? 100 : 95 });
    addRelation(entry, lemma, role === 'headword' ? 'headword' : 'source_group', true, row.orthographic || lemma);
    const glossRu = row.concept_ru || row.def_ru || row.cx1_ru || null;
    const glossEn = row.concept_en || row.def_en || row.cx1_en || null;
    const sense = addSense(entry, { gloss_ru: glossRu, gloss_en: glossEn,
      raw_sense: [glossRu, glossEn, row.gloss].filter(Boolean).join(' | ') || row.orthographic });
    if (glossRu) addRussianGlossTerms(entry, sense, glossRu, 55);
    if (glossEn) addTerm(entry, { sense, language_code: 'en', term_original: glossEn, term_type: 'gloss', weight: 55 });
  }
}

function ingestIds() {
  for (const row of readJsonl(PATHS.ids)) {
    const isUslar = String(row.source_url || '').includes('books.google') || row.dialect === 'historical';
    const sourceId = isUslar ? 'uslar-1890' : 'ids-lak';
    const formText = row.form_cyrillic || row.form || '';
    const forms = unique(String(formText).split(/\s*[;,]\s*/u).map(cleanForm));
    const headword = forms[0] || formText || row.entry_id;
    const entry = addEntry({ source_id: sourceId, source_entry_ref: row.entry_id,
      direction: 'lbe_en', headword_language: 'lbe', headword_original: headword,
      headword_normalized: normalizeLbe(headword), homonym_number: null,
      part_of_speech: null, noun_class: null, source_locator: row.entry_id,
      source_url: row.source_url || null, raw_entry: JSON.stringify(row),
      review_status: row.review_status || 'source_import_unreviewed' });
    forms.forEach((form, index) => {
      const role = index === 0 ? 'headword' : 'variant';
      addForm(entry, { language_code: 'lbe', form_original: form, form_role: role });
      addTerm(entry, { language_code: 'lbe', term_original: form, term_type: role === 'variant' ? 'inflected_form' : 'headword', weight: index === 0 ? 100 : 88 });
      if (singleWord(form)) addRelation(entry, form, index === 0 ? 'headword' : 'translation_equivalent');
    });
    const glossEn = row.meaning || row.gloss || null;
    const sense = addSense(entry, { gloss_en: glossEn, raw_sense: glossEn || row.raw_entry || JSON.stringify(row) });
    if (glossEn) addTerm(entry, { sense, language_code: 'en', term_original: glossEn, term_type: 'gloss', weight: 55 });
  }
}

function ingestDigiev() {
  const rows = JSON.parse(fs.readFileSync(PATHS.corpus, 'utf8'))
    .filter(row => row[3] === 'Digiev phrasebook');
  for (const row of rows) {
      const lak = row[1];
      const russian = row[2];
      const sourceRef = row[5];
      const entry = addEntry({ source_id: 'digiev-2004', source_entry_ref: sourceRef,
        direction: 'ru_lbe', headword_language: 'ru', headword_original: russian,
        headword_normalized: normalizeRu(russian), homonym_number: null, part_of_speech: null,
        noun_class: null, source_locator: sourceRef, source_url: row[6] || null,
        raw_entry: `${russian} | ${lak}`, review_status: 'source_import_unreviewed' });
      addForm(entry, { language_code: 'ru', form_original: russian, form_role: 'headword' });
      addTerm(entry, { language_code: 'ru', term_original: russian, term_type: 'headword', weight: 100 });
      const sense = addSense(entry, { definition: lak, raw_sense: lak });
      const role = singleWord(lak) ? 'translation_equivalent' : 'phrase';
      addForm(entry, { language_code: 'lbe', form_original: lak, form_role: role });
      addTerm(entry, { sense, language_code: 'lbe', term_original: lak, term_type: role, weight: role === 'translation_equivalent' ? 90 : 70 });
      if (role === 'translation_equivalent') addRelation(entry, lak, 'translation_equivalent');
  }
}

function writeArtifact(name, rows) {
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const bytes = zlib.gzipSync(Buffer.from(text), { level: 9, mtime: 0 });
  fs.writeFileSync(path.join(OUTPUT, name), bytes);
  return { records: rows.length, sha256: hash(bytes) };
}

function main() {
  for (const filename of Object.values(PATHS)) if (!fs.existsSync(filename)) throw new Error(`Missing source ${filename}`);
  ingestGadzhiev();
  ingestKhaydakov();
  ingestLexCauc();
  ingestKomen();
  ingestIds();
  ingestDigiev();
  fs.mkdirSync(OUTPUT, { recursive: true });
  const artifacts = {};
  for (const [name, rows] of [['sources.jsonl.gz', bundle.sources], ['entries.jsonl.gz', bundle.entries],
    ['senses.jsonl.gz', bundle.senses], ['forms.jsonl.gz', bundle.forms],
    ['relations.jsonl.gz', bundle.relations], ['search-terms.jsonl.gz', bundle.terms]]) {
    artifacts[name] = writeArtifact(name, rows);
  }
  const bySource = {};
  for (const entry of bundle.entries) bySource[entry.source_id] = (bySource[entry.source_id] || 0) + 1;
  const manifest = { schema_version: SCHEMA_VERSION, generator_version: GENERATOR_VERSION,
    normalization_version: 'lak-search-v1', artifacts, counts: {
      sources: bundle.sources.length, entries: bundle.entries.length, senses: bundle.senses.length,
      forms: bundle.forms.length, relations: bundle.relations.length, search_terms: bundle.terms.length,
      entries_by_source: bySource,
    } };
  fs.writeFileSync(path.join(OUTPUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest.counts, null, 2));
}

if (require.main === module) main();

module.exports = { normalizeRu, normalizeLbe, parseGadzhievTranslation, gadzhievCandidates,
  khaydakovHeadword, khaydakovParadigm };
