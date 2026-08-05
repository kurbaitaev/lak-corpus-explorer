'use strict';

// Shared corpus-search primitives.
//
// A corpus record is a fixed-length array:
//   [0] kind ('text' | 'lexicon')
//   [1] Lak text / form
//   [2] translation or source-document id
//   [3] source
//   [4] variety
//   [5] record id
//   [6] url
//   [7] optional Lak Cyrillic parallel
//   [8] optional English translation
//   [9] optional license
//   [10] optional persistent collection identifier
//
// Matching is FIELD-SCOPED: a query only matches when the whole phrase, or
// every one of its tokens, is found inside ONE searchable field. Joining the
// fields before matching (the previous behaviour) made a query match across
// field boundaries, which produced results no reader could explain.
//
// Two deterministic tiers are returned, and nothing else:
//   MATCH_PHRASE  (0) — the normalized query occurs verbatim in one field
//   MATCH_TOKENS  (1) — every normalized query token occurs, as a whole
//                       token, in the SAME field, in any order
// A record matching only *some* of the query tokens is not a match at all,
// so "где ты" never degrades into an any-word search.

const MATCH_PHRASE = 0;
const MATCH_TOKENS = 1;
const NO_MATCH = -1;

// Fields a free-text query may match. Index 6 (url) is deliberately excluded.
const QUERY_FIELDS = [1, 2, 3, 4, 5, 7, 8];
// Fields an alias-expanded query may match as metadata (the Lak form itself is
// matched through the alias expansion, not as literal text).
const META_FIELDS = [2, 3, 4, 5, 8];

// Letters, digits and the Lak palochka in all its lookalike spellings.
const WORD_CHARS = /[^\p{L}\p{N}ӀIІ]+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[iіӏ]/g, 'Ӏ')
    .toLocaleLowerCase();
}

// Normalized query with collapsed whitespace, so "где   ты" === "где ты".
function normalizeQuery(q) {
  return norm(String(q ?? '').trim()).replace(/\s+/g, ' ');
}

function tokenize(value) {
  return norm(value).replace(WORD_CHARS, ' ').trim().split(' ').filter(Boolean);
}

// True when `form` occurs as a whole token inside `value`.
function tokenHas(value, form) {
  if (!form) return false;
  const text = ' ' + norm(value).replace(WORD_CHARS, ' ') + ' ';
  return text.includes(' ' + form + ' ');
}

// Tier for a single field, or NO_MATCH.
function fieldMatchTier(fieldValue, phrase, queryTokens) {
  if (!phrase) return NO_MATCH;
  const normalized = norm(fieldValue).replace(/\s+/g, ' ');
  if (normalized.includes(phrase)) return MATCH_PHRASE;
  if (queryTokens.length < 2) return NO_MATCH;
  const tokens = new Set(tokenize(fieldValue));
  return queryTokens.every(t => tokens.has(t)) ? MATCH_TOKENS : NO_MATCH;
}

// Best (lowest) tier across the given field indexes, or NO_MATCH.
function recordMatchTier(record, phrase, queryTokens, fieldIndexes = QUERY_FIELDS) {
  let best = NO_MATCH;
  for (const index of fieldIndexes) {
    const tier = fieldMatchTier(record[index], phrase, queryTokens);
    if (tier === MATCH_PHRASE) return MATCH_PHRASE;
    if (tier !== NO_MATCH && (best === NO_MATCH || tier < best)) best = tier;
  }
  return best;
}

// ── Matched-span computation (for result highlighting) ───────
function buildNormMap(text) {
  let normStr = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const n = norm(text[i]);
    for (let j = 0; j < n.length; j++) { normStr += n[j]; map.push(i); }
  }
  return { normStr, map };
}

function findMatchSpans(text, forms, tokenOnly) {
  const src = String(text ?? '');
  if (!src) return [];
  const { normStr, map } = buildNormMap(src);
  const spans = [];
  for (const form of forms) {
    if (!form) continue;
    let idx = 0;
    while ((idx = normStr.indexOf(form, idx)) !== -1) {
      const end = idx + form.length;
      const okStart = idx === 0 || !WORD_CHAR.test(normStr[idx - 1]);
      const okEnd   = end >= normStr.length || !WORD_CHAR.test(normStr[end]);
      if (!tokenOnly || (okStart && okEnd)) {
        const oStart = map[idx];
        const oEnd   = (end - 1 < map.length) ? map[end - 1] + 1 : src.length;
        spans.push([oStart, oEnd]);
      }
      idx = end;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

// Spans to highlight in the Lak text of one row. Exact-phrase spans win; the
// token fallback highlights whole tokens only, mirroring how it matched.
function highlightSpansFor(lakText, { phrase, queryTokens, aliasForms }) {
  if (aliasForms && aliasForms.length) {
    const spans = findMatchSpans(lakText, aliasForms, true);
    if (spans.length) return spans;
    return phrase ? findMatchSpans(lakText, [phrase], false) : [];
  }
  if (!phrase) return [];
  const phraseSpans = findMatchSpans(lakText, [phrase], false);
  if (phraseSpans.length) return phraseSpans;
  if (queryTokens.length < 2) return [];
  return findMatchSpans(lakText, queryTokens, true);
}

module.exports = {
  MATCH_PHRASE, MATCH_TOKENS, NO_MATCH,
  QUERY_FIELDS, META_FIELDS,
  norm, normalizeQuery, tokenize, tokenHas,
  fieldMatchTier, recordMatchTier,
  findMatchSpans, highlightSpansFor,
};
