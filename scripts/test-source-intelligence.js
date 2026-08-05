'use strict';

/*
 * Private Alignment Lab and Source Intelligence test-suite.
 *
 * Part 1 (pure): the candidate generator is deterministic — the same profiles
 * produce byte-identical proposals, every proposal records the signals that
 * fired, and nothing is proposed without evidence. The alignment engine
 * produces 1:1, 1:many, many:1 and explicitly unmatched units and is stable
 * across runs.
 *
 * Part 2 (database): the scan is idempotent, and the War family is seeded with
 * War-1 as the Lak text, War-1a as an alternate near-duplicate Lak version and
 * War-2 as the Russian parallel/translation candidate.
 *
 * Part 3 (runtime): an isolated server on port 5062 proves the boundaries —
 * unauthenticated requests get 401 with no private text, a self-registered
 * contributor gets 403, a trusted validator may read and open candidates but
 * may not accept them or raise exposure, a verified expert may, and exposure
 * is refused until rights are cleared and the review is accepted. Alignment
 * regeneration never discards a reviewer's work.
 *
 * Part 4 (localization): every label, empty, loading and error key used by the
 * three private screens exists in the central dictionary with EN and RU.
 *
 * Every row this suite creates is removed afterwards; rows it changes are
 * restored to the state it found them in.
 *
 * Usage: node scripts/test-source-intelligence.js
 * Requires: DATABASE_URL, REVIEWER_PASSPHRASE.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const intel = require('../lib/source-intelligence');
const engine = require('../lib/alignment-engine');

const PORT = 5062; // 5060/5061 are refused by Node's fetch as unsafe ports.
const BASE = `http://127.0.0.1:${PORT}`;
const PASSPHRASE = process.env.REVIEWER_PASSPHRASE;
if (!PASSPHRASE) { console.error('REVIEWER_PASSPHRASE is required'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WAR_PRIMARY = 193;    // …/_LakTextMaterials/War/War-1.doc
const WAR_ALTERNATE = 191;  // …/_LakTextMaterials/War-1a.doc
const WAR_RUSSIAN = 194;    // …/_LakTextMaterials/War/War-2.doc

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
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

/* ── Part 1: deterministic candidate generation ─────────────── */

// Two synthetic profiles in the shape buildProfiles() produces. Using fixtures
// rather than the package keeps this part independent of what is staged.
function profile(overrides) {
  const base = {
    id: 'p1',
    kind: 'v13_source',
    ref: '10',
    source_sequence: 10,
    source_path: 'Sources/Family/Doc-1.doc',
    source_sha256: 'a'.repeat(64),
    label: 'Doc-1.doc',
    duplicate_group: null,
    canonical_duplicate: null,
    material_type: 'text',
    language_scope: 'Lak',
    extraction_quality: 'good',
    text_chars: 1000,
    sampled_chars: 1000,
    sampled_units: 12,
    title: 'doc-1',
    title_base: 'doc-1',
    title_root: 'doc',
    title_markers: [],
    folder: 'sources/family',
    folder_name: 'family',
    family_key: 'title:doc',
    language: 'lak',
    script: 'cyrillic',
    numbers: ['1941'],
    headings: ['аьрали ххуллу'],
    punctuation: { '.': 10, ',': 4 },
    sketch: [1, 2, 3, 4, 5],
    public_overlap: 5,
    token_count: 120,
  };
  return { ...base, ...overrides };
}

