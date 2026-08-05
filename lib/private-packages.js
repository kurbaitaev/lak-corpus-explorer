'use strict';

// Registry, restore and verification-cache layer for the private research
// packages (audited v1.2 and v1.3).
//
// The contract:
//   * The persistent copy of a package is its ARCHIVE, held in persistent
//     private storage (lib/private-storage.js) under its recorded SHA-256.
//   * `private/<id>/` is a disposable cache. Delete it and the next boot
//     restores it from the archive; nothing is ever reconstructed from a
//     quoted count.
//   * A restored archive is re-hashed before extraction. A digest mismatch
//     blocks that package and is reported verbatim — never guessed around.
//   * Verification results are cached under a content key derived from the
//     SHA-256 of every file the verifier reads, so an unchanged package is
//     not re-parsed on the next boot. A changed, missing or tampered file
//     changes the content key, so a stale cache entry can never resurrect a
//     package that would now fail.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const storage = require('./private-storage');

const ROOT = path.join(__dirname, '..');
const CACHE_ROOT = process.env.PRIVATE_PACKAGE_CACHE_DIR || path.join(ROOT, 'private');
const ARCHIVE_DIR = process.env.SOURCE_IMPORT_ARCHIVE_DIR || path.join(ROOT, 'attached_assets');

// Both packages, described only by what was recorded when they were received.
const PACKAGES = [
  {
    id: 'v1.2',
    label: 'lak-corpus-v1.2-processed-only',
    archive_sha256: '6183e591fa8e35cb93c058bcf276f934fe1cbb7080a0cce87300ba5a7ddedd4e',
    storage_key: 'private-packages/lak-corpus-v1.2-processed-only.zip',
    // Files sit at the archive root.
    archive_prefix: '',
    // Presence probe: the package declaration plus one payload file.
    required_files: ['stats.json', 'khaydakov_1962_lexicon.jsonl'],
  },
  {
    id: 'v1.3',
    label: 'lak-corpus-v1.3-private-data-and-findings',
    archive_sha256: '3152d173fb722c9295f13c7ca955d6b36910917a1b349ee9ca08a616e2fcfef9',
    storage_key: 'private-packages/lak-corpus-v1.3-private-data-and-findings.zip',
    archive_prefix: '04_corpus/lak-corpus-v1.3/',
    required_files: ['reports/stats.json', 'reports/candidate_stats.json',
      'processed/source_routes.jsonl'],
  },
];

const byId = Object.fromEntries(PACKAGES.map(p => [p.id, p]));

function cacheDirFor(pkg) {
  return path.join(CACHE_ROOT, pkg.id);
}

function cacheComplete(pkg, dir = cacheDirFor(pkg)) {
  return pkg.required_files.every(rel => fs.existsSync(path.join(dir, rel)));
}

// The uploaded archive as it arrives in attached_assets: the workspace adds a
// numeric suffix, so match on the recorded label instead of an exact name.
function findWorkspaceArchive(pkg, archiveDir = ARCHIVE_DIR) {
  let names;
  try { names = fs.readdirSync(archiveDir); } catch { return null; }
  const name = names.find(n => n.startsWith(pkg.label) && n.endsWith('.zip'));
  return name ? path.join(archiveDir, name) : null;
}

// Resolve an archive entry against the directory it is being written into and
// refuse anything that escapes it (absolute paths, `..` segments). A private
// package is trusted by checksum, but an extractor that can be talked into
// writing outside its own cache is not worth keeping.
function safeEntryPath(stageDir, entryName) {
  const normalised = entryName.replace(/\\/g, '/');
  const target = path.resolve(stageDir, normalised);
  const root = path.resolve(stageDir) + path.sep;
  if (target !== path.resolve(stageDir) && !target.startsWith(root)) {
    throw new Error(`archive entry escapes the extraction directory: ${entryName}`);
  }
  return target;
}

