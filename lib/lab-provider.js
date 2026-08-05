'use strict';

// Evidence-only translation provider for the Translation Lab.
//
// There is NO generative model key in this environment, and the provider is
// designed so that even if one were added it could not silently invent target
// text. The provider takes retrieved corpus evidence plus reviewed translation
// memory and:
//   1. classifies how well the evidence answers the request, and
//   2. proposes a *suggested target* ONLY when that target is a verbatim string
//      drawn from a real record (reviewed pair, dictionary sense, or an
//      attested public example that carries both sides).
// When there is no such evidence, suggested_target is null and the answer
// abstains explicitly. The provider never concatenates, paraphrases, or
// generates novel Lak/Russian text, and never claims a translation was
// validated or learned when the evidence is only a candidate match.

const memory = require('./lab-memory');

const PROVIDER = 'evidence-only';

// What may supply a translation target is decided in ONE place
// (lib/lab-memory.js): monolingual usage can never propose one.
const isTargetEvidence = e => memory.canPropose(e);
const isGold = e => memory.isGoldEvidence(e);

// Classification of a retrieval result:
//   reviewed_memory   — an expert-approved, rights-eligible pair answers it
//   exact_dictionary  — a validated (non-OCR) translation source (alias or
//                        lexicon dictionary sense) that yields a target
//   corpus_supported  — weaker translation evidence (e.g. OCR dictionary sense)
//   attested_usage    — only monolingual corpus examples exist (no target →
//                        the lab abstains but still returns them as usage)
//   no_evidence       — nothing retrieved at all
function classify(evidence) {
  if (!evidence || !evidence.length) {
    return { classification: 'no_evidence', confidence: 0 };
  }
  // Reviewed translation memory: the only evidence that is more than a
  // candidate match.
  if (evidence.some(isGold)) {
    return { classification: 'reviewed_memory', confidence: 0.97 };
  }
  // Strong translation evidence: a validated, non-OCR alias / dictionary sense.
  const strongTarget = evidence.find(
    e => isTargetEvidence(e) && e.validated && !e.is_ocr);
  if (strongTarget) {
    return { classification: 'exact_dictionary', confidence: 0.9 };
  }
  // Any translation evidence at all (e.g. an OCR dictionary sense).
  const anyTarget = evidence.find(isTargetEvidence);
  if (anyTarget) {
    return { classification: 'corpus_supported', confidence: anyTarget.is_ocr ? 0.3 : 0.6 };
  }
  // Only monolingual usage — no translation can be drawn from it.
  return { classification: 'attested_usage', confidence: 0 };
}

// Pick the verbatim suggested target from the highest-ranked TRANSLATION
// evidence only. For ru2lak the target is a Lak string; for lak2ru a Russian
// gloss. Monolingual usage rows are skipped entirely — they never supply a
// target. The chosen string is ALWAYS a field of a real record.
function pickSuggested(direction, evidence) {
  for (const e of evidence) {
    if (!isTargetEvidence(e)) continue;
    const candidate = direction === 'lak2ru' ? e.gloss : e.lak_text;
    if (candidate && candidate.trim()) {
      return { text: candidate.trim(), from: e };
    }
  }
  return null;
}

function buildRationale(direction, classification, suggested, evidence) {
  const dirLabel = direction === 'lak2ru' ? 'Lak → Russian' : 'Russian → Lak';
  if (classification === 'no_evidence') {
    return `No ${dirLabel} evidence was found in the corpus or in reviewed ` +
           `translation memory. The lab does not invent a translation; a human ` +
           `must supply and verify one.`;
  }
  if (classification === 'attested_usage' || !suggested) {
    const n = evidence.filter(e => !memory.canPropose(e)).length;
    return `Only attested monolingual usage was found (${n} example` +
           `${n === 1 ? '' : 's'}) — no reviewed pair, dictionary or alias entry ` +
           `provides a translation. Monolingual examples are shown as usage ` +
           `evidence and can never prove a translation. The lab abstains; a ` +
           `human must supply the target.`;
  }
  if (classification === 'reviewed_memory') {
    const ref = suggested.from ? suggested.from.record_ref : '(unknown)';
    return `Served from reviewed translation memory: an expert-approved, ` +
           `rights-eligible parallel pair (${ref}) answers this request ` +
           `verbatim. This is a reviewed pair, not a generated translation.`;
  }
  const src = suggested.from ? suggested.from.source : '(unknown)';
  const ocr = suggested.from && suggested.from.is_ocr;
  const isAlias = suggested.from && suggested.from.evidence_type === 'alias';
  const base = `Suggested target is quoted verbatim from ` +
               `${isAlias ? 'the corpus alias dictionary' : `a dictionary record (source: ${src})`}` +
               `${ocr ? ', historical OCR' : ''}. ` +
               `It is a candidate match against existing metadata — not a ` +
               `validated translation and not model output — please verify ` +
               `before saving.`;
  if (classification === 'exact_dictionary')
    return `Exact validated dictionary/alias sense found. ` + base;
  return `Weaker (e.g. historical-OCR) dictionary evidence found. ` + base;
}