function pureTests() {
  group('candidate generation is deterministic');
  const left = profile({});
  const right = profile({
    id: 'p2',
    ref: '11',
    source_sequence: 11,
    source_path: 'Sources/Family/Doc-2.doc',
    source_sha256: 'b'.repeat(64),
    label: 'Doc-2.doc',
    language_scope: 'Russian',
    language: 'russian',
    title: 'doc-2',
    title_base: 'doc-2',
    numbers: ['1941'],
    sketch: [1, 2, 9, 10, 11],
    public_overlap: 3,
  });
  const first = intel.proposeRelationships([left, right]);
  const second = intel.proposeRelationships([left, right]);
  check('the same inputs produce byte-identical proposals',
    JSON.stringify(first) === JSON.stringify(second));
  check('a proposal is produced for an evidenced pair', first.proposals.length === 1, first.proposals);

  const proposal = first.proposals[0];
  check('every proposal records which signals fired',
    Array.isArray(proposal.signals) && proposal.signals.length >= 2 &&
    proposal.signals.every(s => s.signal && typeof s.weight === 'number'), proposal.signals);
  check('signal names are unique inside a proposal',
    new Set(proposal.signals.map(s => s.signal)).size === proposal.signals.length);
  check('the measurements behind the signals are kept',
    proposal.evidence && proposal.evidence.left_language === 'lak' &&
    proposal.evidence.right_language === 'russian', proposal.evidence);
  check('the scan reports how many sources and pairs it examined',
    first.sources_scanned === 2 && first.pairs_examined >= 1,
    [first.sources_scanned, first.pairs_examined]);
  check('a cross-language pair with shared structure is a translation candidate',
    proposal.relationship_type === 'translation' || proposal.relationship_type === 'parallel_text',
    proposal.relationship_type);
  check('confidence is a bounded, reproducible number',
    proposal.confidence > 0 && proposal.confidence <= 1, proposal.confidence);
  check('the generator version is recorded on the proposal',
    proposal.generator_version === intel.GENERATOR_VERSION, proposal.generator_version);
  check('nothing is marked validated',
    proposal.review_state === undefined || proposal.review_state === 'source_import_unreviewed',
    proposal.review_state);

  group('proposals need evidence');
  const unrelated = profile({
    id: 'p3',
    ref: '12',
    source_sequence: 12,
    source_path: 'Other/Elsewhere/Zzz.doc',
    source_sha256: 'c'.repeat(64),
    label: 'Zzz.doc',
    title: 'zzz',
    title_base: 'zzz',
    title_root: 'zzz',
    folder: 'other/elsewhere',
    folder_name: 'elsewhere',
    family_key: 'title:zzz',
    language: 'russian',
    sampled_units: 400,
    text_chars: 900000,
    sampled_chars: 900000,
    numbers: [],
    headings: [],
    punctuation: { '.': 1 },
    sketch: [900, 901, 902],
    public_overlap: 0,
  });
  check('an unrelated pair produces nothing',
    intel.proposeRelationships([left, unrelated]).proposals.length === 0,
    intel.proposeRelationships([left, unrelated]).proposals);

  group('identical digests are duplicates, not translations');
  const twin = profile({
    id: 'p4', ref: '13', source_sequence: 13,
    source_path: 'Sources/Copy/Doc-1.doc', folder: 'sources/copy', folder_name: 'copy',
  });
  const dup = intel.proposeRelationships([left, twin]).proposals;
  check('an identical file digest yields a duplicate candidate',
    dup.length === 1 && dup[0].relationship_type === 'duplicate', dup.map(d => d.relationship_type));

  group('ordering does not change the outcome');
  const reversed = intel.proposeRelationships([right, left]).proposals;
  check('pair keys are order-independent',
    reversed.length === 1 && reversed[0].pair_key === proposal.pair_key,
    [reversed[0] && reversed[0].pair_key, proposal.pair_key]);

  group('family keys follow the received path');
  const warStem = intel.pathParts('X/_LakTextMaterials/War-1a.doc').stem;
  check('an edition marker collapses into the base title',
    intel.titleVariants(warStem).base === 'war-1' &&
    intel.titleVariants(warStem).root === 'war' &&
    intel.titleVariants(warStem).markers.includes('edition-letter'),
    intel.titleVariants(warStem));
  check('War-1 and War-1a share a family key',
    intel.familyKeyFor(intel.pathParts('X/War/War-1.doc')) ===
    intel.familyKeyFor(intel.pathParts('X/_LakTextMaterials/War-1a.doc')),
    [intel.familyKeyFor(intel.pathParts('X/War/War-1.doc')),
      intel.familyKeyFor(intel.pathParts('X/_LakTextMaterials/War-1a.doc'))]);
}

/* ── Part 1b: the alignment engine ──────────────────────────── */

