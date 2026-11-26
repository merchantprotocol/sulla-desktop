// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// VM backend for macOS, driving the native Sulla runtime.

import { ChildProcess, spawn as spawnWithSignal } from 'child_process';
import crypto from 'crypto';
import events from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Electron, { ipcMain } from 'electron';
import merge from 'lodash/merge';
import omit from 'lodash/omit';
import yaml from 'yaml';

import { SULLA_FILES_FUSE_HEALTHCHECK, SULLA_FILES_HEALTHCHECK } from './sullaFilesHealthchecks';
import { decideFilesFuseRecovery, hashFilesFuseServiceDefinition, toFilesFuseContainerState } from './sullaFilesFuseRecovery';
import { Architecture, BackendError, BackendEvents, BackendProgress, BackendSettings, execOptions, FailureDetails, RestartReasons, State, VMBackend, VMExecutor } from './backend';
import { ContainerEngineClient, MobyClient } from './containerClient';
import {
  bundledImageLockError, bundledImagesDir, BundledImagesDiskSpaceGuard, currentBundledImageLock, ensureBundledImages, pinComposeImages, sullaRuntimeGuestDocker, useBundledImages,
} from './bundledImages';
import ProgressTracker, { getProgressErrorDescription } from './progressTracker';
import { composeImageFields, resolveSullaServiceImage, shouldRefreshSullaServiceImage } from './sullaServiceImages';
import { filesTlsBind } from './filesTlsIdentity';
import { vaultTlsBind } from './vaultTlsIdentity';
import { accountsSecretBinds, assertNoHostBindMounts, provisionAccountsSecretsInGuest } from './sullaComposeMounts';
import { UserStoppedContainers } from './sullaContainerHealth';
import {
  clearOnDemandServices, configureOnDemandServices, ON_DEMAND_SERVICES, type OnDemandServiceName, SULLA_COMPOSE_COMMAND,
} from './onDemandServices';
import { reconcileComposeService } from './sullaServiceReconcile';
import { ComposeDriftActions } from './ComposeDriftActions';
import { ComposeSecretGuard } from './ComposeSecretGuard';
import { ContainerDriftReconciler } from './ContainerDriftReconciler';
import { PostgresAuthLifecycle } from './PostgresAuthLifecycle';
import { GuestServiceSecretInstallState } from './GuestServiceSecretInstallState';
import { ServiceSecretComposeValues } from './ServiceSecretComposeValues';
import { SullaComposeRegeneration } from './SullaComposeRegeneration';
import {
  ComposeContainerNameReconciler, ComposeServiceHealthWaiter, type ComposeServiceTarget, type DockerCli,
} from './sullaComposeContainers';
import { NamedVolumeMigrator, type NamedVolumeSpec } from './sullaVolumeMigration';
import { ensureAgentNetworkCommand, provisionStateCommand, threatProxyComposeService } from './threatProxyEgress';
import { findSullaRuntimeArtifacts, sullaRuntimeSockets } from './sullaRuntime/artifacts';
import { ensureSullaRuntimeDataDisk } from './sullaRuntime/dataDisk';
import { guestUserFor, NativeRuntime, SullaRuntimeShare, SullaRuntimeStartError } from './sullaRuntime/NativeRuntime';
import { SullaRuntimePortForwarder } from './sullaRuntime/portForwarder';
import { FilesCloudIdentityProjection } from './sullaRuntime/FilesCloudIdentityProjection';
import { GuestTlsIdentityProvisioner } from './sullaRuntime/GuestTlsIdentityProvisioner';
import { HostServiceIdentityStore } from './sullaRuntime/HostServiceIdentityStore';
import { ManagedContainerHealthWatcher } from './sullaRuntime/ManagedContainerHealthWatcher';
import { SullaServiceImageFreshness } from './sullaRuntime/SullaServiceImageFreshness';
import { SullaAccountsDatabaseRepository } from './Repositories/SullaAccountsDatabaseRepository';
import { sullaRuntimeShareList } from './sullaRuntime/shares';
import {
  assertSupportedOnSullaRuntime, isSullaRuntimeActive, setSullaOptionalServicesPlanned, setSullaRuntimeActive, setSullaRuntimeStartFailure,
  SullaRuntimeUnsupportedError, takeSullaRuntimeSuspendRequest,
} from './sullaRuntime/state';