// Collect ranked verbatim alternative TARGETS (distinct), each attributed to a
// real record. Monolingual usage rows are excluded — they are usage, not
// translations. Never invents or merges text.
function collectAlternatives(direction, evidence, chosenText, limit = 6) {
  const seen = new Set(chosenText ? [chosenText] : []);
  const out = [];
  for (const e of evidence) {
    if (!isTargetEvidence(e)) continue;
    const candidate = direction === 'lak2ru' ? e.gloss : e.lak_text;
    const t = candidate && candidate.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({
      target: t, source: e.source, variety: e.variety,
      is_ocr: e.is_ocr, validated: e.validated,
      evidence_type: e.evidence_type,
      evidence_class: memory.classOf(e),
      review_state: e.review_state || null,
      gold: isGold(e),
      record_ref: e.record_ref, score: e.score,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// A coverage summary describing how well the evidence answers the request,
// distinguishing reviewed memory and translation evidence from monolingual usage.
function buildCoverage(evidence, classification) {
  const targetEv = evidence.filter(isTargetEvidence);
  const goldEv = evidence.filter(isGold);
  const validatedTarget = targetEv.filter(e => e.validated && !e.is_ocr).length;
  const ocr = evidence.filter(e => e.is_ocr).length;
  const dict = evidence.filter(e => memory.classOf(e) === 'direct_dictionary').length;
  const alias = evidence.filter(e => e.evidence_type === 'alias').length;
  const usage = evidence.filter(e => memory.classOf(e) === 'usage_support_only').length;
  const attested = evidence.filter(e => memory.classOf(e) === 'attested_public_example').length;
  return {
    total_evidence: evidence.length,
    reviewed_memory_evidence: goldEv.length,
    translation_evidence: targetEv.length,
    validated_target_evidence: validatedTarget,
    alias_entries: alias,
    dictionary_senses: dict,
    attested_public_examples: attested,
    attested_usage_examples: usage,
    ocr_only_evidence: ocr,
    has_gold_evidence: goldEv.length > 0,
    has_translation_target: targetEv.length > 0,
    classification,
  };
}

// Honest statement of what the answer is, and what it is NOT. The lab never
// claims a validated translation, or that a model learned anything, when the
// evidence is only a candidate match.
function buildClaim(classification, gold) {
  if (gold) {
    return {
      claim: 'reviewed_translation',
      statement: 'Reviewed translation: an expert-approved, rights-eligible pair ' +
        'in translation memory answers this request.',
      validated: true,
      model_learning: false,
    };
  }
  if (classification === 'no_evidence' || classification === 'attested_usage') {
    return {
      claim: 'no_translation',
      statement: 'No translation is claimed. The lab abstains.',
      validated: false,
      model_learning: false,
    };
  }
  return {
    claim: 'candidate_match',
    statement: 'Candidate match from corpus evidence — quoted verbatim from an ' +
      'existing record. It is NOT a validated translation, no model produced it, ' +
      'and no model learned from it.',
    validated: false,
    model_learning: false,
  };
}

// Produce a full evidence-only proposal object (not yet persisted).
//   retrieval: { evidence, senses, ocrSenses, aliases, gold_count, isolation }
function propose(direction, retrieval) {
  const evidence = (retrieval && retrieval.evidence) || [];
  const { classification, confidence } = classify(evidence);

  let suggested = null;
  if (classification !== 'no_evidence') {
    suggested = pickSuggested(direction, evidence);
  }

  const suggestedText = suggested ? suggested.text : null;
  const alternatives = collectAlternatives(direction, evidence, suggestedText);
  const coverage = buildCoverage(evidence, classification);
  const goldUsed = !!(suggested && isGold(suggested.from));

  // Abstain when there is no target the lab can honestly quote. The lab never
  // fabricates a translation to fill the gap.
  const abstained = classification === 'no_evidence' || !suggestedText;

  // Certainty is explicit on every answer:
  //   reviewed  — expert-approved pair
  //   candidate — quoted from a dictionary/attested record, unverified
  //   usage_only / none — nothing that can prove a translation
  const certainty = goldUsed ? 'reviewed'
    : (!abstained ? 'candidate'
      : (classification === 'attested_usage' ? 'usage_only' : 'none'));

  const usageOnly = classification === 'attested_usage';
  const abstain = {
    abstained,
    reason: abstained
      ? (usageOnly ? 'usage_only_no_translation' : 'no_reliable_target')
      : null,
    detail: abstained
      ? (usageOnly
        ? 'Only monolingual usage was found. Monolingual examples support ' +
          'context but can never prove a translation, so the lab abstains.'
        : 'No evidence yields a verbatim target; a human must supply one.')
      : null,
  };

  // "unknowns" surfaces what the lab could NOT resolve, so a human knows what
  // still needs attention. It never contains invented target text.
  const unknowns = [];
  if (abstained) {
    unknowns.push({ reason: abstain.reason, detail: abstain.detail });
  } else if (suggested && suggested.from && suggested.from.is_ocr) {
    unknowns.push({
      reason: 'ocr_unreliable',
      detail: 'Only weak or historical-OCR dictionary evidence was found; verify carefully.',
    });
  }
  if (!abstained && !goldUsed) {
    unknowns.push({
      reason: 'not_reviewed',
      detail: 'No expert-approved pair covers this request; the suggestion is a ' +
              'candidate match awaiting review.',
    });
  }

  const from = suggested ? suggested.from : null;
  const evidenceClass = from ? memory.classOf(from) : null;

  return {
    provider: PROVIDER,
    evidence_only: true,
    mode: 'evidence-only',
    model_version: 'none',
    prompt_version: 'evidence-only-v1',
    fine_tuned: false,
    classification,
    confidence,
    abstained,
    abstain,
    certainty,
    // Verbatim strings when evidence exists, otherwise null. The lab never
    // returns invented target text. literal == the highest-ranked exact
    // quotation; natural == same verbatim string (the lab cannot rephrase, so
    // there is no separate "natural" generation — a human writes that).
    suggested_target: suggestedText,
    literal_target: suggestedText,
    natural_target: null,
    suggested_from: from,
    // Evidence type / review state / provenance of the answer itself.
    evidence_type: from ? from.evidence_type : null,
    evidence_class: evidenceClass,
    review_state: from ? (from.review_state || null) : null,
    gold: goldUsed,
    provenance: from ? {
      source: from.source || null,
      record_ref: from.record_ref || null,
      record_url: from.record_url || null,
      variety: from.variety || null,
      is_ocr: !!from.is_ocr,
      rights_status: from.rights_status || null,
      approved_by: from.approved_by || null,
      approved_at: from.approved_at || null,
    } : null,
    claim: buildClaim(classification, goldUsed),
    alternatives,
    unknowns,
    coverage,
    isolation: (retrieval && retrieval.isolation) || null,
    rationale: buildRationale(direction, classification, suggested, evidence),
    evidence,
    senses: (retrieval && retrieval.senses) || [],
    ocrSenses: (retrieval && retrieval.ocrSenses) || [],
    aliases: (retrieval && retrieval.aliases) || [],
    // Explicit disclaimer surfaced to callers/UI.
    disclaimer: 'Evidence-only: no generative model is configured and no model ' +
                'is trained or fine-tuned. Suggestions are quotations from ' +
                'reviewed translation memory or the corpus, ranked with reviewed ' +
                'pairs above modern validated sources above historical OCR. ' +
                'Anything that is not reviewed translation memory is a candidate ' +
                'match, not a validated translation.',
  };
}

module.exports = {
  propose, classify, pickSuggested, collectAlternatives, buildCoverage,
  buildClaim, PROVIDER,
};
