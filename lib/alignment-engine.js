'use strict';

// Hierarchical alignment for a private source-relationship candidate.
//
// The engine produces section → paragraph → sentence units for a pair of
// sources. Every unit records how it was produced, which signals supported it
// and how confident the deterministic match is. Cardinalities are explicit:
//
//   one_to_one       one unit on each side
//   one_to_many      one left unit covers several right units
//   many_to_one      several left units cover one right unit
//   unmatched_left   a left unit with no counterpart
//   unmatched_right  a right unit with no counterpart
//
// The alignment is a CANDIDATE. Nothing here is a validated translation: a
// unit only leaves 'source_import_unreviewed' when a human reviewer accepts,
// rejects or adjusts it, and the stored units are the thing they correct —
// the engine never silently regenerates over human work.
//
// The matcher is a deterministic dynamic program over unit lengths with a
// shared-number bonus. No model, no randomness, no clock.

const crypto = require('crypto');

const ENGINE_VERSION = 'alignment-engine-v1';

const MERGE_PENALTY = 0.3;
const SKIP_PENALTY = 0.9;
const SECTION_CHUNK = 10;
const SECTION_PREVIEW_CHARS = 1200;
const MAX_UNITS_PER_SIDE = 600;
const MAX_SENTENCES_PER_PARAGRAPH = 40;

const round4 = n => Math.round(n * 10000) / 10000;
const clamp01 = n => Math.max(0, Math.min(1, n));

function rowId(prefix, ...parts) {
  return prefix + crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function numbersOf(text) {
  return new Set(String(text).match(/\d{1,4}/g) || []);
}

function setJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) shared += 1;
  return round4(shared / (a.size + b.size - shared));
}

