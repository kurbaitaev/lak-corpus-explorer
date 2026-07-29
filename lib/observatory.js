'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(
  __dirname,
  '..',
  'attached_assets',
  '0_lak-resource-observatory-68-records_1785352975014.json'
);

// This is an operational acquisition flag, not a legal conclusion. Each flagged
// record either states an explicit permission/consent/agreement/research-only
// constraint, or proposes copying/extracting/OCR/alignment/transcription/archive
// work on a copyrighted, edition-controlled, or reproduction-controlled source.
// Keep this reviewed set stable and preserve the registry's original rights text.
const PERMISSION_SENSITIVE_IDS = new Set([
  'held-gadzhiev',
  'held-literary',
  'held-tolstoy',
  'held-folktales',
  'khaydakov',
  'digiev',
  'ilchi',
  'gtrk-radio',
  'rutube-gtrk',
  'rgvk',
  'dspu-video',
  'agamov-app',
  'dictionary-2019-40k',
  'kayaev-dictionary',
  'kayaev-archive',
  'kazenin-syntax',
  'abdullaev-classes',
  'folklore-monuments',
  'khalilov-song',
  'forker-audio',
  'daniel-recordings',
  'ismailova-link-verbs',
  'postpositions-comparison',
  'quba-audio',
  'pear-stories',
]);

function evidenceGroup(status) {
  if (status === 'Held' || status === 'Processed') return 'Held or processed';
  if (status === 'Verified') return 'Verified online resource';
  if (status === 'Verified lead' || status === 'Needs verification') return 'Verified lead';
  if (status === 'Catalog only') return 'Catalog only';
  if (['Contact lead', 'Institutional lead', 'Local lead'].includes(status)) return 'Contact or institutional lead';
  if (status === 'Discovery portal') return 'Discovery portal';
  if (status === 'Gap confirmed') return 'Confirmed gap';
  return status;
}

function isPublicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function containsBibleReference(resource) {
  const searchable = [
    resource.id,
    resource.title,
    resource.creator,
    resource.category,
    resource.notes,
    resource.action,
  ].join(' ');
  return /\b(bible|biblical|scripture|gospel|quran|koran)\b|библи|евангел|коран/i.test(searchable);
}

function loadObservatory() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  if (!Array.isArray(registry.resources)) throw new Error('Observatory registry has no resources array');
  if (registry.record_count !== 68 || registry.resources.length !== 68) {
    throw new Error(`Observatory registry must contain exactly 68 records; found ${registry.resources.length}`);
  }

  const ids = new Set(registry.resources.map(resource => resource.id));
  if (ids.size !== registry.resources.length) throw new Error('Observatory registry contains duplicate IDs');
  const bibleHits = registry.resources.filter(containsBibleReference);
  if (bibleHits.length) throw new Error(`Bible-derived Observatory records are forbidden: ${bibleHits.map(r => r.id).join(', ')}`);
  for (const id of PERMISSION_SENSITIVE_IDS) {
    if (!ids.has(id)) throw new Error(`Permission-sensitive Observatory record is missing: ${id}`);
  }

  const resources = registry.resources.map(resource => ({
    ...resource,
    permission_sensitive: PERMISSION_SENSITIVE_IDS.has(resource.id),
    evidence_group: evidenceGroup(resource.status),
    public_url: isPublicUrl(resource.url) ? resource.url : null,
  }));
  const counts = {
    total: resources.length,
    p0: resources.filter(resource => resource.priority === 'P0').length,
    held_or_processed: resources.filter(resource => ['Held', 'Processed'].includes(resource.status)).length,
    permission_sensitive: resources.filter(resource => resource.permission_sensitive).length,
  };
  if (counts.p0 !== 21 || counts.held_or_processed !== 11 || counts.permission_sensitive !== 25) {
    throw new Error(`Observatory headline count mismatch: ${JSON.stringify(counts)}`);
  }

  return {
    name: registry.name,
    scope: registry.scope,
    checked_at: registry.checked_at,
    record_count: registry.record_count,
    counts,
    options: {
      categories: [...new Set(resources.map(resource => resource.category))].sort(),
      statuses: [...new Set(resources.map(resource => resource.status))].sort(),
      evidence_groups: [...new Set(resources.map(resource => resource.evidence_group))],
      priorities: ['P0', 'P1', 'P2'],
    },
    resources,
  };
}

module.exports = {
  REGISTRY_PATH,
  PERMISSION_SENSITIVE_IDS,
  containsBibleReference,
  evidenceGroup,
  isPublicUrl,
  loadObservatory,
};