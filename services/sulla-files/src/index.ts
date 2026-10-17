import { FilesKeyring, LegacyServerKeyring } from './keyring.js';
import { createApp } from './app.js';
import { backup, nightlyBackups, restore } from './backup.js';
import { loadConfig } from './config.js';
import { connect, connectOptional, migrate } from './db.js';
import { desktopIndexSource, storedIndexSource } from './indexSource.js';
import { IndexingQueue } from './indexing.js';
import { LocalFilesManager } from './localManager.js';
import { runLegacyPreflight } from './legacyPreflight.js';
import { PotionEmbedder } from './potionEmbedder.js';
import { RecordingEnrichmentQueue } from './recordingEnrichment.js';
import { FileSearch } from './search.js';

const config = loadConfig(); const command = process.argv[2];
if (command === 'backup') { if (process.argv.includes('--watch')) await nightlyBackups(config); else await backup(config); process.exit(0) }
if (command === 'restore') { await restore(config, process.argv[3]); process.exit(0) }
const db = await connect(config.databaseUrl); await migrate(db);
if (config.mode === 'desktop' && config.filesRoot) config.legacyPreflight = await runLegacyPreflight(db, config.filesRoot, { caseInsensitive: process.env.SULLA_FILES_CASE_INSENSITIVE_ROOT === '1' });
config.keyring = config.mode === 'desktop' ? new FilesKeyring(db) : new LegacyServerKeyring(db, config.capabilitySigningKey);
const identityDb = await connectOptional(config.vaultDatabaseUrl);
const embedder = PotionEmbedder.load(config.modelDir);
const indexer = new IndexingQueue(db, config.mode === 'desktop' && config.filesRoot ? desktopIndexSource(config.filesRoot, db) : storedIndexSource(db, config), embedder);
const manager = config.mode === 'desktop' ? new LocalFilesManager(db, config, indexer) : undefined;
const enrichment = config.mode === 'desktop' && config.filesRoot ? new RecordingEnrichmentQueue(db, config.filesRoot) : undefined;
const search = new FileSearch(db, embedder);
let initialization:Promise<void> | undefined;
const initialize = () => initialization ??= (async() => {
  await manager?.initialize(); await indexer.start(); await enrichment?.start();
})().catch(error => { initialization = undefined; throw error });
const lock = async() => { await Promise.all([manager?.close(), indexer.close(), enrichment?.close()]); initialization = undefined; };
const server = createApp(db, config, manager, identityDb, search, initialize, lock).listen(config.port, '0.0.0.0', () => {
  console.log(`[SullaFiles] ${ config.mode } service listening on ${ config.port }`);
  if (config.mode === 'server') initialize().catch(() => console.error('[SullaFiles] server initialization failed'));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => { void lock().finally(() => { config.keyring?.close(); return Promise.all([db.end(), identityDb?.end()]).finally(() => process.exit(0)); }); }); });