// Sentence splitting that keeps the terminator, tolerates Cyrillic text and
// never loses characters: the concatenation of the parts is the input.
function splitSentences(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  const parts = value.match(/[^.!?…]+[.!?…]+(?:["»)]+)?\s*|[^.!?…]+$/g) || [value];
  const sentences = parts.map(part => part.trim()).filter(Boolean);
  return sentences.length ? sentences.slice(0, MAX_SENTENCES_PER_PARAGRAPH) : [value];
}

function isHeading(text) {
  const line = String(text || '').trim();
  if (!line || line.length > 90) return false;
  if (/[.!?…]$/.test(line)) return false;
  return true;
}

// Group paragraphs into sections. Headings start a section; a document with
// no usable headings is chunked into fixed runs so the hierarchy still holds.
function detectSections(units) {
  const headingIndexes = [];
  units.forEach((unit, index) => { if (isHeading(unit)) headingIndexes.push(index); });
  const sections = [];
  if (headingIndexes.length >= 2) {
    const starts = headingIndexes[0] === 0 ? headingIndexes : [0].concat(headingIndexes);
    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : units.length;
      if (end > start) sections.push({ start, end, heading: isHeading(units[start]) ? units[start].trim() : null });
    });
  } else {
    for (let start = 0; start < units.length; start += SECTION_CHUNK) {
      const end = Math.min(start + SECTION_CHUNK, units.length);
      sections.push({ start, end, heading: null });
    }
  }
  return sections.length ? sections : [{ start: 0, end: units.length, heading: null }];
}

// ── The matcher ───────────────────────────────────────────────
function pairCost(leftText, rightText, ratio) {
  const left = Math.max(String(leftText).length, 1);
  const right = Math.max(String(rightText).length, 1);
  const expected = right * ratio;
  const lengthCost = Math.abs(left - expected) / Math.max(left, expected);
  const numberBonus = setJaccard(numbersOf(leftText), numbersOf(rightText)) * 0.5;
  return Math.max(0, lengthCost - numberBonus);
}

function signalsFor(leftText, rightText, cardinality) {
  const signals = [];
  if (cardinality === 'unmatched_left' || cardinality === 'unmatched_right') {
    signals.push({ signal: 'no_counterpart', detail: null });
    return signals;
  }
  const numbers = setJaccard(numbersOf(leftText), numbersOf(rightText));
  signals.push({ signal: 'length_ratio', detail: round4(
    Math.min(leftText.length, rightText.length) / Math.max(leftText.length || 1, rightText.length || 1)) });
  if (numbers > 0) signals.push({ signal: 'number_overlap', detail: numbers });
  if (cardinality === 'one_to_many' || cardinality === 'many_to_one') {
    signals.push({ signal: 'merged_units', detail: cardinality });
  }
  return signals;
}

// Deterministic DP over (1,1), (1,2), (2,1), (1,0) and (0,1) moves.
// Ties are broken in that fixed order, so the same input always yields the
// same alignment.
function alignSequences(leftItems, rightItems) {
  const left = leftItems.map(item => String(item == null ? '' : item));
  const right = rightItems.map(item => String(item == null ? '' : item));
  const totalLeft = left.reduce((sum, item) => sum + item.length, 0) || 1;
  const totalRight = right.reduce((sum, item) => sum + item.length, 0) || 1;
  const ratio = totalLeft / totalRight;

  const n = left.length;
  const m = right.length;
  const cost = [];
  const back = [];
  for (let i = 0; i <= n; i += 1) {
    cost.push(new Array(m + 1).fill(Infinity));
    back.push(new Array(m + 1).fill(null));
  }
  cost[0][0] = 0;
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= m; j += 1) {
      const base = cost[i][j];
      if (base === Infinity) continue;
      const moves = [];
      if (i < n && j < m) moves.push([1, 1, pairCost(left[i], right[j], ratio)]);
      if (i < n && j + 1 < m) {
        moves.push([1, 2, pairCost(left[i], right[j] + ' ' + right[j + 1], ratio) + MERGE_PENALTY]);
      }
      if (i + 1 < n && j < m) {
        moves.push([2, 1, pairCost(left[i] + ' ' + left[i + 1], right[j], ratio) + MERGE_PENALTY]);
      }
      if (i < n) moves.push([1, 0, SKIP_PENALTY]);
      if (j < m) moves.push([0, 1, SKIP_PENALTY]);
      for (const [di, dj, moveCost] of moves) {
        const next = base + moveCost;
        if (next < cost[i + di][j + dj] - 1e-12) {
          cost[i + di][j + dj] = next;
          back[i + di][j + dj] = { di, dj, cost: moveCost, fromI: i, fromJ: j };
        }
      }
    }
  }

  const steps = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const step = back[i][j];
    if (!step) break;
    steps.push({ ...step });
    i = step.fromI; j = step.fromJ;
  }
  steps.reverse();

  return steps.map(step => {
    const leftRefs = [];
    const rightRefs = [];
    for (let k = 0; k < step.di; k += 1) leftRefs.push(step.fromI + k);
    for (let k = 0; k < step.dj; k += 1) rightRefs.push(step.fromJ + k);
    let cardinality;
    if (step.di === 1 && step.dj === 1) cardinality = 'one_to_one';
    else if (step.di === 1 && step.dj > 1) cardinality = 'one_to_many';
    else if (step.di > 1 && step.dj === 1) cardinality = 'many_to_one';
    else if (step.dj === 0) cardinality = 'unmatched_left';
    else cardinality = 'unmatched_right';
    const leftText = leftRefs.map(index => left[index]).join('\n');
    const rightText = rightRefs.map(index => right[index]).join('\n');
    return {
      cardinality,
      left_refs: leftRefs,
      right_refs: rightRefs,
      left_text: leftText || null,
      right_text: rightText || null,
      confidence: round4(clamp01(1 - step.cost)),
      signals: signalsFor(leftText, rightText, cardinality),
    };
  });
}

