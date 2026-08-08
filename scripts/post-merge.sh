#!/bin/bash
set -e

# Install/update Node dependencies
npm install --prefer-offline

# Apply the legacy bootstrap plus versioned additive migrations to the
# development database.
#
# This project has no declarative schema file: lib/db.js creates and evolves
# every table imperatively, and server.js runs it at boot. That means a
# development database in which the app has never run is missing the newest
# tables and columns, while production — which has run them — still has them.
# The publish-time diff reads that as "production has objects development does
# not" and proposes DROPping them, which would destroy the private package
# archives held in the production database.
#
# Applying the versioned runner here keeps development level with code so the
# publish diff stays additive. The PCMLBE corpus importer remains a separate,
# explicitly reconciled job and never runs during deployment.
node scripts/migrate.js