// Unpack the archive with the bundled zip reader rather than shelling out to
// `unzip`. The system binary is present in the workspace but not guaranteed in
// the deployment image, where its absence surfaced only as an empty-stderr
// "unzip failed" and left the package blocked in production.
function unzipTo(archivePath, stageDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr) return reject(new Error(`archive could not be opened: ${openErr.message}`));
      zip.on('error', err => reject(new Error(`archive could not be read: ${err.message}`)));
      zip.on('end', resolve);
      zip.readEntry();
      zip.on('entry', entry => {
        let target;
        try { target = safeEntryPath(stageDir, entry.fileName); }
        catch (err) { return reject(err); }
        if (entry.fileName.endsWith('/')) {
          fs.mkdirSync(target, { recursive: true });
          return zip.readEntry();
        }
        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) {
            return reject(new Error(`archive entry could not be read (${entry.fileName}): ${streamErr.message}`));
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const out = fs.createWriteStream(target);
          readStream.on('error', err =>
            reject(new Error(`archive entry could not be read (${entry.fileName}): ${err.message}`)));
          out.on('error', err =>
            reject(new Error(`archive entry could not be written (${entry.fileName}): ${err.message}`)));
          out.on('close', () => zip.readEntry());
          readStream.pipe(out);
        });
      });
    });
  });
}

async function extractArchive(archivePath, destDir, prefix) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  // Stage inside the cache root, not /tmp: the two are different devices in
  // this container, and rename() cannot cross them.
  const stageDir = prefix
    ? fs.mkdtempSync(path.join(path.dirname(destDir), '.pkg-stage-'))
    : destDir;
  try {
    await unzipTo(archivePath, stageDir);
  } catch (err) {
    if (prefix) fs.rmSync(stageDir, { recursive: true, force: true });
    throw new Error(`archive could not be extracted: ${err.message}`);
  }
  if (prefix) {
    const inner = path.join(stageDir, prefix);
    if (!fs.existsSync(inner)) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      throw new Error(`archive does not contain the expected directory ${prefix}`);
    }
    for (const entry of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, entry), path.join(destDir, entry));
    }
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

// Push the workspace archive into persistent storage. Called on boot so a
// freshly uploaded package becomes rebuild-proof without a manual step.
async function syncArchiveToStorage(pool, pkg) {
  const archivePath = findWorkspaceArchive(pkg);
  if (!archivePath) return { uploaded: false, reason: 'no archive in the workspace' };
  const stored = await storage.head(pool, pkg.storage_key);
  if (stored && stored.sha256 === pkg.archive_sha256) return { uploaded: false, reason: 'already stored' };
  const digest = await storage.sha256Stream(archivePath);
  if (digest !== pkg.archive_sha256) {
    return { uploaded: false, reason:
      'the archive in the workspace does not match the checksum recorded when it was received' };
  }
  const result = await storage.put(pool, pkg.storage_key, archivePath,
    { expectedSha256: pkg.archive_sha256 });
  return { uploaded: result.stored, reason: null };
}

