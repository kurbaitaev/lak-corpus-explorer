'use strict';

const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Database ─────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

// ── Load corpus data at startup ───────────────────────────────
let CORPUS_DATA    = [];
let CORPUS_STATS   = {};
let CORPUS_ALIASES = {};

function loadCorpus() {
  try {
    const dataPath = path.join(__dirname, 'public/data/corpus-data.json');
    const metaPath = path.join(__dirname, 'public/data/corpus-meta.json');
    CORPUS_DATA = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const meta  = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    CORPUS_STATS   = meta.stats;
    CORPUS_ALIASES = meta.aliases;
    console.log(`Corpus loaded: ${CORPUS_DATA.length} records`);
  } catch (err) {
    console.error('Failed to load corpus:', err.message);
  }
}
loadCorpus();

// ── Normalisation (mirrors client-side) ──────────────────────
function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[iіӏ]/g, 'Ӏ')
    .toLocaleLowerCase();
}

function tokenHas(value, form) {
  const text = ' ' + norm(value).replace(/[^\p{L}\p{N}ӀIІ]+/gu, ' ') + ' ';
  return text.includes(' ' + form + ' ');
}

// ── Matched-span computation (for result highlighting) ───────
// Builds a normalised copy of `text` plus an index map back to the
// original string, so spans found in normalised space can be
// reported as [start, end) offsets into the original text.
function buildNormMap(text) {
  let normStr = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const n = norm(text[i]);
    for (let j = 0; j < n.length; j++) { normStr += n[j]; map.push(i); }
  }
  return { normStr, map };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

// forms: normalised search forms; tokenOnly: require word boundaries
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

// ── Build stamp (changes every restart → busts all asset caches) ─
const BUILD = Date.now();
const PUBLIC = path.join(__dirname, 'public');

// Pre-load and stamp HTML files at startup
function stampHtml(file) {
  let html = fs.readFileSync(path.join(PUBLIC, file), 'utf-8');
  // Inject ?v=<stamp> into every CSS/JS asset reference that doesn't already have one
  html = html.replace(/(href|src)="(\/[^"]+\.(css|js))(\?[^"]*)?">/g,
    (_, attr, p, _ext, q) => `${attr}="${p}?v=${BUILD}">`);
  return html;
}

const PAGES = {};
for (const f of ['index.html', 'about.html', 'queue.html']) {
  PAGES[f] = stampHtml(f);
}

// ── Middleware ────────────────────────────────────────────────
app.use(compression());
app.use(express.json());

function sendPage(res, html) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Clear-Site-Data', '"cache"');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// Serve HTML pages dynamically.
// Redirect bare URLs to a stamped version so the browser can never serve
// a bfcache / disk-cached copy — the stamped URL changes every restart.
function htmlRoute(page) {
  return (req, res) => {
    if (!req.query.v && !req.query.bust) {
      // No version stamp → redirect to stamped URL (no-store so redirect itself isn't cached)
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, req.path + '?v=' + BUILD);
    }
    sendPage(res, PAGES[page]);
  };
}

app.get('/',          htmlRoute('index.html'));
app.get('/about.html', htmlRoute('about.html'));
app.get('/queue.html', htmlRoute('queue.html'));

// ── Legacy-cache busters ──────────────────────────────────────
// Old cached index.html loads /data/corpus.js and /js/search.js (unversioned).
// Serve a JS shim that forces a hard reload so any stuck browser recovers.
const RELOAD_SHIM = `/* Page reload shim — superseded by server-side search */
(function(){location.replace(location.pathname+'?bust='+Date.now());})();`;

app.get('/data/corpus.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(RELOAD_SHIM);
});

// Unversioned /js/search.js only ever came from the old cached HTML
app.get('/js/search.js', (req, res, next) => {
  if (!req.query.v) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    return res.send(RELOAD_SHIM);
  }
  // versioned request — fall through to static middleware
  next();
});

