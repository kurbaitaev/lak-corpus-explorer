'use strict';

const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadObservatory } = require('./lib/observatory');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Database ─────────────────────────────────────────────────
const { pool, migrate } = require('./lib/db');

// ── Load corpus data at startup ───────────────────────────────
let CORPUS_DATA    = [];
let CORPUS_STATS   = {};
let CORPUS_ALIASES = {};

function loadCorpus() {
  const dataPath = path.join(__dirname, 'data/corpus-data.json');
  const metaPath = path.join(__dirname, 'data/corpus-meta.json');

  // Data files are generated (gitignored). If missing, rebuild them from
  // the canonical index.html via the extraction script.
  if (!fs.existsSync(dataPath) || !fs.existsSync(metaPath)) {
    console.log('Corpus data files missing — running scripts/extract-corpus.py …');
    const { spawnSync } = require('child_process');
    const result = spawnSync('python3', [path.join(__dirname, 'scripts/extract-corpus.py')], {
      stdio: 'inherit',
    });
    if (result.status !== 0 || !fs.existsSync(dataPath) || !fs.existsSync(metaPath)) {
      console.error(
        'FATAL: corpus data files are missing and could not be regenerated.\n' +
        'Run "python3 scripts/extract-corpus.py" manually (requires the canonical index.html at the project root).'
      );
      process.exit(1);
    }
  }

  try {
    CORPUS_DATA = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const meta  = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    CORPUS_STATS   = meta.stats;
    CORPUS_ALIASES = meta.aliases;
    console.log(`Corpus loaded: ${CORPUS_DATA.length} records`);
  } catch (err) {
    console.error('FATAL: failed to load corpus data:', err.message);
    console.error('Run "python3 scripts/extract-corpus.py" to regenerate the data files.');
    process.exit(1);
  }
}
loadCorpus();

// The Observatory is a provenance/acquisition registry. It is deliberately
// loaded through an independent path and never appended to CORPUS_DATA.
const OBSERVATORY = loadObservatory();
const OBSERVATORY_IDS = new Set(OBSERVATORY.resources.map(resource => resource.id));
console.log(`Observatory loaded: ${OBSERVATORY.resources.length} non-Bible resources`);
const withoutObservatoryReviews = rows => rows.filter(row => !OBSERVATORY_IDS.has(row.record_id));

// ── Curated alias additions (fill gaps in the extracted alias dictionary) ──
const CURATED_ALIASES = {
  'солнце': ['баргь'],
};
// Lab-only sense labels must not replace the broader search alias expansion.
const LAB_CURATED_ALIASES = {
  ...CURATED_ALIASES,
  'луна': ['барз (ссавнийсса)'],
  'месяц': ['барз (шинал)'],
};

// Ensure reviewer_verified column exists
pool.query('ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewer_verified BOOLEAN NOT NULL DEFAULT FALSE')
  .catch(err => console.error('Migration failed:', err.message));

// Validation & gamification schema (idempotent, backward-compatible)
migrate().catch(err => console.error('Schema migration failed:', err.message));

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

// ── Reviewer session helpers (signed cookie, no extra deps) ──
const SESSION_SECRET      = process.env.SESSION_SECRET;
const REVIEWER_PASSPHRASE = process.env.REVIEWER_PASSPHRASE || '';
const COOKIE_NAME         = 'reviewer_session';
const COOKIE_MAX_AGE      = 30 * 24 * 3600; // 30 days in seconds

function signPayload(p) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
}

function makeSessionCookie(name) {
  const p = Buffer.from(JSON.stringify({ name }), 'utf8').toString('base64url');
  return `${p}.${signPayload(p)}`;
}

function readSession(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(/;\s*/).find(c => c.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  const val = decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
  const dot = val.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = val.slice(0, dot);
  const sig     = val.slice(dot + 1);
  const expect  = signPayload(payload);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return s && typeof s.name === 'string' && s.name ? s : null;
  } catch { return null; }
}

// ── Build stamp (changes every restart → busts all asset caches) ─
const BUILD = Date.now();
const PUBLIC = path.join(__dirname, 'public');

// Pre-load and stamp HTML files at startup
function stampHtml(file) {
  let html = fs.readFileSync(path.join(PUBLIC, file), 'utf-8');
  html = html.replace(/(href|src)="(\/[^"]+\.(css|js))(\?[^"]*)?">/g,
    (_, attr, p, _ext, q) => `${attr}="${p}?v=${BUILD}">`);
  return html;
}

const PAGES = {};
for (const f of ['index.html', 'about.html', 'queue.html', 'login.html',
                 'register.html', 'profile.html', 'validate.html', 'leaderboard.html',
                   'dashboard.html', 'how-it-works.html', 'lab.html', 'observatory.html']) {
  PAGES[f] = stampHtml(f);
}

