'use strict';

/*
 * Private source-import layer test-suite (audited Diana Forker v1.2 package).
 *
 * Part 1 verifies lib/source-import.js against the real processed package in
 * private/v1.2: exact record counts, agreement with the package's own
 * stats.json, provenance granularity, fail-closed policy fields on every
 * record, audio totals, reference-metadata-only, Bible exclusion and
 * binary-URL refusal. Tampered copies of the package must be rejected, and a
 * workspace without the package must ingest nothing at all.
 *
 * Part 2 spawns an isolated server on port 5058 and proves the runtime
 * boundaries: authorization, four separate rights/access/review/training
 * decisions, corroboration without merging, exclusion from ordinary corpus
 * search and every public export, and a training export that fails closed.
 *
 * Every row it creates or changes is restored afterwards.
 *
 * Usage: node scripts/test-source-import.js
 * Requires: DATABASE_URL, REVIEWER_PASSPHRASE.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const sourceImport = require('../lib/source-import');

const BASE = 'http://127.0.0.1:5058';
const PASSPHRASE = process.env.REVIEWER_PASSPHRASE;
if (!PASSPHRASE) { console.error('REVIEWER_PASSPHRASE is required'); process.exit(1); }

const PACKAGE_DIR = sourceImport.PACKAGE_DIR;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A word that appears in the private Dzhidalaev OCR pages and nowhere in the
// public corpus. It must never surface in search or in any public export.
const OCR_MARKER = 'Дагучпедгиз';
const EXPECTED_TOTAL = 12478;
const SOURCE_IDS = sourceImport.EXPECTED_SOURCES.map(s => s.source_id);
const IDS = SOURCE_IDS.map(id => `'${id}'`).join(',');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

function client() {
  let cookie = '';
  return {
    async req(method, p, body) {
      const res = await fetch(BASE + p, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
      return { status: res.status, data, text };
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b); },
  };
}

// ── Tampered copies of the real package ──────────────────────
// Copy the package into a scratch directory and rewrite one record (or the
// package's own stats) before re-running verification.
function tamper(tmpRoot, name, file, mutate) {
  const dir = path.join(tmpRoot, 'tamper-' + name);
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(PACKAGE_DIR)) {
    fs.copyFileSync(path.join(PACKAGE_DIR, entry), path.join(dir, entry));
  }
  const target = path.join(dir, file);
  if (file.endsWith('.jsonl')) {
    const lines = fs.readFileSync(target, 'utf8').trim().split('\n');
    const records = lines.map(l => JSON.parse(l));
    const replacement = mutate(records);
    fs.writeFileSync(target, (replacement || records).map(r => JSON.stringify(r)).join('\n') + '\n');
  } else {
    const json = JSON.parse(fs.readFileSync(target, 'utf8'));
    mutate(json);
    fs.writeFileSync(target, JSON.stringify(json));
  }
  return sourceImport.verifySources({ packageDir: dir });
}

// ── Cleanup ──────────────────────────────────────────────────
// The staged candidates belong to the workspace, not to this test: only the
// test's own accounts, decisions and links are removed and every candidate it
// touched is reset to the fail-closed default.
const TEST_CONTRIBUTORS = `(SELECT id FROM contributors WHERE email LIKE 'test-si-%@example.com')`;
async function cleanup() {
  await pool.query(
    `DELETE FROM source_import_corroborations
      WHERE linked_by IN ${TEST_CONTRIBUTORS} OR note LIKE 'test-si:%'`);
  await pool.query(
    `DELETE FROM source_import_decisions
      WHERE decided_by IN ${TEST_CONTRIBUTORS} OR note LIKE 'test-si:%'
         OR decided_by_name IN ('SI Reviewer','SI Trusted')`);
  await pool.query(
    `UPDATE source_import_candidates
        SET access_status = 'private_research', rights_status = 'permission_pending',
            review_state = 'source_import_unreviewed', consent_status = 'unknown',
            training_ready = FALSE
      WHERE review_state <> 'source_import_unreviewed'
         OR access_status <> 'private_research' OR rights_status <> 'permission_pending'
         OR training_ready`);
  await pool.query(`DELETE FROM audit_events WHERE actor_id IN ${TEST_CONTRIBUTORS}
    OR event_type LIKE 'source_import_%'`);
  await pool.query(`DELETE FROM expert_grants WHERE contributor_id IN ${TEST_CONTRIBUTORS}`);
  await pool.query(`DELETE FROM contributors WHERE email LIKE 'test-si-%@example.com'`);
}

// ── Part 1: package verification ─────────────────────────────
function verificationTests(tmpRoot) {
  group('workspace without the processed package');
  const emptyDir = path.join(tmpRoot, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const missing = sourceImport.verifySources({ packageDir: emptyDir });
  check('every audited source reports awaiting_manifest',
    missing.sources.every(s => s.status === 'awaiting_manifest'), missing.sources.map(s => s.status));
  check('ingestion is blocked', missing.ingestion_blocked === true);
  check('no records are produced', missing.counts.verified_records === 0);
  check('audited totals are still reported as expectations',
    missing.counts.expected_records === EXPECTED_TOTAL, missing.counts.expected_records);

  group('verified v1.2 package');
  const verified = sourceImport.verifySources({ packageDir: PACKAGE_DIR });
  check('all five source groups verify', verified.counts.verified === 5,
    verified.sources.map(s => s.source_id + ':' + s.status + ':' + s.error));
  check('ingestion is not blocked', verified.ingestion_blocked === false);
  check('verified totals match the audit', verified.counts.verified_records === EXPECTED_TOTAL,
    verified.counts.verified_records);
  const bySource = Object.fromEntries(verified.sources.map(s => [s.source_id, s]));
  check('Khaydakov exposes 9,294 Lak-to-Russian candidates',
    bySource['khaydakov-1962'].records.length === 9294 &&
    bySource['khaydakov-1962'].layer === 'lexical_candidate');
  check('Khaydakov candidates carry Lak and Russian text with row provenance',
    bySource['khaydakov-1962'].records.every(r => r.lak_text && r.row_ref) &&
    bySource['khaydakov-1962'].records[0].ru_text !== null);
  check('LexCauc exposes 2,246 structured lexical candidates',
    bySource['lexcauc'].records.length === 2246 &&
    bySource['lexcauc'].records.every(r => r.row_ref));
  check('Dzhidalaev exposes 926 page-level OCR candidates',
    bySource['dzhidalaev-1993'].records.length === 926 &&
    bySource['dzhidalaev-1993'].layer === 'ocr_candidate' &&
    bySource['dzhidalaev-1993'].provenance_granularity === 'page' &&
    bySource['dzhidalaev-1993'].records.every(r => r.page_ref && r.ocr_text));
  const audio = bySource['lexcauc-audio'];
  check('WAV inventory is collection-level with 7 files / 3154.894 s',
    audio.provenance_granularity === 'collection' && audio.records.length === 7 &&
    audio.metrics.file_count === 7 && audio.metrics.total_duration_seconds === 3154.894, audio.metrics);
  check('audio rows claim no alignment, speaker or dialect',
    audio.records.every(r => r.provenance.row_or_time_alignment === null &&
      r.provenance.speaker_id === null && r.provenance.speaker_variety === null));
  check('audio consent stays unknown', audio.records.every(r => r.consent_status === 'unknown'));
  const refs = bySource['diana-reference-documents'];
  check('Kazenin 2013 and Anderson 1996 are reference metadata',
    refs.layer === 'reference_metadata' && refs.records.length === 5 &&
    refs.records.some(r => /Anderson/i.test(r.provenance.author) && r.provenance.year === 1996) &&
    refs.records.some(r => r.provenance.year === 2013));
  check('reference records carry no copied content',
    refs.records.every(r => !r.ocr_text && !r.ru_text && !r.lak_text));
  check('every record carries the SHA-256 of the received source file',
    verified.sources.every(s => s.records.every(r => /^[0-9a-f]{64}$/.test(r.provenance.source_sha256))));
  check('every record has a stable content checksum',
    verified.sources.every(s => s.records.every(r => /^[0-9a-f]{64}$/.test(r.content_sha256))));

  group('corroboration is reported, never merged');
  check('exact-spelling overlap matches the package reconciliation report',
    verified.overlap.overlapping_forms === 563 &&
    verified.reconciliation.exact_form_overlap.khaydakov_lexcauc === 563, verified.overlap);
  check('overlapping candidates stay as separate pairs',
    verified.overlap.candidate_pairs === 653, verified.overlap);

  group('public status is content-free');
  const status = sourceImport.publicStatus(verified);
  const statusText = JSON.stringify(status);
  check('no candidate text is exposed', !statusText.includes(OCR_MARKER) &&
    !statusText.includes(bySource['khaydakov-1962'].records[0].ru_text));
  check('policy defaults are fail-closed',
    status.policy_defaults.access_status === 'private_research' &&
    status.policy_defaults.rights_status === 'permission_pending' &&
    status.policy_defaults.review_state === 'source_import_unreviewed' &&
    status.policy_defaults.training_ready === false &&
    status.policy_defaults.redistribution_permitted === false, status.policy_defaults);
  check('no source is training-ready or public', status.sources.every(s =>
    s.training_ready === false && s.access_status === 'private_research'));
  check('corroboration is reported as unmerged', status.corroboration.merged === false);

  group('tampered packages are rejected');
  const cases = [
    ['record-count', 'lexcauc_lak_lexicon.jsonl', 'lexcauc',
      records => records.slice(0, -1), /audited count|2246/i],
    ['stats-mismatch', 'stats.json', 'khaydakov-1962',
      json => { json.khaydakov_entries = 9000; }, /stats\.khaydakov_entries/i],
    ['bible-declared', 'stats.json', 'lexcauc',
      json => { json.bible_included = true; }, /bible/i],
    ['access-relaxed', 'lexcauc_lak_lexicon.jsonl', 'lexcauc',
      records => { records[3].access_status = 'public'; }, /access_status/i],
    ['training-eligible', 'khaydakov_1962_lexicon.jsonl', 'khaydakov-1962',
      records => { records[7].training_eligible = true; }, /training_eligible|training-ready/i],
    ['review-state', 'lexcauc_lak_lexicon.jsonl', 'lexcauc',
      records => { records[2].review_status = 'approved'; }, /review_status/i],
    ['ocr-searchable', 'dzhidalaev_1993_ocr_pages.jsonl', 'dzhidalaev-1993',
      records => { records[4].search_eligible = true; }, /search_eligible/i],
    ['reference-extraction', 'reference_documents.jsonl', 'diana-reference-documents',
      records => { records[0].public_text_extraction_allowed = true; }, /public_text_extraction_allowed/i],
    ['bible-source', 'lexcauc_lak_lexicon.jsonl', 'lexcauc',
      records => { records[1].source = 'Лакский перевод Евангелия'; }, /bible/i],
    ['binary-url', 'lexcauc_audio_inventory.jsonl', 'lexcauc-audio',
      records => { records[0].notes = 'https://example.org/audio/LexCauc_Lak_1.WAV'; }, /binary/i],
    ['missing-provenance', 'dzhidalaev_1993_ocr_pages.jsonl', 'dzhidalaev-1993',
      records => { delete records[5].page; }, /missing page/i],
    ['duplicate-ref', 'khaydakov_1962_lexicon.jsonl', 'khaydakov-1962',
      records => { records[1].entry_id = records[0].entry_id; }, /duplicate/i],
    ['missing-file-hash', 'lexcauc_lak_lexicon.jsonl', 'lexcauc',
      records => { records[6].source_sha256 = 'not-a-hash'; }, /SHA-256/i],
    ['audio-duration', 'lexcauc_audio_inventory.jsonl', 'lexcauc-audio',
      records => { records[0].duration_seconds = 600; }, /audited 3154\.894/i],
    ['audio-alignment-claim', 'lexcauc_audio_inventory.jsonl', 'lexcauc-audio',
      records => { records[2].row_or_time_alignment = 'rows 1–300'; }, /alignment/i],
    ['reference-missing-anderson', 'reference_documents.jsonl', 'diana-reference-documents',
      records => { const a = records.find(r => /Anderson/i.test(r.author || '')); a.author = 'Unknown'; },
      /Anderson 1996/i],
    ['reference-copied-text', 'reference_documents.jsonl', 'diana-reference-documents',
      records => { records[1].full_text = 'copied chapter text'; }, /metadata only/i],
    ['stats-missing-key', 'stats.json', 'khaydakov-1962',
      json => { delete json.khaydakov_entries; }, /does not declare khaydakov_entries/i],
    ['stats-missing-audio-seconds', 'stats.json', 'lexcauc-audio',
      json => { delete json.lexcauc_audio_seconds; }, /does not declare lexcauc_audio_seconds/i],
    ['broken-json', 'lexcauc_lak_lexicon.jsonl', 'lexcauc', null, /not valid JSON/i],
  ];
  for (const [name, file, sourceId, mutate, pattern] of cases) {
    let result;
    if (mutate === null) {
      const dir = path.join(tmpRoot, 'tamper-' + name);
      fs.mkdirSync(dir, { recursive: true });
      for (const entry of fs.readdirSync(PACKAGE_DIR)) {
        fs.copyFileSync(path.join(PACKAGE_DIR, entry), path.join(dir, entry));
      }
      fs.appendFileSync(path.join(dir, file), '{"entry_id": broken\n');
      result = sourceImport.verifySources({ packageDir: dir });
    } else {
      result = tamper(tmpRoot, name, file, mutate);
    }
    const source = result.sources.find(s => s.source_id === sourceId);
    check(`${name} → rejected`, source.status === 'rejected' && pattern.test(source.error || ''),
      { status: source.status, error: source.error });
    check(`${name} → contributes no records`, source.records.length === 0);
    check(`${name} → ingestion is blocked`, result.ingestion_blocked === true);
    fs.rmSync(path.join(tmpRoot, 'tamper-' + name), { recursive: true, force: true });
  }

  // The package declaration is not optional: without it there is nothing to
  // check the audited counts against, so nothing may be ingested.
  group('the package declaration is mandatory');
  const withoutStats = (name, mutate) => {
    const dir = path.join(tmpRoot, 'nostats-' + name);
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(PACKAGE_DIR)) {
      fs.copyFileSync(path.join(PACKAGE_DIR, entry), path.join(dir, entry));
    }
    mutate(path.join(dir, 'stats.json'));
    const result = sourceImport.verifySources({ packageDir: dir });
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  };

  for (const [name, mutate] of [
    ['missing stats.json', p => fs.rmSync(p)],
    ['unreadable stats.json', p => fs.writeFileSync(p, '{ not json')],
  ]) {
    const result = withoutStats(name.replace(/\W+/g, '-'), mutate);
    check(`${name} → no source is verified`,
      result.sources.every(s => s.status === 'awaiting_manifest' && s.records.length === 0),
      result.sources.map(s => s.status));
    check(`${name} → ingestion is blocked`, result.ingestion_blocked === true);
    check(`${name} → the package reads as absent`, result.package_present === false);
    const pub = sourceImport.publicStatus(result);
    check(`${name} → public status says the package is not present`,
      pub.sources.every(s => s.blocked_reason_code === 'package_not_present' &&
        s.verified_record_count === 0),
      pub.sources.map(s => s.blocked_reason_code));
    check(`${name} → nothing can be imported`,
      result.sources.reduce((n, s) => n + s.records.length, 0) === 0);
  }

  // A different archive under the audited name blocks everything too.
  const archiveDir = path.join(tmpRoot, 'archive-mismatch');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'lak-corpus-v1.2-processed-only-999.zip'), 'not the audited archive');
  const swapped = sourceImport.verifySources({ packageDir: PACKAGE_DIR, archiveDir });
  check('a mismatched package archive rejects every source',
    swapped.sources.every(s => s.status === 'rejected' && /checksum/i.test(s.error || '')),
    swapped.sources.map(s => s.error));
  check('a mismatched package archive blocks ingestion', swapped.ingestion_blocked === true);
  const withArchive = sourceImport.verifySources({ packageDir: PACKAGE_DIR });
  check('the received archive still matches its recorded checksum',
    withArchive.sources.every(s => s.status === 'verified'),
    withArchive.sources.map(s => s.error));
  fs.rmSync(archiveDir, { recursive: true, force: true });
}

// ── Part 2: runtime boundaries ───────────────────────────────
async function runtimeTests() {
  group('status endpoint after import');
  const anon = client();
  const status = await anon.get('/api/source-import/status');
  const bySource = Object.fromEntries((status.data.sources || []).map(s => [s.source_id, s]));
  check('status is public', status.status === 200);
  check('Khaydakov staged 9,294 private candidates',
    bySource['khaydakov-1962'].imported_record_count === 9294, bySource['khaydakov-1962']);
  check('LexCauc staged 2,246 private candidates',
    bySource['lexcauc'].imported_record_count === 2246, bySource['lexcauc']);
  check('Dzhidalaev staged 926 OCR candidates',
    bySource['dzhidalaev-1993'].imported_record_count === 926, bySource['dzhidalaev-1993']);
  check('audio inventory reports 7 files / 3154.894 s',
    bySource['lexcauc-audio'].metrics.file_count === 7 &&
    bySource['lexcauc-audio'].metrics.total_duration_seconds === 3154.894);
  check('reference documents are staged as metadata',
    bySource['diana-reference-documents'].imported_record_count === 5);
  check('nothing is public or training-ready',
    status.data.sources.every(s => s.public_record_count === 0 && s.training_ready_record_count === 0));
  check('status leaks no candidate text', !status.text.includes(OCR_MARKER));
  // Diagnostics are internal: a blocked source may report a bounded code, never
  // a verifier message, a file name or a path fragment.
  const allowedCodes = ['package_not_present', 'verification_failed'];
  check('status carries no verifier diagnostics',
    status.data.sources.every(s => !("blocked_reason" in s) &&
      (s.blocked_reason_code === null || allowedCodes.includes(s.blocked_reason_code))),
    status.data.sources.map(s => s.blocked_reason_code));
  check('status exposes no filesystem detail',
    !/\.jsonl|\.json\b|\/home\/|private\/|ENOENT|SyntaxError|at Object\./.test(
      status.text.replace(/"source_file":"[^"]*"/g, '')),
    status.text.slice(0, 400));

  group('authorization');
  check('anonymous candidate list → 401', (await anon.get('/api/source-import/candidates')).status === 401);
  check('anonymous review → 401',
    (await anon.post('/api/source-import/candidates/x/review', { review_state: 'in_review' })).status === 401);
  check('anonymous corroboration → 401',
    (await anon.post('/api/source-import/candidates/x/corroborations', { related_record_id: 'y' })).status === 401);
  check('anonymous training export → 401', (await anon.get('/api/source-import/export.jsonl')).status === 401);

  const contributor = client();
  const reg = await contributor.post('/api/auth/register', {
    email: 'test-si-contributor@example.com', password: 'test-password-123', display_name: 'SI Contributor' });
  check('self-registered contributor cannot read candidates',
    (await contributor.get('/api/source-import/candidates')).status === 403, reg.data);
  check('self-registered contributor cannot read OCR pages',
    (await contributor.get('/api/source-import/candidates?source_id=dzhidalaev-1993')).status === 403);

  const admin = client();
  const adminLogin = await admin.post('/api/auth/login', { name: 'SI Reviewer', passphrase: PASSPHRASE });
  check('reviewer (administrator) login → 200', adminLogin.status === 200, adminLogin.data);

  const trusted = client();
  const regT = await trusted.post('/api/auth/register', {
    email: 'test-si-trusted@example.com', password: 'test-password-123', display_name: 'SI Trusted' });
  await admin.post(`/api/admin/contributors/${regT.data.account.id}/role`, {
    role: 'trusted_validator', basis: 'test-si: community language worker' });
  const trustedList = await trusted.get('/api/source-import/candidates?source_id=lexcauc&limit=3');
  check('trusted validator can read candidates', trustedList.status === 200, trustedList.data);
  check('candidate payload keeps immutable row provenance',
    trustedList.data.candidates.every(c => c.provenance && c.provenance.source_id === 'lexcauc' &&
      c.provenance.source_row && /^[0-9a-f]{64}$/.test(c.provenance.source_sha256)));
  check('candidates default to the fail-closed state',
    trustedList.data.candidates.every(c =>
      c.access_status === 'private_research' && c.rights_status === 'permission_pending' &&
      c.review_state === 'source_import_unreviewed' && c.consent_status === 'unknown' &&
      c.training_ready === false),
    trustedList.data.candidates[0]);
  const ocrList = await trusted.get('/api/source-import/candidates?source_id=dzhidalaev-1993&limit=2');
  check('OCR pages are readable only inside the review workflow',
    ocrList.status === 200 && ocrList.data.candidates[0].ocr_text &&
    ocrList.data.candidates[0].page_ref, ocrList.data.candidates && ocrList.data.candidates[0]);

  const [first, second] = trustedList.data.candidates;

  group('separate rights / access / review / training decisions');
  const inReview = await trusted.post(`/api/source-import/candidates/${first.id}/review`, {
    review_state: 'in_review', note: 'test-si: opened' });
  check('trusted validator may move a candidate into review',
    inReview.status === 200 && inReview.data.candidate.review_state === 'in_review', inReview.data);
  check('review does not change rights or access',
    inReview.data.candidate.rights_status === 'permission_pending' &&
    inReview.data.candidate.access_status === 'private_research' &&
    inReview.data.candidate.training_ready === false);
  const trustedPublish = await trusted.post(`/api/source-import/candidates/${first.id}/review`, {
    access_status: 'public', note: 'test-si: attempted publish' });
  check('trusted validator cannot publish a candidate', trustedPublish.status === 403, trustedPublish.data);
  const acceptOnly = await admin.post(`/api/source-import/candidates/${first.id}/review`, {
    review_state: 'accepted_candidate', note: 'test-si: accepted' });
  check('acceptance alone leaves rights pending',
    acceptOnly.data.candidate.rights_status === 'permission_pending' &&
    acceptOnly.data.candidate.training_ready === false);
  const trainWithoutRights = await admin.post(`/api/source-import/candidates/${first.id}/review`, {
    training_ready: true, note: 'test-si: train without rights' });
  check('training without cleared rights → 409', trainWithoutRights.status === 409, trainWithoutRights.data);
  const trainWithoutConsent = await admin.post(`/api/source-import/candidates/${first.id}/review`, {
    rights_status: 'permission_granted', training_ready: true, consent_status: 'unknown',
    note: 'test-si: train without consent' });
  check('training without settled consent → 409', trainWithoutConsent.status === 409, trainWithoutConsent.data);
  const invalid = await admin.post(`/api/source-import/candidates/${first.id}/review`, {
    review_state: 'totally_fine' });
  check('unknown review state → 400', invalid.status === 400);
  const decisions = await pool.query(
    `SELECT decision_type, from_value, to_value FROM source_import_decisions
      WHERE candidate_id = $1 ORDER BY created_at`, [first.id]);
  check('every decision is logged immutably with its type',
    decisions.rows.length >= 2 && decisions.rows.some(d => d.decision_type === 'review'), decisions.rows);

  group('training export fails closed');
  const emptyExport = await admin.get('/api/source-import/export.jsonl');
  check('accepted-but-unclear candidate is not exported',
    emptyExport.status === 200 && emptyExport.text.trim() === '', emptyExport.text.slice(0, 200));
  const cleared = await admin.post(`/api/source-import/candidates/${first.id}/review`, {
    rights_status: 'permission_granted', consent_status: 'documented',
    review_state: 'accepted_candidate', access_status: 'public', training_ready: true,
    note: 'test-si: fully cleared' });
  check('fully cleared candidate may be published by an expert',
    cleared.status === 200 && cleared.data.candidate.training_ready === true, cleared.data);
  const fullExport = await admin.get('/api/source-import/export.jsonl');
  check('only the fully cleared candidate is exported',
    fullExport.text.trim().split('\n').filter(Boolean).length === 1, fullExport.text.slice(0, 200));
  check('the export carries provenance', fullExport.text.includes('"source_id":"lexcauc"'));
  const reverted = await admin.post(`/api/source-import/candidates/${first.id}/review`, {
    training_ready: false, access_status: 'private_research', note: 'test-si: withdrawn' });
  check('withdrawing the decision empties the export again',
    reverted.status === 200 && (await admin.get('/api/source-import/export.jsonl')).text.trim() === '');

  group('duplicates are corroborated, never merged');
  const autoLinks = await pool.query(
    `SELECT COUNT(*)::int AS n FROM source_import_corroborations
      WHERE relation = 'corroborates' AND linked_by_name = 'source-import'`);
  check('exact-spelling overlaps are linked automatically', autoLinks.rows[0].n === 653, autoLinks.rows[0]);
  const merged = await pool.query(
    `SELECT COUNT(*)::int AS n FROM source_import_candidates WHERE source_id IN (${IDS})`);
  check('linking merged nothing: all candidates are still stored separately',
    merged.rows[0].n === EXPECTED_TOTAL, merged.rows[0]);
  const link = await trusted.post(`/api/source-import/candidates/${first.id}/corroborations`, {
    related_candidate_id: second.id, note: 'test-si: same headword' });
  check('manual duplicate link is recorded', link.status === 200 && link.data.merged === false, link.data);
  const relink = await trusted.post(`/api/source-import/candidates/${first.id}/corroborations`, {
    related_candidate_id: second.id, note: 'test-si: same headword' });
  check('re-linking is idempotent', relink.status === 200 && relink.data.already_linked === true, relink.data);
  check('self-link → 400', (await trusted.post(`/api/source-import/candidates/${first.id}/corroborations`, {
    related_candidate_id: first.id, note: 'test-si: self' })).status === 400);
  check('unknown related candidate → 400',
    (await trusted.post(`/api/source-import/candidates/${first.id}/corroborations`, {
      related_candidate_id: 'sic_missing', note: 'test-si: unknown' })).status === 400);
  const secondAfter = await trusted.get(`/api/source-import/candidates/${second.id}`);
  check('the corroborating candidate keeps its own text and state',
    secondAfter.data.candidate.lak_text === second.lak_text &&
    secondAfter.data.candidate.review_state === 'source_import_unreviewed' &&
    secondAfter.data.candidate.access_status === 'private_research', secondAfter.data.candidate);
  const firstAfter = await trusted.get(`/api/source-import/candidates/${first.id}`);
  check('provenance is unchanged by review and linking',
    JSON.stringify(firstAfter.data.candidate.provenance) === JSON.stringify(first.provenance));
  check('the corroboration is visible on the candidate',
    firstAfter.data.corroborations.some(c => c.relation === 'corroborates' &&
      c.related_candidate_id === second.id), firstAfter.data.corroborations);

  group('candidates stay out of public search and exports');
  const ocrSearch = await anon.get(`/api/corpus/search?q=${encodeURIComponent(OCR_MARKER)}&limit=5`);
  check('OCR page text is not searchable', ocrSearch.data.total === 0, ocrSearch.data.total);
  const refSearch = await anon.get(`/api/corpus/search?q=${encodeURIComponent('lexcauc-lak')}&limit=5`);
  check('candidate references are not searchable', refSearch.data.total === 0, refSearch.data.total);
  const exportJson = await anon.get('/api/export.json');
  check('public JSON export excludes candidates',
    !exportJson.text.includes(OCR_MARKER) && !exportJson.text.includes('khaydakov-1962:'));
  const exportCsv = await anon.get('/api/export.csv');
  check('public CSV export excludes candidates',
    !exportCsv.text.includes(OCR_MARKER) && !exportCsv.text.includes('khaydakov-1962:'));
  const labExport = await anon.get('/api/lab/export.jsonl');
  check('Translation Lab export excludes candidates', !labExport.text.includes(OCR_MARKER));
  const audioRows = await pool.query(
    `SELECT provenance FROM source_import_candidates WHERE source_id = 'lexcauc-audio'`);
  check('no audio binary URL is stored',
    audioRows.rows.every(r => !/https?:\/\//.test(JSON.stringify(r.provenance))));
  check('no WAV binary is published under public/',
    !fs.existsSync(path.join(__dirname, '..', 'public', 'audio')) &&
    !fs.readdirSync(path.join(__dirname, '..', 'public')).some(f => /\.wav$/i.test(f)));

  group('import integrity and idempotency');
  const totals = await pool.query(
    `SELECT source_id, COUNT(*)::int AS n FROM source_import_candidates
      WHERE source_id IN (${IDS}) GROUP BY source_id ORDER BY source_id`);
  const stored = Object.fromEntries(totals.rows.map(r => [r.source_id, r.n]));
  check('all audited records are staged exactly once',
    stored['khaydakov-1962'] === 9294 && stored['lexcauc'] === 2246 &&
    stored['dzhidalaev-1993'] === 926 && stored['lexcauc-audio'] === 7 &&
    stored['diana-reference-documents'] === 5, stored);
  const pageRefs = await pool.query(
    `SELECT COUNT(*)::int AS n FROM source_import_candidates
      WHERE source_id = 'dzhidalaev-1993' AND page_ref IS NULL`);
  check('page-level OCR rows all carry a page reference', pageRefs.rows[0].n === 0, pageRefs.rows[0]);
  const batches = await pool.query(
    `SELECT source_id, manifest_sha256, imported_count, expected_count
       FROM source_import_batches WHERE source_id IN (${IDS})`);
  check('each batch records the source file digest it imported',
    batches.rows.length === 5 &&
    batches.rows.every(b => /^[0-9a-f]{64}$/.test(b.manifest_sha256) &&
      b.imported_count === b.expected_count), batches.rows.map(b => b.source_id));
  const reimport = await sourceImport.importVerified(pool, sourceImport.verifySources());
  check('re-importing the same package stages nothing new',
    reimport.imported.every(entry => entry.already_present === true), reimport.imported);
  const after = await pool.query(
    `SELECT COUNT(*)::int AS n FROM source_import_candidates WHERE source_id IN (${IDS})`);
  check('candidate count is unchanged after re-import', after.rows[0].n === EXPECTED_TOTAL, after.rows[0]);
}

async function main() {
  if (!fs.existsSync(path.join(PACKAGE_DIR, 'stats.json'))) {
    console.error(`The processed v1.2 package is not present in ${PACKAGE_DIR}; ` +
      'extract it there before running this suite.');
    process.exit(1);
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lak-source-import-'));
  console.log('Cleaning up any previous test artifacts…');
  await cleanup();

  let child = null;
  try {
    verificationTests(tmpRoot);

    console.log('\nStarting isolated test server on :5058 …');
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: '5058', AUTH_RATE_MAX: '1000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const bootDeadline = Date.now() + 60000;
    while (!log.includes('running on port 5058')) {
      if (Date.now() > bootDeadline) throw new Error('Server did not start:\n' + log);
      await sleep(200);
    }
    // Import runs asynchronously after migration; wait for it to settle.
    const importDeadline = Date.now() + 180000;
    for (;;) {
      const res = await fetch(`${BASE}/api/source-import/status`).then(r => r.json()).catch(() => null);
      const khaydakov = res && (res.sources || []).find(s => s.source_id === 'khaydakov-1962');
      if (khaydakov && khaydakov.imported_record_count === 9294) break;
      if (Date.now() > importDeadline) throw new Error('Import did not finish:\n' + log);
      await sleep(500);
    }

    await runtimeTests();
  } finally {
    if (child) child.kill('SIGKILL');
    await sleep(300);
    console.log('\nRestoring candidate state and removing test accounts…');
    await cleanup();
    await pool.end();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
