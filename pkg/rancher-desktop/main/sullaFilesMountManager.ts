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
const HEALTH_CHECK_MS = 60_000;
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
const RETRY_STEADY_MS = 5 * 60_000;

/** Backoff for the n-th consecutive failed attempt (0-based): 5s, 10s, 20s, 40s, 60s, then every 5 minutes. */
export function sullaFilesMountRetryDelay(failures:number):number {
  return RETRY_DELAYS_MS[failures] ?? RETRY_STEADY_MS;
}

/** Re-runs the backend's guest preparation and brings dependent compose services up to date. */
export type SullaFilesGuestRecovery = () => Promise<void>;

export interface SullaFilesMountCredentials {
  token:        string;
}

export class SullaFilesMountManager extends EventEmitter {
  private executor?: VMExecutor;
  private credentialProvider?: () => Promise<SullaFilesMountCredentials>;
  private refreshTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private retryFailures = 0;
  private recoverGuest?: SullaFilesGuestRecovery;
  /** Files is unlocked and wants the mount; false while locked or shutting down. */
  private wanted = false;
  /** Bumped by lock/backend teardown so scheduled or in-flight attempts stand down. */
  private lifecycle = 0;
  private recovering = false;
  private lastLoggedFailure?: string;
  private operation?: Promise<void>;
  private credentialWrite?: Promise<void>;
  private credentialGeneration = 0;
  private guestPreparationFailure?: string;
  /** True only after the backend prepared the anchor and no probe has since contradicted it. */
  private guestAnchorConfirmed = false;
  private statusValue:SullaFilesNativeRuntimeStatus = {
    state: 'disabled', ready: false, generation: 0, sourceGrant: sullaFilesNativeSourceGrant(),
    reason: DISABLED_REASON,
  };

  status():SullaFilesNativeRuntimeStatus { return { ...this.statusValue } }

  configureGuest(executor:VMExecutor, recover?:SullaFilesGuestRecovery):void {
    this.executor = executor;
    this.recoverGuest = recover;
    if (!sullaFilesNativeSourceRolloutRequested()) this.publish('disabled', DISABLED_REASON);
  }

  /**
   * Record the outcome of the backend's guest anchor preparation. A failure
   * leaves the adapter out of compose, so start() reports it instead of trying.
   */
  reportGuestPreparation(failureReason?:string):void {
    this.guestPreparationFailure = failureReason;
    this.guestAnchorConfirmed = !failureReason;
    if (!failureReason || !sullaFilesNativeSourceRolloutRequested()) return;
    this.publish('error', `The Files guest mount is unavailable: ${ failureReason }`);
    // A recovery attempt in flight schedules its own follow-up.
    if (!this.recovering) this.scheduleRetry(`The Files guest mount is unavailable: ${ failureReason }`);
  }

  clearGuest(executor:VMExecutor):void {
    if (this.executor === executor) {
      this.executor = undefined;
      this.recoverGuest = undefined;
      this.guestAnchorConfirmed = false;
      ++this.lifecycle;
      this.cancelRetry();
    }
  }

  /**
   * Whether containers may bind /mnt/sulla-files with rslave propagation: the
   * backend confirmed our shared anchor (or the adapter above it) this
   * generation. Docker refuses rslave binds of a non-shared path, so callers
   * omit the bind otherwise and the container still starts.
   */
  guestMountAvailable():boolean {
    return this.guestAnchorConfirmed && !this.guestPreparationFailure;
  }

  async start(provider:() => Promise<SullaFilesMountCredentials>):Promise<void> {
    if (!sullaFilesNativeSourceRolloutRequested()) {
      this.publish('disabled', DISABLED_REASON);
      return;
    }
    // Unlock (re)starts the schedule from the first, shortest delay.
    this.wanted = true;
    this.credentialProvider = provider;
    this.retryFailures = 0;
    this.cancelRetry();
    const lifecycle = this.lifecycle;

    await this.serialize(() => this.attempt(lifecycle));
  }