// ── Middleware ────────────────────────────────────────────────
app.use(compression());
app.use(express.json());

// Expert-validation & gamification API
app.use(require('./routes/validation')({ pool }));
// Evidence-grounded Translation Lab (evidence-only until a provider is authorized).
app.use(require('./routes/lab')({
  pool,
  corpusData: CORPUS_DATA,
  corpusAliases: CORPUS_ALIASES,
  curatedAliases: LAB_CURATED_ALIASES,
  norm,
  tokenHas,
}));

function sendPage(res, html) {
  // Revalidate HTML on every navigation so markup never goes stale,
  // while still allowing ETag-based 304s (fast). No Clear-Site-Data —
  // wiping the whole cache per visit is what made the app feel slow.
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// ── HTML pages ────────────────────────────────────────────────
app.get('/', (req, res) => sendPage(res, PAGES['index.html']));
for (const f of Object.keys(PAGES)) {
  if (f !== 'index.html') app.get('/' + f, (req, res) => sendPage(res, PAGES[f]));
}

// ── Static assets ─────────────────────────────────────────────
// Use no-cache (ETag revalidation) for everything so updated code is
// always picked up. The old `immutable, 1-year` policy served stale JS
// against fresh HTML, which is what made buttons stop responding.
// express.static sends ETags by default, so unchanged files return 304.
app.use(express.static(PUBLIC, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ── Auth endpoints ────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  if (!REVIEWER_PASSPHRASE) {
    return res.status(503).json({ error: 'Reviewer login is not configured (REVIEWER_PASSPHRASE not set)' });
  }
  const { name, passphrase } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) return res.status(400).json({ error: 'Name is required' });
  const a = Buffer.from(String(passphrase || ''));
  const b = Buffer.from(REVIEWER_PASSPHRASE);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Incorrect passphrase' });
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(makeSessionCookie(cleanName))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`);
  res.json({ reviewer: cleanName });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = readSession(req);
  const { readAccountSession } = require('./lib/auth');
  const account = readAccountSession(req);
  res.json({
    reviewer: session ? session.name : null,
    account: account
      ? { id: account.aid, display_name: account.name, role: account.role }
      : null,
  });
});

// ── Corpus stats ─────────────────────────────────────────────
app.get('/api/corpus/stats', (req, res) => {
  res.json({ stats: CORPUS_STATS, totalRecords: CORPUS_DATA.length });
});

// Observatory registry API — intentionally separate from corpus and Lab APIs.
app.get('/api/observatory/resources', (req, res) => {
  res.json(OBSERVATORY);
});

// ── Corpus search ─────────────────────────────────────────────
// GET /api/corpus/search?q=&kind=&source=&variety=&page=&limit=
app.get('/api/corpus/search', (req, res) => {
  const {
    q       = '',
    kind    = '',
    source  = '',
    variety = '',
    page    = '1',
    limit   = '50',
  } = req.query;

  const currentQ = norm(q.trim());
  // Curated overlay takes precedence over extracted aliases for known gaps
  const expanded = currentQ ? (CURATED_ALIASES[currentQ] || CORPUS_ALIASES[currentQ] || []) : [];

  let filtered = CORPUS_DATA.filter(r => {
    if (kind    && r[0] !== kind)    return false;
    if (source  && r[3] !== source)  return false;
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

  // Source-aware prioritisation: modern/verified sources first,
  // historical OCR (Uslar 1890) last within the result set.
  displayed = [
    ...displayed.filter(r => r[3] !== 'Uslar 1890'),
    ...displayed.filter(r => r[3] === 'Uslar 1890'),
  ];

  const pageNum     = Math.max(1, parseInt(page) || 1);
  const pageSize    = Math.min(Math.max(1, parseInt(limit) || 50), 200);
  const total       = displayed.length;
  const pages       = Math.max(1, Math.ceil(total / pageSize));
  const safePageNum = Math.min(pageNum, pages);
  const rows = displayed.slice((safePageNum - 1) * pageSize, safePageNum * pageSize);

  // Compute senses for concept card (lexicon entries matching expansion).
  // Modern/verified dictionary evidence forms the primary answer;
  // historical OCR senses (Uslar 1890) are returned separately and labelled.
  let senses = [];
  let ocrSenses = [];
  if (expanded.length) {
    const senseSet = new Set();
    const ocrSet  = new Set();
    for (const r of CORPUS_DATA) {
      if (r[0] !== 'lexicon' || !r[2]) continue;
      if (!expanded.some(form => tokenHas(r[1], norm(form)))) continue;
      if (r[3] === 'Uslar 1890') ocrSet.add(r[2]);
      else senseSet.add(r[2]);
    }
    senses    = [...senseSet].slice(0, 8);
    ocrSenses = [...ocrSet].slice(0, 8);
  }

  // Matched spans in the Lak text (r[1]) for each returned row
  const normForms = expanded.map(f => norm(f)).filter(Boolean);
  const matches = rows.map(r => {
    if (!currentQ) return [];
    if (normForms.length) {
      const spans = findMatchSpans(r[1], normForms, true);
      return spans.length ? spans : findMatchSpans(r[1], [currentQ], false);
    }
    return findMatchSpans(r[1], [currentQ], false);
  });

  res.json({
    query: q,
    expanded,
    senses,
    ocrSenses,
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
    let sql = `SELECT id, record_id, state, correction, note, reviewer_name, reviewer_verified, created_at, updated_at FROM reviews`;
    const params = [];
    if (state && validStates.includes(state)) {
      sql += ' WHERE state = $1'; params.push(state);
    }
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0));
    const result = await pool.query(sql, params);
    res.json({ reviews: withoutObservatoryReviews(result.rows) });
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
    if (OBSERVATORY_IDS.has(record_id))
      return res.status(400).json({
        error: 'Observatory records are provenance leads and cannot enter corpus validation',
      });
    if (!state || !validStates.includes(state))
      return res.status(400).json({ error: 'state must be approved, flagged, or unreviewed' });
    // Logged-in reviewers get authoritative attribution; anonymous free-text still allowed
    const session   = readSession(req);
    // Contributor accounts with a trusted/expert/admin role may also approve —
    // canonical corpus changes stay restricted to trusted reviewers, experts, admins.
    let accountIdentity = null;
    if (!session) {
      const { getIdentity, TRUSTED_PLUS } = require('./lib/auth');
      const candidate = getIdentity(req);
      if (candidate && candidate.type === 'account') {
        const roleRow = await pool.query('SELECT role FROM contributors WHERE id = $1', [candidate.id]);
        if (roleRow.rows[0] && TRUSTED_PLUS.includes(roleRow.rows[0].role)) accountIdentity = candidate;
      }
    }
    const approver = session || accountIdentity;
    if (state === 'approved' && !approver)
      return res.status(403).json({
        error: 'Approving a record requires a trusted reviewer, expert, or administrator login. Anonymous visitors can flag problems or submit suggestions.',
      });
    const finalName = approver
      ? approver.name
      : (reviewer_name ? String(reviewer_name).slice(0, 100) : null);
    const result = await pool.query(
      `INSERT INTO reviews (record_id, state, correction, note, reviewer_name, reviewer_verified)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (record_id) DO UPDATE SET
         state = EXCLUDED.state,
         correction = EXCLUDED.correction,
         note = EXCLUDED.note,
         reviewer_name = EXCLUDED.reviewer_name,
         reviewer_verified = EXCLUDED.reviewer_verified,
         updated_at = now()
       RETURNING id, record_id, state, correction, note, reviewer_name, reviewer_verified, created_at, updated_at`,
      [record_id, state, correction || null, note || null, finalName, !!approver]
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
    const ids = record_ids.slice(0, 200).map(String).filter(id => !OBSERVATORY_IDS.has(id));
    if (!ids.length) return res.json({ reviews: {} });
    const result = await pool.query(
      `SELECT record_id, state, correction, note, reviewer_name, reviewer_verified, created_at, updated_at
       FROM reviews WHERE record_id = ANY($1)`,
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
    const result = await pool.query('SELECT record_id, state FROM reviews');
    const counts = { approved: 0, flagged: 0, unreviewed: 0 };
    for (const row of withoutObservatoryReviews(result.rows)) counts[row.state]++;
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/export.json', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT record_id, state, correction, note, reviewer_name, reviewer_verified, created_at, updated_at FROM reviews ORDER BY record_id'
    );

    const escCsv = v => v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"';
    res.setHeader('Content-Disposition', 'attachment; filename="lak-corpus-reviews.json"');
    res.json({ exported_at: new Date().toISOString(), reviews: withoutObservatoryReviews(result.rows) });
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

app.get('/api/export.csv', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT record_id, state, correction, note, reviewer_name, reviewer_verified, created_at, updated_at FROM reviews ORDER BY record_id'
    );

    const escCsv = v => v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"';
    const header = 'record_id,state,correction,note,reviewer_name,reviewer_verified,created_at,updated_at\n';
    const rows = withoutObservatoryReviews(result.rows).map(r =>
      [r.record_id, r.state, r.correction, r.note, r.reviewer_name, r.reviewer_verified, r.created_at, r.updated_at].map(escCsv).join(',')
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