// ── Hierarchy ─────────────────────────────────────────────────
// Sentence units are produced for matched paragraph pairs. An unmatched
// paragraph stays a paragraph-level unmatched unit: splitting text that has
// no counterpart into sentences would add rows without adding evidence.
function buildAlignment(leftUnits, rightUnits) {
  const left = (leftUnits || []).slice(0, MAX_UNITS_PER_SIDE).map(unit => String(unit || '').trim()).filter(Boolean);
  const right = (rightUnits || []).slice(0, MAX_UNITS_PER_SIDE).map(unit => String(unit || '').trim()).filter(Boolean);
  const leftSections = detectSections(left);
  const rightSections = detectSections(right);
  const sectionTextLeft = leftSections.map(section => left.slice(section.start, section.end).join('\n'));
  const sectionTextRight = rightSections.map(section => right.slice(section.start, section.end).join('\n'));

  const sectionSteps = alignSequences(sectionTextLeft, sectionTextRight);
  const nodes = [];
  const counters = { section: 0, paragraph: 0, sentence: 0 };

  for (const step of sectionSteps) {
    const leftParagraphs = [];
    const leftIndexes = [];
    for (const index of step.left_refs) {
      for (let p = leftSections[index].start; p < leftSections[index].end; p += 1) {
        leftParagraphs.push(left[p]); leftIndexes.push(p);
      }
    }
    const rightParagraphs = [];
    const rightIndexes = [];
    for (const index of step.right_refs) {
      for (let p = rightSections[index].start; p < rightSections[index].end; p += 1) {
        rightParagraphs.push(right[p]); rightIndexes.push(p);
      }
    }

    const sectionNode = {
      level: 'section',
      ordinal: counters.section++,
      cardinality: step.cardinality,
      left_refs: step.left_refs,
      right_refs: step.right_refs,
      left_text: step.left_text ? step.left_text.slice(0, SECTION_PREVIEW_CHARS) : null,
      right_text: step.right_text ? step.right_text.slice(0, SECTION_PREVIEW_CHARS) : null,
      method: 'length_ratio_dp',
      signals: step.signals,
      confidence: step.confidence,
      children: [],
    };

    const paragraphSteps = (leftParagraphs.length && rightParagraphs.length)
      ? alignSequences(leftParagraphs, rightParagraphs)
      : leftParagraphs.map((text, index) => ({
        cardinality: 'unmatched_left', left_refs: [index], right_refs: [],
        left_text: text, right_text: null, confidence: 0,
        signals: signalsFor(text, '', 'unmatched_left'),
      })).concat(rightParagraphs.map((text, index) => ({
        cardinality: 'unmatched_right', left_refs: [], right_refs: [index],
        left_text: null, right_text: text, confidence: 0,
        signals: signalsFor('', text, 'unmatched_right'),
      })));

    for (const paragraphStep of paragraphSteps) {
      const paragraphNode = {
        level: 'paragraph',
        ordinal: counters.paragraph++,
        cardinality: paragraphStep.cardinality,
        left_refs: paragraphStep.left_refs.map(index => leftIndexes[index]),
        right_refs: paragraphStep.right_refs.map(index => rightIndexes[index]),
        left_text: paragraphStep.left_text,
        right_text: paragraphStep.right_text,
        method: 'length_ratio_dp',
        signals: paragraphStep.signals,
        confidence: paragraphStep.confidence,
        children: [],
      };
      sectionNode.children.push(paragraphNode);

      if (paragraphStep.cardinality === 'unmatched_left' || paragraphStep.cardinality === 'unmatched_right') continue;
      const leftSentences = splitSentences(paragraphStep.left_text || '');
      const rightSentences = splitSentences(paragraphStep.right_text || '');
      if (!leftSentences.length || !rightSentences.length) continue;
      if (leftSentences.length === 1 && rightSentences.length === 1) {
        // A single sentence on both sides adds no information beyond the
        // paragraph unit itself, but the reviewer still needs a sentence row
        // to accept or reject at that level.
        paragraphNode.children.push({
          level: 'sentence',
          ordinal: counters.sentence++,
          cardinality: 'one_to_one',
          left_refs: [0], right_refs: [0],
          left_text: leftSentences[0], right_text: rightSentences[0],
          method: 'length_ratio_dp',
          signals: signalsFor(leftSentences[0], rightSentences[0], 'one_to_one'),
          confidence: paragraphNode.confidence,
          children: [],
        });
        continue;
      }
      for (const sentenceStep of alignSequences(leftSentences, rightSentences)) {
        paragraphNode.children.push({
          level: 'sentence',
          ordinal: counters.sentence++,
          cardinality: sentenceStep.cardinality,
          left_refs: sentenceStep.left_refs,
          right_refs: sentenceStep.right_refs,
          left_text: sentenceStep.left_text,
          right_text: sentenceStep.right_text,
          method: 'length_ratio_dp',
          signals: sentenceStep.signals,
          confidence: sentenceStep.confidence,
          children: [],
        });
      }
    }
    nodes.push(sectionNode);
  }

  const counts = { section: counters.section, paragraph: counters.paragraph, sentence: counters.sentence };
  const cardinalities = {};
  const walk = list => list.forEach(node => {
    cardinalities[node.cardinality] = (cardinalities[node.cardinality] || 0) + 1;
    walk(node.children);
  });
  walk(nodes);
  return { engine_version: ENGINE_VERSION, nodes, counts, cardinalities };
}