  /**
   * One serialized attempt to bring the mount up. Failures never escape: they
   * publish 'error' with a reason and schedule the next retry, so a failed
   * preparation or start never stays failed for the session.
   */
  private async attempt(lifecycle:number):Promise<void> {
    if (lifecycle !== this.lifecycle || !this.wanted || this.statusValue.ready) return;
    const provider = this.credentialProvider;

    try {
      if (!provider) throw new Error('Files mount credential custody is unavailable');
      if (this.guestPreparationFailure || !this.guestAnchorConfirmed) {
        if (!this.recoverGuest) {
          throw new Error(`The Files guest mount is unavailable: ${ this.guestPreparationFailure ?? 'the guest anchor is not prepared' }`);
        }
        this.recovering = true;
        try { await this.recoverGuest() } finally { this.recovering = false }
        if (lifecycle !== this.lifecycle) return;
        if (!this.guestMountAvailable()) {
          throw new Error(`The Files guest mount is unavailable: ${ this.guestPreparationFailure ?? 'the guest anchor is not prepared' }`);
        }
      }
      await this.startInternal(provider);
      this.retryFailures = 0;
      if (this.lastLoggedFailure) console.log('[SullaFiles] Files guest mount recovered');
      this.lastLoggedFailure = undefined;
    } catch (error) {
      if (lifecycle !== this.lifecycle || !this.wanted) return;
      const reason = error instanceof Error ? error.message : String(error);

      if (this.statusValue.state !== 'error' || this.statusValue.reason !== reason) this.publish('error', reason);
      this.scheduleRetry(reason);
    }
  }

  private scheduleRetry(reason:string):void {
    if (!this.wanted || this.retryTimer) return;
    const delay = sullaFilesMountRetryDelay(this.retryFailures++);
    const lifecycle = this.lifecycle;

    if (reason !== this.lastLoggedFailure) {
      console.warn(`[SullaFiles] Files guest mount unavailable: ${ reason }; retrying in ${ Math.round(delay / 1000) }s`);
      this.lastLoggedFailure = reason;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.serialize(() => this.attempt(lifecycle)).catch(() => undefined);
    }, delay);
    this.retryTimer.unref?.();
  }

  private cancelRetry():void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async startInternal(provider:() => Promise<SullaFilesMountCredentials>):Promise<void> {
    const executor = this.executor;
    if (!executor) throw new Error('The guest backend is not ready for the Files mount.');
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
    // Lock drains the mount: no further retries, and an attempt already in
    // flight finishes first (serialized) and then sees the new lifecycle.
    this.wanted = false;
    ++this.lifecycle;
    this.cancelRetry();
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
        this.runtimeFailure(generation, `FUSE capability refresh failed: ${ error instanceof Error ? error.message : String(error) }`);
      });
    }, TOKEN_REFRESH_MS);
    this.refreshTimer.unref?.();
    // Notice an adapter that disappears (container exit, external unmount).
    this.healthTimer = setInterval(() => {
      const executor = this.executor;

      if (!executor || generation !== this.credentialGeneration || !this.statusValue.ready) return;
      // An unreadable mount table is not evidence the adapter is gone.
      probeFilesAnchor(executor, MOUNT_PATH).then((probe) => {
        if (probe.state !== 'adapter') this.runtimeFailure(generation, 'The guest Files adapter mount disappeared');
      }, () => undefined);
    }, HEALTH_CHECK_MS);
    this.healthTimer.unref?.();
  }

  /** A live mount failed: drain what is left of it and recover on the retry schedule. */
  private runtimeFailure(generation:number, reason:string):void {
    this.serialize(async() => {
      if (generation !== this.credentialGeneration || !this.wanted) return;
      this.clearRefresh();
      ++this.credentialGeneration;
      await this.stopGuest().catch(() => undefined);
      this.publish('error', reason);
      this.scheduleRetry(reason);
    }).catch(() => undefined);
  }

  private clearRefresh():void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.refreshTimer = undefined;
    this.healthTimer = undefined;
  }

  private async isAdapterMounted(executor:VMExecutor):Promise<boolean> {
    return await this.mountState(executor) === 'adapter';
  }

  private async mountState(executor:VMExecutor):Promise<'adapter' | 'anchor' | 'none' | 'unexpected'> {
    // An unreadable mount table is treated as "nothing mounted", which the
    // callers then refuse as a missing anchor.
    const probe = await probeFilesAnchor(executor, MOUNT_PATH).catch(() => undefined);

    // A probe can only withdraw confirmation; only the backend's preparation
    // (which also makes the anchor shared) grants it.
    if (!probe || probe.state === 'not-mounted' || probe.state === 'unexpected') this.guestAnchorConfirmed = false;
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
