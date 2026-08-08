'use strict';

const crypto = require('crypto');

const NORMALIZATION_VERSION = 'lak-search-v1';
const FEATURE_ENABLED = /^(1|true|yes)$/i.test(process.env.CORPUS_V2_ENABLED || 'false');

function normalizeLak(value) {
  return String(value ?? '')
    .normalize('NFC')
    .toLocaleLowerCase()
    .replace(/[іi1]/g, 'Ӏ')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// v1.4 evidence preserves the audit's historical normalization keys. Some
// source rows therefore contain capital palochka while typed Cyrillic folds to
// small palochka (and ё/е may differ). Search both exact normalized variants
// without silently rewriting stored source evidence.
function normalizeLakVariants(value) {
  const base = normalizeLak(value);
  const canonical = base.replace(/ӏ/g, 'Ӏ').replace(/ё/g, 'е');
  const small = canonical.replace(/Ӏ/g, 'ӏ');
  const variants = new Set([base, canonical, small]);
  for (const item of [...variants]) {
    variants.add(item.replace(/е/g, 'ё'));
    variants.add(item.replace(/ё/g, 'е'));
  }
  return [...variants].filter(Boolean);
}

function stableId(prefix, ...parts) {
  const digest = crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

function wordformId(normalized) {
  return stableId('wf', 'lbe', NORMALIZATION_VERSION, normalized);
}

function lemmaKeyId(normalized) {
  return stableId('lemma', 'lbe', NORMALIZATION_VERSION, normalized);
}

function parsePagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

function requireFeature(req, res, next) {
  if (!FEATURE_ENABLED) return res.status(404).json({ error: 'Corpus v2 is not enabled.' });
  next();
}

module.exports = {
  FEATURE_ENABLED,
  NORMALIZATION_VERSION,
  normalizeLak,
  normalizeLakVariants,
  stableId,
  wordformId,
  lemmaKeyId,
  parsePagination,
  requireFeature,
};
