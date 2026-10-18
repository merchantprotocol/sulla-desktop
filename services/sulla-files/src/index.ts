import { createApp } from './app.js';
import { backup, nightlyBackups, restore } from './backup.js';
import { loadConfig } from './config.js';
import { connect, connectOptional, migrate } from './db.js';
import { desktopIndexSource, storedIndexSource } from './indexSource.js';
import { IndexingQueue } from './indexing.js';
import { FilesKeyBundleRecovery } from './keyBundleRecovery.js';
import { SecureCollectionKeyExchange } from './keyExchange.js';
import { FilesKeyring, LegacyServerKeyring } from './keyring.js';
import { runLegacyPreflight } from './legacyPreflight.js';
import { LocalFilesManager } from './localManager.js';
import { PotionEmbedder } from './potionEmbedder.js';
import { RecordingEnrichmentQueue } from './recordingEnrichment.js';
import { FileResidencyManager } from './residency.js';
import { HttpResidencyTransport, loadResidencySyncBundle } from './residencyHttp.js';
import { FileSearch } from './search.js';
import { Store } from './store.js';
import { cleanupStaleUploads } from './uploadCleanup.js';
import { configuredVaultFilesKeyBundleAuthority } from './vaultKeyBundleAuthority.js';
import { adoptVaultPrincipal } from './vaultPrincipal.js';

const config = loadConfig(); const command = process.argv[2];
if (command === 'backup') { if (process.argv.includes('--watch')) await nightlyBackups(config); else await backup(config); process.exit(0) }
if (command === 'restore') { await restore(config, process.argv[3]); process.exit(0) }
const db = await connect(config.databaseUrl); await migrate(db);
if (config.mode === 'desktop') {
  await cleanupStaleUploads(db, new Store(config.chunkRoot)).catch(error => { console.warn('[SullaFiles] stale upload cleanup deferred:', error) });
}
if (config.mode === 'desktop' && config.filesRoot) config.legacyPreflight = await runLegacyPreflight(db, config.filesRoot, { caseInsensitive: config.caseInsensitiveRoot });
config.keyring = config.mode === 'desktop' ? new FilesKeyring(db) : new LegacyServerKeyring(db, config.capabilitySigningKey);
const vaultAuthority = configuredVaultFilesKeyBundleAuthority(config);
const keyRecovery = vaultAuthority && config.keyring instanceof FilesKeyring
  ? new FilesKeyBundleRecovery(db, config.keyring, vaultAuthority)
  : undefined;
const identityDb = await connectOptional(config.vaultDatabaseUrl);
const embedder = PotionEmbedder.load(config.modelDir);
const indexer = new IndexingQueue(db, config.mode === 'desktop' && config.filesRoot ? desktopIndexSource(config.filesRoot, db) : storedIndexSource(db, config), embedder);
const manager = config.mode === 'desktop' ? new LocalFilesManager(db, config, indexer) : undefined;
const residency = manager && config.filesRoot && config.serverUrl && vaultAuthority && keyRecovery && config.keyring instanceof FilesKeyring
  ? new FileResidencyManager(
    db,
    new Store(config.chunkRoot),
    config.keyring,
    new SecureCollectionKeyExchange(db, config.keyring, vaultAuthority, keyRecovery),
    new HttpResidencyTransport({
      serverUrl: config.serverUrl,
      principalId: () => config.userId,
      deviceId: config.deviceId,
      capabilitySigningKey: config.capabilitySigningKey,
      bundleFor: version => loadResidencySyncBundle(db, version),
    }),
    manager.mutations,
  )
  : undefined;
const enrichment = config.mode === 'desktop' && config.filesRoot ? new RecordingEnrichmentQueue(db, config.filesRoot) : undefined;
const search = new FileSearch(db, embedder);
let initialization:Promise<void> | undefined;

const initialize = () => {
  initialization ??= (async() => {
    if (vaultAuthority) {
      const { principalId } = await vaultAuthority.unlockedPrincipal();
      await adoptVaultPrincipal(db, config, principalId);
    }
    if (manager) {
      await manager.initialize(async() => {
        if (keyRecovery) await keyRecovery.enrollAllCollections(config.userId);
        await residency?.recoverPending();
      });
    } else if (keyRecovery) await keyRecovery.enrollAllCollections(config.userId);
    await indexer.start(); await enrichment?.start();
  })().catch(error => { initialization = undefined; throw error });
  return initialization;
};
const lock = async() => {
  await Promise.all([manager?.close(), indexer.close(), enrichment?.close()]);
  initialization = undefined;
};
const recover = keyRecovery && vaultAuthority
  ? async(master:Buffer) => {
    const { principalId } = await vaultAuthority.unlockedPrincipal();
    return keyRecovery.recoverDeviceMaster(master, principalId);
  }
  : undefined;
const app = createApp(db, config, manager, identityDb, search, initialize, lock, recover, residency);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[SullaFiles] ${ config.mode } service listening on ${ config.port }`);
  if (config.mode === 'server') initialize().catch(() => console.error('[SullaFiles] server initialization failed'));
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      lock().finally(() => {
        config.keyring?.close();
        return Promise.all([db.end(), identityDb?.end()]).finally(() => process.exit(0));
      }).catch(() => process.exit(1));
    });
  });
}