// ── Source text for a relationship side ───────────────────────
// Paragraph units come from the staged private candidates, ordered exactly as
// they were extracted. Nothing is read from the public corpus.
async function loadUnits(pool, sourceRef) {
  const sequence = parseInt(sourceRef, 10);
  if (!Number.isInteger(sequence)) return [];
  const result = await pool.query(
    `SELECT text FROM v13_candidates
      WHERE source_sequence = $1 AND text IS NOT NULL AND btrim(text) <> ''
      ORDER BY source_unit NULLS LAST, source_line NULLS LAST, candidate_ref
      LIMIT $2`,
    [sequence, MAX_UNITS_PER_SIDE]);
  return result.rows.map(row => String(row.text));
}

async function persistAlignment(pool, relationshipId, alignment) {
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    const insert = async (node, parentId) => {
      const id = rowId('pau_', relationshipId, node.level, String(node.ordinal));
      await client.query(
        `INSERT INTO private_alignment_units
           (id, relationship_id, level, parent_id, ordinal, cardinality, left_refs, right_refs,
            left_text, right_text, method, signals, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (relationship_id, level, ordinal) DO NOTHING`,
        [id, relationshipId, node.level, parentId, node.ordinal, node.cardinality,
         JSON.stringify(node.left_refs), JSON.stringify(node.right_refs),
         node.left_text, node.right_text, node.method,
         JSON.stringify(node.signals), node.confidence]);
      written += 1;
      for (const child of node.children) await insert(child, id);
    };
    for (const node of alignment.nodes) await insert(node, null);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return written;
}

// Generate and store the alignment for a relationship. Idempotent: when units
// already exist the stored alignment is returned untouched, because a
// reviewer's corrections live in those rows.
async function generateForRelationship(pool, relationship, options = {}) {
  const existing = await pool.query(
    `SELECT COUNT(*)::int AS units,
            COUNT(*) FILTER (WHERE review_state <> 'source_import_unreviewed' OR adjusted)::int AS reviewed
       FROM private_alignment_units WHERE relationship_id = $1`,
    [relationship.id]);
  const stored = existing.rows[0];
  if (stored.units > 0 && !options.regenerate) {
    return { generated: false, already_present: true, units: stored.units, reviewed: stored.reviewed };
  }
  if (stored.units > 0 && options.regenerate && stored.reviewed > 0) {
    const error = new Error('This alignment carries human decisions; regenerating it would discard them.');
    error.code = 'ALIGNMENT_HAS_DECISIONS';
    throw error;
  }

  const [leftUnits, rightUnits] = await Promise.all([
    loadUnits(pool, relationship.left_source_ref),
    loadUnits(pool, relationship.right_source_ref),
  ]);
  if (!leftUnits.length || !rightUnits.length) {
    return {
      generated: false, already_present: false, units: 0, reviewed: 0,
      reason: 'no_extracted_units',
      left_units: leftUnits.length, right_units: rightUnits.length,
    };
  }

  if (stored.units > 0) {
    await pool.query('DELETE FROM private_alignment_units WHERE relationship_id = $1', [relationship.id]);
  }
  const alignment = buildAlignment(leftUnits, rightUnits);
  const written = await persistAlignment(pool, relationship.id, alignment);
  return {
    generated: true,
    already_present: false,
    units: written,
    reviewed: 0,
    counts: alignment.counts,
    cardinalities: alignment.cardinalities,
    engine_version: alignment.engine_version,
    left_units: leftUnits.length,
    right_units: rightUnits.length,
  };
}

module.exports = {
  ENGINE_VERSION,
  splitSentences,
  detectSections,
  alignSequences,
  buildAlignment,
  loadUnits,
  persistAlignment,
  generateForRelationship,
};
