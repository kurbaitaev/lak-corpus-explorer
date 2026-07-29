'use strict';

// Evidence-only translation provider for the Translation Lab.
//
// There is NO generative model key in this environment, and the provider is
// designed so that even if one were added it could not silently invent target
// text. The provider takes retrieved corpus evidence and:
//   1. classifies how well the evidence answers the request, and
//   2. proposes a *suggested target* ONLY when that target is a verbatim string
//      drawn from a real corpus record (dictionary sense or corpus sentence).
// When there is no such evidence, suggested_target is null and the
// classification is 'no_evidence'. The provider never concatenates,
// paraphrases, or generates novel Lak/Russian text.

const PROVIDER = 'evidence-only';

// ONLY these evidence classes may supply a translation target. A
// corpus_example is attested monolingual usage and can NEVER be a translation.
const TARGET_EVIDENCE = new Set(['dictionary_sense', 'alias', 'validated_parallel']);
function isTargetEvidence(e) {
  return e && TARGET_EVIDENCE.has(e.evidence_type);
}

// Classification of a retrieval result:
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
  // Only monolingual corpus usage — no translation can be drawn from it.
  return { classification: 'attested_usage', confidence: 0 };
}

// Pick the verbatim suggested target from the highest-ranked TRANSLATION
// evidence only. For ru2lak the target is a Lak string; for lak2ru a Russian
// gloss. corpus_example rows are skipped entirely — they never supply a target.
// The chosen string is ALWAYS a field of real dictionary/alias metadata.
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
    return `No ${dirLabel} evidence was found in the corpus. The lab does not ` +
           `invent a translation; a human must supply and verify one.`;
  }
  if (classification === 'attested_usage' || !suggested) {
    const n = evidence.filter(e => e.evidence_type === 'corpus_example').length;
    return `Only attested monolingual usage was found (${n} corpus example` +
           `${n === 1 ? '' : 's'}) — no dictionary or alias entry provides a ` +
           `translation. Corpus sentences are shown as usage evidence, not as a ` +
           `translation. The lab abstains; a human must supply the target.`;
  }
  const src = suggested.from ? suggested.from.source : '(unknown)';
  const ocr = suggested.from && suggested.from.is_ocr;
  const isAlias = suggested.from && suggested.from.evidence_type === 'alias';
  const base = `Suggested target is quoted verbatim from ` +
               `${isAlias ? 'the corpus alias dictionary' : `a dictionary record (source: ${src})`}` +
               `${ocr ? ', historical OCR' : ''}. ` +
               `It is existing dictionary metadata, not a generated translation — ` +
               `please verify before saving.`;
  if (classification === 'exact_dictionary')
    return `Exact validated dictionary/alias sense found. ` + base;
  return `Weaker (e.g. historical-OCR) dictionary evidence found. ` + base;
}

// Collect ranked verbatim alternative TARGETS (distinct), each attributed to a
// real dictionary/alias record. corpus_example rows are excluded — they are
// usage, not translations. Never invents or merges text.
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
      evidence_type: e.evidence_type, record_ref: e.record_ref, score: e.score,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// A coverage summary describing how well the corpus answers the request,
// distinguishing translation evidence from attested monolingual usage.
function buildCoverage(evidence, classification) {
  const targetEv = evidence.filter(isTargetEvidence);
  const validatedTarget = targetEv.filter(e => e.validated && !e.is_ocr).length;
  const ocr = evidence.filter(e => e.is_ocr).length;
  const dict = evidence.filter(e => e.evidence_type === 'dictionary_sense').length;
  const alias = evidence.filter(e => e.evidence_type === 'alias').length;
  const usage = evidence.filter(e => e.evidence_type === 'corpus_example').length;
  return {
    total_evidence: evidence.length,
    translation_evidence: targetEv.length,
    validated_target_evidence: validatedTarget,
    alias_entries: alias,
    dictionary_senses: dict,
    attested_usage_examples: usage,
    ocr_only_evidence: ocr,
    has_translation_target: targetEv.length > 0,
    classification,
  };
}

// Produce a full evidence-only proposal object (not yet persisted).
//   retrieval: { evidence, senses, ocrSenses, aliases }
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

  // Abstain when there is no corpus target the lab can honestly quote. The lab
  // never fabricates a translation to fill the gap.
  const abstained = classification === 'no_evidence' || !suggestedText;

  // "unknowns" surfaces what the lab could NOT resolve, so a human knows what
  // still needs attention. It never contains invented target text.
  const unknowns = [];
  if (abstained) {
    const usageOnly = classification === 'attested_usage';
    unknowns.push({
      reason: usageOnly ? 'usage_only_no_translation' : 'no_reliable_target',
      detail: usageOnly
        ? 'Only monolingual corpus usage was found; no dictionary/alias entry ' +
          'provides a translation. A human must supply the target.'
        : 'No corpus evidence yields a verbatim target; a human must supply one.',
    });
  } else if (suggested && suggested.from && suggested.from.is_ocr) {
    unknowns.push({
      reason: 'ocr_unreliable',
      detail: 'Only weak or historical-OCR dictionary evidence was found; verify carefully.',
    });
  }

  return {
    provider: PROVIDER,
    evidence_only: true,
    mode: 'evidence-only',
    model_version: 'none',
    prompt_version: 'evidence-only-v1',
    classification,
    confidence,
    abstained,
    // Verbatim corpus strings when evidence exists, otherwise null. The lab
    // never returns invented target text. literal == the highest-ranked exact
    // quotation; natural == same verbatim string (the lab cannot rephrase, so
    // there is no separate "natural" generation — a human writes that).
    suggested_target: suggestedText,
    literal_target: suggestedText,
    natural_target: null,
    suggested_from: suggested ? suggested.from : null,
    alternatives,
    unknowns,
    coverage,
    rationale: buildRationale(direction, classification, suggested, evidence),
    evidence,
    senses: (retrieval && retrieval.senses) || [],
    ocrSenses: (retrieval && retrieval.ocrSenses) || [],
    aliases: (retrieval && retrieval.aliases) || [],
    // Explicit disclaimer surfaced to callers/UI.
    disclaimer: 'Evidence-only: no generative model is configured. Suggestions ' +
                'are quotations from the corpus, ranked with modern validated ' +
                'sources above historical OCR. A human must confirm any pair.',
  };
}

module.exports = { propose, classify, pickSuggested, collectAlternatives, buildCoverage, PROVIDER };
