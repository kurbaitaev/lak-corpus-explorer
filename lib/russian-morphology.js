'use strict';

// Conservative Russian inflection matching for dictionary lookup. Exact
// spellings always win; stemming is used only as a fallback so forms such as
// "слово", "слова", "слову" and "словами" reach the same dictionary entry.

const RUSSIAN = /[а-яё]/i;
const TOKEN = /[а-яё]+/gi;

function stemRussian(input) {
  let word = String(input || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
  if (!RUSSIAN.test(word) || word.length < 4) return word;

  // Russian Porter stemmer. It removes grammatical endings, not lexical
  // material, and is deterministic enough for explainable search expansion.
  const rv = word.search(/[аеиоуыэюя]/);
  if (rv < 0 || rv === word.length - 1) return word;
  const prefix = word.slice(0, rv + 1);
  let tail = word.slice(rv + 1);

  function removeAfterAorYa(value, pattern) {
    const match = value.match(pattern);
    if (!match) return value;
    const start = value.length - match[0].length;
    return /[ая]$/u.test(value.slice(0, start)) ? value.slice(0, start) : value;
  }

  const original = tail;
  tail = tail.replace(/(ившись|ывшись|ивши|ывши|ив|ыв)$/u, '');
  if (tail === original) {
    tail = removeAfterAorYa(tail, /(вшись|вши|в)$/u);
  }

  if (tail === original) {
    tail = tail.replace(/(ся|сь)$/u, '');
    const beforeAdjective = tail;
    tail = tail.replace(/(ими|ыми|его|ого|ему|ому|ее|ие|ые|ое|ей|ий|ый|ой|ем|им|ым|ом|их|ых|ую|юю|ая|яя|ою|ею)$/u, '');
    if (tail !== beforeAdjective) {
      tail = tail.replace(/(ем|нн|вш|ющ|щ)$/u, '');
      tail = tail.replace(/(ивш|ывш|ующ)$/u, '');
    } else {
      const beforeVerb = tail;
      tail = tail.replace(/(ила|ыла|ена|ейте|уйте|ите|или|ыли|ей|уй|ил|ыл|им|ым|ен|ило|ыло|ено|ят|ует|уют|ит|ыт|ены|ить|ыть|ишь|ую|ю)$/u, '');
      if (tail === beforeVerb) {
        tail = removeAfterAorYa(tail, /(ла|на|ете|йте|ли|й|л|ем|н|ло|но|ет|ны|ть|ешь|нно)$/u);
      }
      if (tail === beforeVerb) {
        tail = tail.replace(/(иями|ями|ами|ией|иям|ием|иях|ию|ью|ия|ья|ев|ов|ие|ье|еи|ии|ей|ой|ий|й|иям|ям|ием|ем|ам|ом|о|у|ах|иях|ях|ы|ь|ию|ью|ю|ия|ья|я|а|евы|овы|е|и)$/u, '');
      }
    }
  }

  tail = tail.replace(/и$/u, '');
  let result = prefix + tail;
  if (/ость$/u.test(result)) result = result.replace(/ость$/u, '');
  result = result.replace(/ейше$/u, '').replace(/нн$/u, 'н').replace(/ь$/u, '');
  return result || word;
}

function russianTokens(value) {
  return (String(value || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').match(TOKEN) || []);
}

function stemKey(value) {
  const tokens = russianTokens(value);
  if (!tokens.length) return '';
  return tokens.map(stemRussian).join(' ');
}

function containsRussianForm(text, query) {
  const wanted = russianTokens(query).map(stemRussian);
  if (!wanted.length) return false;
  const actual = russianTokens(text).map(stemRussian);
  if (wanted.length === 1) return actual.includes(wanted[0]);
  for (let i = 0; i <= actual.length - wanted.length; i += 1) {
    if (wanted.every((stem, j) => actual[i + j] === stem)) return true;
  }
  return false;
}

function createAliasResolver(aliasMaps, normalize) {
  const maps = aliasMaps.filter(Boolean);
  const byStem = new Map();
  for (const map of maps) {
    for (const rawKey of Object.keys(map)) {
      const key = normalize(rawKey);
      const stem = stemKey(key);
      if (!stem) continue;
      if (!byStem.has(stem)) byStem.set(stem, []);
      byStem.get(stem).push({ key, aliases: map[rawKey] || [] });
    }
  }

  return function resolve(normalizedQuery) {
    for (const map of maps) {
      if (Array.isArray(map[normalizedQuery]) && map[normalizedQuery].length) {
        return { aliases: map[normalizedQuery], matchedQuery: normalizedQuery, match: 'exact' };
      }
    }
    const stem = stemKey(normalizedQuery);
    if (!stem) return { aliases: [], matchedQuery: null, match: 'none' };
    const candidates = byStem.get(stem) || [];
    const aliases = [];
    const keys = [];
    for (const candidate of candidates) {
      keys.push(candidate.key);
      for (const alias of candidate.aliases) if (!aliases.includes(alias)) aliases.push(alias);
    }
    return {
      aliases,
      matchedQuery: keys.length ? keys[0] : null,
      match: aliases.length ? 'inflection' : 'none',
    };
  };
}

module.exports = { stemRussian, stemKey, containsRussianForm, createAliasResolver };