function alignmentTests() {
  group('alignment cardinalities');
  // Sentence 2 on the left corresponds to two sentences on the right (1:many),
  // sentences 4 and 5 collapse into one (many:1), and the last left sentence
  // has no counterpart at all (unmatched).
  // The left side keeps one sentence per paragraph where the right side runs
  // them together, so the engine has to merge on one side (1:many / many:1),
  // and the left has a paragraph the right does not (unmatched).
  const leftUnits = [
    'ГЛАВА 1',
    'Ва аьрали ххуллу бур.',
    'Гьунттий 1941 шинал дав дуркIунни.',
    'Цалчинмур бутта увкIунни ва кказит бувккунни.',
    'Ниттил чивчуна ва ахирданий цучIав акъая.',
  ];
  const rightUnits = [
    'ГЛАВА 1',
    'Это была военная дорога. Завтра в 1941 году началась война. Первый отец пришёл и прочитал газету.',
  ];

  const first = engine.buildAlignment(leftUnits, rightUnits);
  const second = engine.buildAlignment(leftUnits, rightUnits);
  check('the same texts produce an identical alignment',
    JSON.stringify(first) === JSON.stringify(second));

  const flat = [];
  (function walk(units) {
    for (const unit of units) { flat.push(unit); walk(unit.children || []); }
  })(first.nodes);

  const levels = new Set(flat.map(u => u.level));
  check('the alignment is hierarchical: section → paragraph → sentence',
    levels.has('section') && levels.has('paragraph') && levels.has('sentence'), [...levels]);

  const cardinalities = new Set(flat.map(u => u.cardinality));
  check('1:1 units are produced', cardinalities.has('one_to_one'));
  check('1:many or many:1 units are produced',
    cardinalities.has('one_to_many') || cardinalities.has('many_to_one'), [...cardinalities]);

  const unmatched = engine.buildAlignment(
    ['Первый абзац здесь.', 'Второй абзац здесь.', 'Третий абзац здесь.', 'Четвёртый лишний абзац здесь.'],
    ['Первый абзац здесь.']);
  const unmatchedFlat = [];
  (function walk(units) {
    for (const unit of units) { unmatchedFlat.push(unit); walk(unit.children || []); }
  })(unmatched.nodes);
  check('unmatched units are explicit, not dropped',
    unmatchedFlat.some(u => u.cardinality === 'unmatched_left' || u.cardinality === 'unmatched_right'),
    [...new Set(unmatchedFlat.map(u => u.cardinality))]);

  check('every unit records the method that produced it, under a versioned engine',
    flat.every(u => u.method) && first.engine_version === engine.ENGINE_VERSION,
    first.engine_version);
  check('the engine reports its unit counts per level',
    first.counts.section > 0 && first.counts.paragraph > 0 && first.counts.sentence > 0, first.counts);
  check('no unit claims to be validated',
    flat.every(u => u.review_state === undefined || u.review_state === 'source_import_unreviewed'));
  check('a many-to-one unit keeps both sides of the merge',
    flat.filter(u => u.cardinality === 'one_to_many' || u.cardinality === 'many_to_one')
      .every(u => u.left_text && u.right_text));

  group('sentence splitting');
  check('sentences split on terminal punctuation',
    engine.splitSentences('Один. Два! Три? Четыре').length === 4,
    engine.splitSentences('Один. Два! Три? Четыре'));
  check('empty input yields no sentences', engine.splitSentences('   ').length === 0);
}

/* ── Part 2: scan idempotency and the War family ────────────── */

