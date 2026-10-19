import { EventEmitter } from 'node:events';

import type { VMExecutor } from '@pkg/backend/backend';
import type { SullaFilesNativeRuntimeStatus } from '@pkg/utils/sullaFilesNativeSource';
import { sullaFilesNativeSourceGrant, sullaFilesNativeSourceRolloutRequested } from '@pkg/utils/sullaFilesNativeSource';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const COMPOSE_FILE = '/tmp/sulla-docker-compose.yml';
const RUNTIME_ROOT = '/var/lib/sulla/files-fuse';
const TOKEN_FILE = `${ RUNTIME_ROOT }/token`;
const COLLECTION_FILE = `${ RUNTIME_ROOT }/collection`;
const MOUNT_PATH = '/mnt/sulla-files';
const TOKEN_REFRESH_MS = 4 * 60_000;

export interface SullaFilesMountCredentials {
  collectionId: string;
  token:        string;
}

export class SullaFilesMountManager extends EventEmitter {
  private executor?: VMExecutor;
  private credentialProvider?: () => Promise<SullaFilesMountCredentials>;
  private refreshTimer?: NodeJS.Timeout;
  private operation?: Promise<void>;
  private statusValue:SullaFilesNativeRuntimeStatus = {
    state: 'disabled', ready: false, generation: 0, sourceGrant: sullaFilesNativeSourceGrant(),
    reason: 'Native Files rollout is disabled pending native acceptance.',
  };

  status():SullaFilesNativeRuntimeStatus { return { ...this.statusValue } }

  configureGuest(executor:VMExecutor):void {
    this.executor = executor;
    if (!sullaFilesNativeSourceRolloutRequested()) this.publish('disabled', 'Native Files rollout is disabled pending native acceptance.');
  }

  clearGuest(executor:VMExecutor):void {
    if (this.executor === executor) this.executor = undefined;
  }

  async start(provider:() => Promise<SullaFilesMountCredentials>):Promise<void> {
    if (!sullaFilesNativeSourceRolloutRequested()) {
      this.publish('disabled', 'Native Files rollout is disabled pending native acceptance.');
      return;
    }
    if (this.operation) await this.operation;
    if (this.statusValue.ready) return;
    const operation = this.startInternal(provider);
    this.operation = operation;
    try { await operation } finally { if (this.operation === operation) this.operation = undefined }
  }

  private async startInternal(provider:() => Promise<SullaFilesMountCredentials>):Promise<void> {
    const executor = this.executor;
    if (!executor) {
      this.publish('error', 'The guest backend is not ready for the Files mount.');
      return;
    }
    this.credentialProvider = provider;
    this.publish('starting');
    try {
      await executor.execCommand({ root: true }, 'install', '-d', '-m', '0700', RUNTIME_ROOT);
      await executor.execCommand({ root: true }, 'install', '-d', '-m', '0700', '-o', '1000', '-g', '1000', MOUNT_PATH);
      // Recover a stale adapter/mount before admitting a fresh generation.
      await this.stopGuest();
      await this.refreshCredentials();
      await executor.execCommand(
        { root: true }, 'docker', 'compose', '-f', COMPOSE_FILE, '-p', 'sulla',
        'up', '-d', '--no-deps', '--force-recreate', 'sulla_files_fuse',
      );
      for (let attempt = 0; attempt < 20; attempt++) {
        const mounted = await executor.execCommand(
          { root: true, capture: true, expectFailure: true }, 'sh', '-c',
          `mountpoint -q ${ MOUNT_PATH } && printf ready || true`,
        );
        if (mounted.trim() === 'ready') {
          this.publish('ready', undefined, MOUNT_PATH);
          this.armRefresh();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('The guest adapter did not produce a verified FUSE mount');
    } catch (error) {
      await this.stopGuest().catch(() => undefined);
      this.publish('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async stop():Promise<void> {
    if (this.operation) await this.operation.catch(() => undefined);
    if (this.statusValue.state === 'disabled' && !this.executor) return;
    const operation = this.stopInternal();
    this.operation = operation;
    try { await operation } finally { if (this.operation === operation) this.operation = undefined }
  }

  private async stopInternal():Promise<void> {
    this.clearRefresh();
    this.publish('locking');
    try {
      await this.stopGuest();
      this.publish(sullaFilesNativeSourceRolloutRequested() ? 'starting' : 'disabled',
        sullaFilesNativeSourceRolloutRequested() ? 'Files is locked; the guest mount is unavailable.' : 'Native Files rollout is disabled pending native acceptance.');
    } catch (error) {
      this.publish('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async stopGuest():Promise<void> {
    const executor = this.executor;
    if (!executor) return;
    await executor.execCommand(
      { root: true, expectFailure: true }, 'docker', 'compose', '-f', COMPOSE_FILE, '-p', 'sulla',
      'stop', '-t', '10', 'sulla_files_fuse',
    ).catch(() => undefined);
    await executor.execCommand({ root: true, expectFailure: true }, 'fusermount3', '-u', MOUNT_PATH).catch(() => undefined);
    const mounted = await executor.execCommand(
      { root: true, capture: true, expectFailure: true }, 'sh', '-c',
      `mountpoint -q ${ MOUNT_PATH } && printf mounted || true`,
    );
    if (mounted.trim() === 'mounted') throw new Error('The guest Files mount did not unmount cleanly');
    await executor.execCommand({ root: true, expectFailure: true }, 'rm', '-f', TOKEN_FILE, COLLECTION_FILE);
  }

  private async refreshCredentials():Promise<void> {
    if (!this.executor || !this.credentialProvider) throw new Error('Files mount credential custody is unavailable');
    const credentials = await this.credentialProvider();
    if (!/^[0-9a-f-]{36}$/i.test(credentials.collectionId) || credentials.token.length < 64 || credentials.token.length > 4096) {
      throw new Error('Files mount credentials are invalid');
    }
    await this.writeGuestSecret(TOKEN_FILE, `${ credentials.token }\n`);
    await this.writeGuestSecret(COLLECTION_FILE, `${ credentials.collectionId }\n`);
  }

  private async writeGuestSecret(destination:string, contents:string):Promise<void> {
    if (!this.executor) throw new Error('Files mount guest is unavailable');
    const child = this.executor.spawn(
      { root: true }, 'sh', '-c', `umask 077; cat > ${ destination }.new && mv ${ destination }.new ${ destination }`,
    );
    const complete = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Guest secret write failed (${ code ?? 'signal' })`)));
    });
    child.stdin?.end(contents);
    await complete;
  }

  private armRefresh():void {
    this.clearRefresh();
    this.refreshTimer = setInterval(() => {
      this.refreshCredentials().catch(error => {
        console.warn('[SullaFiles] FUSE capability refresh failed:', error);
        this.stop().catch(stopError => console.warn('[SullaFiles] FUSE shutdown after capability failure failed:', stopError));
      });
    }, TOKEN_REFRESH_MS);
    this.refreshTimer.unref();
  }

  private clearRefresh():void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private publish(state:SullaFilesNativeRuntimeStatus['state'], reason?:string, mountPath?:string):void {
    this.statusValue = {
      state,
      ready: state === 'ready',
      generation: this.statusValue.generation + 1,
      sourceGrant: sullaFilesNativeSourceGrant(),
      ...(mountPath ? { mountPath } : {}),
      ...(reason ? { reason } : {}),
    };
    this.emit('changed', this.status());
  }
}

let instance:SullaFilesMountManager | undefined;
export function getSullaFilesMountManager():SullaFilesMountManager {
  instance ??= new SullaFilesMountManager();
  return instance;
}