// Make sure `private/<id>/` holds the package. Returns where it came from and,
// on failure, why the package is unavailable. Never throws.
async function ensureLocalCache(pool, pkg) {
  const dir = cacheDirFor(pkg);
  if (cacheComplete(pkg, dir)) {
    return { present: true, restore_source: 'local_cache', blocked_reason: null, cache_dir: dir };
  }

  const stored = await storage.head(pool, pkg.storage_key).catch(() => null);
  const workspaceArchive = findWorkspaceArchive(pkg);
  let archivePath = null;
  let restoreSource = null;
  let tempArchive = null;

  try {
    if (stored) {
      tempArchive = path.join(require('os').tmpdir(), `${pkg.label}-restore.zip`);
      await storage.restoreToFile(pool, pkg.storage_key, tempArchive);
      if (stored.sha256 !== pkg.archive_sha256) {
        return {
          present: false, restore_source: null, cache_dir: dir,
          blocked_reason: 'The archive in persistent storage does not match the checksum recorded ' +
            'when the package was received, so it was not extracted.',
        };
      }
      archivePath = tempArchive;
      restoreSource = 'persistent_storage';
    } else if (workspaceArchive) {
      const digest = await storage.sha256Stream(workspaceArchive);
      if (digest !== pkg.archive_sha256) {
        return {
          present: false, restore_source: null, cache_dir: dir,
          blocked_reason: 'The package archive in the workspace does not match the checksum ' +
            'recorded when it was received.',
        };
      }
      archivePath = workspaceArchive;
      restoreSource = 'workspace_archive';
    } else {
      return {
        present: false, restore_source: null, cache_dir: dir,
        blocked_reason: 'The package is not in the local cache and no archive is held in ' +
          'persistent storage, so nothing was ingested.',
      };
    }

    await extractArchive(archivePath, dir, pkg.archive_prefix);
    if (!cacheComplete(pkg, dir)) {
      return {
        present: false, restore_source: restoreSource, cache_dir: dir,
        blocked_reason: 'The restored archive does not contain the files the package must declare.',
      };
    }
    return { present: true, restore_source: restoreSource, blocked_reason: null, cache_dir: dir };
  } catch (err) {
    return {
      present: false, restore_source: null, cache_dir: dir,
      blocked_reason: `The package could not be restored from persistent storage: ${err.message}`,
    };
  } finally {
    if (tempArchive) fs.rmSync(tempArchive, { force: true });
  }
}

// ── Verification cache ─────────────────────────────────────────
// The content key is a digest over (relative path, size, SHA-256) of every
// file the verifier reads, sorted by path. It changes whenever a file is
// edited, truncated, added or removed, which is exactly when a cached
// "verified" answer must stop being trusted.
function hashFileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function fileFingerprints(dir, relativePaths) {
  const files = {};
  const parts = [...relativePaths].sort().map(rel => {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) return `${rel}:absent`;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      // Directories of extracted text bodies: their names and count are part
      // of the fingerprint, so a removed body invalidates a cached result.
      const names = fs.readdirSync(full).sort();
      return `${rel}:dir:${names.length}:${crypto.createHash('sha256').update(names.join('\n')).digest('hex')}`;
    }
    const digest = hashFileSync(full);
    files[rel] = digest;
    return `${rel}:${stat.size}:${digest}`;
  });
  return { key: crypto.createHash('sha256').update(parts.join('\n')).digest('hex'), files };
}

function contentKey(dir, relativePaths) {
  return fileFingerprints(dir, relativePaths).key;
}

async function readCachedVerification(pool, packageId, key) {
  const rows = await pool.query(
    `SELECT status, blocked_reason, declared, observed, verified_at
       FROM private_package_verifications WHERE package_id = $1 AND content_key = $2`,
    [packageId, key]);
  return rows.rows[0] || null;
}

async function writeCachedVerification(pool, packageId, key, result, archiveSha256) {
  await pool.query(
    `INSERT INTO private_package_verifications
       (package_id, content_key, status, blocked_reason, declared, observed, archive_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (package_id, content_key) DO UPDATE
       SET status = EXCLUDED.status, blocked_reason = EXCLUDED.blocked_reason,
           declared = EXCLUDED.declared, observed = EXCLUDED.observed,
           archive_sha256 = EXCLUDED.archive_sha256, verified_at = now()`,
    [packageId, key, result.status, result.blocked_reason,
     JSON.stringify(result.declared || {}), JSON.stringify(result.observed || {}),
     archiveSha256 || null]);
}

module.exports = {
  PACKAGES, byId, CACHE_ROOT, ARCHIVE_DIR,
  cacheDirFor, cacheComplete, findWorkspaceArchive, extractArchive,
  syncArchiveToStorage, ensureLocalCache,
  hashFileSync, contentKey, fileFingerprints, readCachedVerification, writeCachedVerification,
};
