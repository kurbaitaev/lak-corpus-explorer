'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const authState = document.getElementById('lab-auth-state');
  const labApp = document.getElementById('lab-app');
  const identity = await window.fetchIdentity();
  labApp.style.display = 'block';
  authState.style.display = identity.account ? 'none' : 'block';

  let proposal = null;
  const toast = (message, type = 'ok') => {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  };
  const api = async (url, options) => {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  };

  try {
    const p = await api('/api/lab/provider');
    document.getElementById('provider-info').textContent =
      `${p.provider} · model ${p.model_version} · prompt ${p.prompt_version}`;
  } catch {
    document.getElementById('provider-info').textContent = 'Evidence-only mode';
  }

  const workbench = document.getElementById('lab-workbench-view');
  const history = document.getElementById('lab-history-view');
  const workBtn = document.getElementById('btn-view-workbench');
  const historyBtn = document.getElementById('btn-view-history');
  function showView(name) {
    const showingHistory = name === 'history';
    workbench.style.display = showingHistory ? 'none' : 'block';
    history.style.display = showingHistory ? 'block' : 'none';
    workBtn.classList.toggle('btn-primary', !showingHistory);
    historyBtn.classList.toggle('btn-primary', showingHistory);
    if (showingHistory) loadHistory();
  }
  workBtn.addEventListener('click', () => showView('workbench'));
  historyBtn.addEventListener('click', () => {
    if (!identity.account) return toast('Log in to view saved translation pairs.', 'warn');
    showView('history');
  });

  document.getElementById('propose-form').addEventListener('submit', async event => {
    event.preventDefault();
    const sourceText = document.getElementById('lab-source-text').value.trim();
    const direction = document.getElementById('lab-direction').value;
    if (!sourceText) return;
    const button = document.getElementById('btn-propose');
    button.disabled = true;
    document.getElementById('lab-propose-loading').style.display = 'block';
    document.getElementById('lab-proposal-area').style.display = 'none';
    try {
      proposal = await api('/api/lab/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_text: sourceText, direction }),
      });
      document.getElementById('lab-literal-target').value = proposal.literal_target || '';
      document.getElementById('lab-natural-target').value = proposal.natural_target || '';
      document.getElementById('lab-abstained').checked = !!proposal.abstained;
      const coverage = proposal.coverage || {};
      document.getElementById('lab-proposal-meta').innerHTML = `
        <span class="lab-stat-badge">${esc(proposal.mode || 'evidence-only')}</span>
        <span class="lab-stat-badge">Confidence ${Math.round((proposal.confidence || 0) * 100)}%</span>
        <span class="lab-stat-badge">${coverage.total_evidence || 0} evidence records</span>
        ${proposal.abstained ? '<span class="lab-stat-badge low-conf">Insufficient evidence — abstained</span>' : ''}`;
      const alternatives = proposal.alternatives || [];
      const alt = document.getElementById('lab-proposal-alternatives');
      alt.style.display = alternatives.length || (proposal.unknowns || []).length ? 'block' : 'none';
      alt.innerHTML = `<strong>Alternatives and unknowns</strong>
        <p>${alternatives.length ? alternatives.map(item => esc(item.target || item)).join(' · ') : 'No supported alternative found.'}</p>
        ${(proposal.unknowns || []).length ? `<p><b>Unknown:</b> ${proposal.unknowns.map(item => esc(item.detail || item.reason || item)).join(', ')}</p>` : ''}`;
      const evidence = proposal.evidence || [];
      const ev = document.getElementById('lab-proposal-evidence');
      ev.style.display = 'block';
      ev.innerHTML = `<strong>Retrieved evidence</strong>${evidence.length ? evidence.map(item => `
        <article class="lab-evidence-item">
          <div><span class="quality-badge ${item.validated ? 'q-approved' : item.is_ocr ? 'q-ocr' : 'q-unreviewed'}">${esc(item.evidence_type.replace(/_/g, ' '))}</span>
          <b>${esc(item.lak_text || item.gloss)}</b></div>
          <p>${esc(item.gloss)} · ${esc(item.source)} · ${esc(item.variety || 'unspecified')} · ${esc(item.record_ref)}</p>
        </article>`).join('') : '<p>No authorized evidence found. The system has not invented a translation.</p>'}`;
      document.getElementById('lab-evidence-ids').value =
        evidence.map(item => item.record_ref).filter(Boolean).join(', ');
      document.getElementById('lab-proposal-area').style.display = 'block';
      document.getElementById('lab-literal-target').focus();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
      document.getElementById('lab-propose-loading').style.display = 'none';
    }
  });

  document.getElementById('btn-clear-propose').addEventListener('click', () => {
    proposal = null;
    document.getElementById('lab-proposal-area').style.display = 'none';
    document.getElementById('lab-source-text').value = '';
    document.getElementById('save-pair-form').reset();
  });

  document.getElementById('save-pair-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!identity.account) return toast('Log in to save a translation pair.', 'warn');
    const literal = document.getElementById('lab-literal-target').value.trim();
    const natural = document.getElementById('lab-natural-target').value.trim();
    const abstained = document.getElementById('lab-abstained').checked;
    if (!abstained && !literal && !natural) return toast('Enter a human translation or abstain.', 'warn');
    const payload = {
      source_text: document.getElementById('lab-source-text').value.trim(),
      direction: document.getElementById('lab-direction').value,
      target_literal: literal, target_natural: natural,
      variety: document.getElementById('lab-variety').value,
      orthography: document.getElementById('lab-orthography').value,
      source_type: document.getElementById('lab-source-type').value,
      source_provenance: document.getElementById('lab-provenance').value.trim(),
      rights_status: document.getElementById('lab-rights').value,
      access_status: document.getElementById('lab-access').value,
      evidence_ids: document.getElementById('lab-evidence-ids').value.split(',').map(x => x.trim()).filter(Boolean),
      abstained, error_category: document.getElementById('lab-error-cat').value,
      request_id: proposal && proposal.request_id,
      proposal_id: proposal && proposal.proposal_id,
      from_evidence: !!(proposal && proposal.evidence && proposal.evidence.length),
    };
    const button = document.getElementById('btn-save-pair');
    button.disabled = true;
    try {
      await api('/api/lab/pairs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast('Translation pair submitted for independent review.');
      showView('history');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  async function loadHistory() {
    const tbody = document.getElementById('lab-history-tbody');
    const loading = document.getElementById('lab-history-loading');
    const empty = document.getElementById('lab-history-empty');
    loading.style.display = 'block'; empty.style.display = 'none'; tbody.innerHTML = '';
    try {
      const data = await api('/api/lab/my-pairs');
      loading.style.display = 'none';
      if (!(data.pairs || []).length) return void (empty.style.display = 'block');
      tbody.innerHTML = data.pairs.map(pair => `<tr>
        <td data-label="Direction">${pair.direction === 'ru2lak' ? 'RU→LAK' : 'LAK→RU'}</td>
        <td data-label="Source">${esc(pair.source_text)}</td>
        <td data-label="Literal target">${esc(pair.target_literal || '—')}</td>
        <td data-label="Natural target">${esc(pair.target_natural || '—')}</td>
        <td data-label="Status"><span class="quality-badge ${pair.status === 'approved' ? 'q-approved' : pair.status === 'rejected' ? 'q-flagged' : 'q-unreviewed'}">${esc(pair.status)}</span></td>
      </tr>`).join('');
    } catch (error) {
      loading.textContent = error.message;
    }
  }
});