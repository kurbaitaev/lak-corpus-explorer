'use strict';

/*
 * v1.3 release gate — leak probe, route-status matrix and count verification.
 *
 * This script is the machine half of the release checklist. It answers three
 * questions against a live server, and fails loudly on the first violation it
 * can prove:
 *
 *  1. LEAK PROBE — can any private marker or any real private string reach a
 *     public surface? Markers are not invented: they are sampled from the
 *     private packages that are actually staged (v1.2 and v1.3), filtered
 *     against the public corpus so that only genuinely-private strings are
 *     probed, and then searched for in every public HTML page, every static
 *     asset the server will serve (including the client bundles and any
 *     source map), every public JSON/CSV/JSONL/TSV export, the Lab, corpus
 *     search and every unauthenticated API.
 *
 *  2. ROUTE STATUS — does every route return the status it is supposed to,
 *     and does every private route return 401 to an unauthenticated caller?
 *
 *  3. COUNTS — public corpus 24,403 records; Observatory 68 resources; v1.2
 *     12,478 of 12,478 verified; v1.3 staged exactly its audited numbers with
 *     nothing public, nothing training-ready and nothing added to the public
 *     corpus.
 *
 * Nothing here writes to the database and nothing needs a login: the whole
 * point is to look at the app the way an anonymous visitor does.
 *
 * Usage: node scripts/release-gate.js            (BASE_URL defaults to :5000)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PRIVATE_ROOT = process.env.PRIVATE_PACKAGE_CACHE_DIR || path.join(ROOT, 'private');

const v13 = require('../lib/source-import-v13');
const sourceImport = require('../lib/source-import');

let passed = 0, failed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else {
    failed++; failures.push(name);
    console.log(`  ✗ ${name}${detail !== undefined ? ' — ' + String(JSON.stringify(detail)).slice(0, 400) : ''}`);
  }
}
function group(title) { console.log(`\n[${title}]`); }

// ── HTTP ───────────────────────────────────────────────────────
async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON: HTML, CSV, JSONL, TSV */ }
  return { status: res.status, text, data, headers: res.headers };
}
const get = p => req('GET', p);

// ── Private marker material ────────────────────────────────────
//
// Structural markers: strings that only exist because the private packages
// exist. A single occurrence on a public surface is a leak of provenance even
// when no passage is attached to it.
const STRUCTURAL_MARKERS = [
  '_LakTextMaterials',                      // the private source tree
  'CaucTexts_Lak',                          // the private collection root
  '/Users/kurbaitaev',                      // the absolute path of the donor machine
  'lak-materials-2026-08-04',               // the incoming drop directory
  'private_research_pending_permission',    // the package's own rights value
  '1.3-candidate',                          // the private candidate schema tag
  '1.3-reference',                          // the private reference schema tag
  'source_relative_path',                   // the private provenance field name
  'extracted_text_relpath',                 // the pointer into private bodies
  'Дагучпедгиз',                            // v1.2 Dzhidalaev OCR imprint
  'khaydakov_1962_lexicon.jsonl',           // v1.2 payload file name
  'private_text_segments.jsonl',            // v1.3 payload file names
  'private_lexicon_lines.jsonl',
  'private_grammar_examples.jsonl',
  'rights_review_queue.jsonl',
  'source_manifest.jsonl',
];

// Read the first `limit` records of a JSONL layer without loading the file.
async function sampleRecords(file, limit) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* the verifier owns validity */ }
    if (out.length >= limit) break;
  }
  rl.close();
  return out;
}