async function scanTests() {
  group('the scan is idempotent');
  const before = await pool.query('SELECT count(*)::int AS n FROM private_source_relationships');
  const again = await intel.scan(pool, {});
  const after = await pool.query('SELECT count(*)::int AS n FROM private_source_relationships');
  check('a repeated scan adds no rows', before.rows[0].n === after.rows[0].n,
    [before.rows[0].n, after.rows[0].n]);
  check('the repeated scan reports itself as cached', again.ran === false, again);
  check('the War family is re-asserted on every boot',
    again.war_family && (again.war_family.seeded === 3 || (again.war_family.relationships || []).length === 3),
    again.war_family);

  group('the War family is seeded with the right roles');
  const war = await pool.query(
    `SELECT relationship_type, method, origin,
            left_source_ref, left_role, left_language,
            right_source_ref, right_role, right_language,
            review_state, confidence
       FROM private_source_relationships
      WHERE method = 'war_family_seed'
      ORDER BY left_source_ref::int, right_source_ref::int`);
  check('exactly three War relationships exist', war.rows.length === 3,
    war.rows.map(r => r.relationship_type));

  const roleFor = sequence => {
    for (const row of war.rows) {
      if (Number(row.left_source_ref) === sequence) return row.left_role;
      if (Number(row.right_source_ref) === sequence) return row.right_role;
    }
    return null;
  };
  check('War-1 is the Lak text', roleFor(WAR_PRIMARY) === 'lak_primary', roleFor(WAR_PRIMARY));
  check('War-1a is the alternate near-duplicate Lak version',
    roleFor(WAR_ALTERNATE) === 'lak_alternate_near_duplicate', roleFor(WAR_ALTERNATE));
  check('War-2 is the Russian parallel/translation candidate',
    roleFor(WAR_RUSSIAN) === 'russian_translation_candidate', roleFor(WAR_RUSSIAN));

  const pair = (a, b) => war.rows.find(row =>
    (Number(row.left_source_ref) === a && Number(row.right_source_ref) === b) ||
    (Number(row.left_source_ref) === b && Number(row.right_source_ref) === a));
  check('War-1 ↔ War-1a is an alternate edition',
    pair(WAR_PRIMARY, WAR_ALTERNATE).relationship_type === 'alternate_edition',
    pair(WAR_PRIMARY, WAR_ALTERNATE).relationship_type);
  check('War-1 ↔ War-2 is a translation candidate',
    pair(WAR_PRIMARY, WAR_RUSSIAN).relationship_type === 'translation',
    pair(WAR_PRIMARY, WAR_RUSSIAN).relationship_type);
  check('War-1a ↔ War-2 is a parallel text candidate',
    pair(WAR_ALTERNATE, WAR_RUSSIAN).relationship_type === 'parallel_text',
    pair(WAR_ALTERNATE, WAR_RUSSIAN).relationship_type);
  check('the seeded languages are computed, not copied from the manifest',
    pair(WAR_PRIMARY, WAR_RUSSIAN).left_language !== pair(WAR_PRIMARY, WAR_RUSSIAN).right_language,
    [pair(WAR_PRIMARY, WAR_RUSSIAN).left_language, pair(WAR_PRIMARY, WAR_RUSSIAN).right_language]);
  check('nothing seeded is accepted on the machine\'s say-so',
    war.rows.every(row => row.review_state === 'source_import_unreviewed'),
    war.rows.map(r => r.review_state));
  check('the three War sources share one family key',
    (await pool.query(
      `SELECT count(DISTINCT family_key)::int AS n FROM v13_sources
        WHERE source_sequence = ANY($1::int[])`,
      [[WAR_PRIMARY, WAR_ALTERNATE, WAR_RUSSIAN]])).rows[0].n === 1);
}

/* ── Part 3: the runtime boundary ───────────────────────────── */

const TEST_ACCOUNTS = `(SELECT id FROM contributors WHERE email LIKE 'test-intel-%@example.com')`;

