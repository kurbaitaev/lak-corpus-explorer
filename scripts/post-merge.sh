#!/bin/bash
set -e

# Install/update Node dependencies
npm install --prefer-offline

# Apply the schema bootstrap to the development database.
#
# This project has no declarative schema file: lib/db.js creates and evolves
# every table imperatively, and server.js runs it at boot. That means a
# development database in which the app has never run is missing the newest
# tables and columns, while production — which has run them — still has them.
# The publish-time diff reads that as "production has objects development does
# not" and proposes DROPping them, which would destroy the private package
# archives held in the production database.
#
# Applying the bootstrap here keeps the development database level with the
# code on every merge, so the publish diff stays additive. Every statement is
# CREATE/ADD ... IF NOT EXISTS or a DROP CONSTRAINT IF EXISTS paired with its
# re-add, so this is safe to run repeatedly and never drops data.
node -e "
const db = require('./lib/db');
db.migrate()
  .then(() => db.pool.end())
  .catch(err => { console.error('schema bootstrap failed:', err.message); process.exit(1); });
"