// Everything a visitor can already read. A "private" string that also occurs
// here is not private, so probing for it would produce a false alarm.
function publicHaystack() {
  const parts = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else parts.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(PUBLIC_DIR);
  parts.push(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
  return parts.join('\n').toLowerCase();
}

// Take substantial, distinctive strings out of a private layer.
function textMarkersFrom(records, field, { minLength = 28, maxLength = 90, want = 12 }, haystack) {
  const out = [];
  for (const record of records) {
    const raw = String(record[field] == null ? '' : record[field]).replace(/\s+/g, ' ').trim();
    if (raw.length < minLength) continue;
    const marker = raw.slice(0, maxLength);
    if (haystack.includes(marker.toLowerCase())) continue;   // already public → not a marker
    if (out.includes(marker)) continue;
    out.push(marker);
    if (out.length >= want) break;
  }
  return out;
}

// Cyrillic words long enough to be distinctive, used as search queries: a
// public search for one of them must return nothing at all.
function queryTokensFrom(records, field, haystack, want = 12) {
  const out = [];
  for (const record of records) {
    for (const token of String(record[field] == null ? '' : record[field]).split(/[^\p{L}\p{N}Ӏ|'-]+/u)) {
      if (token.length < 9) continue;
      if (!/[\u0400-\u04FF]/.test(token)) continue;
      const lower = token.toLowerCase();
      if (haystack.includes(lower)) continue;
      if (out.includes(token)) continue;
      out.push(token);
      if (out.length >= want) return out;
    }
  }
  return out;
}

async function buildMarkers() {
  const haystack = publicHaystack();
  const v12 = path.join(PRIVATE_ROOT, 'v1.2');
  const v13dir = path.join(PRIVATE_ROOT, 'v1.3');

  const khaydakov = await sampleRecords(path.join(v12, 'khaydakov_1962_lexicon.jsonl'), 400);
  const dzhidalaev = await sampleRecords(path.join(v12, 'dzhidalaev_1993_ocr_pages.jsonl'), 60);
  const lexcauc = await sampleRecords(path.join(v12, 'lexcauc_lak_lexicon.jsonl'), 200);
  const segments = await sampleRecords(path.join(v13dir, 'processed/private_text_segments.jsonl'), 200);
  const grammar = await sampleRecords(path.join(v13dir, 'processed/private_grammar_examples.jsonl'), 200);
  const lexicon = await sampleRecords(path.join(v13dir, 'processed/private_lexicon_lines.jsonl'), 400);
  const manifest = await sampleRecords(path.join(v13dir, 'processed/source_manifest.jsonl'), 200);
  const reference = await sampleRecords(path.join(v13dir, 'processed/private_reference_index.jsonl'), 84);

  const text = [
    ...textMarkersFrom(khaydakov, 'russian_entry_text', { want: 10 }, haystack),
    ...textMarkersFrom(dzhidalaev, 'ocr_text', { want: 8 }, haystack),
    ...textMarkersFrom(lexcauc, 'lak_form', { minLength: 6, maxLength: 40, want: 6 }, haystack),
    ...textMarkersFrom(segments, 'text', { want: 12 }, haystack),
    ...textMarkersFrom(grammar, 'text', { want: 12 }, haystack),
    ...textMarkersFrom(lexicon, 'text', { want: 12 }, haystack),
  ];

  // Provenance: private source paths, private candidate ids and the digests
  // that name a private extracted body.
  const provenance = [];
  for (const record of [...segments, ...grammar, ...manifest, ...reference].slice(0, 400)) {
    for (const value of [record.source_relative_path, record.relative_path,
      record.candidate_id, record.extracted_text_relpath, record.absolute_source_path]) {
      if (!value) continue;
      const marker = String(value).slice(0, 120);
      if (marker.length < 12) continue;
      if (haystack.includes(marker.toLowerCase())) continue;
      if (!provenance.includes(marker)) provenance.push(marker);
      if (provenance.length >= 40) break;
    }
    if (provenance.length >= 40) break;
  }

  const queries = [
    ...queryTokensFrom(khaydakov, 'russian_entry_text', haystack, 8),
    ...queryTokensFrom(lexicon, 'text', haystack, 8),
    ...queryTokensFrom(dzhidalaev, 'ocr_text', haystack, 6),
  ];

  return { structural: STRUCTURAL_MARKERS.slice(), text, provenance, queries };
}

// ── Surfaces ───────────────────────────────────────────────────
const HTML_PAGES = ['/', '/index.html', '/about.html', '/queue.html', '/login.html', '/register.html',
  '/profile.html', '/validate.html', '/leaderboard.html', '/dashboard.html', '/how-it-works.html',
  '/lab.html', '/observatory.html', '/research.html', '/intelligence.html', '/alignment.html', '/rights.html'];

function staticAssetPaths() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}/${entry.name}`);
      else if (!entry.name.endsWith('.html')) out.push(`${prefix}/${entry.name}`);
    }
  };
  walk(PUBLIC_DIR, '');
  return out;
}

// Public APIs an anonymous visitor can call, including every export format.
const PUBLIC_APIS = [
  ['GET', '/api/auth/me'],
  ['GET', '/api/corpus/stats'],
  ['GET', '/api/corpus/search?q=&limit=200&page=1'],
  ['GET', '/api/corpus/search?q=&limit=200&page=7'],
  ['GET', '/api/corpus/search?q=%D0%BB%D1%83%D0%BD%D0%B0&limit=100'],
  ['GET', '/api/observatory/resources'],
  ['GET', '/api/research/update'],
  ['GET', '/api/source-import/status'],
  ['GET', '/api/reviews?limit=200'],
  ['GET', '/api/stats/reviews'],
  ['GET', '/api/export.json'],
  ['GET', '/api/export.csv'],
  ['GET', '/api/leaderboard?period=all'],
  ['GET', '/api/lab/provider'],
  ['GET', '/api/lab/dataset-card'],
  ['GET', '/api/lab/memory?direction=ru2lak&q=%D0%BB%D1%83%D0%BD%D0%B0'],
  ['GET', '/api/lab/export.jsonl'],
  ['GET', '/api/lab/export.tsv'],
  ['GET', '/api/lab/export.hf.json'],
];

// Every route that must refuse an unauthenticated caller with 401.
const PRIVATE_ROUTES = [
  ['GET', '/api/profile'],
  ['GET', '/api/validation/next'],
  ['POST', '/api/validation/tasks/release-gate:probe/vote', { value: 'correct' }],
  ['GET', '/api/validation/tasks/release-gate:probe/result'],
  ['POST', '/api/validation/tasks/release-gate:probe/adjudicate', { decision: 'correct' }],
  ['GET', '/api/leaderboard/me'],
  ['GET', '/api/quests'],
  ['POST', '/api/appeals', { target_type: 'points', reason: 'release-gate probe' }],
  ['GET', '/api/audit?target_type=validation_task&target_id=release-gate:probe'],
  ['GET', '/api/admin/overview'],
  ['GET', '/api/admin/invites'],
  ['GET', '/api/admin/appeals'],
  ['POST', '/api/admin/tasks', { id: 'release-gate:probe', kind: 'spelling' }],
  ['POST', '/api/admin/invites', { role: 'trusted_validator' }],
  ['POST', '/api/admin/points/invalidate', { contributor_id: 'x', reason: 'probe' }],
  ['GET', '/api/lab/my-pairs'],
  ['POST', '/api/lab/pairs', { direction: 'ru2lak', source_text: 'release-gate probe' }],
  ['GET', '/api/lab/review-queue'],
  ['GET', '/api/lab/benchmark?split=test'],
  ['GET', '/api/lab/benchmark/template.tsv'],
  ['GET', '/api/lab/benchmark/template'],
  ['POST', '/api/lab/benchmark/import', { items: [] }],
  ['GET', '/api/lab/benchmark/export.jsonl'],
  ['GET', '/api/lab/benchmark/export.tsv'],
  ['GET', '/api/lab/runs'],
  ['POST', '/api/lab/runs', { split: 'test', config: 'retrieval_only' }],
  ['GET', '/api/lab/runs/compare?split=test'],
  ['GET', '/api/source-import/packages'],
  ['GET', '/api/source-import/candidates'],
  ['GET', '/api/source-import/candidates/1'],
  ['POST', '/api/source-import/candidates/1/review', { review_state: 'accepted_candidate' }],
  ['POST', '/api/source-import/candidates/1/corroborations', { relation: 'corroborates' }],
  ['GET', '/api/source-import/export.jsonl'],
  ['GET', '/api/private/intel/status'],
  ['GET', '/api/private/intel/sources'],
  ['GET', '/api/private/intel/sources/193'],
  ['GET', '/api/private/intel/facets'],
  ['GET', '/api/private/intel/families'],
  ['POST', '/api/private/intel/sources/193/decisions', { kind: 'review', value: 'accepted' }],
  ['POST', '/api/private/intel/scan', {}],
  ['GET', '/api/private/relationships'],
  ['GET', '/api/private/relationships/1'],
  ['POST', '/api/private/relationships/1/review', { decision: 'accept' }],
  ['GET', '/api/private/relationships/1/alignment'],
  ['POST', '/api/private/relationships/1/alignment', {}],
  ['POST', '/api/private/alignment-units/1/review', { decision: 'accept' }],
  ['GET', '/api/private/rights-queue'],
  ['GET', '/api/private/rights-queue/facets'],
  ['GET', '/api/private/rights-queue/193'],
  ['POST', '/api/private/rights-queue/193/decisions', { kind: 'rights', value: 'permission_granted' }],
];

// ── The probe ──────────────────────────────────────────────────
// `echoed` is the term the caller sent: search and propose repeat the query
// back, and a request echoing its own input is not the app disclosing
// anything it holds. Every other marker is a real hit.
function scan(body, markers, echoed) {
  const hay = body.toLowerCase();
  const skip = echoed ? echoed.toLowerCase() : null;
  const hits = [];
  for (const [kind, list] of Object.entries(markers)) {
    if (kind === 'queries') continue;
    for (const marker of list) {
      const needle = marker.toLowerCase();
      if (skip && (needle === skip || skip.includes(needle))) continue;
      if (hay.includes(needle)) hits.push(`${kind}:${marker.slice(0, 60)}`);
      if (hits.length >= 3) return hits;
    }
  }
  return hits;
}

async function main() {
  console.log(`Release gate against ${BASE}`);

  group('private markers are available to probe with');
  const markers = await buildMarkers();
  const total = markers.structural.length + markers.text.length + markers.provenance.length;
  check('structural provenance markers are defined', markers.structural.length >= 16, markers.structural.length);
  check('real private text was sampled from the staged packages', markers.text.length >= 40, markers.text.length);
  check('private source paths and candidate ids were sampled', markers.provenance.length >= 20, markers.provenance.length);
  check('private-only search terms were sampled', markers.queries.length >= 12, markers.queries.length);
  console.log(`  … probing ${total} markers and ${markers.queries.length} private search terms`);

  // ── 1. Leak probe ────────────────────────────────────────────
  group('leak probe: public HTML pages');
  for (const page of HTML_PAGES) {
    const res = await get(page);
    const hits = scan(res.text, markers);
    check(`${page} carries no private marker`, res.status === 200 && hits.length === 0, { status: res.status, hits });
  }

  group('leak probe: every static asset the server will serve');
  const assets = staticAssetPaths();
  let assetHits = 0, assetBytes = 0, sourceMapRefs = [];
  for (const asset of assets) {
    const res = await get(asset);
    if (res.status !== 200) { check(`${asset} serves`, false, res.status); continue; }
    assetBytes += res.text.length;
    const hits = scan(res.text, markers);
    if (hits.length) { assetHits++; check(`${asset} carries no private marker`, false, hits); }
    if (/sourceMappingURL/.test(res.text)) sourceMapRefs.push(asset);
  }
  check(`all ${assets.length} static assets are free of private markers (${Math.round(assetBytes / 1024)} KB scanned)`,
    assetHits === 0, assetHits);
  check('no client asset references a source map', sourceMapRefs.length === 0, sourceMapRefs);
  const mapProbe = await get('/js/search.js.map');
  check('no source map is served alongside the client bundles', mapProbe.status !== 200, mapProbe.status);

  group('leak probe: public JSON, CSV, JSONL and TSV surfaces');
  for (const [method, p] of PUBLIC_APIS) {
    const res = await req(method, p);
    const hits = scan(res.text, markers);
    check(`${p} carries no private marker`, res.status === 200 && hits.length === 0, { status: res.status, hits });
  }

  group('leak probe: corpus search cannot reach private text');
  let searchLeaks = 0;
  for (const term of markers.queries) {
    const res = await get(`/api/corpus/search?q=${encodeURIComponent(term)}&limit=50`);
    const hits = scan(res.text, markers, term);
    if (res.status !== 200 || res.data.total !== 0 || hits.length) {
      searchLeaks++;
      check(`search "${term}" returns nothing`, false, { status: res.status, total: res.data && res.data.total, hits });
    }
  }
  check(`all ${markers.queries.length} private-only terms return zero public results`, searchLeaks === 0, searchLeaks);
  const structuralSearch = await get(`/api/corpus/search?q=${encodeURIComponent('_LakTextMaterials')}&limit=20`);
  check('a private path fragment matches no corpus record',
    structuralSearch.status === 200 && structuralSearch.data.total === 0, structuralSearch.data && structuralSearch.data.total);

  group('leak probe: the Lab answers nothing from private material');
  let labLeaks = 0;
  for (const term of markers.queries.slice(0, 8)) {
    for (const direction of ['ru2lak', 'lak2ru']) {
      const res = await req('POST', '/api/lab/propose', { direction, source_text: term });
      const hits = scan(res.text, markers, term);
      const answered = res.data && (res.data.literal_target || res.data.natural_target || res.data.suggested_target);
      if (res.status !== 200 || hits.length || answered) {
        labLeaks++;
        check(`propose(${direction}, "${term}") abstains`, false, { status: res.status, hits, answered });
      }
    }
  }
  check('the Lab abstains on every private-only term and leaks nothing', labLeaks === 0, labLeaks);
  const evidence = await req('POST', '/api/corpus/evidence',
    { q: markers.queries[0] || 'луна', records: [] });
  check('the public evidence endpoint leaks nothing',
    evidence.status === 200 && scan(evidence.text, markers).length === 0, evidence.status);

  group('leak probe: unauthenticated private routes return no private content');
  let bodyLeaks = 0;
  for (const [method, p, body] of PRIVATE_ROUTES) {
    const res = await req(method, p, body);
    if (scan(res.text, markers).length) { bodyLeaks++; check(`${method} ${p} body is content-free`, false, res.text.slice(0, 200)); }
  }
  check(`all ${PRIVATE_ROUTES.length} private routes answer without private content`, bodyLeaks === 0, bodyLeaks);

  // ── 2. Route status matrix ───────────────────────────────────
  group('route status: public surfaces');
  for (const page of HTML_PAGES) {
    const res = await get(page);
    check(`GET ${page} → 200`, res.status === 200, res.status);
  }
  for (const [method, p] of PUBLIC_APIS) {
    const res = await req(method, p);
    check(`${method} ${p} → 200`, res.status === 200, res.status);
  }
  const propose = await req('POST', '/api/lab/propose', { direction: 'ru2lak', source_text: 'спасибо' });
  check('POST /api/lab/propose → 200', propose.status === 200, propose.status);
  const missing = await get('/no-such-page-release-gate');
  check('an unknown path → 404', missing.status === 404, missing.status);

  group('route status: every private route is 401 unauthenticated');
  for (const [method, p, body] of PRIVATE_ROUTES) {
    const res = await req(method, p, body);
    check(`${method} ${p} → 401`, res.status === 401, res.status);
  }

  // ── 3. Counts ────────────────────────────────────────────────
  group('counts: the public corpus is unchanged');
  const stats = await get('/api/corpus/stats');
  check('the public corpus is exactly 24,403 records', stats.data.totalRecords === 24403, stats.data.totalRecords);
  const observatory = await get('/api/observatory/resources');
  check('the Observatory lists exactly 68 public resources',
    observatory.data.resources.length === 68 && observatory.data.counts.total === 68,
    { resources: observatory.data.resources.length, total: observatory.data.counts.total });

  group('counts: the audited v1.2 package');
  const v12status = await get('/api/source-import/status');
  const c12 = v12status.data.counts;
  check('v1.2 reports 12,478 of 12,478 verified',
    c12.expected_records === sourceImport.EXPECTED_SOURCES.reduce((n, s) => n + s.expected_record_count, 0) &&
    c12.expected_records === 12478 && c12.verified_records === 12478, c12);
  check('v1.2 verified all five source groups with nothing rejected',
    c12.sources_total === 5 && c12.verified === 5 && c12.rejected === 0 && c12.awaiting_manifest === 0, c12);
  check('v1.2 ingestion is not blocked', v12status.data.ingestion_blocked === false);
  check('every v1.2 source stays private, permission-pending and not training-ready',
    v12status.data.sources.every(s => s.access_status === 'private_research' &&
      s.rights_status === 'permission_pending' && s.training_ready === false &&
      s.public_record_count === 0 && s.training_ready_record_count === 0),
    v12status.data.sources.map(s => [s.source_id, s.access_status, s.public_record_count]));
  check('v1.2 corroboration is reported, never merged',
    v12status.data.corroboration.overlapping_forms === 563 &&
    v12status.data.corroboration.candidate_pairs === 653 &&
    v12status.data.corroboration.merged === false, v12status.data.corroboration);

  group('counts: the audited v1.3 package');
  const research = await get('/api/research/update');
  const update = research.data;
  check('v1.3 verified', update.package.id === 'v1.3' && update.package.verification_status === 'verified',
    update.package);
  for (const [key, value] of Object.entries(v13.AUDITED)) {
    check(`v1.3 ${key}: ${value} audited = ${update.staged ? update.staged[key] : null} staged`,
      update.audited[key] === value && update.staged && update.staged[key] === value,
      { audited: update.audited[key], staged: update.staged && update.staged[key] });
  }
  check('v1.3 declares its counts as matching', update.counts_match === true && update.counts_available === true,
    { counts_match: update.counts_match, counts_available: update.counts_available });
  check('nothing in v1.3 is public-search-eligible, training-ready or reviewed',
    update.staged.public_search_eligible === 0 && update.staged.training_ready === 0 &&
    update.staged.reviewed === 0, update.staged);
  check('v1.3 policy stays fail-closed',
    update.policy.access_status === 'private_research' && update.policy.rights_status === 'permission_pending' &&
    update.policy.review_state === 'source_import_unreviewed' &&
    update.policy.public_search_eligible === false && update.policy.training_ready === false, update.policy);
  check('the public corpus panel repeats 24,403 / 68 and claims no v1.3 additions',
    update.public_corpus.records === 24403 && update.public_corpus.observatory_resources === 68 &&
    update.public_corpus.records_added_by_v13 === 0 && update.public_corpus.public_candidates === 0,
    update.public_corpus);
  check('every source family is reported as private and unreviewed',
    update.families.length === update.family_count && update.families.length >= 7 &&
    update.families.every(f => f.is_public === false && f.access_status === 'private_research' &&
      f.review_status === 'unreviewed_alignment_candidate' && f.blocking_steps.length === 3),
    update.families.map(f => [f.id, f.is_public, f.files]));

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) {
    console.log('FAILED: ' + failures.slice(0, 20).join('; '));
    process.exit(1);
  }
}

main().catch(error => { console.error('RELEASE GATE ERROR:', error); process.exit(1); });