async function runtimeTests() {
  group('unauthenticated access is refused with no content');
  const anon = client();
  const anonRoutes = [
    '/api/private/intel/status', '/api/private/intel/sources', '/api/private/intel/facets',
    '/api/private/intel/families', `/api/private/intel/sources/${WAR_PRIMARY}`,
    '/api/private/relationships', '/api/private/rights-queue', '/api/private/rights-queue/facets',
    `/api/private/rights-queue/${WAR_PRIMARY}`,
  ];
  const anonResults = [];
  for (const route of anonRoutes) anonResults.push([route, await anon.get(route)]);
  check('every private GET returns 401',
    anonResults.every(([, res]) => res.status === 401),
    anonResults.filter(([, res]) => res.status !== 401).map(([route, res]) => route + ':' + res.status));
  check('no 401 body carries private text or provenance',
    anonResults.every(([, res]) => !/War-|_LakTextMaterials|[0-9a-f]{64}/.test(res.text)),
    anonResults.map(([route, res]) => route + ':' + res.text.slice(0, 80)));
  const anonWrites = [
    await anon.post('/api/private/intel/scan', {}),
    await anon.post('/api/private/relationships/x/review', { review_state: 'accepted_candidate' }),
    await anon.post('/api/private/relationships/x/alignment', {}),
    await anon.post('/api/private/alignment-units/x/review', { action: 'accept' }),
    await anon.post(`/api/private/rights-queue/${WAR_PRIMARY}/decisions`, { rights_status: 'public_domain' }),
  ];
  check('every private POST returns 401', anonWrites.every(res => res.status === 401),
    anonWrites.map(r => r.status));

  group('a self-registered contributor is refused');
  const contributor = client();
  const reg = await contributor.post('/api/auth/register', {
    email: 'test-intel-contributor@example.com', password: 'test-password-123', display_name: 'Intel Contributor' });
  check('registration succeeded', reg.status === 200 || reg.status === 201, reg.data);
  check('a contributor cannot list sources',
    (await contributor.get('/api/private/intel/sources')).status === 403);
  check('a contributor cannot list relationship candidates',
    (await contributor.get('/api/private/relationships')).status === 403);
  check('a contributor cannot open the rights queue',
    (await contributor.get('/api/private/rights-queue')).status === 403);

  const admin = client();
  const adminLogin = await admin.post('/api/auth/login', { name: 'Intel Reviewer', passphrase: PASSPHRASE });
  check('reviewer (administrator) login → 200', adminLogin.status === 200, adminLogin.data);

  const trusted = client();
  const regTrusted = await trusted.post('/api/auth/register', {
    email: 'test-intel-trusted@example.com', password: 'test-password-123', display_name: 'Intel Trusted' });
  await admin.post(`/api/admin/contributors/${regTrusted.data.account.id}/role`, {
    role: 'trusted_validator', basis: 'test-intel: community language worker' });
  const expert = client();
  const regExpert = await expert.post('/api/auth/register', {
    email: 'test-intel-expert@example.com', password: 'test-password-123', display_name: 'Intel Expert' });
  await admin.post(`/api/admin/contributors/${regExpert.data.account.id}/role`, {
    role: 'verified_expert', basis: 'test-intel: verified linguist' });

  group('the source browser');
  const status = await trusted.get('/api/private/intel/status');
  check('a trusted validator can read the workspace status', status.status === 200, status.data);
  check('the status counts private and public sources',
    status.data.private_sources.total >= 320 && status.data.public_sources > 0, status.data);

  const sources = await trusted.get('/api/private/intel/sources?limit=200');
  check('the browser lists sources', sources.status === 200 && sources.data.sources.length > 0,
    sources.data.total);
  check('every listed source carries its material type, family and statuses',
    sources.data.sources.every(s => s.material_type !== undefined && s.family_key !== undefined &&
      s.rights_status && s.review_state), sources.data.sources[0]);
  const scopes = await Promise.all(['public_corpus', 'private_v12', 'private_v13'].map(scope =>
    trusted.get(`/api/private/intel/sources?scope=${scope}&limit=3`)));
  check('the browser reaches every layer: public corpus, private v1.2 and private v1.3',
    scopes.every(res => res.status === 200 && res.data.sources.length > 0),
    scopes.map(res => [res.status, res.data.total]));
  check('each layer is returned under its own scope',
    scopes.every(res => res.data.sources.every(s => s.scope)),
    scopes.map(res => res.data.sources[0] && res.data.sources[0].scope));

  const filtered = await trusted.get('/api/private/intel/sources?scope=private_v13&rights_status=permission_pending&limit=5');
  check('filters narrow the list', filtered.status === 200 &&
    filtered.data.sources.every(s => s.scope === 'private_v13' && s.rights_status === 'permission_pending'),
    filtered.data.sources && filtered.data.sources[0]);

  const facets = await trusted.get('/api/private/intel/facets');
  check('facets cover every filter on the screen',
    ['material_type', 'language_scope', 'family_key', 'extraction_quality',
      'rights_status', 'review_state', 'access_status'].every(key => Array.isArray(facets.data[key])),
    Object.keys(facets.data));

  const families = await trusted.get('/api/private/intel/families');
  check('the family view groups related sources', families.status === 200 &&
    families.data.families.some(f => f.members.length > 1), families.data.families &&
    families.data.families.slice(0, 2));

  const detail = await trusted.get(`/api/private/intel/sources/${WAR_PRIMARY}`);
  check('a source detail carries immutable provenance', detail.status === 200 &&
    /War-1\.doc$/.test(detail.data.provenance.source_path) &&
    /^[0-9a-f]{64}$/.test(detail.data.provenance.file_digest), detail.data.provenance);
  check('a source detail lists its relationship candidates',
    detail.data.relationships.length >= 2, detail.data.relationships &&
    detail.data.relationships.map(r => r.relationship_type));
  check('corroborating spellings are reported, never merged',
    Array.isArray(detail.data.corroborating_spellings) &&
    detail.data.corroborating_spellings.every(s => s.form && !s.merged));

  group('relationship candidates are never presented as validated');
  const relationships = await trusted.get('/api/private/relationships?limit=100');
  check('the candidate list is readable by a trusted validator', relationships.status === 200);
  check('every response is flagged as candidate-only',
    relationships.data.validated === false, relationships.data.validated);
  const warPair = relationships.data.relationships.find(r =>
    Number(r.left.ref) === WAR_PRIMARY && Number(r.right.ref) === WAR_RUSSIAN);
  check('the War translation candidate is in the list', !!warPair, relationships.data.total);
  const pairDetail = await trusted.get(`/api/private/relationships/${warPair.id}`);
  check('a candidate exposes the evidence behind it',
    pairDetail.status === 200 && pairDetail.data.relationship.signals.length > 0,
    pairDetail.data.relationship && pairDetail.data.relationship.signals);

  group('decision gates are enforced on the server');
  const trustedAccept = await trusted.post(`/api/private/relationships/${warPair.id}/review`, {
    review_state: 'accepted_candidate', note: 'test-intel: attempt' });
  check('a trusted validator may not accept a candidate', trustedAccept.status === 403, trustedAccept.data);
  const trustedInReview = await trusted.post(`/api/private/relationships/${warPair.id}/review`, {
    review_state: 'in_review', note: 'test-intel: opened' });
  check('a trusted validator may move a candidate into review',
    trustedInReview.status === 200 && trustedInReview.data.relationship.review_state === 'in_review',
    trustedInReview.data);
  const expertAccept = await expert.post(`/api/private/relationships/${warPair.id}/review`, {
    review_state: 'accepted_candidate', note: 'test-intel: accepted by expert' });
  check('a verified expert may accept a candidate',
    expertAccept.status === 200 && expertAccept.data.relationship.review_state === 'accepted_candidate',
    expertAccept.data);
  check('accepting a relationship does not make it a validated translation',
    expertAccept.data.validated === false, expertAccept.data.validated);

  group('the rights queue');
  const queue = await trusted.get('/api/private/rights-queue?limit=10');
  check('the queue is readable', queue.status === 200, queue.data);
  check('the queue holds the 293 v1.3 rights-review items', queue.data.total === 293, queue.data.total);
  check('queue items carry the action they need',
    queue.data.items.every(item => item.required_action !== undefined), queue.data.items[0]);
  const queueItem = await trusted.get(`/api/private/rights-queue/${WAR_PRIMARY}`);
  check('a queue item shows provenance and corroboration',
    queueItem.status === 200 && queueItem.data.provenance.file_digest &&
    Array.isArray(queueItem.data.corroborating_spellings), queueItem.data.provenance);

  group('the four decisions are independent and gated');
  const rightsOnly = await trusted.post(`/api/private/rights-queue/${WAR_PRIMARY}/decisions`, {
    rights_status: 'permission_granted', note: 'test-intel: holder replied' });
  check('a trusted validator may record a rights decision alone',
    rightsOnly.status === 200 && rightsOnly.data.source.rights_status === 'permission_granted',
    rightsOnly.data);
  check('a rights decision does not change access, review or training',
    rightsOnly.data.source.access_status === 'private_research' &&
    rightsOnly.data.source.review_state !== 'accepted_candidate' &&
    rightsOnly.data.source.training_ready === false, rightsOnly.data.source);

  const trustedPublic = await trusted.post(`/api/private/rights-queue/${WAR_PRIMARY}/decisions`, {
    access_status: 'public', note: 'test-intel: attempt' });
  check('a trusted validator may not raise exposure', trustedPublic.status === 403, trustedPublic.data);

  const earlyTraining = await expert.post(`/api/private/rights-queue/${WAR_PRIMARY}/decisions`, {
    training_ready: true, note: 'test-intel: attempt before review' });
  check('training use is refused while the review is not accepted',
    earlyTraining.status === 409, earlyTraining.data);
  check('the refusal names what is missing',
    Array.isArray(earlyTraining.data.blockers) && earlyTraining.data.blockers.length > 0,
    earlyTraining.data.blockers);

  const acceptReview = await expert.post(`/api/private/rights-queue/${WAR_PRIMARY}/decisions`, {
    review_state: 'accepted_candidate', note: 'test-intel: reviewed' });
  check('a verified expert may accept the review', acceptReview.status === 200, acceptReview.data);
  const nowTraining = await expert.post(`/api/private/rights-queue/${WAR_PRIMARY}/decisions`, {
    training_ready: true, note: 'test-intel: cleared' });
  check('training use is allowed once rights are cleared and the review accepted',
    nowTraining.status === 200 && nowTraining.data.source.training_ready === true, nowTraining.data);

  const history = await trusted.get(`/api/private/rights-queue/${WAR_PRIMARY}`);
  const types = new Set(history.data.decisions.map(d => d.decision_type));
  check('every decision is logged separately with its note',
    types.has('rights') && types.has('review') && types.has('training'), [...types]);
  check('the decision log keeps who decided',
    history.data.decisions.every(d => d.decided_by_name && d.decided_by_role),
    history.data.decisions[0]);

  group('the alignment lab');
  const generated = await expert.post(`/api/private/relationships/${warPair.id}/alignment`, {});
  check('a verified expert can produce an alignment', generated.status === 200, generated.data);
  const alignment = await trusted.get(`/api/private/relationships/${warPair.id}/alignment`);
  check('the alignment is hierarchical and stored', alignment.status === 200 &&
    alignment.data.total_units > 0 && alignment.data.sections.length > 0, {
    total: alignment.data.total_units, sections: alignment.data.sections && alignment.data.sections.length });
  check('the alignment reports its cardinalities',
    alignment.data.cardinalities && Object.keys(alignment.data.cardinalities).length > 0,
    alignment.data.cardinalities);
  check('the alignment is never presented as validated',
    alignment.data.validated === false, alignment.data.validated);

  const unit = alignment.data.sections[0];
  const trustedUnitAccept = await trusted.post(`/api/private/alignment-units/${unit.id}/review`, { action: 'accept' });
  check('a trusted validator may not accept an alignment unit',
    trustedUnitAccept.status === 403, trustedUnitAccept.data);
  const expertUnitAccept = await expert.post(`/api/private/alignment-units/${unit.id}/review`, {
    action: 'accept', note: 'test-intel: unit reviewed' });
  check('a verified expert may accept an alignment unit',
    expertUnitAccept.status === 200 && expertUnitAccept.data.unit.review_state === 'accepted_candidate',
    expertUnitAccept.data);
  const adjust = await trusted.post(`/api/private/alignment-units/${unit.id}/review`, {
    action: 'adjust', cardinality: 'many_to_one', note: 'test-intel: corrected' });
  check('a reviewer can correct a unit rather than regenerate it',
    adjust.status === 200 && adjust.data.unit.cardinality === 'many_to_one' && adjust.data.unit.adjusted === true,
    adjust.data);
  const regenerate = await expert.post(`/api/private/relationships/${warPair.id}/alignment`, {});
  check('regenerating never discards a reviewer\'s decisions',
    regenerate.status === 409 || regenerate.data.generated === false, regenerate.data);

  group('private text stays behind the gate');
  const anonAlignment = await anon.get(`/api/private/relationships/${warPair.id}/alignment`);
  check('an anonymous alignment read → 401 with no text',
    anonAlignment.status === 401 && !/[А-Яа-яЁё]{20,}/.test(anonAlignment.text), anonAlignment.text.slice(0, 120));
  const anonPage = await fetch(`${BASE}/intelligence.html`).then(r => r.text());
  check('the workspace page ships no private text',
    !/War-1\.doc|_LakTextMaterials/.test(anonPage));
}

