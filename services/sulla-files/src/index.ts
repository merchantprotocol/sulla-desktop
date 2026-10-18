import { createApp } from './app.js';
import { backup, nightlyBackups, restore } from './backup.js';
import { loadConfig } from './config.js';
import { connect, connectOptional, migrate } from './db.js';
import { desktopIndexSource, storedIndexSource } from './indexSource.js';
import { IndexingQueue } from './indexing.js';
import { FilesKeyring, LegacyServerKeyring } from './keyring.js';
import { runLegacyPreflight } from './legacyPreflight.js';
import { FilesKeyBundleRecovery } from './keyBundleRecovery.js';
import { LocalFilesManager } from './localManager.js';
import { PotionEmbedder } from './potionEmbedder.js';
import { RecordingEnrichmentQueue } from './recordingEnrichment.js';
import { FileSearch } from './search.js';
import { Store } from './store.js';
import { cleanupStaleUploads } from './uploadCleanup.js';
import { configuredVaultFilesKeyBundleAuthority } from './vaultKeyBundleAuthority.js';

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
const enrichment = config.mode === 'desktop' && config.filesRoot ? new RecordingEnrichmentQueue(db, config.filesRoot) : undefined;
const search = new FileSearch(db, embedder);
let initialization:Promise<void> | undefined;
const adoptVaultPrincipal = async(principalId:string) => {
  if (config.userId === principalId) return;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const owners = (await client.query<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM collections FOR UPDATE',
    )).rows;
    const foreignBundle = (await client.query(
      'SELECT 1 FROM files_collection_key_bundles WHERE principal_id<>$1 LIMIT 1', [principalId],
    )).rowCount;
    // A restarted process loads its configured sentinel again, while ownership
    // already belongs to the same authenticated Vault principal.
    if (!foreignBundle && owners.every(row => row.owner_user_id === principalId)) {
      await client.query('COMMIT');
      config.userId = principalId;
      return;
    }
    if (config.userId !== 'desktop-user' || owners.some(row => row.owner_user_id !== config.userId) || foreignBundle) {
      throw new Error('Existing Files collections belong to another principal; secure migration is required');
    }
    await client.query(
      `INSERT INTO collection_acl(collection_id,principal_type,principal_id,role)
       SELECT id,'user',$2,'manage' FROM collections WHERE owner_user_id=$1
       ON CONFLICT(collection_id,principal_type,principal_id) DO UPDATE SET role='manage'`,
      [config.userId, principalId],
    );
    await client.query("DELETE FROM collection_acl WHERE principal_type='user' AND principal_id=$1", [config.userId]);
    await client.query('UPDATE file_share_links SET owner_user_id=$2 WHERE owner_user_id=$1', [config.userId, principalId]);
    await client.query('UPDATE collections SET owner_user_id=$2,updated_at=NOW() WHERE owner_user_id=$1', [config.userId, principalId]);
    await client.query('COMMIT');
    config.userId = principalId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
const initialize = () => {
  initialization ??= (async() => {
    if (vaultAuthority) {
      const { principalId } = await vaultAuthority.unlockedPrincipal();
      await adoptVaultPrincipal(principalId);
    }
    await manager?.initialize();
    if (keyRecovery) await keyRecovery.enrollAllCollections(config.userId);
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
const app = createApp(db, config, manager, identityDb, search, initialize, lock, recover);
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
