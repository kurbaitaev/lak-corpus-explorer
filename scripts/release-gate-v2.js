'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const commands = [
  ['node', ['scripts/test-lexicon-synthesis.js']],
  ['node', ['scripts/test-corpus-v2-import.js']],
  ['node', ['scripts/test-corpus-v2-search.js']],
  ['node', ['scripts/test-morphology-review.js']],
  ['node', ['scripts/test-i18n-v2.js']],
  ['node', ['scripts/test-corpus-v2-autostart.js']],
  ['node', ['scripts/test-corpus-evidence-spine.js']],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('offline corpus v2 release gate passed; database import and live browser gates still require a migrated development database');
