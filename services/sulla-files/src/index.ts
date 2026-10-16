import { createApp } from './app.js';
import { backup, nightlyBackups, restore } from './backup.js';
import { loadConfig } from './config.js';
import { connect, migrate } from './db.js';
import { LocalFilesManager } from './localManager.js';
import { RecordingEnrichmentQueue } from './recordingEnrichment.js';

const config = loadConfig(); const command = process.argv[2];
if (command === 'backup') { if (process.argv.includes('--watch')) await nightlyBackups(config); else await backup(config); process.exit(0) }
if (command === 'restore') { await restore(config, process.argv[3]); process.exit(0) }
const db = await connect(config.databaseUrl); await migrate(db);
const manager = config.mode === 'desktop' ? new LocalFilesManager(db, config) : undefined;
const enrichment = config.mode === 'desktop' && config.filesRoot ? new RecordingEnrichmentQueue(db, config.filesRoot) : undefined;
const server = createApp(db, config, manager).listen(config.port, '0.0.0.0', () => {
  console.log(`[SullaFiles] ${ config.mode } service listening on ${ config.port }`);
  manager?.initialize().catch(error => console.error('[SullaFiles] watched folder initialization failed', error));
  enrichment?.start().catch(error => console.error('[SullaFiles] recording enrichment initialization failed', error));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { manager?.close(); enrichment?.close(); server.close(() => db.end().finally(() => process.exit(0))) });
