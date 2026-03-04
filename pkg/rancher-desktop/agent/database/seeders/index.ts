// seeders/index.ts
// Central registry for all seeders
// DatabaseManager imports this to run tracked seeders

import { initialize as n8nUserSeeder } from './N8nUserSeeder';
import { initialize as n8nSettingsSeeder } from './N8nSettingsSeeder';
import { initialize as ollamaIntegrationSeeder } from './OllamaIntegrationSeeder';
import { initialize as firstRunRemoteCredentialsSeeder } from './FirstRunRemoteCredentialsSeeder';

// Add future seeders here in the same way
// import { initialize as someOtherSeeder } from './some-other-seeder';

export const seedersRegistry = [
  {
    name: 'n8n-user-seeder',
    run: n8nUserSeeder,
  },
  {
    name: 'n8n-settings-seeder',
    run: n8nSettingsSeeder,
  },
  {
    name: 'ollama-integration-seeder',
    run: ollamaIntegrationSeeder,
  },
  {
    name: 'firstrun-remote-credentials-seeder',
    run: firstRunRemoteCredentialsSeeder,
  },
  // {
  //   name: 'core-data-seed',
  //   run: coreDataSeeder,
  // },
] as const;