import { serviceSecretProvider } from '@pkg/agent/app/Providers/ServiceSecretServiceProvider';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import PROVISION_VAULT_TLS from '@pkg/assets/scripts/provision-vault-tls';
import PROVISION_FILES_TLS from '@pkg/assets/scripts/provision-files-tls';
import SULLA_DOCKER_COMPOSE from '@pkg/assets/sulla-docker-compose.yaml';
import * as settingsImpl from '@pkg/config/settingsImpl';
import { readExistingDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import mainEvents from '@pkg/main/mainEvents';
import { refreshVaultPinnedSessions } from '@pkg/main/vaultTls';
import { refreshFilesPinnedSessions } from '@pkg/main/sullaFilesTls';
import {
  SULLA_FILES_GUEST_MOUNT_PATH, SULLA_FILES_GUEST_PARENT_PATH, SULLA_FILES_GUEST_FUSE_BIND, prepareSullaFilesGuestAnchorDraining,
} from '@pkg/backend/guestMountInfo';
import { getSullaFilesBackups } from '@pkg/main/sullaFilesBackups';
import { getSullaFilesMountManager } from '@pkg/main/sullaFilesMountManager';
import { exec as sudo } from '@pkg/sudo-prompt';
import { expectVaultContainer, instantiateSullaStart, markSullaDockerServicesStarted, markVaultContainerReady } from '@pkg/sulla';
import * as childProcess from '@pkg/utils/childProcess';
import clone from '@pkg/utils/clone';
import dockerDirManager from '@pkg/utils/dockerDirManager';
import { sullaFilesNativeSourceRolloutRequested } from '@pkg/utils/sullaFilesNativeSource';
import Logging from '@pkg/utils/logging';
import { hostPort, loopbackOrigin } from '@pkg/utils/instance';
import paths from '@pkg/utils/paths';
import { jsonStringifyWithWhiteSpace } from '@pkg/utils/stringify';
import { RecursivePartial } from '@pkg/utils/typeUtils';

/**
 * Enumeration for tracking what operation the backend is undergoing.
 */
export enum Action {
  NONE = 'idle',
  STARTING = 'starting',
  STOPPING = 'stopping',
}

class ManagedServicesReconciliationCancelled extends Error {
  constructor() {
    super('Managed-service reconciliation was superseded by a backend stop or restart');
  }
}

const console = Logging.sullaRuntime;

const ROOT_DOCKER_CONFIG_PATH = '/root/.docker/config.json';

/** The Mac's loopback as seen from the guest. */
const HOST_GATEWAY = '192.168.5.2';

/**
 * NODE_OPTIONS for a Node service container. The old-space cap is the heap
 * the service may grow to; mem_limit is that plus ~100 MB for code, buffers
 * and native memory. A small young generation (semi-space, MB) keeps idle
 * services from holding on to tens of MB of nursery after a burst. Only flags
 * Node accepts in NODE_OPTIONS belong here (e.g. not --single-threaded-gc).
 */
function serviceNodeOptions(heapMiB: number, semiSpaceMiB = 2): string {
  return `--max-old-space-size=${ heapMiB } --max-semi-space-size=${ semiSpaceMiB }`;
}

function logStartupPhase(phase: string, startedAt: number, details = ''): void {
  const suffix = details ? ` ${ details }` : '';

  console.log(`[startup-phase] ${ new Date().toISOString() } phase=${ phase } elapsedMs=${ Date.now() - startedAt }${ suffix }`);
}

/** Below this much free space on the Mac a fresh install stops; below the warning level it only warns. */
const DISK_WARN_BYTES = 20 * 1024 ** 3;

function formatGB(bytes: number): string {
  return `${ (bytes / 1024 ** 3).toFixed(1) } GB`;
}

const OPTIONAL_SERVICE_ATTEMPTS = 8;
/** After the fast attempts, optional services are reconciled this often (plus jitter) until all are healthy. */
const OPTIONAL_SERVICE_RECONCILE_MS = 60_000;
/** How long Docker may take to answer after the guest reports it ready. */
const DOCKER_API_TIMEOUT_MS = 120_000;

/** Stateful services whose image declares a VOLUME the compose file now names. */
const SULLA_NAMED_VOLUME_MIGRATIONS: ReadonlyArray<NamedVolumeSpec> = [
  { service: 'redis', container: 'sulla_redis', mountPath: '/data', volume: 'sulla_redis_data', composeVolume: 'sulla_redis_data' },
];

/**
 * The VM or its Docker did not come up. `message` is written for the user
 * (background.ts shows it with Try again); the cause stays in the log.
 */
export class SullaRuntimeBootError extends BackendError {
  constructor(readonly reason: 'disk-space' | 'data-disk' | 'timeout' | 'docker' | 'shares' | 'start', message: string) {
    super('Sulla couldn\'t start its engine', message, true);
  }
}

function bootFailure(error: unknown): SullaRuntimeBootError {
  if (error instanceof SullaRuntimeBootError) return error;
  if (error instanceof SullaRuntimeStartError) {
    if (error.reason === 'data-disk') return new SullaRuntimeBootError('data-disk', 'Sulla couldn\'t open its disk. It may need repair.');
    if (error.reason === 'timeout') return new SullaRuntimeBootError('timeout', 'Sulla\'s engine took too long to start.');
  }

  return new SullaRuntimeBootError('start', 'Sulla\'s engine stopped while starting.');
}

/**
 * SullaRuntimeBackend drives the native Sulla runtime: a macOS
 * Virtualization.framework VM booted and controlled through the
 * `sulla-runtime` host binary. Guest commands run through
 * `sulla-runtime exec`.
 */
/** Bundled image names (packaging/bundled-images.yaml) that Postgres and Redis run from; loaded and started first. */
const DATABASE_IMAGE_NAMES = new Set(['sulla-postgres', 'redis']);

export default class SullaRuntimeBackend extends events.EventEmitter implements VMBackend, VMExecutor {
  constructor(arch: Architecture) {
    super();
    this.arch = arch;

    this.progressTracker = new ProgressTracker((progress) => {
      this.progress = progress;
      this.emit('progress');
    }, console);
    // Service images embedded by the build (scripts/fetch-bundled-assets.ts).
    useBundledImages(path.join(paths.resources, 'darwin', 'images'));
    // The Repair action (IPC 'sulla-runtime:repair-services').
    mainEvents.on('sulla-managed-services-repair', () => {
      this.repairManagedServices().catch(error => console.warn('[Sulla] Repair failed:', error));
    });
    // Stop/Start/Restart/Delete from the Docker tab (IPC 'docker/container-intent').
    mainEvents.on('sulla-container-intent', (intent, names) => {
      this.#userStopped.record(intent, names);
    });
    // The service secret: tell the provider how to inspect and open the guest
    // database, and regenerate compose when the database's value wins.
    serviceSecretProvider.useInstallState(new GuestServiceSecretInstallState(
      this.#quietGuestDocker, target => this.waitForDockerServiceHealthy(target, 300),
    ));
    serviceSecretProvider.onChange(reason => this.regenerateComposeAfterSecretChange(reason));
  }

  readonly executor = this;
  readonly managesSullaServices = true;
  #containerEngineClient: ContainerEngineClient | undefined;
  #activeOptionalSullaServices = new Set<string>();
  /** Settles when the first background pass over the optional services finishes. */
  #optionalServicesSettled: Promise<void> = Promise.resolve();
  /** The generation whose optional-service reconcile and health watch are running (one each per generation). */
  #optionalReconcileGeneration?: number;
  /** Runs the next optional-service reconcile now instead of after its delay. */
  #wakeOptionalReconcile?: () => void;
  #optionalSullaFallbackImages = new Map<string, { env: string; image: string }>();
  #managedSullaRefreshImages = new Map<string, string>();
  /** Services running an image bundled with the app: the exact reference they must run. */
  #pinnedSullaImages = new Map<string, string>();
  #managedServicesReconciliation?: Promise<void>;
  #hostPreparationDeferred = false;
  #backendStartSettled?: Promise<void>;
  #managedServicesGeneration = 0;
  /** One opportunistic cache/image trim per successful managed-services start. */
  #startupBuildCacheGcGeneration?: number;
  /** FUSE adapter services whose dead mount was drained; restart the process in-place. */
  #staleFilesAdapters = new Set<string>();
  #lastFilesFuseRestartMs?: number;
  /** Every compose service with a fixed container_name, from the last prepared compose file. */
  #composeTargets: ComposeServiceTarget[] = [];
  readonly #guestDocker: DockerCli = { run: args => this.execCommand({ capture: true, root: true, expectFailure: true }, 'docker', ...args) };
  /**
   * Guest Docker that never logs command output: used where stdout carries the service secret.
   * Bounded; SIGKILL because spawnFile treats a SIGTERM exit as success (empty output would read as "fresh").
   */
  readonly #quietGuestDocker: DockerCli = {
    run: async args => (await childProcess.spawnFile(paths.sullaRuntime, this.guestExecArgs({ root: true }, ['docker', ...args]),
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: GuestServiceSecretInstallState.DOCKER_TIMEOUT_MS, killSignal: 'SIGKILL' })).stdout,
  };
  /** Finds compose containers by label and heals names left by an interrupted re-create. */
  readonly #composeContainers = new ComposeContainerNameReconciler(this.#guestDocker, 'sulla', console);
  readonly #composeHealth = new ComposeServiceHealthWaiter(this.#guestDocker, this.#composeContainers);
  readonly #volumeMigrator = new NamedVolumeMigrator(this.#guestDocker, this.#composeContainers, 'sulla', console);
  /** Sulla containers the person stopped from the Docker tab; supervision leaves them stopped. */
  readonly #userStopped = new UserStoppedContainers();
  readonly #filesCloudIdentity = new FilesCloudIdentityProjection(
    readExistingDesktopDeviceId, contents => this.writeFile(FilesCloudIdentityProjection.GUEST_ENV_FILE, contents, 0o600),
  );
  readonly #healthWatcher = new ManagedContainerHealthWatcher(
    this, this.#userStopped,
    async() => (await import('@pkg/agent/services/AgentContainerLauncher')).repairHostRelay(),
    error => error instanceof ManagedServicesReconciliationCancelled,
    undefined,
    async() => {
      const { getSullaFilesWatcher } = await import('@pkg/main/sullaFilesWatcher');
      void getSullaFilesWatcher().recoverAfterContainerRestart().catch(error => console.warn('[SullaFiles] restart recovery failed:', error));
    },
    (target, heal, checkpoint) => this.#composeRegeneration.serialize(async() => {
      checkpoint();
      if (this.#userStopped.has(target.container)) return;
      const changed = await this.#filesCloudIdentity.refresh();
      const drifted = changed || await this.#composeDrift.hasDrifted(target);

      checkpoint();
      if (!this.#userStopped.has(target.container)) await heal(drifted);
    }),
  );
  readonly #identityStore = new HostServiceIdentityStore(() => Electron.safeStorage, () => paths.appHome);
  readonly #tlsIdentities = new GuestTlsIdentityProvisioner(
    this, { vault: PROVISION_VAULT_TLS, files: PROVISION_FILES_TLS },
    { refreshVault: refreshVaultPinnedSessions, refreshFiles: refreshFilesPinnedSessions }, () => paths.appHome,
  );
  readonly #imageFreshness = new SullaServiceImageFreshness(this, this.#managedSullaRefreshImages, this.#pinnedSullaImages,
    (target, timeoutSec, generation) => this.waitForDockerServiceHealthy(target, timeoutSec, generation));
  readonly #accountsDatabase = new SullaAccountsDatabaseRepository({
    capture: args => this.execCommand({ capture: true, root: true }, ...args),
    run:     args => this.execCommand({ root: true }, ...args),
  });
  readonly #driftActions = new ComposeDriftActions(this.#guestDocker, (...command) => this.execCommand({ root: true }, ...command),
    (target, timeoutSec) => this.waitForDockerServiceHealthy(target, timeoutSec), console);
  /** Mid-session drift sweeps share one reconciler so a container that cannot converge is not recreated in a loop. */
  readonly #composeDrift = new ContainerDriftReconciler(this.#guestDocker, SULLA_COMPOSE_COMMAND.slice(1),
    service => this.#driftActions.recreate(service), console, target => this.#driftActions.settle(target));
  readonly #composeRegeneration = new SullaComposeRegeneration(async() => {
    await this.prepareSullaComposeFile();

    // The Files mount manager owns the FUSE adapter, and on-demand runtimes
    // may be mid-invocation; neither carries the service secret.
    return this.#composeTargets.filter(target => target.service !== 'sulla_files_fuse' && !(target.service in ON_DEMAND_SERVICES));
  }, this.#composeDrift, console, () => this.reconcileFilesFuseDefinition());
  /** Network logins to PostgreSQL: role password follows the secret, then trust → scram (backend/PostgresAuthLifecycle.ts). */
  readonly #postgresAuth = PostgresAuthLifecycle.forGuest({ binary: paths.sullaRuntime, guestArgs: command => this.guestExecArgs({ root: true }, command), drift: this.#composeDrift,
    waitServiceHealthy: (target, timeoutSec) => this.waitForDockerServiceHealthy(target, timeoutSec), accountsPasswordFile: path.join(paths.appHome, 'accounts', 'database.password'), secret: serviceSecretProvider });
  #lastGuestRecovery = 0;
  #lastFilesGuestMountFailure?: string;
  #filesFuseConfigHash?: string;
  /** The native Sulla runtime VM. */
  #sullaRuntime?: NativeRuntime;
  #sullaRuntimeForwarder?: SullaRuntimePortForwarder;

  private beginManagedServicesGeneration(): number {
    this.#managedServicesGeneration += 1;

    return this.#managedServicesGeneration;
  }

  private invalidateManagedServicesGeneration(): void {
    this.#managedServicesGeneration += 1;
  }

  private assertManagedServicesGeneration(generation: number): void {
    if (generation !== this.#managedServicesGeneration) {
      throw new ManagedServicesReconciliationCancelled();
    }
  }

  get containerEngineClient() {
    if (this.#containerEngineClient) {
      return this.#containerEngineClient;
    }

    throw new Error('Invalid state, no container engine client available.');
  }

  /** The current config state. */
  protected cfg: BackendSettings | undefined;

  /** The current architecture. */
  protected readonly arch: Architecture;

  /** Whether we can prompt the user for administrative access - this setting persists in the config. */
  #adminAccess = false;

  /** A transient property that prevents prompting via modal UI elements. */
  #noModalDialogs = false;

  get noModalDialogs() {
    return this.#noModalDialogs;
  }

  set noModalDialogs(value: boolean) {
    this.#noModalDialogs = value;
  }

  /** Helper object to manage progress notifications. */
  progressTracker;

  /**
   * The current operation underway; used to avoid responding to state changes
   * when we're in the process of doing a different one.
   */
  currentAction: Action = Action.NONE;

  writeSetting(changed: RecursivePartial<BackendSettings>) {
    if (changed) {
      mainEvents.emit('settings-write', changed);
    }
    this.cfg = merge({}, this.cfg, changed);
  }

  protected internalState: State = State.STOPPED;
  get state() {
    return this.internalState;
  }

  protected setState(state: State): Promise<void> {
    this.internalState = state;
    this.emit('state-changed', this.state);

    return Promise.resolve();
  }

  progress: BackendProgress = { current: 0, max: 0 };

  debug = false;

  emit: VMBackend['emit'] = events.EventEmitter.prototype.emit;

  get backend(): 'sulla-runtime' {
    return 'sulla-runtime';
  }

  get cpus(): Promise<number> {
    return Promise.resolve(this.#sullaRuntime ? this.cfg?.virtualMachine.numberCPUs ?? 0 : 0);
  }

  get memory(): Promise<number> {
    return Promise.resolve(this.#sullaRuntime ? this.cfg?.virtualMachine.memoryInGB ?? 0 : 0);
  }

  protected ensureArchitectureMatch() {
    if (os.platform().startsWith('darwin')) {
      // Since we now use native Electron, the only case this might be an issue
      // is the user is running under Rosetta. Flag that.
      if (Electron.app.runningUnderARM64Translation) {
        // Using 'aarch64' and 'x86_64' in the error because that's what we use
        // for the DMG suffix, e.g. "Sulla Desktop.aarch64.dmg"
        throw new BackendError('Fatal Error', `Sulla Desktop for x86_64 does not work on aarch64.`, true);
      }
    }
  }

  /** The guest's address as seen from the host side of the runtime's NAT. */
  get ipAddress(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  getBackendInvalidReason(): Promise<BackendError | null> {
    return Promise.resolve(null);
  }

  /** argv for `sulla-runtime exec` running the given command in the guest. */
  protected guestExecArgs(options: execOptions, command: string[]): string[] {
    const args = ['exec'];

    if (options.cwd) {
      args.push('--workdir', String(options.cwd));
    }

    // The guest command user is already root, so `options.root` needs no sudo.
    return [...args, '--', ...command];
  }

  /** Run the given command within the guest. */
  guestSpawn(options: execOptions, command: string[]): ChildProcess {
    return spawnWithSignal(
      paths.sullaRuntime,
      this.guestExecArgs(options, command),
      { ...omit(options, 'cwd', 'root', 'expectFailure', 'logStream'), env: { ...process.env, ...options.env ?? {} } });
  }

  async execCommand(...command: string[]): Promise<void>;
  async execCommand(options: execOptions, ...command: string[]): Promise<void>;
  async execCommand(options: execOptions & { capture: true }, ...command: string[]): Promise<string>;
  async execCommand(optionsOrArg: execOptions | string, ...command: string[]): Promise<void | string> {
    let options: execOptions & { capture?: boolean } = {};

    if (typeof optionsOrArg === 'string') {
      command = [optionsOrArg].concat(command);
    } else {
      options = optionsOrArg;
    }

    const args = this.guestExecArgs(options, command);
    const label = `sulla-runtime ${ args.join(' ') }`;

    try {
      const { stdout, stderr } = await childProcess.spawnFile(paths.sullaRuntime, args,
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const formatBreak = stderr || stdout ? '\n' : '';

      console.log(`> ${ label }${ formatBreak }${ stderr }${ stdout }`);

      if (options.capture) {
        return stdout;
      }
    } catch (ex: any) {
      if (!(options.expectFailure ?? false)) {
        console.error(`> ${ label }\n$`, ex);
        if (this.debug && 'stdout' in ex) {
          console.error('stdout:', ex.stdout);
        }
        if (this.debug && 'stderr' in ex) {
          console.error('stderr:', ex.stderr);
        }
      }
      throw ex;
    }
  }

  spawn(...command: string[]): childProcess.ChildProcess;
  spawn(options: execOptions, ...command: string[]): childProcess.ChildProcess;
  spawn(optionsOrCommand: string | execOptions, ...command: string[]): ChildProcess {
    let options: execOptions = {};
    const args = command.concat();

    if (typeof optionsOrCommand === 'string') {
      args.unshift(optionsOrCommand);
    } else {
      options = optionsOrCommand;
    }

    return this.guestSpawn(options, args);
  }

  /** Run `sulla-runtime` with the given host-side arguments (e.g. `copy`), feeding optional stdin. */
  protected async runtimeCommand(args: string[], input?: string): Promise<string> {
    const proc = spawnWithSignal(paths.sullaRuntime, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    proc.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    proc.stdin?.on('error', () => { /* the exit code reports the failure */ });
    proc.stdin?.end(input);
    await new Promise<void>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code, signal) => {
        if (code || signal) {
          reject(new Error(`sulla-runtime ${ args[0] } exited with ${ code ?? signal }: ${ Buffer.concat(stderr).toString('utf-8').trim() }`));
        } else {
          resolve();
        }
      });
    });

    return Buffer.concat(stdout).toString('utf-8');
  }

  async readFile(filePath: string, options?: { encoding?: BufferEncoding }): Promise<string> {
    try {
      // Not logged through execCommand: file contents would flood the log.
      const contents = await this.runtimeCommand(['exec', '--', '/bin/cat', filePath]);

      return Buffer.from(contents, 'utf-8').toString(options?.encoding ?? 'utf-8');
    } catch (ex: any) {
      console.error(`Failed to read file ${ filePath }:`, ex);
      throw ex;
    }
  }

  /**
   * Write the given contents to a given file name in the guest.
   * The file will be owned by root.
   */
  async writeFile(filePath: string, fileContents: string, permissions: fs.Mode = 0o644) {
    await this.runtimeCommand(
      ['exec', '--', 'sh', '-c', 'cat > "$1.tmp" && chmod "$2" "$1.tmp" && mv "$1.tmp" "$1"', 'sh', filePath, permissions.toString(8)],
      fileContents);
  }

  async copyFileIn(hostPath: string, vmPath: string): Promise<void> {
    await this.runtimeCommand(['copy', hostPath, `guest:${ vmPath }`]);
    await this.execCommand('chmod', '644', vmPath);
  }

  async copyFileOut(vmPath: string, hostPath: string): Promise<void> {
    await this.runtimeCommand(['copy', `guest:${ vmPath }`, hostPath]);
  }

  /**
   * Write the host-side API token and the guest's /etc/sulla-env. The runtime
   * guest has no Node.js, so the in-guest sulla CLI and daemon are not installed.
   */
  protected async writeGuestSullaEnv() {
    // --- Ensure the host-side API token file exists (independent of VM state) ---
    const crypto = await import('node:crypto');
    const tokenFile = path.join(paths.appHome, 'chat-api-token.json');
    let sullaApiToken = '';
    try {
      const raw = await fs.promises.readFile(tokenFile, 'utf-8');
      sullaApiToken = JSON.parse(raw).token || '';
    } catch {
      sullaApiToken = await SullaSettingsModel.get('sullaApiToken') || '';
    }
    if (!sullaApiToken) {
      sullaApiToken = crypto.randomBytes(48).toString('base64url');
      console.log('[sulla-runtime] Generated new API token during CLI install');
    }
    // Usually 3000; another app on the Mac may hold it (chatCompletionsPort).
    const { chatCompletionsPort } = await import('@pkg/main/chatCompletionsServer');
    const port = await chatCompletionsPort();

    await fs.promises.mkdir(paths.appHome, { recursive: true });
    await fs.promises.writeFile(tokenFile, JSON.stringify({
      token: sullaApiToken,
      port,
      pid:   process.pid,
    }, null, 2), { mode: 0o600 });
    const sullaEnv = `SULLA_API_TOKEN=${ sullaApiToken }\nSULLA_HOST=host.sulla.internal\nSULLA_API_PORT=${ port }\n`;

    await this.writeFile('/etc/sulla-env', sullaEnv, 0o644);
    console.log('[sulla-runtime] wrote /etc/sulla-env');
  }


  async start(config_: BackendSettings): Promise<void> {
    const config = this.cfg = clone(config_);
    const managedServicesGeneration = this.beginManagedServicesGeneration();

    // Restarting Docker brings every Sulla service back, including ones stopped by hand.
    this.#userStopped.clear();
    this.currentAction = Action.STARTING;
    let settleBackendStart!: () => void;
    const backendStartSettled = new Promise<void>((resolve) => { settleBackendStart = resolve });
    const finishBackendStart = () => {
      settleBackendStart();
      if (this.#backendStartSettled === backendStartSettled) {
        this.#backendStartSettled = undefined;
      }
    };

    this.#backendStartSettled = backendStartSettled;
    try {
      await this.setState(State.STARTING);
      this.assertManagedServicesGeneration(managedServicesGeneration);
    } catch (error) {
      finishBackendStart();
      if (error instanceof ManagedServicesReconciliationCancelled) return;
      if (managedServicesGeneration === this.#managedServicesGeneration) this.currentAction = Action.NONE;
      throw error;
    }
    this.#containerEngineClient = undefined;

    await this.progressTracker.action('Starting Backend', 10, async() => {
      // Emit event when main process starts up (for detecting restarts)
      ipcMain.emit('sulla-main-started');
      const backendStartTotal = Date.now();

      try {
        this.progressTracker.numeric('Starting Backend', 0, 100);
        setSullaRuntimeStartFailure(undefined);
        this.ensureArchitectureMatch();
        await this.startOnSullaRuntime(config, managedServicesGeneration, backendStartTotal);
      } catch (err) {
        if (err instanceof ManagedServicesReconciliationCancelled) {
          console.log('[Sulla] Managed-service reconciliation cancelled by backend lifecycle change');

          return;
        }
        console.error('Error starting the Sulla runtime:', err);
        const failure = bootFailure(err);

        setSullaRuntimeStartFailure({ reason: failure.reason, message: failure.message });
        firstRunTrace('vm', 'backend start failed', { reason: failure.reason, message: failure.message, error: err });
        await this.setState(State.ERROR);
        mainEvents.emit('sulla-backend-start-failed', { reason: failure.reason, message: failure.message });
        if (err instanceof BackendError) {
          if (!err.fatal) {
            return;
          }
        }
        throw err;
      } finally {
        if (managedServicesGeneration === this.#managedServicesGeneration) {
          this.currentAction = Action.NONE;
        }
        finishBackendStart();
      }
    });
  }



  /** Boot the Sulla runtime through Docker-ready, then bring up the managed services. A failure fails the backend start. */
  protected async startOnSullaRuntime(config: BackendSettings, generation: number, backendStartTotal: number): Promise<void> {
    const shares = this.sullaRuntimeShares();

    // A cold boot on a slow Mac, or a disk replaying its journal after a
    // crash, can miss the deadline once; one more try is cheap.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.startSullaRuntimeThroughDockerReady(config, shares);
        break;
      } catch (error) {
        await this.stopSullaRuntime().catch(cleanupError => console.error('[sulla-runtime] cleanup after a failed start failed:', cleanupError));
        // A damaged disk or a full Mac will fail the same way again.
        const retryable = !(error instanceof SullaRuntimeBootError) &&
          !(error instanceof SullaRuntimeStartError && error.reason === 'data-disk');

        if (attempt >= 2 || !retryable) throw bootFailure(error);
        this.assertManagedServicesGeneration(generation);
        console.warn('[sulla-runtime] the VM did not reach Docker-ready; trying once more:', error);
        firstRunTrace('vm', 'boot failed; trying once more', { error });
        this.progressTracker.numeric('Starting Sulla\'s engine again…', 0, 100);
      }
    }
    try {
      await this.finishSullaRuntimeBoot(config, generation, backendStartTotal, shares);
    } catch (error) {
      if (error instanceof ManagedServicesReconciliationCancelled) throw error;
      // Keep the real cause: the user-facing message stays short, but the
      // trace and log must say why (for example a tool that cannot run on
      // this Mac's CPU), or every engine failure looks the same.
      console.error('[sulla-runtime] engine start failed after Docker-ready:', error);
      firstRunTrace('vm', 'engine start failed after Docker-ready', { status: 'failure', error });
      await this.stopSullaRuntime().catch(cleanupError => console.error('[sulla-runtime] cleanup after a failed start failed:', cleanupError));
      throw error instanceof SullaRuntimeBootError ? error : new SullaRuntimeBootError('docker', 'Sulla\'s container engine didn\'t answer.');
    }
  }

  /** Host folders shared into the guest under short virtio-fs tags, at the same path. */
  protected sullaRuntimeShares(): SullaRuntimeShare[] {
    // Unpackaged source checkouts build services in the guest (see resolveSullaServiceImage).
    const sourceRoot = !Electron.app.isPackaged && fs.existsSync(path.join(process.cwd(), 'services')) ? process.cwd() : undefined;

    return sullaRuntimeShareList([paths.cache, paths.logs], paths.resources, sourceRoot);
  }

  protected async startSullaRuntimeThroughDockerReady(config: BackendSettings, shares: SullaRuntimeShare[]): Promise<void> {
    const preparedAt = Date.now();
    const artifacts = await findSullaRuntimeArtifacts();

    const dataDisk = await ensureSullaRuntimeDataDisk();

    console.log(`[sulla-runtime] data disk ${ dataDisk.path } (${ dataDisk.source })`);
    // Sulla's disk is sparse and grows as images load. A fresh install needs
    // room for them; an existing one already has most of them, so it only warns.
    const freeBytes = await this.freeDiskBytes();

    if (freeBytes !== undefined && freeBytes < DISK_WARN_BYTES) {
      firstRunTrace('vm', 'low disk space', { freeBytes, disk: dataDisk.source });
      console.warn(`[sulla-runtime] only ${ formatGB(freeBytes) } free on the Mac`);
      this.progressTracker.numeric(`Your Mac is low on disk space (${ formatGB(freeBytes) } free)`, 2, 100);
    }
    // A share whose folder is missing fails the VM configuration.
    for (const share of shares.filter(share => !share.readOnly)) {
      await fs.promises.mkdir(share.hostPath, { recursive: true });
    }
    const { username, uid } = os.userInfo();
    const guestUser = guestUserFor(username, uid);

    if (!guestUser) console.warn('[sulla-runtime] the login name cannot be passed to the guest; guest paths stay root-owned');
    const runtime = this.#sullaRuntime = new NativeRuntime(artifacts);

    console.log(`[startup-perf] sulla-runtime artifacts + data disk (before spawn): ${ Date.now() - preparedAt }ms`);
    const spawnedAt = Date.now();
    const bootStep = (text: string, percent: number) => this.progressTracker.numeric(text, percent, 100);
    let helloSeen = false;
    // The guest is silent until its data disk is mounted, which after an
    // unclean shutdown includes a disk check.
    const diskCheckNote = setTimeout(() => {
      if (!helloSeen) bootStep('Checking Sulla\'s disk…', 8);
    }, 15_000);

    bootStep('Starting Sulla\'s engine…', 5);
    firstRunTrace('vm', 'boot started', { cpus: config.virtualMachine.numberCPUs, memoryGB: config.virtualMachine.memoryInGB, disk: dataDisk.source });
    try {
      await runtime.start({
        dataDisk:         dataDisk.path,
        cpus:             config.virtualMachine.numberCPUs,
        memoryMiB:        config.virtualMachine.memoryInGB * 1024,
        shares,
        guestUser,
        onMilestone:      (name, elapsedMs) => {
          console.log(`[startup-perf] sulla-runtime ${ name }: ${ elapsedMs }ms after spawn`);
          // Each milestone also restarts the boot's quiet-time deadline (NativeRuntime).
          firstRunTrace('vm', `boot ${ name }`, { elapsedMs });
          if (name === 'hello') {
            helloSeen = true;
            bootStep('Starting the container engine…', 15);
          } else if (name === 'event:unit-ready') {
            bootStep('Waiting for the container engine…', 25);
          }
        },
        onUnexpectedExit: (reason) => {
          console.error(`[sulla-runtime] the runtime stopped unexpectedly (${ reason })`);
          void this.stopSullaRuntime().finally(() => this.setState(State.ERROR));
        },
      });
    } finally {
      clearTimeout(diskCheckNote);
    }
    console.log(`[startup-perf] sulla-runtime spawn -> docker-ready (cold boot or restore): ${ Date.now() - spawnedAt }ms`);

    // Guest commands go through `paths.sullaRuntime`, which already points at the host binary.
    setSullaRuntimeActive(true, guestUser);
  }

  /**
   * Everything after Docker-ready on the runtime: shares, the Docker client
   * and context, port forwarding, and the managed services.
   */
  protected async finishSullaRuntimeBoot(
    config: BackendSettings, generation: number, backendStartTotal: number, shares: SullaRuntimeShare[],
  ): Promise<void> {
    let t = Date.now();

    await this.mountSullaRuntimeShares(shares);
    console.log(`[startup-perf] sulla-runtime shares mounted: ${ Date.now() - t }ms`);

    const dockerSocket = sullaRuntimeSockets.docker;

    this.#containerEngineClient = new MobyClient(this, `unix://${ dockerSocket }`);
    await this.progressTracker.action('Setting docker context', 50,
      dockerDirManager.ensureDockerContextConfigured(false, dockerSocket));
    this.#sullaRuntimeForwarder = new SullaRuntimePortForwarder(dockerSocket, sullaRuntimeSockets.guest, { filesPort: 30124 });
    this.#sullaRuntimeForwarder.start();

    await this.progressTracker.action('Writing sulla environment', 50, this.writeGuestSullaEnv());
    // Bounded twice: the probe stops polling at the deadline, and a single
    // `docker system info` that hangs on a wedged socket cannot hold it either.
    let dockerApiTimer: NodeJS.Timeout | undefined;

    await this.progressTracker.action('Waiting for container engine client to be ready', 50, Promise.race([
      this.#containerEngineClient.waitForReady(DOCKER_API_TIMEOUT_MS),
      new Promise<never>((_, reject) => {
        dockerApiTimer = setTimeout(() => reject(new Error(`Docker did not answer within ${ DOCKER_API_TIMEOUT_MS / 1000 }s`)), DOCKER_API_TIMEOUT_MS + 15_000);
      }),
    ]).finally(() => clearTimeout(dockerApiTimer)));
    logStartupPhase('docker-api-ready', backendStartTotal, 'status=ready runtime=sulla');
    firstRunTrace('vm', 'docker answering', { msSinceBackendStart: Date.now() - backendStartTotal });

    await this.setState(State.DISABLED);
    mainEvents.emit('first-run-backend-booted');
    t = Date.now();
    void (async() => {
      await this.reconcileManagedServicesWithRetries(generation, config);
      console.log(`[startup-perf] sulla-runtime managed services ready: ${ Date.now() - t }ms`);
      logStartupPhase('sulla-services', t, 'status=ready runtime=sulla');
      this.runStartupBuildCacheGc(generation);
      await SullaSettingsModel.set('firstKubernetesIsInstalled', true, 'boolean');
    })().catch((error) => {
      if (!(error instanceof ManagedServicesReconciliationCancelled)) {
        console.warn(`[startup-phase] ${ new Date().toISOString() } phase=background-startup status=degraded runtime=sulla`, error);
      }
    });
    logStartupPhase('backend-ready', backendStartTotal, 'scope=docker-api services=streaming runtime=sulla');
  }

  /** Run low-priority, best-effort Docker cleanup after readiness; never gates startup. */
  private runStartupBuildCacheGc(generation: number): void {
    if (this.#startupBuildCacheGcGeneration === generation) return;
    this.#startupBuildCacheGcGeneration = generation;
    void (async() => {
      const startedAt = Date.now();
      try {
        // Agent builds use the guest Docker CLI. Avoid pruning while one is active.
        const building = await this.execCommand({ capture: true, root: true }, 'sh', '-c',
          'needle="docker"" build"; for p in /proc/[0-9]*/cmdline; do cmd=$(tr "\\000" " " < "$p" 2>/dev/null) || continue; case "$cmd" in *"$needle"*) echo active; exit 0;; esac; done; exit 0');
        if (building.trim()) {
          console.log('[startup-perf] build-cache-gc skipped: agent container build active');
          return;
        }
        let reclaimedBytes = 0;
        for (const args of [
          // buildx 0.30 (Docker 29 guest) takes --reserved-space; --keep-storage is gone.
          ['builder', 'prune', '-f', '--reserved-space', '1GB', '--filter', 'until=168h'],
          ['image', 'prune', '-f'],
        ]) {
          const output = await this.execCommand({ capture: true, root: true }, 'sh', '-c',
            'if command -v ionice >/dev/null 2>&1; then nice -n 19 ionice -c3 docker \"$@\"; else nice -n 19 docker \"$@\"; fi', 'sh', ...args);
          const matches = [...output.matchAll(/Total(?: reclaimed space)?:\s*([0-9.]+)\s*(B|kB|KB|MB|GB)/gi)];
          for (const [, amount, unit] of matches) {
            const factor = ({ B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as Record<string, number>)[unit.toUpperCase()];
            reclaimedBytes += Math.round(Number(amount) * factor);
          }
        }
        console.log(`[startup-perf] build-cache-gc elapsed=${ Date.now() - startedAt }ms bytes-reclaimed=${ reclaimedBytes }`);
      } catch (error) {
        console.warn(`[startup-perf] build-cache-gc failed non-fatally after ${ Date.now() - startedAt }ms`, error);
      }
    })();
  }

  /**
   * Mount each share in the guest at its host path, before anything else uses
   * it. The app's resources and its transfer folder are required: without
   * them later steps fail far from the cause, so the boot fails here instead.
   * Logs and cache are optional.
   */
  protected async mountSullaRuntimeShares(shares: SullaRuntimeShare[]): Promise<void> {
    const required = new Set(['/tmp/sulla-desktop', paths.resources]);

    for (const share of shares) {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.execCommand({ root: true }, 'sh', '-c',
            'mkdir -p "$2" && { mountpoint -q "$2" || mount -t virtiofs "$1" "$2"; }', 'sh', share.tag, share.hostPath);
          break;
        } catch (error) {
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 1_000));
            continue;
          }
          console.error(`[sulla-runtime] could not mount ${ share.hostPath } in the guest:`, error);
          if (required.has(share.hostPath)) {
            throw new SullaRuntimeBootError('shares', 'Sulla couldn\'t connect its app folders to its engine.');
          }
          break;
        }
      }
    }
  }

  /** Stop the runtime and clear the Docker context. Safe to call when it is not running. */
  protected async stopSullaRuntime(): Promise<void> {
    const runtime = this.#sullaRuntime;
    const wasActive = isSullaRuntimeActive();

    this.#sullaRuntimeForwarder?.stop();
    this.#sullaRuntimeForwarder = undefined;
    this.#sullaRuntime = undefined;
    void import('@pkg/main/threat-proxy').then(threatProxy => threatProxy.clearGuest(this)).catch(() => undefined);
    clearOnDemandServices();
    setSullaRuntimeActive(false);
    this.#containerEngineClient = undefined;
    try {
      await runtime?.stop({ suspend: takeSullaRuntimeSuspendRequest() });
    } finally {
      if (wasActive) await dockerDirManager.clearDockerContext();
    }
  }

  /**
   * Transient failures (Compose pull, credentials not yet available) are
   * retried. After the first few the backend reports ERROR and the app opens
   * degraded ('sulla-managed-services-failed'), but retrying never stops
   * while the app is open: the delay grows to a minute, and repair() runs the
   * next attempt at once. A later success clears the error.
   */
  private async reconcileManagedServicesWithRetries(generation: number, config: BackendSettings): Promise<void> {
    const retryDelaysMs = [5_000, 15_000, 30_000, 60_000];
    let reportedFailure = false;

    for (let attempt = 0; ; attempt++) {
      try {
        await this.reconcileManagedServices(generation, config);
        if (reportedFailure && this.state === State.ERROR) await this.setState(State.DISABLED);

        return;
      } catch (error) {
        if (error instanceof ManagedServicesReconciliationCancelled ||
            generation !== this.#managedServicesGeneration) {
          throw error;
        }
        if (error instanceof SullaRuntimeBootError && error.reason === 'disk-space') {
          await this.setState(State.ERROR);
          mainEvents.emit('sulla-managed-services-failed');
          return;
        }
        firstRunTrace('services', 'core services failed; retrying', { attempt: attempt + 1, error });
        if (attempt >= 3 && !reportedFailure) {
          reportedFailure = true;
          console.error('[startup-phase] phase=sulla-services status=failed after retries; still retrying every minute', error);
          await this.setState(State.ERROR);
          // Release the boot screen: it waits for the services, and would wait forever.
          mainEvents.emit('sulla-managed-services-failed');
        } else {
          console.warn(`[startup-phase] ${ new Date().toISOString() } phase=sulla-services status=retrying attempt=${ attempt + 1 }`, error);
        }
        await this.waitForRepairOr(retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]);
      }
    }
  }

  #repairRequested?: () => void;

  /** Sleep, or wake early when the user asks for a repair. */
  private waitForRepairOr(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, delayMs);

      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#repairRequested = done;
    }).finally(() => { this.#repairRequested = undefined });
  }

  /**
   * The Repair action: retry the managed services now. Wakes a waiting
   * retry, or reconciles the current generation again when nothing is in
   * flight (which also restarts the optional-service reconcile).
   */
  async repairManagedServices(): Promise<void> {
    if (!this.cfg || !isSullaRuntimeActive()) throw new Error('Sulla\'s engine is not running; restart it instead');
    this.#wakeOptionalReconcile?.();
    if (this.#repairRequested) {
      this.#repairRequested();

      return;
    }
    if (this.#managedServicesReconciliation) return;
    await this.reconcileManagedServicesWithRetries(this.#managedServicesGeneration, this.cfg);
  }

  private async reconcileManagedServices(generation: number, config: BackendSettings): Promise<void> {
    const previous = this.#managedServicesReconciliation;
    const reconciliation = (async() => {
      if (previous) await previous.catch(() => undefined);
      this.assertManagedServicesGeneration(generation);
      const { resetAgentContainerImageResolution, keepThreatProxyForRunningAgents } = await import('@pkg/agent/services/AgentContainerLauncher');

      resetAgentContainerImageResolution();
      keepThreatProxyForRunningAgents();
      await this.reconcileSullaDockerEnvironment(generation);
      markSullaDockerServicesStarted();
      getSullaFilesBackups().configureGuest(this);
      getSullaFilesMountManager().configureGuest(this, () => this.recoverSullaFilesGuestMount());
      this.assertManagedServicesGeneration(generation);
      await instantiateSullaStart(() => this.assertManagedServicesGeneration(generation));
      this.assertManagedServicesGeneration(generation);
      mainEvents.emit('sulla-managed-services-ready');
    })();

    this.#managedServicesReconciliation = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.#managedServicesReconciliation === reconciliation) {
        this.#managedServicesReconciliation = undefined;
      }
    }
  }

  /**
   * Deploys Sulla services using Docker Compose.
   * Handles preparation of compose file, deployment, health checks, and model pulling.
   */
  private async reconcileSullaDockerEnvironment(generation: number): Promise<void> {
    const dockerEnvTotal = Date.now();
    let t = Date.now();

    this.assertManagedServicesGeneration(generation);
    await this.progressTracker.action('Preparing Sulla Docker Compose file', 30, async() => {
      this.progressTracker.numeric('Preparing Sulla Docker Compose file', 5, 100);
      t = Date.now();
      await this.#composeRegeneration.serialize(async() => {
        this.assertManagedServicesGeneration(generation);
        await this.#filesCloudIdentity.refresh(true);
        this.assertManagedServicesGeneration(generation);
        await this.prepareSullaComposeFile();
      });
      this.assertManagedServicesGeneration(generation);
      console.log(`[startup-perf] prepareSullaComposeFile: ${ Date.now() - t }ms`);
      this.progressTracker.numeric('Docker Compose file prepared', 15, 100);
    });

    // The DB images must exist in the guest before Compose is allowed to start
    // these services; otherwise a fresh install can trigger a network pull.
    await this.loadBundledImages(image => DATABASE_IMAGE_NAMES.has(image.name));
    this.assertManagedServicesGeneration(generation);

    // Start readiness gates early, alongside non-DB image import and proxy
    // preparation. Keep the promise observed so a failed early start cannot
    // become an unhandled rejection while those operations are in flight.
    const databaseStart = this.startDatabaseServices(generation);
    void databaseStart.catch(() => undefined);

    // Every service image (threat proxy included) must be in the guest before
    // the agent network/egress setup and compose; agents depend on the proxy.
    await this.progressTracker.action('Loading bundled container images', 40, async() => {
      t = Date.now();
      await this.loadBundledImages(image => !image.onDemand && !DATABASE_IMAGE_NAMES.has(image.name));
      this.assertManagedServicesGeneration(generation);
      console.log(`[startup-perf] loadBundledImages: ${ Date.now() - t }ms`);
    });

    await this.progressTracker.action('Preparing the threat proxy', 40, async() => {
      t = Date.now();
      await this.prepareThreatProxyGuest();
      this.assertManagedServicesGeneration(generation);
      console.log(`[startup-perf] prepareThreatProxyGuest: ${ Date.now() - t }ms`);
    });

    await this.progressTracker.action('Deploying Sulla services with Docker Compose', 50, async() => {
      this.progressTracker.numeric('Deploying Sulla services with Docker Compose', 20, 100);
      t = Date.now();
      await databaseStart;
      await this.applySullaCompose(generation);
      console.log(`[startup-perf] applySullaCompose: ${ Date.now() - t }ms`);
      this.progressTracker.numeric('Sulla services deployed', 35, 100);
    });

    // Images used later (agent containers) load in the background, after the
    // services have started, so a large docker load does not land on top of
    // the boot peak. An agent launched before then loads its image itself.
    void this.#optionalServicesSettled
      .then(() => this.loadBundledImages(image => !!image.onDemand, false))
      .catch(error => console.warn('[bundled-images] background load failed:', error));

    this.progressTracker.numeric('Sulla deployment completed', 100, 100);
    console.log(`[startup-perf] sullaStepDockerEnvironment total: ${ Date.now() - dockerEnvTotal }ms`);
  }

  private async startDatabaseServices(generation: number): Promise<void> {
    this.assertManagedServicesGeneration(generation);
    await this.execCommand({ root: true }, 'docker', 'compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla', 'up', '-d', 'postgres', 'redis');
    this.assertManagedServicesGeneration(generation);
  }


  /**
   * Load the app's bundled images the guest does not have yet (first boot, or
   * after an app update shipped new ones). Without a bundle (development) this
   * does nothing and compose pulls as before.
   */
  private async loadBundledImages(filter: (image: { name: string; onDemand?: boolean }) => boolean, reportProgress = true): Promise<void> {
    const lock = currentBundledImageLock();
    const imagesDir = bundledImagesDir();

    const lockError = bundledImageLockError();

    if (lockError) {
      firstRunTrace('vm', 'bundled image lock unreadable; images will be pulled', { error: lockError });
    }
    if (!lock || !imagesDir) return;
    // A full Mac fails `docker load` partway with an error that names nothing.
    // Check only after the loader identifies missing images; existing installs
    // must be allowed to start even when they have little free space.
    const result = await ensureBundledImages({
      lock,
      imagesDir,
      docker:     sullaRuntimeGuestDocker(paths.sullaRuntime),
      filter,
      beforeLoad: async(missing) => {
        const guard = new BundledImagesDiskSpaceGuard(
          () => this.freeDiskBytes(),
          free => {
            console.warn(`[sulla-runtime] only ${ formatGB(free) } free on the Mac`);
            firstRunTrace('vm', 'low disk space', { freeBytes: free });
            if (reportProgress) this.progressTracker.numeric(`Your Mac is low on disk space (${ formatGB(free) } free)`, 2, 100);
          },
        );
        try {
          await guard.assertCanLoad(missing, lock.images.filter(filter).length);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          firstRunTrace('vm', 'not enough disk space to load images', { message });
          mainEvents.emit('sulla-backend-start-failed', { reason: 'disk-space', message });
          throw new SullaRuntimeBootError('disk-space', message);
        }
      },
      onProgress: reportProgress
        ? (done, total, image) => this.progressTracker.numeric(`Loading bundled image ${ image.name }`, done, total)
        : undefined,
    });

    if (reportProgress) this.progressTracker.numeric('Bundled container images loaded', 100, 100);
    if (result.loaded.length || result.failed.length) {
      console.log(`[bundled-images] present=${ result.present.join(',') || '-' } loaded=${ result.loaded.join(',') || '-' } failed=${ result.failed.map(f => f.name).join(',') || '-' }`);
    }
    firstRunTrace('vm', 'bundled images', {
      present: result.present, loaded: result.loaded, failed: result.failed.map(f => `${ f.name }: ${ f.error.message.split('\n')[0] }`),
    });
    // The images ship inside the app, so a load that fails twice means a
    // damaged app or a full disk. Name the component loudly, but still let
    // compose download it: online, that recovers instead of failing the boot.
    if (result.failed.length) {
      console.error(`[bundled-images] Couldn't load component ${ result.failed.map(f => f.name).join(', ') } from the app; ` +
        'downloading it instead. If this keeps happening, free up disk space or reinstall Sulla.');
    }
  }

  /** Free space on the Mac volume that holds Sulla's disk, in bytes; undefined when unknown. */
  private async freeDiskBytes(): Promise<number | undefined> {
    try {
      const stats = await fs.promises.statfs(paths.appHome);

      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      console.warn('[sulla-runtime] could not read free disk space:', error);

      return undefined;
    }
  }

  /**
   * Prepares the Docker Compose file for Sulla services by parsing and modifying dynamic values like passwords.
   */
  /**
   * The threat proxy scans agent web egress (see threatProxyEgress.ts). It is
   * always in compose; the user's on/off setting only switches the firewall
   * redirect, so toggling it never needs a compose regeneration.
   */
  private addThreatProxyService(compose: any): void {
    const image = resolveSullaServiceImage(
      'sulla-threat-proxy', process.cwd(), Electron.app.getVersion(), process.env.SULLA_THREAT_PROXY_IMAGE,
    );
    const resolvedImage = image.build ? image.image : `\${SULLA_THREAT_PROXY_IMAGE:-${ image.image }}`;

    if (shouldRefreshSullaServiceImage(image, process.env.SULLA_THREAT_PROXY_IMAGE)) {
      this.#managedSullaRefreshImages.set('threat_proxy', image.image);
    }
    if (!image.build && !image.bundled && !process.env.SULLA_THREAT_PROXY_IMAGE && !image.image.endsWith(':latest')) {
      this.#optionalSullaFallbackImages.set('threat_proxy', {
        env: 'SULLA_THREAT_PROXY_IMAGE', image: 'ghcr.io/merchantprotocol/sulla-threat-proxy:latest',
      });
    }
    compose.services.threat_proxy = threatProxyComposeService({ ...composeImageFields(image), image: resolvedImage });
  }

  /**
   * Guest-side threat proxy setup, before compose starts anything: the state
   * directories, the config and blocklist from the host, the agent network
   * with its fixed bridge, and the egress firewall rules (which fail closed
   * until the proxy container is up). A failure here does not stop the other
   * services: the agent launcher re-applies the network and rules before every
   * agent start and refuses to start an agent when that fails.
   */
  private async prepareThreatProxyGuest(): Promise<void> {
    try {
      await this.execCommand({ root: true }, ...provisionStateCommand());
      await this.execCommand({ root: true }, ...ensureAgentNetworkCommand());
      const threatProxy = await import('@pkg/main/threat-proxy');

      await threatProxy.configureGuest(this);
    } catch (error) {
      console.error('[Sulla] Threat proxy guest setup failed; agent launches will retry it:', error);
    }
  }

  private async prepareSullaComposeFile(): Promise<void> {
    const parsedCompose = typeof SULLA_DOCKER_COMPOSE === 'string' ? yaml.parse(SULLA_DOCKER_COMPOSE) : SULLA_DOCKER_COMPOSE;
    const compose = clone(parsedCompose);
    // Resolve host ports here, before the compose file crosses into the guest.
    // Guest Docker must never depend on inheriting the host Electron environment.
    for (const service of Object.values(compose.services ?? {}) as any[]) {
      if (!Array.isArray(service?.ports)) continue;
      service.ports = service.ports.map((entry: unknown) => typeof entry === 'string'
        ? entry.replace(/\$\{SULLA_PORT_(\d+):-\d+\}/g, (_match, base) => String(hostPort(Number(base))))
        : entry);
    }

    this.#optionalSullaFallbackImages.clear();
    this.#managedSullaRefreshImages.clear();
    this.#pinnedSullaImages.clear();
    // Bundled base images (postgres, redis, the function runtimes) run at
    // their pinned version and are updated with the app, not refreshed.
    const bundledBaseServices = new Set(pinComposeImages(compose, currentBundledImageLock()));

    for (const service of ['python_runtime', 'shell_runtime', 'node_runtime']) {
      const image = compose.services[service]?.image;

      if (typeof image === 'string' && !bundledBaseServices.has(service)) this.#managedSullaRefreshImages.set(service, image);
    }
    // Escape '$' as '$$' so Docker Compose doesn't interpret it as a variable.
    const escapeForCompose = (val: string) => val.replace(/\$/g, '$$$$');
    // Waits for a readable settings store; never a hardcoded fallback credential.
    const serviceSecret = await ServiceSecretComposeValues.resolve(serviceSecretProvider);
    const tokenFile = path.join(paths.appHome, 'chat-api-token.json');
    let sullaApiToken = '';
    try {
      sullaApiToken = JSON.parse(await fs.promises.readFile(tokenFile, 'utf-8')).token || '';
    } catch {
      sullaApiToken = await SullaSettingsModel.get('sullaApiToken') || '';
    }
    if (!sullaApiToken) throw new Error('Sulla API token is unavailable while preparing container services');
    const { chatCompletionsPort } = await import('@pkg/main/chatCompletionsServer');
    const chatApiPort = await chatCompletionsPort();
    sullaApiToken = escapeForCompose(sullaApiToken);
    const filesBootstrapIdentity = await this.#identityStore.loadOrCreateFilesBootstrapIdentity();
    const { fingerprint: filesTlsFingerprint } = await this.#tlsIdentities.prepareFilesTlsIdentity();
    try {
      const accountsSecrets = await this.#identityStore.prepareAccountsSecrets(serviceSecret.raw);
      // The host files remain the value store; the container binds a
      // root-owned guest copy because the VM cannot see host paths.
      await provisionAccountsSecretsInGuest({
        run:         (command, options) => this.execCommand({ capture: true, root: options?.root }, ...command),
        copyToGuest: (hostPath, guestPath) => this.runtimeCommand(['copy', hostPath, `guest:${ guestPath }`]).then(() => undefined),
      }, {
        'database.username': accountsSecrets.databaseUsername,
        'database.password': accountsSecrets.databasePassword,
        'bootstrap.secret':  accountsSecrets.bootstrap,
        'session.secret':    accountsSecrets.session,
        'encryption.key':    accountsSecrets.encryption,
      });
      const accountsImage = resolveSullaServiceImage(
        'sulla-accounts', process.cwd(), Electron.app.getVersion(), process.env.SULLA_ACCOUNTS_IMAGE,
      );
      const resolvedAccountsImage = accountsImage.build ? accountsImage.image : `\${SULLA_ACCOUNTS_IMAGE:-${ accountsImage.image }}`;

      if (shouldRefreshSullaServiceImage(accountsImage, process.env.SULLA_ACCOUNTS_IMAGE)) {
        this.#managedSullaRefreshImages.set('sulla_accounts', accountsImage.image);
      }
      if (!accountsImage.build && !accountsImage.bundled && !process.env.SULLA_ACCOUNTS_IMAGE && !accountsImage.image.endsWith(':latest')) {
        this.#optionalSullaFallbackImages.set('sulla_accounts', {
          env: 'SULLA_ACCOUNTS_IMAGE', image: 'ghcr.io/merchantprotocol/sulla-accounts:latest',
        });
      }
      compose.services.sulla_accounts = {
        ...composeImageFields(accountsImage),
        image:          resolvedAccountsImage,
        container_name: 'sulla_accounts',
        depends_on:     { postgres: { condition: 'service_healthy' } },
        environment:    {
          NODE_OPTIONS:                                serviceNodeOptions(128),
          SULLA_ACCOUNTS_MODE:                         'desktop',
          SULLA_ACCOUNTS_PORT:                         '3020',
          SULLA_ACCOUNTS_PUBLIC_URL:                   loopbackOrigin('http', 3020),
          SULLA_ACCOUNTS_DATABASE_HOST:                'postgres',
          SULLA_ACCOUNTS_DATABASE_PORT:                '5432',
          SULLA_ACCOUNTS_DATABASE_NAME:                'sulla_accounts',
          SULLA_ACCOUNTS_DATABASE_USERNAME_FILE:       '/run/sulla-accounts-source/database.username',
          SULLA_ACCOUNTS_DATABASE_PASSWORD_FILE:       '/run/sulla-accounts-source/database.password',
          SULLA_ACCOUNTS_BOOTSTRAP_SECRET_SOURCE_FILE: '/run/sulla-accounts-source/bootstrap.secret',
          SULLA_ACCOUNTS_SESSION_SECRET_SOURCE_FILE:   '/run/sulla-accounts-source/session.secret',
          SULLA_ACCOUNTS_ENCRYPTION_KEY_SOURCE_FILE:   '/run/sulla-accounts-source/encryption.key',
        },
        ports:   [`127.0.0.1:${ hostPort(3020) }:3020`],
        volumes:     accountsSecretBinds(),
        tmpfs:       ['/run/sulla-accounts-private:rw,noexec,nosuid,nodev,mode=0700,uid=10001,gid=10001'],
        restart:     'unless-stopped',
        mem_limit:    '256m',
        healthcheck: {
          test:     ['CMD', 'curl', '--fail', '--silent', '--show-error', 'http://localhost:3020/readyz'],
          interval: '5s',
          timeout:  '3s',
          retries:  10,
        },
      };
    } catch (error) {
      delete compose.services.sulla_accounts;
      this.#optionalSullaFallbackImages.delete('sulla_accounts');
      this.#managedSullaRefreshImages.delete('sulla_accounts');
      console.warn('[Sulla] Accounts provisioning unavailable; continuing without the optional service:', error);
    }
    let vaultIdentities: {
      bootstrapToken: string; controlToken: string; approvalToken: string; brokerToken: string; filesToken: string;
    } | undefined;
    let vaultTlsFingerprint: string | undefined;
    if (settingsImpl.getSettings().experimental.sullaVaultV2Enabled) {
      vaultIdentities = await this.#identityStore.loadOrCreateVaultServiceIdentities();
      ({ fingerprint: vaultTlsFingerprint } = await this.#tlsIdentities.prepareVaultTlsIdentity());
      const vaultImage = resolveSullaServiceImage(
        'sulla-vault', process.cwd(), Electron.app.getVersion(), process.env.SULLA_VAULT_IMAGE,
      );

      const image = vaultImage.build ? vaultImage.image : `\${SULLA_VAULT_IMAGE:-${ vaultImage.image }}`;

      if (shouldRefreshSullaServiceImage(vaultImage, process.env.SULLA_VAULT_IMAGE)) {
        this.#managedSullaRefreshImages.set('sulla_vault', vaultImage.image);
      }
      if (!vaultImage.build && !vaultImage.bundled && !process.env.SULLA_VAULT_IMAGE && !vaultImage.image.endsWith(':latest')) {
        this.#optionalSullaFallbackImages.set('sulla_vault', {
          env: 'SULLA_VAULT_IMAGE', image: 'ghcr.io/merchantprotocol/sulla-vault:latest',
        });
      }
      compose.services.sulla_vault = {
        ...composeImageFields(vaultImage),
        image,
        container_name: 'sulla_vault',
        labels: { 'sulla.vault-tls-fingerprint': vaultTlsFingerprint },
        depends_on: { postgres: { condition: 'service_healthy' } },
        environment: {
          // 36 MB JSON bodies in desktop mode; Argon2 (libsodium wasm, up to
          // 256 MB at moderate cost) lives outside the heap, so the limit stays.
          NODE_OPTIONS: serviceNodeOptions(256),
          SULLA_VAULT_MODE: 'desktop',
          // SULLA_VAULT_*DATABASE_URL: set by serviceSecret.applyTo(compose) below.
          SULLA_VAULT_BOOTSTRAP_TOKEN: vaultIdentities.bootstrapToken,
          SULLA_VAULT_DESKTOP_CONTROL_TOKEN: vaultIdentities.controlToken,
          SULLA_VAULT_APPROVAL_TOKEN: vaultIdentities.approvalToken,
          SULLA_VAULT_BROKER_TOKEN: vaultIdentities.brokerToken,
          SULLA_VAULT_FILES_TOKEN: vaultIdentities.filesToken,
          SULLA_FILES_API_URL: 'https://sulla_files:8792',
          SULLA_VAULT_AUDIT_SPOOL_DIR: '/var/lib/sulla-vault',
          SULLA_FILES_TLS_CA_FILE: '/run/sulla-files-ca/tls.crt',
          NODE_EXTRA_CA_CERTS: '/run/sulla-files-ca/tls.crt',
          SULLA_VAULT_HUMAN_UI_ORIGIN: loopbackOrigin('https', 30135),
          SULLA_VAULT_TLS_CERTIFICATE_PATH: '/run/sulla-vault-tls/tls.crt',
          SULLA_VAULT_TLS_PRIVATE_KEY_PATH: '/run/sulla-vault-tls/tls.key',
        },
        // 30121 on the host belongs to sullaSecretsServer; the vault must not share it.
        ports: [`127.0.0.1:${ hostPort(30135) }:8787`],
        volumes: [vaultTlsBind(), filesTlsBind(true), 'sulla-vault-data:/var/lib/sulla-vault'],
        restart: 'unless-stopped',
        mem_limit: '768m',
        // Node is otherwise PID 1 here and never reaps orphans. BusyBox wget
        // forks an ssl_client helper for every HTTPS healthcheck; when it is
        // orphaned it becomes a zombie under Node, one every 10s (~8,600/day).
        // Docker's init (tini) as PID 1 reaps them.
        init: true,
        healthcheck: { test: ['CMD', 'wget', '--no-check-certificate', '-qO-', 'https://127.0.0.1:8787/healthz'], interval: '10s', timeout: '3s', retries: 5 },
      };
    }

    // Desktop runs its own local workflow manager and ephemeral runner processes
    // inside the local Docker network. Remote workflows remain client records
    // managed through Desktop UI/model code, not by a Desktop server mode.
    const workflowImage = resolveSullaServiceImage(
      'sulla-workflows', process.cwd(), Electron.app.getVersion(), process.env.SULLA_WORKFLOW_IMAGE,
    );
    const image = workflowImage.build ? workflowImage.image : `\${SULLA_WORKFLOW_IMAGE:-${ workflowImage.image }}`;

    if (shouldRefreshSullaServiceImage(workflowImage, process.env.SULLA_WORKFLOW_IMAGE)) {
      this.#managedSullaRefreshImages.set('workflow_manager', workflowImage.image);
    }
    if (!workflowImage.build && !workflowImage.bundled && !process.env.SULLA_WORKFLOW_IMAGE && !workflowImage.image.endsWith(':latest')) {
      this.#optionalSullaFallbackImages.set('workflow_manager', {
        env: 'SULLA_WORKFLOW_IMAGE', image: 'ghcr.io/merchantprotocol/sulla-workflows:latest',
      });
    }
    compose.services.workflow_manager = {
      ...composeImageFields(workflowImage),
      image,
      // Source checkouts retain their Dockerfile build; published images are
      // refreshed by the common managed-image reconciliation path.
      ...(workflowImage.build ? { pull_policy: 'build' } : {}),
      container_name: 'sulla_workflow_manager',
      // The manager alone needs Docker socket access to launch short-lived
      // runners. Runners retain the image's unprivileged `node` user and are
      // granted only the socket GID discovered by the manager.
      user: 'root',
      // The image ENTRYPOINT ends in `setpriv … "$@"`, so this replaces CMD
      // and must name the interpreter or the .js file is exec'd directly (126).
      command: ['node', 'dist/services/sulla-workflows/src/manager.js'],
      depends_on: {
        postgres: { condition: 'service_healthy' },
        redis: { condition: 'service_healthy' },
        sulla_files: { condition: 'service_healthy' },
      },
      env_file: ['/etc/sulla-env'],
      environment: {
        NODE_OPTIONS: serviceNodeOptions(256),
        SULLA_WORKFLOW_ROLE: 'manager',
        // SULLA_DATABASE_URL: set by serviceSecret.applyTo(compose) below.
        SULLA_REDIS_URL: 'redis://redis:6379',
        SULLA_MANAGER_URL: 'http://workflow_manager:8788',
        SULLA_TOOL_API_URL: `http://host.docker.internal:${ chatApiPort }`,
        SULLA_WORKFLOW_IMAGE: image,
        SULLA_DOCKER_NETWORK: 'sulla_default',
      },
      extra_hosts: ['host.docker.internal:host-gateway'],
      ports: [`127.0.0.1:${ hostPort(30122) }:8788`],
      volumes: ['/var/run/docker.sock:/var/run/docker.sock', '/mnt/sulla:/mnt/sulla:rslave'],
      restart: 'unless-stopped',
      mem_limit: '384m',
      healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8788/healthz'], interval: '5s', timeout: '3s', retries: 10 },
    };

    // Desktop owns controller and desktop-local tools. Containers reach that
    // real owner through the existing authenticated outbound relay; they never
    // map a made-up controller hostname or a VM gateway to the macOS process.
    const relayImage = resolveSullaServiceImage(
      'sulla-relay', process.cwd(), Electron.app.getVersion(), process.env.SULLA_RELAY_IMAGE,
    );
    const resolvedRelayImage = relayImage.build ? relayImage.image : `\${SULLA_RELAY_IMAGE:-${ relayImage.image }}`;
    if (shouldRefreshSullaServiceImage(relayImage, process.env.SULLA_RELAY_IMAGE)) {
      this.#managedSullaRefreshImages.set('sulla_relay', relayImage.image);
    }
    if (!relayImage.build && !relayImage.bundled && !process.env.SULLA_RELAY_IMAGE && !relayImage.image.endsWith(':latest')) {
      this.#optionalSullaFallbackImages.set('sulla_relay', {
        env: 'SULLA_RELAY_IMAGE', image: 'ghcr.io/merchantprotocol/sulla-relay:latest',
      });
    }
    compose.services.sulla_relay = {
      ...composeImageFields(relayImage),
      image: resolvedRelayImage,
      container_name: 'sulla_relay',
      depends_on: { redis: { condition: 'service_healthy' } },
      environment: {
        NODE_OPTIONS: serviceNodeOptions(128),
        SULLA_REDIS_URL: 'redis://redis:6379',
        SULLA_RELAY_DEVICE_TOKEN_SECRET: sullaApiToken,
        SULLA_RELAY_INTERNAL_TOKEN: sullaApiToken,
        SULLA_RELAY_REPLICA_ID: 'desktop-local',
      },
      ports: [`127.0.0.1:${ hostPort(30126) }:8790`],
      restart: 'unless-stopped',
      mem_limit: '256m',
      healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8790/healthz'], interval: '5s', timeout: '3s', retries: 10 },
    };

    this.addThreatProxyService(compose);

    const toolsImage = resolveSullaServiceImage(
      'sulla-tools', process.cwd(), Electron.app.getVersion(), process.env.SULLA_TOOLS_IMAGE,
    );
    const resolvedToolsImage = toolsImage.build ? toolsImage.image : `\${SULLA_TOOLS_IMAGE:-${ toolsImage.image }}`;
    if (shouldRefreshSullaServiceImage(toolsImage, process.env.SULLA_TOOLS_IMAGE)) {
      this.#managedSullaRefreshImages.set('tools', toolsImage.image);
    }
    if (!toolsImage.build && !toolsImage.bundled && !process.env.SULLA_TOOLS_IMAGE && !toolsImage.image.endsWith(':latest')) {
      this.#optionalSullaFallbackImages.set('tools', {
        env: 'SULLA_TOOLS_IMAGE', image: 'ghcr.io/merchantprotocol/sulla-tools:latest',
      });
    }
    compose.services.tools = {
      ...composeImageFields(toolsImage),
      image: resolvedToolsImage,
      container_name: 'sulla_tools',
      labels: {
        'sulla.files-tls-fingerprint': filesTlsFingerprint,
        ...(vaultTlsFingerprint ? { 'sulla.vault-tls-fingerprint': vaultTlsFingerprint } : {}),
      },
      depends_on: {
        postgres: { condition: 'service_healthy' },
        redis: { condition: 'service_healthy' },
        sulla_relay: { condition: 'service_healthy' },
        sulla_files: { condition: 'service_healthy' },
        ...(vaultIdentities ? { sulla_vault: { condition: 'service_healthy' } } : {}),
      },
      env_file: ['/etc/sulla-env'],
      environment: {
        // The image runs TypeScript through tsx, whose esbuild helper process
        // also counts against mem_limit.
        NODE_OPTIONS: serviceNodeOptions(320),
        // The agent tool code in this image opens its own PostgresClient pool
        // (default 20) next to the service pool above; one caller needs few.
        SULLA_DATABASE_POOL_MAX: '5',
        // SULLA_DATABASE_URL and SULLA_FILES_CAPABILITY_SECRET: set by serviceSecret.applyTo(compose) below.
        SULLA_REDIS_URL: 'redis://redis:6379',
        SULLA_RELAY_URL: 'http://sulla_relay:8790',
        SULLA_RELAY_TOKEN: sullaApiToken,
        SULLA_FILES_API_URL:     'https://sulla_files:8792',
        SULLA_FILES_TLS_CA_FILE: '/run/sulla-files-ca/tls.crt',
        ...(vaultIdentities ? {
          SULLA_VAULT_BROKER_URL:        'https://sulla_vault:8787',
          SULLA_VAULT_BROKER_SERVICE_ID: 'sulla-tools',
          SULLA_VAULT_BROKER_TOKEN:      vaultIdentities.brokerToken,
          SULLA_VAULT_TLS_CA_FILE:       '/run/sulla-vault-ca/tls.crt',
          NODE_EXTRA_CA_CERTS:           '/run/sulla-vault-ca/tls.crt',
        } : {}),
      },
      ports: [`127.0.0.1:${ hostPort(30123) }:3000`],
      volumes: [
        ...(vaultIdentities ? [vaultTlsBind(true)] : []),
        filesTlsBind(true),
      ],
      restart: 'unless-stopped',
      mem_limit: '512m',
      healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/healthz'], interval: '5s', timeout: '3s', retries: 10 },
    };

    const filesImage = resolveSullaServiceImage(
      'sulla-files', process.cwd(), Electron.app.getVersion(), process.env.SULLA_FILES_IMAGE,
    );
    const resolvedFilesImage = filesImage.build ? filesImage.image : `\${SULLA_FILES_IMAGE:-${ filesImage.image }}`;

    if (shouldRefreshSullaServiceImage(filesImage, process.env.SULLA_FILES_IMAGE)) {
      this.#managedSullaRefreshImages.set('sulla_files', filesImage.image);
    } else if (filesImage.bundled && !process.env.SULLA_FILES_IMAGE) {
      this.#pinnedSullaImages.set('sulla_files', filesImage.image);
    }
    compose.services.sulla_files = {
      ...composeImageFields(filesImage),
      image: resolvedFilesImage,
      container_name: 'sulla_files',
      // Only managed Files lifecycle actions refresh this file. Unrelated
      // secret/mount regeneration cannot turn a late ID into a surprise outage.
      env_file: [FilesCloudIdentityProjection.GUEST_ENV_FILE],
      labels: {
        'sulla.files-tls-fingerprint': filesTlsFingerprint,
        ...(vaultTlsFingerprint ? { 'sulla.vault-tls-fingerprint': vaultTlsFingerprint } : {}),
      },
      depends_on: {
        postgres: { condition: 'service_healthy' },
        ...(vaultIdentities ? { sulla_vault: { condition: 'service_healthy' } } : {}),
      },
      environment: {
        // The image entrypoint appends --max-old-space-size=512 (#1363), so
        // 512 is the real heap; the rest of mem_limit covers the Potion table,
        // chunk buffers and the OCR/Whisper/ffmpeg child processes.
        NODE_OPTIONS:                      serviceNodeOptions(512, 4),
        // SULLA_FILES_DATABASE_URL, _CAPABILITY_SIGNING_KEY, _LOCAL_TOKEN: set by serviceSecret.applyTo(compose) below.
        SULLA_FILES_CHUNK_ROOT:            '/var/lib/sulla-files/chunks',
        SULLA_FILES_DATA_ROOT:             '/var/lib/sulla-files',
        SULLA_FILES_STORED_ONLY:           '1',
        SULLA_FILES_MODE:                  'desktop',
        SULLA_FILES_DEVICE_ID:             os.hostname(),
        SULLA_FILES_UID:                   String(os.userInfo().uid),
        SULLA_FILES_GID:                   String(os.userInfo().gid),
        SULLA_FILES_BOOTSTRAP_SERVICE_ID:  'sulla-desktop-files-bootstrap',
        SULLA_FILES_BOOTSTRAP_TOKEN:       filesBootstrapIdentity,
        SULLA_FILES_TLS_CERTIFICATE_PATH:  '/run/sulla-files-tls/tls.crt',
        SULLA_FILES_TLS_PRIVATE_KEY_PATH:  '/run/sulla-files-tls/tls.key',
        SULLA_FILES_CASE_INSENSITIVE_ROOT: process.platform === 'darwin' ? '1' : '0',
        ...(sullaFilesNativeSourceRolloutRequested()
          ? {
            SULLA_FILES_FUSE_EXPERIMENT: '1',
          }
          : {}),
        ...(vaultIdentities ? {
          SULLA_FILES_VAULT_AUTHORITY_URL:        'https://sulla_vault:8787',
          SULLA_FILES_VAULT_AUTHORITY_SERVICE_ID: 'sulla-files',
          SULLA_FILES_VAULT_AUTHORITY_TOKEN:      vaultIdentities.filesToken,
          SULLA_FILES_VAULT_AUTHORITY_CA_PATH:    '/run/sulla-vault-ca/tls.crt',
          SULLA_FILES_VAULT_BROKER_URL:             'https://sulla_vault:8787',
          SULLA_FILES_VAULT_BROKER_SERVICE_ID:      'sulla-tools',
          SULLA_FILES_VAULT_BROKER_TOKEN:           vaultIdentities.brokerToken,
          SULLA_FILES_VAULT_BROKER_CA_PATH:         '/run/sulla-vault-ca/tls.crt',
        } : {}),
        ...(process.env.SULLA_CLOUD_API_URL ? { SULLA_CLOUD_API_URL: process.env.SULLA_CLOUD_API_URL } : {}),
        ...(process.env.SULLA_FILES_SERVER_URL ? { SULLA_FILES_SERVER_URL: process.env.SULLA_FILES_SERVER_URL } : {}),
        ...(process.env.SULLA_FILES_USER_ID ? { SULLA_FILES_USER_ID: process.env.SULLA_FILES_USER_ID } : {}),
        ...(process.env.SULLA_FILES_ORG_ID ? { SULLA_FILES_ORG_ID: process.env.SULLA_FILES_ORG_ID } : {}),
      },
      ports: [`127.0.0.1:${ hostPort(30124) }:8792`],
      volumes: [
        'sulla-files-data:/var/lib/sulla-files',
        '/mnt/sulla-backups:/var/lib/sulla-files-backups:rslave',
        // The image declares VOLUME /data/files. Without an explicit mount,
        // compose re-inherits whatever an older container had there on every
        // recreate -- including a stale host bind (~/sulla/files) the VM can
        // no longer see. Stored-only mode does not use this folder.
        'sulla-files-folder:/data/files',
        filesTlsBind(),
        ...(vaultIdentities
          ? [vaultTlsBind(true)]
          : []),
      ],
      restart: 'unless-stopped',
      // 1g OOM-killed Files every ~90s on 2026-11-13: steady state is ~1.2g (512 MiB heap plus ~700 MiB native: Potion table, chunk buffers).
      mem_limit: '2g',
      // BusyBox wget against Files' loopback-only plain-HTTP /healthz: no Node runtime and no TLS
      // per tick (the old `node -e` https probe cost ~35% of a CPU on a busy 3-vCPU VM and timed
      // out under load). The node probe remains only as a fallback for an image that predates the
      // loopback listener. 10s x 6 = a minute of failures before Docker says unhealthy, then the
      // heal planner still needs UNHEALTHY_TICKS_BEFORE_RESTART one-minute observations.
      healthcheck: {
        test: ['CMD-SHELL', SULLA_FILES_HEALTHCHECK],
        interval: '10s', timeout: '5s', retries: 6, start_period: '10m',
      },
    };

    // Backups are optional: a bad anchor must never stop Files from booting.
    try { await getSullaFilesBackups().prepareAnchor(this) } catch (error) { console.warn('[SullaFiles] backup mount anchor unavailable; NAS backups disabled this session', error) }

    // The guest Files mount is optional: if its anchor cannot be prepared the
    // adapter is left out of compose and Desktop keeps booting without it.
    if (sullaFilesNativeSourceRolloutRequested() && await this.prepareSullaFilesGuestMount(compose)) {
      const fuseImage = resolveSullaServiceImage(
        'sulla-files-fuse', process.cwd(), Electron.app.getVersion(), process.env.SULLA_FILES_FUSE_IMAGE,
      );
      const resolvedFuseImage = fuseImage.build ? fuseImage.image : `\${SULLA_FILES_FUSE_IMAGE:-${ fuseImage.image }}`;
      if (shouldRefreshSullaServiceImage(fuseImage, process.env.SULLA_FILES_FUSE_IMAGE)) {
        this.#managedSullaRefreshImages.set('sulla_files_fuse', fuseImage.image);
      }
      compose.services.sulla_files_fuse = {
        ...composeImageFields(fuseImage),
        image:          resolvedFuseImage,
        container_name: 'sulla_files_fuse',
        environment: {
          SULLA_FILES_FUSE_URL:             'https://sulla_files:8792',
          SULLA_FILES_FUSE_TOKEN_FILE:      '/run/sulla-files-fuse/token',
          SULLA_FILES_FUSE_MOUNT_PATH:       '/mnt/sulla/files',
          SULLA_FILES_FUSE_SPOOL:            '/var/spool/sulla-files-fuse',
          SSL_CERT_FILE:                     '/run/sulla-files-ca/tls.crt',
        },
        volumes: [
          '/var/lib/sulla/files-fuse:/run/sulla-files-fuse:ro',
          '/proc:/host/proc:ro',
          SULLA_FILES_GUEST_FUSE_BIND,
          // Disk-backed spool for open-file buffers; /tmp is RAM and counts against mem_limit.
          'sulla-files-fuse-spool:/var/spool/sulla-files-fuse',
          filesTlsBind(true),
        ],
        devices:      ['/dev/fuse:/dev/fuse'],
        cap_drop:     ['ALL'],
        cap_add:      ['SYS_ADMIN'],
        security_opt: ['no-new-privileges:true'],
        pid:          'host',
        read_only:    true,
        tmpfs:        ['/tmp:rw,noexec,nosuid,nodev,size=16m'],
        pids_limit:   64,
        mem_limit:    '256m',
        cpus:         0.5,
        depends_on:   { sulla_files: { condition: 'service_healthy' } },
        restart:      'unless-stopped',
        // The adapter is healthy while its FUSE mount is live and its event loop keeps rewriting
        // the status file (every 5 s). It no longer starts Python and a TLS round trip to Files
        // each tick, and a slow Files no longer gets the mount restarted (which would break every
        // open handle with ENOTCONN); the adapter retries Files itself.
        healthcheck: {
          test: ['CMD-SHELL', SULLA_FILES_FUSE_HEALTHCHECK],
          interval: '10s', timeout: '5s', retries: 6, start_period: '2m',
        },
      };
    }

    // Modify dynamic values like passwords
    // Every secret-bearing env var (service DATABASE_URLs, Files tokens, the
    // PostgreSQL password) is set here and only here, for every generation.
    serviceSecret.applyTo(compose);

    compose.volumes ??= {};
    compose.volumes['sulla-vault-data'] ??= {};
    compose.volumes['sulla-files-data'] ??= {};
    compose.volumes['sulla-files-folder'] ??= {};
    compose.volumes['sulla-files-fuse-spool'] ??= {};

    // Function code and invocation material stay inside the guest. Host paths
    // must never become Docker bind sources for agent-controlled runtimes.
    const sullaFunctionsDir = '/mnt/data/sulla/runtime/functions/catalog';
    const sullaRuntimeTempDir = '/mnt/data/sulla/runtime/functions/invocations';

    // /mnt/data is root-owned, so creating /mnt/data/sulla needs root.
    await this.execCommand({ root: true }, 'install', '-d', '-m', '0700', sullaFunctionsDir, sullaRuntimeTempDir);

    if (isSullaRuntimeActive()) {
      // On the runtime the Mac's loopback is the SLIRP host gateway from every
      // container; host-gateway would resolve to the guest itself.
      for (const service of Object.values<any>(compose.services ?? {})) {
        const hosts = Array.isArray(service.extra_hosts) ? service.extra_hosts : [];

        service.extra_hosts = [
          ...hosts.filter((entry: string) => !/^host\.(docker|lima|sulla)\.internal:/.test(entry)),
          `host.docker.internal:${ HOST_GATEWAY }`,
          `host.sulla.internal:${ HOST_GATEWAY }`,
        ];
      }
    }

    // The VM cannot see host directories; a host bind would leave a service
    // permanently unable to start. Fail generation instead of shipping one.
    assertNoHostBindMounts(compose);
    let composeYaml = yaml.stringify(compose, { defaultStringType: 'QUOTE_DOUBLE' });
    composeYaml = composeYaml.replace(/\{\{sullaFunctionsDir\}\}/g, sullaFunctionsDir);
    composeYaml = composeYaml.replace(/\{\{sullaRuntimeTempDir\}\}/g, sullaRuntimeTempDir);
    // Never write a file where a service lacks its secret env or carries a fallback credential.
    const filesFuseService = compose.services?.sulla_files_fuse;

    if (filesFuseService) {
      this.#filesFuseConfigHash = hashFilesFuseServiceDefinition(filesFuseService);
      filesFuseService.labels = { ...(filesFuseService.labels ?? {}), 'com.merchantprotocol.sulla.files-fuse-config-hash': this.#filesFuseConfigHash };
      composeYaml = yaml.stringify(compose, { defaultStringType: 'QUOTE_DOUBLE' });
      composeYaml = composeYaml.replace(/\{\{sullaFunctionsDir\}\}/g, sullaFunctionsDir);
      composeYaml = composeYaml.replace(/\{\{sullaRuntimeTempDir\}\}/g, sullaRuntimeTempDir);
    }
    new ComposeSecretGuard(serviceSecret).assert(compose, composeYaml);
    await this.writeFile('/tmp/sulla-docker-compose.yml', composeYaml, 0o644);
    this.#composeTargets = ComposeContainerNameReconciler.targetsOf(compose);
  }

  /**
   * Runs docker-compose up -d to start all Sulla services in detached mode.
   */
  /**
   * Prepare the optional guest Files propagation anchor. Never throws: on any
   * failure (including the refusal to reuse an unexpected mount) the feature is
   * turned off for this generation, consumers lose their /mnt/sulla-files
   * binds, and the mount manager reports the reason.
   */
  private async prepareSullaFilesGuestMount(compose: any): Promise<boolean> {
    try {
      const { drained } = await prepareSullaFilesGuestAnchorDraining(this);

      if (drained > 0) {
        console.warn(`[Sulla] ${ SULLA_FILES_GUEST_MOUNT_PATH } had ${ drained } stale adapter mount(s); detached them`);
        this.#staleFilesAdapters.add('sulla_files_fuse');
      }
      this.#lastFilesGuestMountFailure = undefined;
      getSullaFilesMountManager().reportGuestPreparation();
      // The workflow manager image cannot ask Desktop; this marker tells it
      // the shared parent exists so its runners may bind /mnt/sulla.
      const workflowManager = compose.services?.workflow_manager;

      if (workflowManager) workflowManager.environment = { ...workflowManager.environment, SULLA_FILES_GUEST_MOUNT: '1' };

      return true;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];

      // Retries regenerate compose; log a failure once, not on every attempt.
      if (reason !== this.#lastFilesGuestMountFailure) console.log(`[Sulla] Files guest mount unavailable: ${ reason }`);
      this.#lastFilesGuestMountFailure = reason;
      getSullaFilesMountManager().reportGuestPreparation(reason);
      for (const service of Object.values<any>(compose.services ?? {})) {
        if (!Array.isArray(service?.volumes)) continue;
        service.volumes = service.volumes.filter((volume: any) => {
          const source = typeof volume === 'string' ? volume.split(':')[0] : volume?.source;

          return source !== SULLA_FILES_GUEST_PARENT_PATH;
        });
      }

      return false;
    }
  }

  /**
   * Runtime recovery for the Files guest mount, called by the mount manager's
   * retry loop. Re-runs the same idempotent preparation by regenerating the
   * compose file (which restores the adapter service and the consumers'
   * /mnt/sulla parent binds once the anchor exists), then brings
   * workflow_manager up to that definition. The mount manager itself starts
   * sulla_files_fuse. Throws when preparation still fails.
   */
  async recoverSullaFilesGuestMount(): Promise<void> {
    const generation = this.#managedServicesGeneration;

    // Never race a startup reconciliation; it regenerates compose itself.
    await this.#managedServicesReconciliation?.catch(() => undefined);
    this.assertManagedServicesGeneration(generation);
    // Regenerating compose is ~100 guest commands; never do it more than twice a minute
    // however often the mount manager retries.
    const sinceLast = Date.now() - this.#lastGuestRecovery;

    if (sinceLast < 30_000 && this.#lastFilesGuestMountFailure) throw new Error(this.#lastFilesGuestMountFailure);
    this.#lastGuestRecovery = Date.now();
    // Every other running container drifted by the new file is recreated too
    // (it used to keep its old definition until the next boot).
    await this.#composeRegeneration.run('Files guest mount recovery', {
      checkpoint:  () => this.assertManagedServicesGeneration(generation),
      beforeSweep: async() => {
        if (!getSullaFilesMountManager().guestMountAvailable()) {
          throw new Error(this.#lastFilesGuestMountFailure ?? 'the guest anchor is not prepared');
        }
        await reconcileComposeService({
          composeCommand: [...SULLA_COMPOSE_COMMAND],
          service:        'workflow_manager',
          run:            (...command) => this.execCommand({ root: true }, ...command),
          checkpoint:     () => this.assertManagedServicesGeneration(generation),
        });
      },
    });
  }

  /**
   * The settings database held a different service secret than the one the
   * running containers were given: rewrite compose with it and recreate every
   * running container whose definition changed. Before the first compose file
   * exists there is nothing to do; boot writes the new value.
   */
  private async regenerateComposeAfterSecretChange(reason: string): Promise<void> {
    await this.#managedServicesReconciliation?.catch(() => undefined);
    if (this.#composeTargets.length === 0) return;
    const generation = this.#managedServicesGeneration;

    await this.#postgresAuth.aroundSecretChange(() => this.#composeRegeneration.run(`service secret: ${ reason }`, { checkpoint: () => this.assertManagedServicesGeneration(generation) }));
  }

  /** Compose regeneration deliberately excludes the FUSE adapter from generic config-hash sweeps.
   * Recreate it only when its stable adapter-owned definition digest differs. */
  private async reconcileFilesFuseDefinition(): Promise<void> {
    const target = this.#composeTargets.find(candidate => candidate.service === 'sulla_files_fuse');

    if (!target || !this.#filesFuseConfigHash) return;
    const output = (await this.execCommand({ capture: true, root: true, expectFailure: true }, 'docker', 'inspect', '--format',
      '{{.State.Status}} {{index .Config.Labels "com.merchantprotocol.sulla.files-fuse-config-hash"}}', target.container).catch(() => '')).trim();

    if (toFilesFuseContainerState(output) !== 'running' || output.split(/\s+/)[1] === this.#filesFuseConfigHash) return;
    console.warn('[Sulla] Files FUSE adapter definition changed; recreating the adapter (stable service hash changed)');
    await reconcileComposeService({ composeCommand: ['docker', 'compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla'], service: target.service,
      run: (...command) => this.execCommand({ root: true }, ...command) });
    await this.waitForDockerServiceHealthy(target, 20, this.#managedServicesGeneration);
  }

  /**
   * How many optional services may be starting at once: a few on a guest
   * under 3 GiB, otherwise all of them.
   */
  private async optionalServiceStartSlots(): Promise<number> {
    try {
      const meminfo = await this.execCommand({ capture: true, expectFailure: true }, 'cat', '/proc/meminfo');
      const totalKiB = Number(/^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo)?.[1]);

      // About one starting service per GiB of guest memory, 2 to 4.
      if (totalKiB > 0) return Math.min(4, Math.max(2, Math.floor(totalKiB / (1024 * 1024))));
    } catch {
      // Unknown size: assume a small guest.
    }

    return 3;
  }

  private async applySullaCompose(generation: number): Promise<void> {
    this.assertManagedServicesGeneration(generation);
    await this.progressTracker.action('Verifying compose file', 62.5, async() => {
      try {
        await this.execCommand({ root: true }, 'test', '-f', '/tmp/sulla-docker-compose.yml');
        console.log('[Sulla] Compose file verified at /tmp/sulla-docker-compose.yml');
      } catch {
        console.warn('[Sulla] Compose file not found at /tmp/sulla-docker-compose.yml');
        throw new Error('Compose file verification failed');
      }
    });

    // Ensure the VM's Docker config doesn't have a broken credsStore that would
    // block image pulls. Most users won't have credentials installed — anonymous
    // pulls should still work (just subject to Docker Hub rate limits).
    await this.progressTracker.action('Checking Docker credentials config', 62.7, async() => {
      try {
        const rawConfig = await this.execCommand({ capture: true, root: true }, 'cat', ROOT_DOCKER_CONFIG_PATH);
        const config = JSON.parse(rawConfig);

        if (config.credsStore) {
          // Test if the credential helper actually works
          try {
            await this.execCommand({ root: true }, `docker-credential-${ config.credsStore }`, 'list');
          } catch {
            console.log(`[Sulla] Credential helper "docker-credential-${ config.credsStore }" is not available, removing credsStore to allow anonymous pulls`);
            delete config.credsStore;
            await this.writeFile(ROOT_DOCKER_CONFIG_PATH, jsonStringifyWithWhiteSpace(config), 0o644);
          }
        }
      } catch {
        // No Docker config file or can't parse it — that's fine, Docker will use defaults
        console.log('[Sulla] No Docker config found in VM, proceeding with anonymous pulls');
      }
    });

    await this.progressTracker.action('Deploying new containers', 63, async() => {
      const composeCommand = ['docker', 'compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla'];
      const reconcileOptionalService = (service: string): Promise<void> => reconcileComposeService({
        composeCommand,
        service,
        refreshImage: this.#managedSullaRefreshImages.get(service),
        run:          (...command) => this.execCommand({ root: true }, ...command),
        checkpoint:   () => this.assertManagedServicesGeneration(generation),
      });
      const startOptionalService = async(service: string): Promise<void> => {
        if (this.#staleFilesAdapters.delete(service)) {
          // The mount manager only marks this after a failed mount probe and a
          // successful stale-layer detach. Restart the live process in-place;
          // a container recreate would break every consumer's bind mount.
          const inspectOutput = (await this.execCommand({ capture: true, root: true, expectFailure: true },
            'docker', 'inspect', '--format', '{{.State.Status}} {{index .Config.Labels "com.merchantprotocol.sulla.files-fuse-config-hash"}}', 'sulla_files_fuse').catch(() => '')).trim();
          const state = toFilesFuseContainerState(inspectOutput);
          const runningConfigHash = inspectOutput.split(/\s+/)[1];
          const action = decideFilesFuseRecovery({
            containerState: state,
            imageChanged: false,
            configChanged: state === 'running' && !!this.#filesFuseConfigHash && runningConfigHash !== this.#filesFuseConfigHash,
            mountDead: true,
            nowMs: Date.now(),
            lastRestartMs: this.#lastFilesFuseRestartMs,
            restartCooldownMs: 60_000,
          });

          if (action === 'restart') {
            console.warn('[Sulla] Files FUSE mount is dead while its adapter container is running; restarting the adapter process (reason: mount health check failed)');
            await this.execCommand({ root: true }, 'docker', 'restart', '--time', '10', 'sulla_files_fuse');
            this.#lastFilesFuseRestartMs = Date.now();
          } else if (action === 'create' || action === 'recreate') {
            console.warn(`[Sulla] Files FUSE adapter recovery requires ${ action } (reason: container ${ state || 'missing' })`);
            await reconcileOptionalService(service);
          } else {
            console.warn('[Sulla] Files FUSE restart skipped (reason: adapter restart is rate-limited or container is already transitioning)');
          }

          return;
        }
        try {
          await reconcileOptionalService(service);
        } catch (error) {
          const fallback = this.#optionalSullaFallbackImages.get(service);

          if (!fallback) throw error;
          console.warn(`[Sulla] Selected image for ${ service } unavailable; trying ${ fallback.image }`);
          await this.execCommand({ root: true }, 'docker', 'pull', fallback.image).catch(pullError => {
            console.warn(`[Sulla] Could not refresh ${ fallback.image }; trying the cached fallback:`, pullError);
          });
          this.assertManagedServicesGeneration(generation);
          await this.execCommand(
            { root: true }, 'env', `${ fallback.env }=${ fallback.image }`,
            ...composeCommand, 'up', '-d', '--no-deps', '--pull', 'never', service,
          );
        }
      };

      // Desktop leaves some running containers alone below (a live Files
      // starter, a service still in its start period). Compose's own diff never
      // runs for those, so compare their config hash with the file just written:
      // a drifted one (e.g. stale env after the service secret changed) is
      // recreated; an unchanged one is left alone.
      const configDrift = new ContainerDriftReconciler(this.#guestDocker, composeCommand.slice(1), startOptionalService, console,
        target => this.#driftActions.settle(target));

      // Retire the old Desktop board container; preserve all database data.
      await this.execCommand({ root: true }, 'docker', 'rm', '-f', 'sulla_projects').catch(() => undefined);

      // An interrupted compose re-create can leave a container under
      // `<id>_<name>` with nothing under its real name. Compose still treats it
      // as current, so heal the names before compose and the health waits run.
      await this.#composeContainers.reconcile(this.#composeTargets)
        .catch(error => console.warn('[Sulla] Could not check compose container names:', (error as Error)?.message?.split('\n')[0]));
      // Move data off anonymous volumes before compose switches the service to its named one.
      for (const spec of SULLA_NAMED_VOLUME_MIGRATIONS) {
        try {
          const result = await this.#volumeMigrator.migrate(spec);

          if (result.kind === 'migrated') firstRunTrace('services', 'volume migrated', { service: spec.service, from: result.source, to: spec.volume });
        } catch (error) {
          // Redis keeps no persistent data (no snapshots, no AOF): never hold startup on it.
          // The anonymous volume is never deleted, so a failed copy loses nothing.
          console.warn(`[Sulla] Could not move ${ spec.service } data to volume ${ spec.volume }; continuing:`, (error as Error)?.message?.split('\n')[0]);
        }
        this.assertManagedServicesGeneration(generation);
      }

      // Postgres and Redis are stable data services. Compose pulls them only when
      // missing; Desktop does not force-refresh their upstream image tags.
      await this.execCommand(
        { root: true }, ...composeCommand, 'up', '-d',
        'postgres', 'redis',
      );
      this.assertManagedServicesGeneration(generation);
      await Promise.all([
        this.waitForDockerServiceHealthy({ service: 'postgres', container: 'sulla_postgres' }, 300, generation),
        this.waitForDockerServiceHealthy({ service: 'redis', container: 'sulla_redis' }, 300, generation),
      ]);
      await this.#postgresAuth.afterPostgresHealthy();
      mainEvents.emit('first-run-ai-runtime-ready');

      this.#activeOptionalSullaServices.clear();
      // The function runtimes start on first use (backend/onDemandServices.ts)
      // and stop again when idle; boot leaves them alone.
      const onDemandRefreshImages: Partial<Record<OnDemandServiceName, string>> = {};

      for (const service of Object.keys(ON_DEMAND_SERVICES) as OnDemandServiceName[]) {
        const image = this.#managedSullaRefreshImages.get(service);

        if (image) onDemandRefreshImages[service] = image;
      }
      configureOnDemandServices(args => this.execCommand({ capture: true, root: true }, ...args), onDemandRefreshImages);
      const optionalServices: Array<{ service: string; container: string }> = [];

      const configuredServices = await this.execCommand(
        { capture: true, root: true }, ...composeCommand, 'config', '--services',
      );

      if (configuredServices.split(/\s+/).includes('sulla_accounts')) {
        try {
          await this.#accountsDatabase.ensureExists();
          optionalServices.push({ service: 'sulla_accounts', container: 'sulla_accounts' });
        } catch (error) {
          console.warn('[Sulla] Accounts database provisioning failed; continuing without the optional service:', error);
        }
      }

      if (configuredServices.split(/\s+/).includes('sulla_files_fuse')) {
        optionalServices.push({ service: 'sulla_files_fuse', container: 'sulla_files_fuse' });
      }

      // Attempt dependencies before their consumers. Optional failure remains
      // isolated; a failed Vault explicitly suppresses Files for this generation.
      if (settingsImpl.getSettings().experimental.sullaVaultV2Enabled) {
        optionalServices.push({ service: 'sulla_vault', container: 'sulla_vault' });
        expectVaultContainer();
      }
      // The threat proxy is on demand too: the agent launcher starts it (and
      // waits for it) before any agent runs; until then the egress rules
      // refuse agent web traffic rather than let it out unscanned.
      optionalServices.push(
        { service: 'sulla_relay', container: 'sulla_relay' },
        { service: 'sulla_files', container: 'sulla_files' },
        { service: 'workflow_manager', container: 'sulla_workflow_manager' },
        { service: 'tools', container: 'sulla_tools' },
      );
      const orderedOptionalServices = optionalServices.sort((left, right) => {
        const order = ['sulla_vault', 'sulla_accounts', 'sulla_relay', 'sulla_files',
          'sulla_files_fuse', 'tools', 'workflow_manager'];

        return order.indexOf(left.service) - order.indexOf(right.service);
      });

      setSullaOptionalServicesPlanned(orderedOptionalServices.map(entry => entry.service));
      // What must be healthy before each optional service starts (the compose
      // depends_on graph). Every other optional service has no dependency on the
      // rest, so they start together: the vault, which gates the main window, is
      // no longer queued behind accounts and the threat proxy.
      const optionalServiceNeeds: Record<string, string[]> = {
        sulla_files:      ['sulla_vault'],
        sulla_files_fuse: ['sulla_files'],
        tools:            ['sulla_relay', 'sulla_files', 'sulla_vault'],
        workflow_manager: ['sulla_files'],
      };
      // Every Node service peaks while it loads code and runs migrations. On a
      // small guest, starting them all at once stacks those peaks; limit how
      // many are between "start" and "healthy" at a time. A service takes a
      // slot only after its dependencies are healthy, so slots cannot deadlock.
      let freeStartSlots = await this.optionalServiceStartSlots();
      const startSlotWaiters: Array<() => void> = [];
      const takeStartSlot = async(): Promise<void> => {
        while (freeStartSlots <= 0) await new Promise<void>(resolve => startSlotWaiters.push(resolve));
        freeStartSlots -= 1;
      };
      const releaseStartSlot = (): void => {
        freeStartSlots += 1;
        startSlotWaiters.shift()?.();
      };
      const reconcileInBackground = async(): Promise<void> => {
        const bootStatus = new Map<string, string>();

        // A slow Mac can take a minute or more to bring the vault up; the fast
        // attempts cover that. After them a slow reconcile keeps going for the
        // life of this generation, so a service that was late, crashed or never
        // got created still comes up without restarting the app.
        for (let attempt = 1; ; attempt++) {
          const runs = new Map<string, Promise<boolean>>();
          const run = (entry: { service: string; container: string }): Promise<boolean> => {
            let started = runs.get(entry.service);

            if (!started) {
              started = reconcileOne(entry);
              runs.set(entry.service, started);
            }

            return started;
          };
          const reconcileOne = async(entry: { service: string; container: string }): Promise<boolean> => {
            const { service, container } = entry;

            if (this.#activeOptionalSullaServices.has(service)) return true;
            // Stopped on purpose from the Docker tab: leave it (and what needs it) until they start it.
            if (this.#userStopped.has(container)) {
              bootStatus.set(service, 'stopped by you');

              return false;
            }
            for (const dependency of optionalServiceNeeds[service] ?? []) {
              const dependencyEntry = orderedOptionalServices.find(candidate => candidate.service === dependency);

              // A dependency Desktop is not managing (e.g. the vault when disabled) cannot block.
              if (!dependencyEntry || this.#activeOptionalSullaServices.has(dependency)) continue;
              if (!await run(dependencyEntry)) {
                bootStatus.set(service, `waiting for ${ dependency }`);

                return false;
              }
            }
            await takeStartSlot();
            try {
              const state = (await this.execCommand(
                { capture: true, root: true, expectFailure: true }, 'docker', 'inspect', '--format',
                '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', container,
              ).catch(() => '')).trim(); // a fresh install has no container yet

              // Files can legitimately spend minutes applying a first-start
              // schema upgrade. Do not re-run compose against a live starter;
              // let it finish, then replace it only if a newer image exists.
              // Any other service still in its start period is left to finish
              // too: compose's fallback would recreate it mid-migration.
              if (service === 'sulla_files') {
                // The image check lets a starter reach healthy and can take
                // minutes. Do not hold the Compose writer queue during that wait.
                const needsStart = !state.startsWith('running') || await this.#imageFreshness.isStale(container, service, generation);

                await this.#composeRegeneration.serialize(async() => {
                  this.assertManagedServicesGeneration(generation);
                  await this.#filesCloudIdentity.refresh();
                  this.assertManagedServicesGeneration(generation);
                  if (needsStart) {
                    await startOptionalService(service);
                  } else {
                    await configDrift.reconcile(entry);
                  }
                });
              } else if (service === 'sulla_files_fuse') {
                if (this.#staleFilesAdapters.has(service) || !state.startsWith('running')) {
                  await startOptionalService(service);
                } else {
                  const imageChanged = state === 'running healthy' && await this.#imageFreshness.isStale(container, service, generation);
                  const runningConfigHash = (await this.execCommand({ capture: true, root: true, expectFailure: true }, 'docker', 'inspect', '--format', '{{index .Config.Labels "com.merchantprotocol.sulla.files-fuse-config-hash"}}', container).catch(() => '')).trim();
                  const recovery = decideFilesFuseRecovery({
                    containerState: 'running', imageChanged,
                    configChanged: !!this.#filesFuseConfigHash && runningConfigHash !== this.#filesFuseConfigHash,
                    mountDead: false,
                    nowMs: Date.now(), lastRestartMs: this.#lastFilesFuseRestartMs, restartCooldownMs: 60_000,
                  });

                  if (recovery === 'recreate') {
                    console.warn('[Sulla] Files FUSE image changed; recreating adapter (reason: image digest changed)');
                    await startOptionalService(service);
                  }
                }
                // Reconcile only the stable digest of the adapter's own restart-relevant
                // definition; Compose's full config hash includes volatile regeneration inputs.
              } else if (state !== 'running starting') {
                await startOptionalService(service);
              } else {
                await configDrift.reconcile(entry);
              }
              await this.waitForDockerServiceHealthy(entry, service === 'sulla_files' ? 600 : 20, generation);
              // A dead-mount recovery keeps the existing container alive. Once it
              // is healthy again, refresh it only if the adapter image actually changed.
              if (service === 'sulla_files_fuse' && this.#lastFilesFuseRestartMs !== undefined
                && await this.#imageFreshness.isStale(container, service, generation)) {
                console.warn('[Sulla] Files FUSE image changed after restart; recreating adapter (reason: image digest changed)');
                await startOptionalService(service);
                await this.waitForDockerServiceHealthy(entry, 20, generation);
              }
              this.#activeOptionalSullaServices.add(service);
              bootStatus.set(service, 'healthy');
              if (service === 'sulla_vault') markVaultContainerReady();

              return true;
            } catch (error) {
              if (error instanceof ManagedServicesReconciliationCancelled) throw error;
              const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];

              bootStatus.set(service, `unhealthy (${ reason })`);
              console.warn(`[Sulla] Optional service ${ service } unavailable (attempt ${ attempt }${ attempt <= OPTIONAL_SERVICE_ATTEMPTS ? `/${ OPTIONAL_SERVICE_ATTEMPTS }` : ', slow reconcile' }); Desktop remains usable: ${ reason }`);

              return false;
            } finally {
              releaseStartSlot();
            }
          };

          this.assertManagedServicesGeneration(generation);
          await Promise.all(orderedOptionalServices.map(run));
          const allActive = orderedOptionalServices.every(entry => this.#activeOptionalSullaServices.has(entry.service));

          if (allActive || attempt === OPTIONAL_SERVICE_ATTEMPTS) {
            settleFirstPass();
            void this.#postgresAuth.afterFirstPass(generation, bootStatus); // in the background: never holds boot
          }
          if (attempt === 1) {
            console.log(`[Sulla] Boot services: postgres=healthy, redis=healthy, ${
              [...bootStatus].map(([service, status]) => `${ service }=${ status }`).join(', ')
            }`);
          }
          firstRunTrace('services', `optional services attempt ${ attempt }`, Object.fromEntries(bootStatus));
          if (allActive) return;
          const delayMs = attempt < OPTIONAL_SERVICE_ATTEMPTS
            ? Math.min(5_000 * attempt, 30_000)
            : OPTIONAL_SERVICE_RECONCILE_MS + Math.round(Math.random() * 15_000);

          await new Promise<void>((resolve) => {
            const timer = setTimeout(wake, delayMs);

            function wake() {
              clearTimeout(timer);
              resolve();
            }
            this.#wakeOptionalReconcile = wake;
          });
          this.#wakeOptionalReconcile = undefined;
        }
      };

      // One reconcile loop and one health watch per generation: a retried
      // reconcile of the same generation must not start a second pair.
      if (this.#optionalReconcileGeneration === generation) return;
      this.#optionalReconcileGeneration = generation;
      let settleFirstPass!: () => void;
      let reconcileRunning = false;
      const startReconcile = (): void => {
        reconcileRunning = true;
        reconcileInBackground().catch((error) => {
          if (!(error instanceof ManagedServicesReconciliationCancelled)) {
            console.warn('[Sulla] Optional service background reconciliation stopped:', error);
          }
        }).finally(() => {
          reconcileRunning = false;
          settleFirstPass();
          this.#wakeOptionalReconcile = undefined;
        });
      };

      // Optional services must never hold the backend STARTED/unlock transition.
      // Compose health dependencies preserve ordering; the background reconcile
      // repairs a cold or transiently broken service after Desktop is usable.
      // Images used later wait for the first pass (see reconcileSullaDockerEnvironment).
      this.#optionalServicesSettled = new Promise<void>((resolve) => { settleFirstPass = resolve });
      startReconcile();
      // A desired service with no container at all (never created, or removed)
      // is invisible to the unhealthy-container check; hand it back to the reconcile.
      this.#healthWatcher.watch(() => this.assertManagedServicesGeneration(generation), composeCommand, orderedOptionalServices, (missing) => {
        for (const entry of missing) this.#activeOptionalSullaServices.delete(entry.service);
        if (this.#wakeOptionalReconcile) this.#wakeOptionalReconcile();
        else if (!reconcileRunning) startReconcile();
      });
    });
  }

  /**
   * Waits for a compose service's container to be healthy. The container is
   * found by its compose labels when it is not under its fixed name, and a
   * name left over from an interrupted re-create is healed on the way.
   */
  private async waitForDockerServiceHealthy(target: ComposeServiceTarget, timeoutSec = 300, generation?: number): Promise<void> {
    await this.#composeHealth.waitHealthy(target, timeoutSec,
      generation === undefined ? undefined : () => this.assertManagedServicesGeneration(generation));
    console.log(`Docker service ${ target.container } is ready`);
  }

  async stop(): Promise<void> {
    // When we manually call stop, the subprocess will terminate, which will
    // cause stop to get called again.  Prevent the reentrancy.
    // If we're in the middle of starting, also ignore the call to stop (from
    // the process terminating), as we do not want to shut down the VM in that
    // case.

    this.invalidateManagedServicesGeneration();
    await getSullaFilesMountManager().stop().catch(error => console.warn('[SullaFiles] guest mount shutdown failed:', error));
    getSullaFilesBackups().clearGuest(this);
    getSullaFilesMountManager().clearGuest(this);
    if (this.currentAction === Action.STARTING && this.#backendStartSettled) {
      await this.#backendStartSettled;
      if (this.currentAction === Action.STARTING) this.currentAction = Action.NONE;
    }
    if (this.currentAction !== Action.NONE) {
      return;
    }
    this.currentAction = Action.STOPPING;
    this.#containerEngineClient = undefined;

    await this.progressTracker.action('Stopping services', 10, async() => {
      try {
        await this.setState(State.STOPPING);
        await this.stopSullaRuntime();
        await this.setState(State.STOPPED);
      } catch (ex) {
        await this.setState(State.ERROR);
        throw ex;
      } finally {
        this.currentAction = Action.NONE;
      }
    });
  }

  del(): Promise<void> {
    assertSupportedOnSullaRuntime('Deleting the virtual machine');
    this.cfg = undefined;

    return Promise.resolve();
  }

  reset(_config: BackendSettings): Promise<void> {
    return Promise.reject(new SullaRuntimeUnsupportedError('Resetting the virtual machine'));
  }

  async handleSettingsUpdate(_: BackendSettings): Promise<void> {}

  requiresRestartReasons(cfg: RecursivePartial<BackendSettings>): Promise<RestartReasons> {
    const reasons: RestartReasons = {};

    if (!this.cfg || !this.#sullaRuntime) {
      return Promise.resolve(reasons); // No need to restart if nothing is running
    }
    const current = this.cfg.virtualMachine;
    const requested = cfg.virtualMachine;

    if (requested?.numberCPUs !== undefined && requested.numberCPUs !== current.numberCPUs) {
      reasons['virtualMachine.numberCPUs'] = { current: current.numberCPUs, desired: requested.numberCPUs, severity: 'restart' };
    }
    if (requested?.memoryInGB !== undefined && requested.memoryInGB !== current.memoryInGB) {
      reasons['virtualMachine.memoryInGB'] = { current: current.memoryInGB, desired: requested.memoryInGB, severity: 'restart' };
    }

    return Promise.resolve(reasons);
  }

  async getFailureDetails(exception: any): Promise<FailureDetails> {
    const logfile = console.path;
    const logLines = (await fs.promises.readFile(logfile, 'utf-8')).split('\n').slice(-10);

    return {
      lastCommand:        exception[childProcess.ErrorCommand],
      lastCommandComment: getProgressErrorDescription(exception) ?? 'Unknown',
      lastLogLines:       logLines,
    };
  }


  // #region Events
  eventNames(): (keyof BackendEvents)[] {
    return super.eventNames() as (keyof BackendEvents)[];
  }

  listeners<eventName extends keyof BackendEvents>(
    event: eventName,
  ): BackendEvents[eventName][] {
    return super.listeners(event) as BackendEvents[eventName][];
  }

  rawListeners<eventName extends keyof BackendEvents>(
    event: eventName,
  ): BackendEvents[eventName][] {
    return super.rawListeners(event) as BackendEvents[eventName][];
  }
  // #endregion
}
