import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';

import { createApp } from './app.js';
import { backup, nightlyBackups, restore } from './backup.js';
import { FilesBootstrapAuthority } from './bootstrapAuthority.js';
import { loadConfig } from './config.js';
import { connect, connectOptional, migrate } from './db.js';
import { desktopIndexSource, storedIndexSource } from './indexSource.js';
import { IndexingQueue } from './indexing.js';
import { FilesKeyBundleRecovery } from './keyBundleRecovery.js';
import { SecureCollectionKeyExchange } from './keyExchange.js';
import { FilesKeyring } from './keyring.js';
import { FilesLifecycle } from './lifecycle.js';
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
config.keyring = new FilesKeyring(db);
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
const lifecycle = new FilesLifecycle(db, config, config.keyring, { initialize, stop: lock, recover });
const bootstrapAuthority = config.mode === 'desktop'
  ? new FilesBootstrapAuthority(
    config.bootstrapServiceId ?? 'sulla-desktop-files-bootstrap',
    config.bootstrapToken ?? (() => { throw new Error('SULLA_FILES_BOOTSTRAP_TOKEN is required in desktop mode') })(),
    lifecycle,
  )
  : undefined;
if (config.mode === 'server') {
  if (!config.serverMasterKey || !/^[A-Za-z0-9_-]{43}$/.test(config.serverMasterKey)) {
    throw new Error('SULLA_FILES_MASTER_KEY must be a 32-byte base64url key in server mode');
  }
  const master = Buffer.from(config.serverMasterKey, 'base64url');
  if (master.length !== 32 || master.toString('base64url') !== config.serverMasterKey) {
    master.fill(0);
    throw new Error('SULLA_FILES_MASTER_KEY must use canonical base64url encoding');
  }
  for (const secret of [config.capabilitySigningKey, config.serverJwtSecret]) {
    if (secret === undefined) continue;
    const bytes = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, 'utf8');
    try {
      if (bytes.length === master.length && timingSafeEqual(bytes, master)) {
        master.fill(0);
        throw new Error('SULLA_FILES_MASTER_KEY must be distinct from service authentication secrets');
      }
      if (typeof secret === 'string' && secret === config.serverMasterKey) {
        master.fill(0);
        throw new Error('SULLA_FILES_MASTER_KEY must be distinct from service authentication secrets');
      }
    } finally { bytes.fill(0) }
  }
  config.serverMasterKey = undefined;
  delete process.env.SULLA_FILES_MASTER_KEY;
  try { await lifecycle.initializeServer(master) } finally { master.fill(0) }
}
const app = createApp(db, config, manager, identityDb, search, undefined, undefined, undefined, residency, lifecycle, bootstrapAuthority);
const tlsEnabled = Boolean(config.tlsCertificatePath && config.tlsPrivateKeyPath);
if (config.mode === 'desktop' && !tlsEnabled) throw new Error('Files TLS identity is required in desktop mode');
const server = tlsEnabled
  ? https.createServer({
    cert: await readFile(config.tlsCertificatePath!),
    key:  await readFile(config.tlsPrivateKeyPath!),
  }, app).listen(config.port, '0.0.0.0', listening)
  : app.listen(config.port, '0.0.0.0', listening);
function listening() {
  console.log(`[SullaFiles] ${ config.mode } service listening on ${ config.port }`);
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      lifecycle.lock().finally(() => {
        return Promise.all([db.end(), identityDb?.end()]).finally(() => process.exit(0));
      }).catch(() => process.exit(1));
    });
  });
}
