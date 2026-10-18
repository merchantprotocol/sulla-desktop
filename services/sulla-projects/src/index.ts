import { createApp } from './app.js';
import { bootstrapDatabase } from './bootstrap.js';
import { loadConfig } from './config.js';
import { configureProjectsDatabase } from './database.js';
import { getProjectsApplicationService } from './domain/ProjectsApplicationService.js';
import { importLegacyProjects, migrateProjectsDatabase } from './migrations.js';

const config = loadConfig();
await bootstrapDatabase(config);
await migrateProjectsDatabase(config);
await importLegacyProjects(config);

const database = configureProjectsDatabase(config.databaseUrl);
await database.healthcheck();
await database.withTenant(config.tenantId, async() => {
  await database.transaction(() =>
    getProjectsApplicationService().bootstrapTenant({ actor: 'projects-service', source: 'system' }));
});

const app = createApp(config);
const server = app.listen(config.port, '0.0.0.0', () => console.log(`[SullaProjects] ${ config.mode } service listening on ${ config.port }`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => database.end().finally(() => process.exit(0))));
}
