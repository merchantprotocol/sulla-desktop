import { EventEmitter } from 'node:events';

import type { VMExecutor } from '@pkg/backend/backend';
import { SULLA_FILES_GUEST_MOUNT_PATH, probeFilesAnchor } from '@pkg/backend/guestMountInfo';
import type { SullaFilesNativeRuntimeStatus } from '@pkg/utils/sullaFilesNativeSource';
import { sullaFilesNativeSourceGrant, sullaFilesNativeSourceRolloutRequested } from '@pkg/utils/sullaFilesNativeSource';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const COMPOSE_FILE = '/tmp/sulla-docker-compose.yml';
const RUNTIME_ROOT = '/var/lib/sulla/files-fuse';
const TOKEN_FILE = `${ RUNTIME_ROOT }/token`;
const MOUNT_PATH = SULLA_FILES_GUEST_MOUNT_PATH;
const TOKEN_REFRESH_MS = 4 * 60_000;
const DISABLED_REASON = 'The Files mount is unavailable.';

export interface SullaFilesMountCredentials {
  token:        string;
}

export class SullaFilesMountManager extends EventEmitter {
  private executor?: VMExecutor;
  private credentialProvider?: () => Promise<SullaFilesMountCredentials>;
  private refreshTimer?: NodeJS.Timeout;
  private operation?: Promise<void>;
  private credentialWrite?: Promise<void>;
  private credentialGeneration = 0;
  private guestPreparationFailure?: string;
  private statusValue:SullaFilesNativeRuntimeStatus = {
    state: 'disabled', ready: false, generation: 0, sourceGrant: sullaFilesNativeSourceGrant(),
    reason: DISABLED_REASON,
  };

  status():SullaFilesNativeRuntimeStatus { return { ...this.statusValue } }

  configureGuest(executor:VMExecutor):void {
    this.executor = executor;
    if (!sullaFilesNativeSourceRolloutRequested()) this.publish('disabled', DISABLED_REASON);
  }

  /**
   * Record the outcome of the backend's guest anchor preparation. A failure
   * leaves the adapter out of compose, so start() reports it instead of trying.
   */
  reportGuestPreparation(failureReason?:string):void {
    this.guestPreparationFailure = failureReason;
    if (failureReason && sullaFilesNativeSourceRolloutRequested()) this.publish('error', `The Files guest mount is unavailable: ${ failureReason }`);
  }

  clearGuest(executor:VMExecutor):void {
    if (this.executor === executor) this.executor = undefined;
  }

  async start(provider:() => Promise<SullaFilesMountCredentials>):Promise<void> {
    if (!sullaFilesNativeSourceRolloutRequested()) {
      this.publish('disabled', DISABLED_REASON);
      return;
    }
    await this.serialize(async() => {
      if (this.statusValue.ready) return;
      if (this.guestPreparationFailure) {
        this.publish('error', `The Files guest mount is unavailable: ${ this.guestPreparationFailure }`);
        return;
      }
      await this.startInternal(provider);
    });
  }

