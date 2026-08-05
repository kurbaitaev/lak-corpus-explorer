'use strict';

// Public, metadata-only research summary of the audited v1.3 private package.
//
// This module is the ONLY path by which the private research package reaches a
// public surface, and it can emit exactly five kinds of value:
//
//   * counts — finite, non-negative integers (or null when not known yet)
//   * booleans
//   * canonical identifiers from the fixed tables in this file (family ids,
//     family kinds, methods, routes, review/rights/access states, the
//     package id and label, verification statuses, blocking steps)
//   * the curated family titles declared in this file
//   * nothing else
//
// Every emission goes through `assertSafe`, which walks the payload and
// refuses any key it does not know and any string it did not declare. A
// passage, a filename, a source path, a candidate row or a blocked-reason
// string therefore cannot be emitted even by a caller that tries: the
// endpoint fails closed with no payload instead of leaking.
//
// The counts come from the *verified* package. When the package is not
// present or did not verify, the audited numbers are still reported — but as
// expectations from the audit, with `staged` null and `counts_available`
// false. A quoted count is never presented as holdings.

const fs = require('fs');
const path = require('path');
const v13 = require('./source-import-v13');
const privatePackages = require('./private-packages');

// ── Source families ────────────────────────────────────────────
//
// The strongest parallel/version opportunities named by the v1.3 findings.
// `match` is INTERNAL: it groups the package's own file routes into families
// and is never emitted. Everything else on a family is canonical metadata.
//
// `method` records how the family was *discovered* — filename/version
// proximity — which is a lead, not proof of sentence equivalence. Nothing
// here asserts that any two passages align; that is what the human pairing
// step exists to decide.
const BLOCKING_STEPS = ['rights_clearance', 'human_pairing_map', 'expert_review'];

const SOURCE_FAMILIES = [
  {
    id: 'lak_russian_epics',
    title: 'Lak and Russian epic versions',
    family: 'parallel_language_versions',
    method: 'paired_language_files',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['/lakepics/'],
  },
  {
    id: 'ttul_daghustan',
    title: 'Gamzatov — Ttul Daghustan versions',
    family: 'edition_versions',
    method: 'multiple_editions_of_one_work',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['ttuldaghustan', 'ttul daghusttan', 'ttuldaghestan'],
  },
  {
    id: 'authier_tales',
    title: 'Authier — Lak tales in Cyrillic and Latin',
    family: 'script_versions',
    method: 'cyrillic_latin_script_pair',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['laktalesauthierversion'],
  },
  {
    id: 'tolstoy_versions',
    title: 'Tolstoy in Lak — Cyrillic and Latin versions',
    family: 'script_versions',
    method: 'cyrillic_latin_script_pair',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['tolstoylak'],
  },
  {
    id: 'lorca',
    title: 'García Lorca — Lak and Russian versions',
    family: 'translated_work_versions',
    method: 'translated_work_version_set',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['garcia lorca'],
  },
  {
    id: 'eleonora_materials',
    title: 'Eleonora — transcription and translation material',
    family: 'fieldwork_transcription',
    method: 'transcription_translation_pair',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['eleonoramaterials'],
  },
  {
    id: 'war_pilot',
    title: 'War — Russian/Lak pilot set',
    family: 'parallel_language_versions',
    method: 'paired_language_files',
    route: 'private_text_segments',
    review_status: 'unreviewed_alignment_candidate',
    match: ['/war/', '/war-1a.'],
  },
];

// The audited aggregate keys a public surface may see, in display order.
const AGGREGATE_KEYS = [
  'source_routes',
  'rights_review_items',
  'usable_private_extractions',
  'private_lexicon_lines',
  'private_text_segments',
  'private_grammar_examples',
  'private_reference_index',
  'system_metadata_files',
];

// ── The emission allowlist ─────────────────────────────────────
const ALLOWED_KEYS = new Set([
  'package', 'id', 'label', 'verification_status',
  'audited', 'staged', 'counts_match', 'counts_available',
  'public_search_eligible', 'training_ready', 'reviewed',
  ...AGGREGATE_KEYS,
  'policy', 'access_status', 'rights_status', 'review_state',
  'public_corpus', 'records', 'observatory_resources',
  'records_added_by_v13', 'public_candidates',
  'families', 'family_count',
  'title', 'family', 'method', 'route', 'review_status', 'is_public',
  'files', 'candidate_files', 'blocking_steps',
]);

const ALLOWED_STRINGS = new Set([
  v13.PACKAGE_ID, v13.PACKAGE_LABEL,
  'verified', 'blocked', 'preparing',
  ...Object.values(v13.REQUIRED_POLICY).filter(v => typeof v === 'string'),
  ...BLOCKING_STEPS,
  ...SOURCE_FAMILIES.flatMap(f => [f.id, f.title, f.family, f.method, f.route, f.review_status]),
  'private_research', 'permission_pending',
]);