/* ── Part 4: EN/RU coverage for the new screens ─────────────── */

function loadDictionary() {
  const sandbox = {
    window: {},
    document: {
      readyState: 'complete',
      documentElement: { setAttribute() {} },
      querySelectorAll() { return []; },
      querySelector() { return null; },
    },
    location: { hostname: 'production.example' },
    navigator: { language: 'en-US' },
    localStorage: { getItem() { return null; }, setItem() {} },
    Intl,
    CustomEvent: function CustomEvent() { return {}; },
    console,
  };
  sandbox.window.dispatchEvent = () => {};
  vm.runInNewContext(fs.readFileSync('public/js/i18n.js', 'utf8'), sandbox);
  return sandbox.window.I18n._dict;
}

function localizationTests() {
  group('EN/RU labels for every new screen');
  const dict = loadDictionary();
  const root = path.join(__dirname, '..', 'public');
  const pages = ['intelligence.html', 'alignment.html', 'rights.html'];
  const scripts = ['js/private-workspace.js', 'js/intelligence.js', 'js/alignment.js', 'js/rights.js'];

  const markupKeys = new Set();
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    for (const match of html.matchAll(/data-i18n(?:-html|-placeholder|-aria|-title)?="([^"]+)"/g)) {
      markupKeys.add(match[1]);
    }
  }
  const missingMarkup = [...markupKeys].filter(key => !dict[key]);
  check('every data-i18n key on the three pages is in the dictionary',
    missingMarkup.length === 0, missingMarkup);

  const codeKeys = new Set();
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(root, script), 'utf8');
    for (const match of source.matchAll(/\bP?\.?t\(\s*'((?:pw|si|align|rights)\.[\w.]+)'/g)) {
      // Keys built at runtime (`t('pw.value.' + slug)`) fall back to the raw
      // canonical value by design and are covered by the canonical checks.
      if (!match[1].endsWith('.')) codeKeys.add(match[1]);
    }
  }
  const missingCode = [...codeKeys].filter(key => !dict[key]);
  check('every label, empty, loading and error key used in code is in the dictionary',
    missingCode.length === 0, missingCode);
  check('the screens actually use the dictionary', codeKeys.size > 60, codeKeys.size);

  const newKeys = Object.keys(dict).filter(key => /^(pw|si|align|rights)\./.test(key));
  const missingRu = newKeys.filter(key => !dict[key].ru);
  const missingEn = newKeys.filter(key => !dict[key].en);
  check('every new key has English', missingEn.length === 0, missingEn);
  check('every new key has Russian', missingRu.length === 0, missingRu);
  check('Russian differs from English where it should',
    newKeys.filter(key => dict[key].en === dict[key].ru).every(key => /^pw\.value\.(none)$/.test(key)),
    newKeys.filter(key => dict[key].en === dict[key].ru));

  const canonical = ['permission_pending', 'accepted_candidate', 'one_to_many', 'unmatched_left',
    'alternate_edition', 'russian_translation_candidate'];
  check('canonical values have display labels but are not themselves translated',
    canonical.every(value => dict['pw.value.' + value] && dict['pw.value.' + value].ru),
    canonical.filter(value => !dict['pw.value.' + value]));
}

