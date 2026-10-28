// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// seeders/index.ts
// Central registry for all seeders
// DatabaseManager imports this to run tracked seeders

import { initialize as firstRunRemoteCredentialsSeeder } from './FirstRunRemoteCredentialsSeeder';
import { initialize as observationsImportSeeder } from './ObservationsImportSeeder';
import { initialize as memorySeedSeeder, MEMORY_SEED_VERSION } from './MemorySeedSeeder';
import { initialize as reflexSeedSeeder, initializeRouteSeed as reflexRouteSeedSeeder } from './ReflexSeedSeeder';

// n8n user and settings seeders have been replaced by the recipe's
// post-server-migration.sql which handles user creation, bcrypt password
// hashing, JWT API key generation, and MCP settings via template variables.

// Add future seeders here in the same way
// import { initialize as someOtherSeeder } from './some-other-seeder';

export const seedersRegistry = [
  { name: `memory-seed-v${ MEMORY_SEED_VERSION }`, run: memorySeedSeeder },
  {
    name: 'firstrun-remote-credentials-seeder',
    run:  firstRunRemoteCredentialsSeeder,
  },
  {
    name: 'observations-import-seeder',
    run:  observationsImportSeeder,
  },
  {
    // Bump with agent/reflex/seed/reflex-seed.json "version" so a new seed
    // loads once on existing installs.
    name: 'reflex-seed-v2',
    run:  reflexSeedSeeder,
  },
  {
    // Bump with agent/reflex/seed/route-seed.json "version". Each run archives
    // shipped routes to retired agents, then loads the current seed.
    name: 'reflex-route-seed-v3',
    run:  reflexRouteSeedSeeder,
  },
  // {
  //   name: 'core-data-seed',
  //   run: coreDataSeeder,
  // },
] as const;
