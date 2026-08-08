'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { cleanDecision } = require('../lib/morphology-review');

assert.deepStrictEqual(cleanDecision({ verdict: 'accept' }), { verdict: 'accept', correctedLemma: null, correctedTag: null });
assert.deepStrictEqual(cleanDecision({ verdict: 'correct', corrected_lemma: '  ДакI ', corrected_tag: ' N-GEN ' }),
  { verdict: 'correct', correctedLemma: 'ДакI', correctedTag: 'N-GEN' });
assert.throws(() => cleanDecision({ verdict: 'correct' }), /corrected lemma/i);
assert.throws(() => cleanDecision({ verdict: 'expert_truth' }), /verdict must be one of/i);

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260807_001_corpus_v2.sql'), 'utf8');
assert(migration.includes("evidence_class TEXT NOT NULL CHECK (evidence_class = 'source_annotation')"));
assert(migration.includes('public_search_eligible BOOLEAN NOT NULL DEFAULT FALSE CHECK (public_search_eligible = FALSE)'));
assert(migration.includes('morphology_proposal_occurrences'));
assert(migration.includes('corpus_wordform_lemma_relations'));
assert(migration.includes("'lemma_analysis'"));
const review = fs.readFileSync(path.join(__dirname, '..', 'lib', 'morphology-review.js'), 'utf8');
assert(!review.includes('INSERT INTO corpus_token_analyses'), 'proposal review must never create token analyses');
console.log('structured morphology decisions and no type-to-token propagation checks passed');