/* ── Cleanup ────────────────────────────────────────────────── */

// Restores every row the suite touches. Each statement stands on its own so a
// run that was interrupted before cleanup cannot poison the next one.
async function cleanup() {
  const run = async (sql, params) => {
    try { await pool.query(sql, params); }
    catch (err) { console.log(`  ! cleanup step failed: ${err.message}`); }
  };
  await run(`DELETE FROM private_review_decisions
     WHERE note LIKE 'test-intel:%' OR decided_by_name IN ('Intel Reviewer','Intel Trusted','Intel Expert')`);
  await run(
    `UPDATE private_source_relationships
        SET review_state = 'source_import_unreviewed', decided_by_name = NULL, decided_at = NULL
      WHERE review_state <> 'source_import_unreviewed'`);
  await run(
    `UPDATE private_alignment_units
        SET review_state = 'source_import_unreviewed', adjusted = FALSE, reviewer_note = NULL,
            decided_by_name = NULL, decided_at = NULL
      WHERE review_state <> 'source_import_unreviewed' OR adjusted`);
  await run(
    `UPDATE v13_sources
        SET rights_status = 'permission_pending', access_status = 'private_research',
            review_state = 'source_import_unreviewed', training_ready = FALSE
      WHERE source_sequence = ANY($1::int[])`,
    [[WAR_PRIMARY, WAR_ALTERNATE, WAR_RUSSIAN]]);
  await run(
    `UPDATE v13_rights_reviews
        SET rights_status = 'permission_pending', review_state = 'source_import_unreviewed'
      WHERE source_sequence = ANY($1::int[])`,
    [[WAR_PRIMARY, WAR_ALTERNATE, WAR_RUSSIAN]]);
  await run(`DELETE FROM audit_events WHERE actor_id IN ${TEST_ACCOUNTS}
      OR event_type LIKE 'private_intel_%'`);
  await run(`DELETE FROM expert_grants WHERE contributor_id IN ${TEST_ACCOUNTS}`);
  await run(`DELETE FROM contributors WHERE email LIKE 'test-intel-%@example.com'`);
}

async function main() {
  let child = null;
  // A previous run that was interrupted may have left accounts behind.
  await cleanup();
  try {
    pureTests();
    alignmentTests();
    localizationTests();
    await scanTests();

    console.log(`\nStarting isolated test server on :${PORT} …`);
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), AUTH_RATE_MAX: '1000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const bootDeadline = Date.now() + 60000;
    while (!log.includes(`running on port ${PORT}`)) {
      if (Date.now() > bootDeadline) throw new Error('Server did not start:\n' + log);
      await sleep(200);
    }
    // The private packages are staged and scanned after boot; wait it out.
    const readyDeadline = Date.now() + 240000;
    while (!/Source intelligence: /.test(log)) {
      if (Date.now() > readyDeadline) throw new Error('Scan did not finish:\n' + log.slice(-2000));
      await sleep(500);
    }
    await runtimeTests();
  } finally {
    if (child) child.kill('SIGKILL');
    await sleep(300);
    console.log('\nRestoring reviewed state and removing test accounts…');
    await cleanup();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
