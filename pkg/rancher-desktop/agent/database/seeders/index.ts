// seeders/index.ts
// Central registry for all seeders
// DatabaseManager imports this to run tracked seeders

import { initialize as firstRunRemoteCredentialsSeeder } from './FirstRunRemoteCredentialsSeeder';
import { initialize as observationsImportSeeder } from './ObservationsImportSeeder';
import { initialize as reflexSeedSeeder } from './ReflexSeedSeeder';
import { initialize as workItemsImportSeeder } from './WorkItemsImportSeeder';

// n8n user and settings seeders have been replaced by the recipe's
// post-server-migration.sql which handles user creation, bcrypt password
// hashing, JWT API key generation, and MCP settings via template variables.

// Add future seeders here in the same way
// import { initialize as someOtherSeeder } from './some-other-seeder';

export const seedersRegistry = [
  {
    name: 'firstrun-remote-credentials-seeder',
    run:  firstRunRemoteCredentialsSeeder,
  },
  {
    name: 'observations-import-seeder',
    run:  observationsImportSeeder,
  },
  {
    name: 'work-items-import-seeder',
    run:  workItemsImportSeeder,
  },
  {
    // Bump with agent/reflex/seed/reflex-seed.json "version" so a new seed
    // loads once on existing installs.
    name: 'reflex-seed-v2',
    run:  reflexSeedSeeder,
  },
  // {
  //   name: 'core-data-seed',
  //   run: coreDataSeeder,
  // },
] as const;