  private async startInternal(provider:() => Promise<SullaFilesMountCredentials>):Promise<void> {
    const executor = this.executor;
    if (!executor) {
      this.publish('error', 'The guest backend is not ready for the Files mount.');
      return;
    }
    this.credentialProvider = provider;
    const credentialGeneration = ++this.credentialGeneration;
    this.publish('starting');
    try {
      await executor.execCommand({ root: true }, 'install', '-d', '-m', '0700', RUNTIME_ROOT);
      // Recover a stale adapter/mount before admitting a fresh generation.
      await this.stopGuest();
      if (await this.mountState(executor) !== 'anchor') throw new Error('The Files propagation anchor is unavailable');
      await this.refreshCredentials(credentialGeneration);
      await executor.execCommand(
        { root: true }, 'docker', 'compose', '-f', COMPOSE_FILE, '-p', 'sulla',
        'up', '-d', '--no-deps', '--force-recreate', 'sulla_files_fuse',
      );
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await this.isAdapterMounted(executor)) {
          // Prove adapter health with a real Files-backed directory read.
          // This does not authorize an agent; that admission remains disabled
          // until Files can enforce a grant-scoped per-agent/job view.
          await executor.execCommand({}, 'sh', '-c', 'ls -A "$1" >/dev/null', 'sh', MOUNT_PATH);
          this.publish('ready', undefined, MOUNT_PATH);
          this.armRefresh(credentialGeneration);
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
    await this.serialize(async() => {
      if (this.statusValue.state === 'disabled' && !this.executor) return;
      await this.stopInternal();
    });
  }

  private async stopInternal():Promise<void> {
    this.clearRefresh();
    ++this.credentialGeneration;
    this.publish('locking');
    try {
      await this.credentialWrite?.catch(() => undefined);
      await this.stopGuest();
      this.credentialProvider = undefined;
      this.publish(sullaFilesNativeSourceRolloutRequested() ? 'starting' : 'disabled',
        sullaFilesNativeSourceRolloutRequested() ? 'Files is locked; the guest mount is unavailable.' : DISABLED_REASON);
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
    const mountedBeforeUnmount = await this.mountState(executor);
    if (mountedBeforeUnmount === 'adapter') {
      await executor.execCommand({ root: true, expectFailure: true }, 'fusermount3', '-u', MOUNT_PATH).catch(() => undefined);
      // fusermount3 ships with fuse3, which the guest may lack; root can
      // unmount a FUSE filesystem with plain (BusyBox or util-linux) umount.
      if (await this.mountState(executor) === 'adapter') {
        await executor.execCommand({ root: true, expectFailure: true }, 'umount', MOUNT_PATH).catch(() => undefined);
      }
    }
    const mountState = await this.mountState(executor);
    await executor.execCommand(
      { root: true }, 'rm', '-f',
      TOKEN_FILE, `${ TOKEN_FILE }.new`,
    );
    if (mountState === 'adapter') throw new Error('The guest Files mount did not unmount cleanly');
    if (mountState === 'unexpected') throw new Error('An unexpected mount occupies the guest Files path');
  }

  private async refreshCredentials(generation:number):Promise<void> {
    const previous = this.credentialWrite?.catch(() => undefined) ?? Promise.resolve();
    const write = previous.then(async() => {
      if (!this.executor || !this.credentialProvider || generation !== this.credentialGeneration) throw new Error('Files mount credential custody is unavailable');
      const credentials = await this.credentialProvider();
      if (generation !== this.credentialGeneration) throw new Error('Files mount credential generation changed');
      if (credentials.token.length < 64 || credentials.token.length > 4096) {
        throw new Error('Files mount credentials are invalid');
      }
      await this.writeGuestSecret(TOKEN_FILE, `${ credentials.token }\n`);
      if (generation !== this.credentialGeneration) throw new Error('Files mount credential generation changed');
    });

    this.credentialWrite = write;
    try { await write } finally { if (this.credentialWrite === write) this.credentialWrite = undefined; }
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

  private armRefresh(generation:number):void {
    this.clearRefresh();
    this.refreshTimer = setInterval(() => {
      this.refreshCredentials(generation).catch(error => {
        if (generation !== this.credentialGeneration) return;
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

  private async isAdapterMounted(executor:VMExecutor):Promise<boolean> {
    return await this.mountState(executor) === 'adapter';
  }

  private async mountState(executor:VMExecutor):Promise<'adapter' | 'anchor' | 'none' | 'unexpected'> {
    // An unreadable mount table is treated as "nothing mounted", which the
    // callers then refuse as a missing anchor.
    const probe = await probeFilesAnchor(executor, MOUNT_PATH).catch(() => undefined);

    if (!probe || probe.state === 'not-mounted') return 'none';
    return probe.state;
  }

  private async serialize(action:() => Promise<void>):Promise<void> {
    const previous = this.operation?.catch(() => undefined) ?? Promise.resolve();
    const operation = previous.then(action);

    this.operation = operation;
    try { await operation } finally { if (this.operation === operation) this.operation = undefined; }
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
