'use strict';

// Boot pipeline for the private research packages.
//
// For each package, in order:
//   1. push the workspace archive into persistent storage (if it is there and
//      matches its recorded digest), so a freshly uploaded package becomes
//      rebuild-proof without a manual step;
//   2. restore `private/<id>/` from persistent storage when the local cache is
//      missing — the local tree is disposable, the archive is the source of
//      truth, and the restored archive is re-hashed before it is extracted;
//   3. verify the package against its own declarations, reusing a cached
//      result when every file the verifier reads is byte-identical to the run
//      that produced it;
//   4. stage whatever verification actually cleared.
//
// Nothing here throws: a package that cannot be restored or verified is
// reported with a reason and simply contributes nothing, while the rest of
// the app keeps running.

const path = require('path');
const packages = require('./private-packages');
const storage = require('./private-storage');
const sourceImport = require('./source-import');
const v13 = require('./source-import-v13');

// Files the v1.2 verifier reads. Editing any of them invalidates the cache.
const V12_VERIFIED_FILES = [
  'stats.json', 'reconciliation.json',
  ...sourceImport.EXPECTED_SOURCES.map(s => s.file),
];

// A verification object without candidate records: enough for the public
// status view and the boot log, cheap enough to cache and reuse.
function lightweight(verification) {
  return {
    package_dir: verification.package_dir,
    package_label: verification.package_label,
    package_present: verification.package_present,
    stats: verification.stats,
    reconciliation: verification.reconciliation,
    overlap: verification.overlap,
    counts: verification.counts,
    ingestion_blocked: verification.ingestion_blocked,
    sources: verification.sources.map(s => ({
      source_id: s.source_id, observatory_id: s.observatory_id, title: s.title,
      layer: s.layer, provenance_granularity: s.provenance_granularity,
      expected_record_count: s.expected_record_count, expected_metrics: s.expected_metrics,
      file: s.file, description_key: s.description_key, status: s.status, error: s.error,
      file_sha256: s.file_sha256, records_sha256: s.records_sha256, metrics: s.metrics,
      verified_record_count: s.status === 'verified' ? s.records.length : 0,
      records: [],
    })),
  };
}

// An "absent package" verification, used when the cache could not be restored
// at all. Reports the audited counts as expectations, never as holdings.
function absentVerification(reason) {
  const verification = sourceImport.verifySources({
    packageDir: path.join(require('os').tmpdir(), 'lak-absent-package-dir'),
  });
  for (const source of verification.sources) source.error = reason;
  return lightweight(verification);
}

// ── v1.2 ───────────────────────────────────────────────────────
async function prepareV12(pool, pkg, availability) {
  const dir = availability.cache_dir;
  if (!availability.present) {
    return {
      verification: absentVerification(availability.blocked_reason),
      cache_hit: false, content_key: null, staged: null,
    };
  }

  const fingerprint = packages.fileFingerprints(dir, V12_VERIFIED_FILES);
  const cached = await packages.readCachedVerification(pool, pkg.id, fingerprint.key);

  // A cached "verified" answer may only be reused when the rows it produced
  // are still staged under exactly the file digests it recorded.
  if (cached && cached.status === 'verified' && cached.observed && cached.observed.verification) {
    const digests = cached.observed.file_digests || {};
    const batches = await pool.query(
      'SELECT source_id, manifest_sha256 FROM source_import_batches WHERE source_id = ANY($1)',
      [Object.keys(digests)]);
    const staged = new Set(batches.rows.map(row => `${row.source_id}:${row.manifest_sha256}`));
    const complete = Object.entries(digests).every(([sourceId, digest]) => staged.has(`${sourceId}:${digest}`));
    if (complete) {
      return { verification: cached.observed.verification, cache_hit: true, content_key: fingerprint.key, staged: null };
    }
  }

  const verification = sourceImport.verifySources({ packageDir: dir });
  const staged = await sourceImport.importVerified(pool, verification);
  const light = lightweight(verification);
  const fileDigests = Object.fromEntries(verification.sources
    .filter(s => s.status === 'verified')
    .map(s => [s.source_id, s.file_sha256]));
  await packages.writeCachedVerification(pool, pkg.id, fingerprint.key, {
    status: verification.ingestion_blocked ? 'blocked' : 'verified',
    blocked_reason: verification.ingestion_blocked
      ? (verification.sources.find(s => s.status !== 'verified') || {}).error || 'ingestion blocked'
      : null,
    declared: verification.stats || {},
    observed: { verification: light, file_digests: fileDigests },
  }, pkg.archive_sha256);
  return { verification: light, cache_hit: false, content_key: fingerprint.key, staged };
}

