'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyBundle } = require('./import-pcmlbe-v14');
const { reconcileBundle, EXPECTED } = require('./reconcile-corpus-v2');

async function main() {
  const bundle = path.join(__dirname, '..', 'imports', 'lak-corpus-v1.4');
  const first = await verifyBundle(bundle);
  for (const [key, value] of Object.entries(EXPECTED)) {
    if (JSON.stringify(first.manifest.counts[key]) !== JSON.stringify(value)) throw new Error(`exact manifest count changed: ${key}`);
  }
  await reconcileBundle(bundle);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lak-v2-tamper-'));
  try {
    for (const file of fs.readdirSync(bundle)) fs.copyFileSync(path.join(bundle, file), path.join(temp, file));
    fs.appendFileSync(path.join(temp, 'documents.jsonl.gz'), Buffer.from([0]));
    let rejected = false;
    try { await verifyBundle(temp); } catch (error) { rejected = /SHA-256 mismatch/.test(error.message); }
    if (!rejected) throw new Error('tampered artifact was not rejected before import');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log('corpus v2 bundle, exact reconciliation, legacy parity, and tamper rejection passed');
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