function assertSafe(value, where = 'summary') {
  if (value === null) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${where}: not a count`);
    return value;
  }
  if (typeof value === 'string') {
    if (!ALLOWED_STRINGS.has(value)) throw new Error(`${where}: string "${value}" is not a declared canonical value`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, i) => assertSafe(item, `${where}[${i}]`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!ALLOWED_KEYS.has(key)) throw new Error(`${where}: key "${key}" is not on the public allowlist`);
      out[key] = assertSafe(item, `${where}.${key}`);
    }
    return out;
  }
  throw new Error(`${where}: unsupported value type`);
}

// ── Family tallies from the verified package ───────────────────
// Streams the package's own route registry and counts files per family.
// Only the tally leaves this function: no path, digest or record is kept.
function packageDir() {
  const pkg = privatePackages.PACKAGES.find(p => p.id === v13.PACKAGE_ID);
  return pkg ? privatePackages.cacheDirFor(pkg) : null;
}

async function familyTallies(dir) {
  if (!dir) return null;
  const routesFile = path.join(dir, v13.REGISTRY_FILES.routes);
  if (!fs.existsSync(routesFile)) return null;
  const tallies = new Map(SOURCE_FAMILIES.map(f => [f.id, { files: 0, candidate_files: 0 }]));
  await v13.forEachRecord(routesFile, record => {
    // System-metadata receipts (.DS_Store and friends) are not materials.
    if (record.material_type === 'system_metadata') return;
    const rel = String(record.source_relative_path || '').toLowerCase();
    for (const family of SOURCE_FAMILIES) {
      if (!family.match.some(fragment => rel.includes(fragment))) continue;
      const tally = tallies.get(family.id);
      tally.files += 1;
      if (record.disposition === 'candidate_generation') tally.candidate_files += 1;
      break;
    }
  });
  return tallies;
}

function familyCards(tallies) {
  return SOURCE_FAMILIES.map(family => {
    const tally = tallies ? tallies.get(family.id) : null;
    return {
      id: family.id,
      title: family.title,
      family: family.family,
      method: family.method,
      route: family.route,
      review_status: family.review_status,
      access_status: v13.REQUIRED_POLICY.access_status,
      rights_status: v13.REQUIRED_POLICY.rights_status,
      is_public: false,
      files: tally ? tally.files : null,
      candidate_files: tally ? tally.candidate_files : null,
      blocking_steps: BLOCKING_STEPS.slice(),
    };
  });
}

function auditedAggregates() {
  return Object.fromEntries(AGGREGATE_KEYS.map(key => [key, v13.AUDITED[key]]));
}

// ── Summaries ──────────────────────────────────────────────────
// Before preparation finishes (or when the package is blocked), the audited
// numbers are still shown — as expectations, with nothing staged.
function preparingSummary({ corpusRecords, observatoryResources }) {
  return {
    package: {
      id: v13.PACKAGE_ID,
      label: v13.PACKAGE_LABEL,
      verification_status: 'preparing',
    },
    audited: auditedAggregates(),
    staged: null,
    counts_match: false,
    counts_available: false,
    policy: { ...v13.REQUIRED_POLICY },
    public_corpus: publicCorpus(corpusRecords, observatoryResources),
    families: familyCards(null),
    family_count: SOURCE_FAMILIES.length,
  };
}

function publicCorpus(corpusRecords, observatoryResources) {
  return {
    records: Number(corpusRecords) || 0,
    observatory_resources: Number(observatoryResources) || 0,
    // The whole point of the panel: the private package added nothing here.
    records_added_by_v13: 0,
    public_candidates: 0,
  };
}

// Build the summary from what actually verified and staged.
//   report — the private-boot report (may be null)
//   staged — v13.stagedCounts(pool) result (may be null)
async function buildSummary({ report, staged, corpusRecords, observatoryResources }) {
  const entry = report && Array.isArray(report.packages)
    ? report.packages.find(p => p.package_id === v13.PACKAGE_ID)
    : null;
  const status = entry && entry.verification_status === 'verified' ? 'verified'
    : entry ? 'blocked' : 'preparing';

  let tallies = null;
  if (status === 'verified') {
    tallies = await familyTallies(packageDir()).catch(() => null);
  }

  const audited = auditedAggregates();
  const stagedCounts = status === 'verified' && staged
    ? {
      ...Object.fromEntries(AGGREGATE_KEYS.map(key => [key, Number(staged[key]) || 0])),
      public_search_eligible: Number(staged.public_search_eligible) || 0,
      training_ready: Number(staged.training_ready) || 0,
      reviewed: Number(staged.reviewed) || 0,
    }
    : null;

  return {
    package: {
      id: v13.PACKAGE_ID,
      label: v13.PACKAGE_LABEL,
      verification_status: status,
    },
    audited,
    staged: stagedCounts,
    counts_match: !!stagedCounts && AGGREGATE_KEYS.every(key => stagedCounts[key] === audited[key]),
    counts_available: !!tallies,
    policy: { ...v13.REQUIRED_POLICY },
    public_corpus: publicCorpus(corpusRecords, observatoryResources),
    families: familyCards(tallies),
    family_count: SOURCE_FAMILIES.length,
  };
}

// The only function a route may call. Anything unexpected in the payload
// throws here, so the endpoint returns an error rather than a leak.
function emit(summary) {
  return assertSafe(summary);
}

module.exports = {
  SOURCE_FAMILIES, AGGREGATE_KEYS, BLOCKING_STEPS,
  ALLOWED_KEYS, ALLOWED_STRINGS,
  assertSafe, emit, buildSummary, preparingSummary, familyTallies, packageDir,
};
