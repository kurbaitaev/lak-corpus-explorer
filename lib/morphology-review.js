'use strict';

const { normalizeLak, lemmaKeyId, NORMALIZATION_VERSION } = require('./corpus-v2');

const VERDICTS = ['accept', 'reject', 'uncertain', 'correct'];

function cleanDecision(body) {
  const verdict = String(body?.verdict || body?.decision || '').trim();
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of: ${VERDICTS.join(', ')}`);
  const correctedLemma = body?.corrected_lemma == null ? null : String(body.corrected_lemma).normalize('NFC').trim().slice(0, 200);
  const correctedTag = body?.corrected_tag == null ? null : String(body.corrected_tag).trim().slice(0, 100);
  if (verdict === 'correct' && !correctedLemma) throw new Error('A corrected lemma is required when verdict is correct.');
  return { verdict, correctedLemma: correctedLemma || null, correctedTag: correctedTag || null };
}

async function applyCommunityConsensus(pool, task, value) {
  if (task.subject_type !== 'morphology_proposal' || !task.subject_id) return;
  const states = { accept: 'community_supported', reject: 'rejected', uncertain: 'uncertain' };
  const state = states[value];
  if (!state) return; // Corrections require structured expert review, not a free-text majority.
  const proposal = (await pool.query('SELECT proposal_version FROM morphology_proposals WHERE id=$1', [task.subject_id])).rows[0];
  if (!proposal) return;
  await pool.query('UPDATE morphology_proposals SET state=$2 WHERE id=$1', [task.subject_id, state]);
  await pool.query(
    `INSERT INTO morphology_decisions
      (proposal_id,validation_task_id,proposal_version,task_version,verdict,contributor_role,evidence_note)
     VALUES ($1,$2,$3,$4,$5,'community_consensus',$6)`,
    [task.subject_id, task.id, proposal.proposal_version, task.version + 1, value,
     'Weighted community consensus; this does not create token-level analyses.']);
}

async function applyExpertDecision(pool, { proposalId, task, identity, body }) {
  const decision = cleanDecision(body);
  const proposal = (await pool.query(
    `SELECT p.*, w.normalized_form AS wordform, l.normalized_form AS proposed_lemma
       FROM morphology_proposals p JOIN corpus_wordforms w ON w.id=p.wordform_id
       JOIN corpus_lemma_keys l ON l.id=p.proposed_lemma_key_id WHERE p.id=$1`, [proposalId])).rows[0];
  if (!proposal) return null;
  const state = decision.verdict === 'accept' ? 'expert_accepted'
    : decision.verdict === 'correct' ? 'corrected'
      : decision.verdict === 'reject' ? 'rejected' : 'uncertain';
  let acceptedLemmaId = null;
  if (decision.verdict === 'accept') acceptedLemmaId = proposal.proposed_lemma_key_id;
  if (decision.verdict === 'correct') {
    const normalized = normalizeLak(decision.correctedLemma);
    acceptedLemmaId = lemmaKeyId(normalized);
    await pool.query(
      `INSERT INTO corpus_lemma_keys (id,language_code,normalized_form,normalization_version,display_form)
       VALUES ($1,'lbe',$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [acceptedLemmaId, normalized, NORMALIZATION_VERSION, decision.correctedLemma]);
  }
  await pool.query('UPDATE morphology_proposals SET state=$2, proposal_version=proposal_version+1 WHERE id=$1', [proposalId, state]);
  await pool.query(
    `INSERT INTO morphology_decisions
      (proposal_id,validation_task_id,proposal_version,task_version,verdict,corrected_lemma,corrected_tag,contributor_id,contributor_role,evidence_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [proposalId, task?.id || null, proposal.proposal_version, task?.version || null,
     decision.verdict, decision.correctedLemma, decision.correctedTag,
     identity.type === 'account' ? identity.id : null, identity.role,
     body?.evidence_note ? String(body.evidence_note).slice(0, 1000) : null]);
  if (acceptedLemmaId) {
    await pool.query(
      `INSERT INTO corpus_wordform_lemma_relations
        (wordform_id,lemma_key_id,basis,proposal_id,review_status,created_by)
       VALUES ($1,$2,'expert_proposal_decision',$3,'expert_verified',$4)
       ON CONFLICT (wordform_id,lemma_key_id,basis) DO NOTHING`,
      [proposal.wordform_id, acceptedLemmaId, proposalId, identity.id || identity.name]);
  }
  return { state, ...decision };
}

module.exports = { VERDICTS, cleanDecision, applyCommunityConsensus, applyExpertDecision };
