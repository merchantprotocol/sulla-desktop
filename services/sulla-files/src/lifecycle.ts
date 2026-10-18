import { join } from 'node:path';

import { FilesBootstrapError, type FilesBootstrapLifecycle } from './bootstrapAuthority.js';
import type { FilesBootstrapDisposition, FilesBootstrapUnlockResponse } from './bootstrapProtocol.js';
import type { Config } from './config.js';
import { FilesMasterKeyRejectedError, type FilesKeyring } from './keyring.js';
import { LegacyFilesImporter } from './legacyImport.js';
import { runLegacyPreflight } from './legacyPreflight.js';

import type pg from 'pg';

interface LifecycleHooks {
  initialize():Promise<void>;
  stop():Promise<void>;
  recover?(master:Buffer):Promise<number>;
}

export interface FilesLifecycleStatus {
  state:'locked' | 'starting' | 'unlocked' | 'error';
  legacyImport:'clear' | 'secure-import-required';
  failure?:{ code:string; stage:string };
}

/** Sole owner of Files key activation, migration, recovery, readiness, and lock ordering. */
export class FilesLifecycle implements FilesBootstrapLifecycle {
  private queue:Promise<unknown> = Promise.resolve();
  private currentGeneration = 0;
  private currentState:FilesLifecycleStatus['state'] = 'locked';
  private failure?:FilesLifecycleStatus['failure'];

  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly keyring:FilesKeyring,
    private readonly hooks:LifecycleHooks,
  ) {}

  get generation():number { return this.currentGeneration }
  get ready():boolean { return this.currentState === 'unlocked' && this.keyring.unlocked }

  status():FilesLifecycleStatus {
    return {
      state: this.currentState,
      legacyImport: this.config.legacyPreflight?.state ?? 'clear',
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  async disposition(hasMasterBlob:boolean):Promise<FilesBootstrapDisposition> {
    const hasState = Boolean((await this.db.query('SELECT 1 FROM files_key_state WHERE id=TRUE')).rowCount);
    if (hasMasterBlob) return 'existing';
    if (!hasState) {
      const protectedState = await this.db.query(`SELECT 1 WHERE
        EXISTS(SELECT 1 FROM files_collection_keys) OR
        EXISTS(SELECT 1 FROM file_versions WHERE manifest_hash IS NOT NULL) OR
        EXISTS(SELECT 1 FROM chunks) OR
        EXISTS(SELECT 1 FROM collections
          WHERE compatibility_state<>'native' OR encrypted_data_key<>'{}'::jsonb OR dedup_key_ciphertext<>'{}'::jsonb)`);
      if (protectedState.rowCount) {
        throw new FilesBootstrapError('FILES_MASTER_STATE_INCOMPLETE', 409, 'Files key state is incomplete; fresh key creation was refused');
      }
      return 'create-new';
    }
    if (!await this.recoveryComplete()) {
      throw new FilesBootstrapError('FILES_MASTER_BLOB_REQUIRED', 409, 'Existing Files state requires its OS-protected master');
    }
    return 'recover';
  }

  private async recoveryComplete():Promise<boolean> {
    const unsupported = await this.db.query(`SELECT 1 FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
      WHERE k.key_origin<>'random' OR c.compatibility_state<>'native' LIMIT 1`);
    const incomplete = await this.db.query(`SELECT 1 FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
      LEFT JOIN files_collection_key_bundles b ON b.collection_id=k.collection_id AND b.principal_id=c.owner_user_id
        AND b.key_version=k.key_version AND b.key_epoch=k.key_epoch
      WHERE b.collection_id IS NULL LIMIT 1`);
    const count = Number((await this.db.query('SELECT COUNT(*)::int AS count FROM files_collection_keys')).rows[0]?.count ?? 0);
    return !unsupported.rowCount && !incomplete.rowCount && count > 0;
  }

  bootstrap(
    material:{ masterKey:Buffer; legacyMasterKeys:Buffer[] },
    disposition:FilesBootstrapDisposition,
    generation:number,
  ):Promise<FilesBootstrapUnlockResponse> {
    return this.serial(async() => {
      this.assertGeneration(generation);
      this.currentState = 'starting'; this.failure = undefined;
      try {
        const hasState = Boolean((await this.db.query('SELECT 1 FROM files_key_state WHERE id=TRUE')).rowCount);
        if (disposition === 'create-new' && hasState) throw new FilesBootstrapError('FILES_BOOTSTRAP_STATE_CHANGED', 409, 'Files key state changed during bootstrap');
        if (disposition === 'recover' && !hasState) throw new FilesBootstrapError('FILES_BOOTSTRAP_STATE_CHANGED', 409, 'Files recovery state changed during bootstrap');
        if (disposition !== 'existing' && await this.disposition(false) !== disposition) {
          throw new FilesBootstrapError('FILES_BOOTSTRAP_STATE_CHANGED', 409, 'Files key state changed during bootstrap');
        }
        if (this.config.filesRoot) {
          this.config.legacyPreflight = await runLegacyPreflight(this.db, this.config.filesRoot, { caseInsensitive: this.config.caseInsensitiveRoot });
        }
        let imported = false;
        if (this.config.legacyPreflight?.state === 'secure-import-required') {
          if (disposition !== 'existing' || !this.config.filesRoot || !this.config.legacyPreflight.protectedPrefix || !material.legacyMasterKeys.length) {
            throw new FilesBootstrapError('FILES_LEGACY_KEY_REQUIRED', 409, 'Legacy Files import requires the existing OS-protected key material');
          }
          const importer = new LegacyFilesImporter(
            this.db, join(this.config.filesRoot, this.config.legacyPreflight.protectedPrefix), this.config.chunkRoot,
          );
          await importer.run(material.masterKey, material.legacyMasterKeys);
          this.config.legacyPreflight = await runLegacyPreflight(this.db, this.config.filesRoot, { caseInsensitive: this.config.caseInsensitiveRoot });
          if (this.config.legacyPreflight.state !== 'clear') throw new FilesBootstrapError('FILES_LEGACY_IMPORT_INCOMPLETE', 409, 'Legacy Files import did not complete');
          imported = true;
        } else if (this.config.filesRoot) {
          // A prior import may have committed before its response reached the
          // helper. Revalidate the durable receipt and every identity mapping
          // before authorizing retirement of the raw legacy master.
          const importer = new LegacyFilesImporter(this.db, this.config.filesRoot, this.config.chunkRoot);
          imported = Boolean(await importer.completedResult());
        }
        this.assertGeneration(generation);
        let recovered = disposition === 'recover';
        if (recovered) {
          if (!this.hooks.recover) throw new FilesBootstrapError('FILES_RECOVERY_UNAVAILABLE', 409, 'Files recovery authority is unavailable');
          await this.hooks.recover(material.masterKey);
        } else {
          try { await this.keyring.unlock(material.masterKey, this.config.capabilitySigningKey) } catch (error) {
            if (error instanceof FilesMasterKeyRejectedError) {
              if (this.config.legacyPreflight?.state !== 'clear' || !this.hooks.recover || !await this.recoveryComplete()) {
                throw new FilesBootstrapError(error.code, 409, 'Files master key was rejected; existing data was preserved');
              }
              this.keyring.close();
              await this.hooks.recover(material.masterKey);
              recovered = true;
            } else {
              throw error;
            }
          }
        }
        this.assertGeneration(generation);
        await this.hooks.initialize();
        this.assertGeneration(generation);
        this.currentState = 'unlocked';
        return { state: 'unlocked', legacyImport: imported ? 'imported' : 'clear', recovered };
      } catch (error) {
        await this.hooks.stop().catch(() => undefined);
        const invalidated = generation !== this.currentGeneration;
        this.currentState = invalidated ? 'locked' : 'error';
        this.failure = invalidated ? undefined : {
          code: error instanceof FilesBootstrapError ? error.code : 'FILES_STARTUP_FAILED',
          stage: this.config.legacyPreflight?.state === 'secure-import-required' ? 'legacy-import' : 'bootstrap',
        };
        this.keyring.close();
        if (error instanceof FilesBootstrapError) throw error;
        throw new FilesBootstrapError('FILES_STARTUP_FAILED', 503, 'Files secure startup failed; existing data was preserved');
      }
    });
  }

  initializeServer(master:Buffer):Promise<void> {
    return this.serial(async() => {
      const generation = this.currentGeneration;
      this.currentState = 'starting';
      try {
        await this.keyring.unlockServer(master, this.config.capabilitySigningKey);
        this.assertGeneration(generation);
        await this.hooks.initialize();
        this.assertGeneration(generation);
        this.currentState = 'unlocked'; this.failure = undefined;
      } catch (error) {
        await this.hooks.stop().catch(() => undefined);
        const invalidated = generation !== this.currentGeneration;
        this.currentState = invalidated ? 'locked' : 'error';
        this.failure = invalidated ? undefined : { code: 'FILES_SERVER_STARTUP_FAILED', stage: 'server-bootstrap' };
        this.keyring.close(); throw error;
      }
    });
  }

  lock():Promise<void> {
    this.currentGeneration++;
    this.currentState = 'locked';
    // This invalidates pending keyring commits immediately; slow shutdown work remains serialized.
    this.keyring.close();
    return this.serial(async() => { await this.hooks.stop(); this.failure = undefined });
  }

  private assertGeneration(expected:number):void {
    if (expected !== this.currentGeneration) throw new FilesBootstrapError('FILES_BOOTSTRAP_CANCELLED', 409, 'Files locked during bootstrap');
  }

  private serial<T>(operation:()=>Promise<T>):Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