// Static assets — long cache (versioned via ?v=BUILD stamp in HTML)
app.use(express.static(PUBLIC, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// ── Corpus stats ─────────────────────────────────────────────
app.get('/api/corpus/stats', (req, res) => {
  res.json({ stats: CORPUS_STATS, totalRecords: CORPUS_DATA.length });
});

// ── Corpus search ─────────────────────────────────────────────
// GET /api/corpus/search?q=&kind=&source=&variety=&page=&limit=
app.get('/api/corpus/search', (req, res) => {
  const {
    q      = '',
    kind   = '',
    source = '',
    variety= '',
    page   = '1',
    limit  = '50',
  } = req.query;

  const currentQ = norm(q.trim());
  const expanded = currentQ ? (CORPUS_ALIASES[currentQ] || []) : [];

  let filtered = CORPUS_DATA.filter(r => {
    if (kind   && r[0] !== kind)   return false;
    if (source && r[3] !== source) return false;
    if (variety && r[4] !== variety) return false;
    if (!currentQ) return true;

    if (expanded.length) {
      const concept = expanded.some(form => tokenHas(r[1], norm(form)));
      const metaHit = norm(r.slice(2, 6).join(' ')).includes(currentQ);
      return concept || metaHit;
    }
    return norm(r.slice(1, 6).join(' ')).includes(currentQ);
  });

  // When alias-expanded, show only text (not lexicon) unless kind=lexicon
  let displayed = filtered;
  if (expanded.length && kind !== 'lexicon') {
    displayed = filtered.filter(r => r[0] === 'text');
  }

  const pageNum  = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(Math.max(1, parseInt(limit) || 50), 200);
  const total    = displayed.length;
  const pages    = Math.max(1, Math.ceil(total / pageSize));
  const safePageNum = Math.min(pageNum, pages);
  const rows     = displayed.slice((safePageNum - 1) * pageSize, safePageNum * pageSize);

  // Compute senses for concept card (lexicon entries matching expansion)
  let senses = [];
  if (expanded.length) {
    const senseSet = new Set(
      CORPUS_DATA
        .filter(r => r[0] === 'lexicon' && expanded.some(form => tokenHas(r[1], norm(form))))
        .map(r => r[2]).filter(Boolean)
    );
    senses = [...senseSet].slice(0, 8);
  }

  // Matched spans in the Lak text (r[1]) for each returned row
  const normForms = expanded.map(f => norm(f)).filter(Boolean);
  const matches = rows.map(r => {
    if (!currentQ) return [];
    if (normForms.length) {
      // Alias-expanded: highlight whole-token matches of the Lak forms;
      // fall back to a literal substring match of the raw query.
      const spans = findMatchSpans(r[1], normForms, true);
      return spans.length ? spans : findMatchSpans(r[1], [currentQ], false);
    }
    return findMatchSpans(r[1], [currentQ], false);
  });

  res.json({
    query: q,
    expanded,
    senses,
    matches,
    total,
    pages,
    page: safePageNum,
    limit: pageSize,
    rows,
  });
});

// ── Reviews ───────────────────────────────────────────────────

app.get('/api/reviews', async (req, res) => {
  try {
    const { state, limit = 100, offset = 0 } = req.query;
    const validStates = ['approved', 'flagged', 'unreviewed'];
    let sql = `SELECT id, record_id, state, correction, note, reviewer_name, created_at, updated_at FROM reviews`;
    const params = [];
    if (state && validStates.includes(state)) {
      sql += ' WHERE state = $1'; params.push(state);
    }
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(Math.min(Number(limit)||100, 500), Math.max(Number(offset)||0, 0));
    const result = await pool.query(sql, params);
    res.json({ reviews: result.rows });
  } catch (err) {
    console.error('GET /api/reviews:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/reviews/:recordId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, record_id, state, correction, note, reviewer_name, created_at, updated_at FROM reviews WHERE record_id = $1',
      [req.params.recordId]
    );
    res.json({ review: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const { record_id, state, correction, note, reviewer_name } = req.body;
    const validStates = ['approved', 'flagged', 'unreviewed'];
    if (!record_id || typeof record_id !== 'string' || record_id.length > 200)
      return res.status(400).json({ error: 'Invalid record_id' });
    if (!state || !validStates.includes(state))
      return res.status(400).json({ error: 'state must be approved, flagged, or unreviewed' });
    const result = await pool.query(
      `INSERT INTO reviews (record_id, state, correction, note, reviewer_name, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (record_id) DO UPDATE
         SET state=EXCLUDED.state, correction=EXCLUDED.correction,
             note=EXCLUDED.note, reviewer_name=EXCLUDED.reviewer_name, updated_at=NOW()
       RETURNING *`,
      [record_id, state,
       correction ? String(correction).slice(0,2000) : null,
       note       ? String(note).slice(0,2000)       : null,
       reviewer_name ? String(reviewer_name).slice(0,100) : null]
    );
    res.json({ review: result.rows[0] });
  } catch (err) {
    console.error('POST /api/reviews:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/reviews/bulk', async (req, res) => {
  try {
    const { record_ids } = req.body;
    if (!Array.isArray(record_ids) || !record_ids.length) return res.json({ reviews: {} });
    const ids = record_ids.slice(0, 200).map(String);
    const result = await pool.query(
      'SELECT record_id, state, correction, note, reviewer_name, updated_at FROM reviews WHERE record_id = ANY($1::text[])',
      [ids]
    );
    const byId = {};
    for (const row of result.rows) byId[row.record_id] = row;
    res.json({ reviews: byId });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/stats/reviews', async (req, res) => {
  try {
    const result = await pool.query('SELECT state, COUNT(*) AS count FROM reviews GROUP BY state');
    const counts = { approved: 0, flagged: 0, unreviewed: 0 };
    for (const row of result.rows) counts[row.state] = Number(row.count);
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/export.json', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT record_id, state, correction, note, reviewer_name, created_at, updated_at FROM reviews ORDER BY record_id'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="lak-corpus-reviews.json"');
    res.json({ exported_at: new Date().toISOString(), reviews: result.rows });
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

app.get('/api/export.csv', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT record_id, state, correction, note, reviewer_name, created_at, updated_at FROM reviews ORDER BY record_id'
    );
    const esc = v => v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"';
    const header = 'record_id,state,correction,note,reviewer_name,created_at,updated_at\n';
    const rows = result.rows.map(r =>
      [r.record_id,r.state,r.correction,r.note,r.reviewer_name,r.created_at,r.updated_at].map(esc).join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lak-corpus-reviews.csv"');
    res.send('\uFEFF' + header + rows);
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

// ── SPA fallback ─────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lak Corpus Explorer running on port ${PORT}`);
});
