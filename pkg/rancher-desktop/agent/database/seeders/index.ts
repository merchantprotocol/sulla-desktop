// seeders/index.ts
// Central registry for all seeders
// DatabaseManager imports this to run tracked seeders

import { initialize as firstRunRemoteCredentialsSeeder } from './FirstRunRemoteCredentialsSeeder';

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
  // {
  //   name: 'core-data-seed',
  //   run: coreDataSeeder,
  // },
] as const;
