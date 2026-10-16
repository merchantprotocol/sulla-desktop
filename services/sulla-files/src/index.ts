import { createApp } from './app.js';
import { backup, nightlyBackups, restore } from './backup.js';
import { loadConfig } from './config.js';
import { connect, connectOptional, migrate } from './db.js';
import { desktopIndexSource, storedIndexSource } from './indexSource.js';
import { IndexingQueue } from './indexing.js';
import { LocalFilesManager } from './localManager.js';
import { PotionEmbedder } from './potionEmbedder.js';
import { FileSearch } from './search.js';

const config = loadConfig(); const command = process.argv[2];
if (command === 'backup') { if (process.argv.includes('--watch')) await nightlyBackups(config); else await backup(config); process.exit(0) }
if (command === 'restore') { await restore(config, process.argv[3]); process.exit(0) }
const db = await connect(config.databaseUrl); await migrate(db);
const identityDb = await connectOptional(config.vaultDatabaseUrl);
const embedder = PotionEmbedder.load(config.modelDir);
const indexer = new IndexingQueue(db, config.mode === 'desktop' && config.filesRoot ? desktopIndexSource(config.filesRoot) : storedIndexSource(db, config), embedder);
const manager = config.mode === 'desktop' ? new LocalFilesManager(db, config, indexer) : undefined;
const search = new FileSearch(db, embedder);
const server = createApp(db, config, manager, identityDb, search).listen(config.port, '0.0.0.0', () => {
  console.log(`[SullaFiles] ${ config.mode } service listening on ${ config.port }`);
  indexer.start().then(() => manager?.initialize()).catch(error => console.error('[SullaFiles] watched folder initialization failed', error));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { manager?.close(); indexer.close(); server.close(() => Promise.all([db.end(), identityDb?.end()]).finally(() => process.exit(0))) });