// ── v1.3 ───────────────────────────────────────────────────────
async function prepareV13(pool, pkg, availability, options = {}) {
  const dir = availability.cache_dir;
  if (!availability.present) {
    return {
      verification: { status: 'blocked', blocked_reason: availability.blocked_reason, declared: {}, observed: {} },
      cache_hit: false, content_key: null, staged: null,
    };
  }

  const fingerprint = packages.fileFingerprints(dir, v13.VERIFIED_FILES);
  const cached = await packages.readCachedVerification(pool, pkg.id, fingerprint.key);

  let verification = null;
  let cacheHit = false;
  if (cached) {
    // Reusing a cached *blocked* answer is always safe: the bytes are
    // identical, so re-reading them would produce the same refusal.
    if (cached.status === 'blocked') {
      return {
        verification: { status: 'blocked', blocked_reason: cached.blocked_reason,
          declared: cached.declared, observed: cached.observed },
        cache_hit: true, content_key: fingerprint.key, staged: null,
      };
    }
    const digests = (cached.observed || {}).file_digests || {};
    // Only a *finished* layer counts. Staging is resumable now, so a batch row
    // exists from the moment a layer starts: if this asked merely whether a row
    // was present, a boot interrupted during the last layer would look fully
    // staged on the next boot, skip the import altogether and strand the
    // partial layer forever — the exact failure this resumability work exists
    // to end.
    const batches = await pool.query(
      `SELECT layer, file_sha256 FROM v13_import_batches WHERE status = 'complete'`);
    const staged = new Set(batches.rows.map(row => `${row.layer}:${row.file_sha256}`));
    const layerFiles = [
      ['source_registry', v13.REGISTRY_FILES.manifest],
      ['rights_review_queue', v13.REGISTRY_FILES.rights],
      ...v13.CANDIDATE_LAYERS.map(l => [l.layer, l.file]),
    ];
    const complete = layerFiles.every(([layer, file]) => digests[file] && staged.has(`${layer}:${digests[file]}`));
    if (complete) {
      return {
        verification: { status: 'verified', blocked_reason: null,
          declared: cached.declared, observed: cached.observed },
        cache_hit: true, content_key: fingerprint.key, staged: null,
      };
    }
    verification = { status: 'verified', blocked_reason: null, declared: cached.declared, observed: cached.observed };
    cacheHit = true;
  }

  if (!verification) {
    verification = await v13.verifyPackage({ packageDir: dir });
    // Record the verdict *before* staging, not after. Verification reads every
    // record in the package, and staging the large layers can be interrupted;
    // caching only on full success meant an interrupted boot re-verified a
    // quarter of a million records from scratch every time. The cache is keyed
    // by the digests of the files the verifier read, and the reuse path above
    // still re-checks that every layer actually landed before it trusts it, so
    // writing it early cannot make an unstaged package look staged.
    await packages.writeCachedVerification(pool, pkg.id, fingerprint.key, {
      status: verification.status === 'verified' ? 'verified' : 'blocked',
      blocked_reason: verification.blocked_reason,
      declared: verification.declared || {},
      observed: { ...(verification.observed || {}), file_digests: fingerprint.files },
    }, pkg.archive_sha256);
  }
  const staged = await v13.importPackage(pool, dir, verification, { onLayer: options.onLayer });
  return { verification, cache_hit: cacheHit, content_key: fingerprint.key, staged };
}

// ── Orchestration ──────────────────────────────────────────────
async function preparePrivatePackages(pool, options = {}) {
  const report = { backend: storage.backendName(), packages: [], v12: null, v13: null };

  for (const pkg of packages.PACKAGES) {
    let upload = { uploaded: false, reason: 'not attempted' };
    try { upload = await packages.syncArchiveToStorage(pool, pkg); }
    catch (err) { upload = { uploaded: false, reason: `upload failed: ${err.message}` }; }

    const availability = await packages.ensureLocalCache(pool, pkg);
    const stored = await storage.head(pool, pkg.storage_key).catch(() => null);

    let prepared;
    try {
      prepared = pkg.id === 'v1.2'
        ? await prepareV12(pool, pkg, availability)
        : await prepareV13(pool, pkg, availability, options);
    } catch (err) {
      prepared = {
        verification: pkg.id === 'v1.2'
          ? absentVerification(`staging failed: ${err.message}`)
          : { status: 'blocked', blocked_reason: `staging failed: ${err.message}`, declared: {}, observed: {} },
        cache_hit: false, content_key: null, staged: null,
      };
    }

    const entry = {
      package_id: pkg.id,
      package_label: pkg.label,
      archive_sha256: pkg.archive_sha256,
      present: availability.present,
      restore_source: availability.restore_source,
      blocked_reason: availability.blocked_reason,
      archive_in_persistent_storage: !!stored,
      archive_digest_verified: !!stored && stored.sha256 === pkg.archive_sha256,
      archive_uploaded_this_boot: upload.uploaded,
      verification_cache_hit: prepared.cache_hit,
      content_key: prepared.content_key,
      staged: prepared.staged,
    };
    if (pkg.id === 'v1.2') {
      const v = prepared.verification;
      entry.verification_status = v.ingestion_blocked ? 'blocked' : 'verified';
      entry.blocked_reason = entry.blocked_reason ||
        (v.ingestion_blocked ? (v.sources.find(s => s.status !== 'verified') || {}).error || null : null);
      entry.declared_counts = { staged_private_candidates: v.counts.expected_records };
      entry.verified_counts = { staged_private_candidates: v.counts.verified_records };
      report.v12 = v;
    } else {
      const v = prepared.verification;
      entry.verification_status = v.status;
      entry.blocked_reason = entry.blocked_reason || v.blocked_reason || null;
      entry.declared_counts = v13.AUDITED;
      entry.verified_counts = v.observed || {};
      report.v13 = v;
    }
    report.packages.push(entry);
  }

  return report;
}

module.exports = { preparePrivatePackages, V12_VERIFIED_FILES, lightweight, absentVerification };
