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

import { Architecture, BackendError, BackendEvents, BackendProgress, BackendSettings, execOptions, FailureDetails, RestartReasons, State, VMBackend, VMExecutor } from './backend';
import { ContainerEngineClient, MobyClient } from './containerClient';
import { bundledImagesDir, currentBundledImageLock, ensureBundledImages, pinComposeImages, sullaRuntimeGuestDocker, useBundledImages } from './bundledImages';
import ProgressTracker, { getProgressErrorDescription } from './progressTracker';
import { composeImageFields, resolveSullaServiceImage, shouldRefreshSullaServiceImage } from './sullaServiceImages';
import { FILES_TLS_DIRECTORY, filesTlsBind } from './filesTlsIdentity';
import { VAULT_TLS_DIRECTORY, vaultTlsBind } from './vaultTlsIdentity';
import { accountsSecretBinds, assertNoHostBindMounts, provisionAccountsSecretsInGuest } from './sullaComposeMounts';
import { planUnhealthyRecreates, type ManagedContainerRow } from './sullaContainerHealth';
import {
  clearOnDemandServices, configureOnDemandServices, ON_DEMAND_SERVICES, type OnDemandServiceName,
} from './onDemandServices';
import { reconcileComposeService } from './sullaServiceReconcile';
import { ensureAgentNetworkCommand, provisionStateCommand, threatProxyComposeService } from './threatProxyEgress';
import { findSullaRuntimeArtifacts, sullaRuntimeSockets } from './sullaRuntime/artifacts';
import { ensureSullaRuntimeDataDisk } from './sullaRuntime/dataDisk';
import { guestUserFor, NativeRuntime, SullaRuntimeShare } from './sullaRuntime/NativeRuntime';
import { SullaRuntimePortForwarder } from './sullaRuntime/portForwarder';
import { assertSupportedOnSullaRuntime, isSullaRuntimeActive, setSullaRuntimeActive, SullaRuntimeUnsupportedError, takeSullaRuntimeSuspendRequest } from './sullaRuntime/state';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import PROVISION_VAULT_TLS from '@pkg/assets/scripts/provision-vault-tls';
import PROVISION_FILES_TLS from '@pkg/assets/scripts/provision-files-tls';
import SULLA_DOCKER_COMPOSE from '@pkg/assets/sulla-docker-compose.yaml';
import * as settingsImpl from '@pkg/config/settingsImpl';
import { readExistingDesktopDeviceId } from '@pkg/main/deviceIdentity';
import mainEvents from '@pkg/main/mainEvents';
import { refreshVaultPinnedSessions } from '@pkg/main/vaultTls';
import { refreshFilesPinnedSessions } from '@pkg/main/sullaFilesTls';
import {
  SULLA_FILES_GUEST_MOUNT_PATH, prepareSullaFilesGuestAnchorDraining,
} from '@pkg/backend/guestMountInfo';
import { getSullaFilesBackups } from '@pkg/main/sullaFilesBackups';
import { getSullaFilesMountManager } from '@pkg/main/sullaFilesMountManager';
import { exec as sudo } from '@pkg/sudo-prompt';
import { expectVaultContainer, instantiateSullaStart, markSullaDockerServicesStarted, markVaultContainerReady } from '@pkg/sulla';
import * as childProcess from '@pkg/utils/childProcess';
import clone from '@pkg/utils/clone';
import dockerDirManager from '@pkg/utils/dockerDirManager';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';
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

const OPTIONAL_SERVICE_ATTEMPTS = 8;

/**
 * SullaRuntimeBackend drives the native Sulla runtime: a macOS
 * Virtualization.framework VM booted and controlled through the
 * `sulla-runtime` host binary. Guest commands run through
 * `sulla-runtime exec`.
 */
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
  }

  readonly executor = this;
  readonly managesSullaServices = true;
  #containerEngineClient: ContainerEngineClient | undefined;
  #activeOptionalSullaServices = new Set<string>();
  /** Settles when the background start of the optional services finishes. */
  #optionalServicesSettled: Promise<void> = Promise.resolve();
  #optionalSullaFallbackImages = new Map<string, { env: string; image: string }>();
  #managedSullaRefreshImages = new Map<string, string>();
  /** Services running an image bundled with the app: the exact reference they must run. */
  #pinnedSullaImages = new Map<string, string>();
  #managedServicesReconciliation?: Promise<void>;
  #hostPreparationDeferred = false;
  #backendStartSettled?: Promise<void>;
  #managedServicesGeneration = 0;
  /** FUSE adapter services whose stale mount was drained; compose must recreate them. */
  #staleFilesAdapters = new Set<string>();
  #containerRecreates = new Map<string, number>();
  #lastGuestRecovery = 0;
  #lastFilesGuestMountFailure?: string;
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
    await fs.promises.mkdir(paths.appHome, { recursive: true });
    await fs.promises.writeFile(tokenFile, JSON.stringify({
      token: sullaApiToken,
      port:  3000,
      pid:   process.pid,
    }, null, 2), { mode: 0o600 });
    const sullaEnv = `SULLA_API_TOKEN=${ sullaApiToken }\nSULLA_HOST=host.sulla.internal\n`;

    await this.writeFile('/etc/sulla-env', sullaEnv, 0o644);
    console.log('[sulla-runtime] wrote /etc/sulla-env');
  }


  async start(config_: BackendSettings): Promise<void> {
    const config = this.cfg = clone(config_);
    const managedServicesGeneration = this.beginManagedServicesGeneration();
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
        this.ensureArchitectureMatch();
        await this.startOnSullaRuntime(config, managedServicesGeneration, backendStartTotal);
      } catch (err) {
        if (err instanceof ManagedServicesReconciliationCancelled) {
          console.log('[Sulla] Managed-service reconciliation cancelled by backend lifecycle change');

          return;
        }
        console.error('Error starting the Sulla runtime:', err);
        await this.setState(State.ERROR);
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

    try {
      await this.startSullaRuntimeThroughDockerReady(config, shares);
    } catch (error) {
      await this.stopSullaRuntime().catch(cleanupError => console.error('[sulla-runtime] cleanup after a failed start failed:', cleanupError));
      throw error;
    }
    await this.finishSullaRuntimeBoot(config, generation, backendStartTotal, shares);
  }

  /** Host folders shared into the guest under short virtio-fs tags, at the same path. */
  protected sullaRuntimeShares(): SullaRuntimeShare[] {
    // Only app-owned transport/cache roots cross the VM boundary. User home,
    // external volumes, and Darwin's broad temporary roots are Files-owned.
    const locations = ['/tmp/sulla-desktop'];

    for (const extraDir of [paths.cache, paths.logs, paths.resources]) {
      const found = locations.some(loc => !path.relative(path.normalize(loc), path.normalize(extraDir)).startsWith('../'));

      if (!found) {
        locations.push(extraDir);
      }
    }

    return locations.map((location, index) => ({
      tag:      `sulla${ index }`,
      hostPath: location,
      readOnly: location === paths.resources,
    }));
  }

  protected async startSullaRuntimeThroughDockerReady(config: BackendSettings, shares: SullaRuntimeShare[]): Promise<void> {
    const preparedAt = Date.now();
    const artifacts = await findSullaRuntimeArtifacts();

    const dataDisk = await ensureSullaRuntimeDataDisk();

    console.log(`[sulla-runtime] data disk ${ dataDisk.path } (${ dataDisk.source })`);
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

    await runtime.start({
      dataDisk:         dataDisk.path,
      cpus:             config.virtualMachine.numberCPUs,
      memoryMiB:        config.virtualMachine.memoryInGB * 1024,
      shares,
      guestUser,
      onMilestone:      (name, elapsedMs) => console.log(`[startup-perf] sulla-runtime ${ name }: ${ elapsedMs }ms after spawn`),
      onUnexpectedExit: (reason) => {
        console.error(`[sulla-runtime] the runtime stopped unexpectedly (${ reason })`);
        void this.stopSullaRuntime().finally(() => this.setState(State.ERROR));
      },
    });
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
    this.#sullaRuntimeForwarder = new SullaRuntimePortForwarder(dockerSocket, sullaRuntimeSockets.guest);
    this.#sullaRuntimeForwarder.start();

    await this.progressTracker.action('Writing sulla environment', 50, this.writeGuestSullaEnv());
    await this.progressTracker.action('Waiting for container engine client to be ready', 50,
      this.#containerEngineClient.waitForReady());
    logStartupPhase('docker-api-ready', backendStartTotal, 'status=ready runtime=sulla');

    await this.setState(State.DISABLED);
    mainEvents.emit('first-run-backend-booted');
    t = Date.now();
    void (async() => {
      await this.reconcileManagedServicesWithRetries(generation, config);
      console.log(`[startup-perf] sulla-runtime managed services ready: ${ Date.now() - t }ms`);
      logStartupPhase('sulla-services', t, 'status=ready runtime=sulla');
      await SullaSettingsModel.set('firstKubernetesIsInstalled', true, 'boolean');
    })().catch((error) => {
      if (!(error instanceof ManagedServicesReconciliationCancelled)) {
        console.warn(`[startup-phase] ${ new Date().toISOString() } phase=background-startup status=degraded runtime=sulla`, error);
        // Release the boot screen: it waits for the services, and would wait forever.
        mainEvents.emit('sulla-managed-services-failed');
      }
    });
    logStartupPhase('backend-ready', backendStartTotal, 'scope=docker-api services=streaming runtime=sulla');
  }

  /** Mount each share in the guest at its host path, before anything else uses it. */
  protected async mountSullaRuntimeShares(shares: SullaRuntimeShare[]): Promise<void> {
    for (const share of shares) {
      try {
        await this.execCommand({ root: true }, 'sh', '-c',
          'mkdir -p "$2" && { mountpoint -q "$2" || mount -t virtiofs "$1" "$2"; }', 'sh', share.tag, share.hostPath);
      } catch (error) {
        console.error(`[sulla-runtime] could not mount ${ share.hostPath } in the guest:`, error);
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
   * retried; a persistent one must surface as ERROR instead of leaving the UI
   * showing a healthy backend with no services.
   */
  private async reconcileManagedServicesWithRetries(generation: number, config: BackendSettings): Promise<void> {
    const retryDelaysMs = [5_000, 15_000, 30_000];

    for (let attempt = 0; ; attempt++) {
      try {
        await this.reconcileManagedServices(generation, config);

        return;
      } catch (error) {
        if (error instanceof ManagedServicesReconciliationCancelled ||
            generation !== this.#managedServicesGeneration) {
          throw error;
        }
        if (attempt >= retryDelaysMs.length) {
          console.error('[startup-phase] phase=sulla-services status=failed after retries', error);
          await this.setState(State.ERROR);
          throw error;
        }
        console.warn(`[startup-phase] ${ new Date().toISOString() } phase=sulla-services status=retrying attempt=${ attempt + 1 }`, error);
        await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]));
      }
    }
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
      await this.prepareSullaComposeFile();
      this.assertManagedServicesGeneration(generation);
      console.log(`[startup-perf] prepareSullaComposeFile: ${ Date.now() - t }ms`);
      this.progressTracker.numeric('Docker Compose file prepared', 15, 100);
    });

    // Every service image (threat proxy included) must be in the guest before
    // the agent network/egress setup and compose; agents depend on the proxy.
    await this.progressTracker.action('Loading bundled container images', 40, async() => {
      t = Date.now();
      await this.loadBundledImages(image => !image.onDemand);
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


  /**
   * Load the app's bundled images the guest does not have yet (first boot, or
   * after an app update shipped new ones). Without a bundle (development) this
   * does nothing and compose pulls as before.
   */
  private async loadBundledImages(filter: (image: { onDemand?: boolean }) => boolean, reportProgress = true): Promise<void> {
    const lock = currentBundledImageLock();
    const imagesDir = bundledImagesDir();

    if (!lock || !imagesDir) return;
    const result = await ensureBundledImages({
      lock,
      imagesDir,
      docker:     sullaRuntimeGuestDocker(paths.sullaRuntime),
      filter,
      onProgress: reportProgress
        ? (done, total, image) => this.progressTracker.numeric(`Loading bundled image ${ image.name }`, done, total)
        : undefined,
    });

    if (reportProgress) this.progressTracker.numeric('Bundled container images loaded', 100, 100);
    if (result.loaded.length || result.failed.length) {
      console.log(`[bundled-images] present=${ result.present.join(',') || '-' } loaded=${ result.loaded.join(',') || '-' } failed=${ result.failed.map(f => f.name).join(',') || '-' }`);
    }
  }

  private async loadOrCreateVaultServiceIdentities(): Promise<{
    bootstrapToken: string; controlToken: string; approvalToken: string; brokerToken: string; filesToken: string;
  }> {
    if (!Electron.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-protected storage is required for the local vault service identities');
    }
    const files = {
      bootstrapToken: 'vault-bootstrap-identity.enc',
      controlToken:   'vault-control-token.enc',
      approvalToken:  'vault-approval-token.enc',
      brokerToken:    'vault-broker-token.enc',
      filesToken:     'vault-files-token.enc',
    } as const;
    await fs.promises.mkdir(paths.appHome, { recursive: true });
    const readProtected = async(file: string): Promise<string | undefined> => {
      try {
        const value = Electron.safeStorage.decryptString(await fs.promises.readFile(path.join(paths.appHome, file)));
        return value.length >= 32 ? value : undefined;
      } catch {
        return undefined;
      }
    };
    let identities = {
      bootstrapToken: await readProtected(files.bootstrapToken),
      controlToken:   await readProtected(files.controlToken),
      approvalToken:  await readProtected(files.approvalToken),
      brokerToken:    await readProtected(files.brokerToken),
      filesToken:     await readProtected(files.filesToken),
    };
    if (Object.values(identities).some(value => !value) || new Set(Object.values(identities)).size !== 5) {
      identities = {
        bootstrapToken: crypto.randomBytes(48).toString('base64url'),
        controlToken:   crypto.randomBytes(48).toString('base64url'),
        approvalToken:  crypto.randomBytes(48).toString('base64url'),
        brokerToken:    crypto.randomBytes(48).toString('base64url'),
        filesToken:     crypto.randomBytes(48).toString('base64url'),
      };
    }
    const writeProtected = async(file: string, value: string): Promise<void> => {
      const target = path.join(paths.appHome, file);
      const temporary = `${ target }.${ process.pid }.tmp`;
      await fs.promises.writeFile(temporary, Electron.safeStorage.encryptString(value), { mode: 0o600 });
      await fs.promises.rename(temporary, target);
    };
    // Repair every exported role identity on every start. These files contain
    // only safeStorage ciphertext and are never mounted into a container.
    await writeProtected(files.bootstrapToken, identities.bootstrapToken!);
    await writeProtected(files.controlToken, identities.controlToken!);
    await writeProtected(files.approvalToken, identities.approvalToken!);
    await writeProtected(files.brokerToken, identities.brokerToken!);
    await writeProtected(files.filesToken, identities.filesToken!);

    return identities as {
      bootstrapToken: string; controlToken: string; approvalToken: string; brokerToken: string; filesToken: string;
    };
  }

  /**
   * Run a TLS identity script (stdout is the public certificate). The Sulla
   * runtime guest may lack openssl; there the same script runs in a throwaway
   * Alpine container that sees only Sulla's guest state directories, so the
   * private key still never leaves the guest disk.
   */
  private async provisionGuestTlsIdentity(script: string, ...args: string[]): Promise<string> {
    // openssl ships in the runtime guest image; the guest cannot install packages.
    const hasOpenssl = await this.execCommand({ root: true, expectFailure: true }, 'sh', '-c', 'command -v openssl >/dev/null').then(() => true, () => false);
    if (!hasOpenssl) {
      throw new Error('The Sulla runtime guest has no openssl, so it cannot create its TLS identities. Update Sulla Desktop to a runtime that includes it.');
    }

    return await this.execCommand({ capture: true, root: true }, 'sh', '-c', script, '--', ...args);
  }

  private async prepareVaultTlsIdentity(): Promise<{ fingerprint: string }> {
    const certificate = await this.provisionGuestTlsIdentity(
      PROVISION_VAULT_TLS, VAULT_TLS_DIRECTORY, '/var/lib/sulla/vault-tls', '1000', '1000',
    );
    const fingerprint = new crypto.X509Certificate(certificate).fingerprint256;
    // The identity directory is 0700 and contains a private key. Publish only
    // the public certificate for the unprivileged native console proxy.
    await this.execCommand({ root: true }, 'mkdir', '-p', '-m', '755', '/etc/sulla-console');
    await this.writeFile('/etc/sulla-console/vault.crt', certificate, 0o644);
    await fs.promises.mkdir(paths.appHome, { recursive: true });
    await fs.promises.writeFile(path.join(paths.appHome, 'vault-tls-certificate.pem'), certificate, { mode: 0o600 });
    await fs.promises.writeFile(path.join(paths.appHome, 'vault-tls-fingerprint'), `${ fingerprint }\n`, { mode: 0o600 });

    await refreshVaultPinnedSessions();

    return { fingerprint };
  }

  private async loadOrCreateFilesBootstrapIdentity():Promise<string> {
    if (!Electron.safeStorage.isEncryptionAvailable()) throw new Error('OS-protected storage is required for Files bootstrap');
    const target = path.join(paths.appHome, 'files-bootstrap-identity.enc');
    let encrypted:Buffer;
    try {
      encrypted = await fs.promises.readFile(target);
      const token = Electron.safeStorage.decryptString(encrypted);
      if (Buffer.byteLength(token) < 32) throw new Error('Existing Files bootstrap identity is invalid');
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const token = crypto.randomBytes(48).toString('base64url');
    await fs.promises.mkdir(paths.appHome, { recursive: true });
    const temporary = `${ target }.${ process.pid }.tmp`;
    const protectedToken = Electron.safeStorage.encryptString(token);
    try {
      const file = await fs.promises.open(temporary, 'wx', 0o600);
      try { await file.writeFile(protectedToken); await file.sync() } finally { await file.close() }
      try { await fs.promises.link(temporary, target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const concurrent = Electron.safeStorage.decryptString(await fs.promises.readFile(target));
        if (Buffer.byteLength(concurrent) < 32) throw new Error('Concurrent Files bootstrap identity is invalid');
        return concurrent;
      }
      const directory = await fs.promises.open(path.dirname(target), fs.constants.O_RDONLY);
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      protectedToken.fill(0);
      await fs.promises.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error });
    }
    return token;
  }

  private async prepareAccountsSecrets(databasePassword: string):Promise<{
    bootstrap:        string;
    databasePassword: string;
    databaseUsername: string;
    encryption:       string;
    session:          string;
  }> {
    const directory = path.join(paths.appHome, 'accounts');

    const directoryInfo = await fs.promises.lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (directoryInfo?.isSymbolicLink() || (directoryInfo && !directoryInfo.isDirectory())) {
      throw new Error('Accounts secret directory is not a regular directory');
    }
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(directory, 0o700);

    const writeAtomic = async(target: string, value: Buffer | string):Promise<void> => {
      const targetInfo = await fs.promises.lstat(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (targetInfo?.isSymbolicLink() || (targetInfo && !targetInfo.isFile())) {
        throw new Error(`Accounts secret path is not a regular file: ${ path.basename(target) }`);
      }
      const temporary = `${ target }.${ process.pid }.${ crypto.randomUUID() }.tmp`;
      const handle = await fs.promises.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(value);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.promises.rename(temporary, target);
        await fs.promises.chmod(target, 0o600);
      } finally {
        await fs.promises.unlink(temporary).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    };
    const loadExisting = async(target: string):Promise<Buffer | undefined> => {
      let handle:fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error(`Accounts secret path is not a regular file: ${ path.basename(target) }`);
        await handle.chmod(0o600);
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    };
    const loadOrCreateRaw = async(name: string, bytes: number):Promise<string> => {
      const target = path.join(directory, name);
      const existing = await loadExisting(target);
      if (existing) {
        if (existing.byteLength !== bytes) throw new Error(`Existing Accounts ${ name } has an invalid length`);
      } else {
        const secret = crypto.randomBytes(bytes);
        try { await writeAtomic(target, secret) } finally { secret.fill(0) }
      }
      return target;
    };
    const loadOrCreateBearer = async(name: string):Promise<string> => {
      const target = path.join(directory, name);
      const existing = await loadExisting(target);
      if (existing) {
        const value = existing.toString('utf8').trim();
        if (!/^[A-Za-z0-9_-]{64}$/.test(value)) throw new Error(`Existing Accounts ${ name } has an invalid format`);
      } else {
        const secret = crypto.randomBytes(48).toString('base64url');
        await writeAtomic(target, secret);
      }
      return target;
    };
    const databaseUsername = path.join(directory, 'database.username');
    const databasePasswordPath = path.join(directory, 'database.password');

    await writeAtomic(databaseUsername, 'sulla');
    await writeAtomic(databasePasswordPath, databasePassword);

    return {
      bootstrap:         await loadOrCreateBearer('bootstrap.secret'),
      databasePassword: databasePasswordPath,
      databaseUsername,
      encryption:        await loadOrCreateRaw('encryption.key', 32),
      session:           await loadOrCreateRaw('session.secret', 48),
    };
  }

  private async prepareFilesTlsIdentity():Promise<{ fingerprint:string }> {
    const { uid, gid } = os.userInfo();
    const certificate = await this.provisionGuestTlsIdentity(PROVISION_FILES_TLS, FILES_TLS_DIRECTORY, String(uid), String(gid));
    const fingerprint = new crypto.X509Certificate(certificate).fingerprint256;
    await this.execCommand({ root: true }, 'mkdir', '-p', '-m', '755', '/etc/sulla-console');
    await this.writeFile('/etc/sulla-console/files.crt', certificate, 0o644);
    await fs.promises.mkdir(paths.appHome, { recursive: true });
    await fs.promises.writeFile(path.join(paths.appHome, 'files-tls-certificate.pem'), certificate, { mode: 0o600 });
    await fs.promises.writeFile(path.join(paths.appHome, 'files-tls-fingerprint'), `${ fingerprint }\n`, { mode: 0o600 });
    await refreshFilesPinnedSessions();
    return { fingerprint };
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
    const rawSullaServicePassword = await SullaSettingsModel.getServicePassword();
    const sullaServicePassword = escapeForCompose(rawSullaServicePassword);
    const tokenFile = path.join(paths.appHome, 'chat-api-token.json');
    let sullaApiToken = '';
    try {
      sullaApiToken = JSON.parse(await fs.promises.readFile(tokenFile, 'utf-8')).token || '';
    } catch {
      sullaApiToken = await SullaSettingsModel.get('sullaApiToken') || '';
    }
    if (!sullaApiToken) throw new Error('Sulla API token is unavailable while preparing container services');
    sullaApiToken = escapeForCompose(sullaApiToken);
    const filesBootstrapIdentity = await this.loadOrCreateFilesBootstrapIdentity();
    const { fingerprint: filesTlsFingerprint } = await this.prepareFilesTlsIdentity();
    try {
      const accountsSecrets = await this.prepareAccountsSecrets(rawSullaServicePassword);
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
      vaultIdentities = await this.loadOrCreateVaultServiceIdentities();
      ({ fingerprint: vaultTlsFingerprint } = await this.prepareVaultTlsIdentity());
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
          SULLA_VAULT_ADMIN_DATABASE_URL: `postgresql://sulla:${ sullaServicePassword }@postgres:5432/sulla`,
          SULLA_VAULT_DATABASE_URL: `postgresql://sulla:${ sullaServicePassword }@postgres:5432/sulla_vault`,
          SULLA_VAULT_LEGACY_DATABASE_URL: `postgresql://sulla:${ sullaServicePassword }@postgres:5432/sulla`,
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
        healthcheck: { test: ['CMD', 'wget', '--no-check-certificate', '-qO-', 'https://127.0.0.1:8787/healthz'], interval: '10s', timeout: '3s', retries: 5 },
      };
    }

    // Desktop is a single-node Sulla Server. The manager and its ephemeral
    // runners use the same image that the server deployment will use; only
    // the launcher driver differs (Docker here, Kubernetes on the server).
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
        SULLA_DATABASE_URL: `postgresql://sulla:${ sullaServicePassword }@postgres:5432/sulla`,
        SULLA_REDIS_URL: 'redis://redis:6379',
        SULLA_MANAGER_URL: 'http://workflow_manager:8788',
        SULLA_TOOL_API_URL: 'http://host.docker.internal:3000',
        SULLA_WORKFLOW_IMAGE: image,
        SULLA_DOCKER_NETWORK: 'sulla_default',
      },
      extra_hosts: ['host.docker.internal:host-gateway'],
      ports: [`127.0.0.1:${ hostPort(30122) }:8788`],
      volumes: ['/var/run/docker.sock:/var/run/docker.sock', '/mnt/sulla-files:/mnt/sulla-files:rslave'],
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
        SULLA_DATABASE_URL: `postgresql://sulla:${ sullaServicePassword }@postgres:5432/sulla`,
        SULLA_REDIS_URL: 'redis://redis:6379',
        SULLA_RELAY_URL: 'http://sulla_relay:8790',
        SULLA_RELAY_TOKEN: sullaApiToken,
        SULLA_FILES_API_URL:     'https://sulla_files:8792',
        SULLA_FILES_TLS_CA_FILE: '/run/sulla-files-ca/tls.crt',
        SULLA_FILES_CAPABILITY_SECRET: sullaServicePassword,
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
        SULLA_FILES_DATABASE_URL:          `postgresql://sulla:${ sullaServicePassword }@postgres:5432/sulla`,
        SULLA_FILES_CHUNK_ROOT:            '/var/lib/sulla-files/chunks',
        SULLA_FILES_DATA_ROOT:             '/var/lib/sulla-files',
        SULLA_FILES_STORED_ONLY:           '1',
        SULLA_FILES_MODE:                  'desktop',
        SULLA_FILES_DEVICE_ID:             os.hostname(),
        // Cloud device id (not the hostname) so the Files catalog push targets this device's Cloud row.
        ...((cloudDeviceId: string | null) => (cloudDeviceId ? { SULLA_FILES_CLOUD_DEVICE_ID: cloudDeviceId } : {}))(readExistingDesktopDeviceId()),
        SULLA_FILES_UID:                   String(os.userInfo().uid),
        SULLA_FILES_GID:                   String(os.userInfo().gid),
        SULLA_FILES_CAPABILITY_SIGNING_KEY: sullaFilesCapabilityKey(sullaServicePassword),
        SULLA_FILES_LOCAL_TOKEN:           sullaServicePassword,
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
      mem_limit: '1g',
      healthcheck: {
        test: [
          'CMD', 'node', '-e',
          "const fs=require('fs'),https=require('https');const r=https.get({hostname:'127.0.0.1',port:8792,path:'/healthz',ca:fs.readFileSync('/run/sulla-files-tls/tls.crt')},x=>{x.resume();process.exit(x.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(2500,()=>r.destroy())",
        ],
        interval: '5s', timeout: '3s', retries: 10, start_period: '10m',
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
          SULLA_FILES_FUSE_MOUNT_PATH:       '/mnt/sulla-files',
          SULLA_FILES_FUSE_SPOOL:            '/var/spool/sulla-files-fuse',
          SSL_CERT_FILE:                     '/run/sulla-files-ca/tls.crt',
        },
        volumes: [
          '/var/lib/sulla/files-fuse:/run/sulla-files-fuse:ro',
          '/proc:/host/proc:ro',
          '/mnt/sulla-files:/mnt/sulla-files:rshared',
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
        healthcheck: {
          test: [
            'CMD', 'python3', '-c',
            "import os,ssl,urllib.request; assert os.path.ismount('/mnt/sulla-files'); urllib.request.urlopen('https://sulla_files:8792/healthz', context=ssl.create_default_context(cafile='/run/sulla-files-ca/tls.crt'), timeout=2).read(1)",
          ],
          interval: '5s', timeout: '3s', retries: 10,
        },
      };
    }

    // Modify dynamic values like passwords
    if (compose.services?.postgres?.environment) {
      compose.services.postgres.environment = compose.services.postgres.environment.map((env: string) => {
        if (env.startsWith('POSTGRES_PASSWORD=')) {
          return `POSTGRES_PASSWORD=${ sullaServicePassword }`;
        }
        return env;
      });
    }

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
    await this.writeFile('/tmp/sulla-docker-compose.yml', composeYaml, 0o644);
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
        console.warn(`[Sulla] ${ SULLA_FILES_GUEST_MOUNT_PATH } had ${ drained } stale adapter mount(s); detached them and will recreate sulla_files_fuse`);
        this.#staleFilesAdapters.add('sulla_files_fuse');
      }
      this.#lastFilesGuestMountFailure = undefined;
      getSullaFilesMountManager().reportGuestPreparation();
      // The workflow manager image cannot ask Desktop; this marker tells it
      // the anchor exists so its runners may bind /mnt/sulla-files.
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

          return source !== SULLA_FILES_GUEST_MOUNT_PATH;
        });
      }

      return false;
    }
  }

  /**
   * Runtime recovery for the Files guest mount, called by the mount manager's
   * retry loop. Re-runs the same idempotent preparation by regenerating the
   * compose file (which restores the adapter service and the consumers'
   * /mnt/sulla-files binds once the anchor exists), then brings
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
    await this.prepareSullaComposeFile();
    this.assertManagedServicesGeneration(generation);
    if (!getSullaFilesMountManager().guestMountAvailable()) {
      throw new Error(this.#lastFilesGuestMountFailure ?? 'the guest anchor is not prepared');
    }
    await reconcileComposeService({
      composeCommand: ['docker', 'compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla'],
      service:        'workflow_manager',
      run:            (...command) => this.execCommand({ root: true }, ...command),
      checkpoint:     () => this.assertManagedServicesGeneration(generation),
    });
  }

  /**
   * How many optional services may be starting at once: a few on a guest
   * under 3 GiB, otherwise all of them.
   */
  private async optionalServiceStartSlots(): Promise<number> {
    try {
      const meminfo = await this.execCommand({ capture: true, expectFailure: true }, 'cat', '/proc/meminfo');
      const totalKiB = Number(/^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo)?.[1]);

      if (totalKiB > 0 && totalKiB < 3 * 1024 * 1024) return 3;
    } catch {
      // Unknown size: keep the full parallel start.
    }

    return Number.POSITIVE_INFINITY;
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
          // Its mount was detached above; the old process holds a dead FUSE session.
          await this.execCommand({ root: true }, ...composeCommand, 'up', '-d', '--no-deps', '--force-recreate', service);

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

      // Retire the old Desktop board container; preserve all database data.
      await this.execCommand({ root: true }, 'docker', 'rm', '-f', 'sulla_projects').catch(() => undefined);

      // Postgres and Redis are stable data services. Compose pulls them only when
      // missing; Desktop does not force-refresh their upstream image tags.
      await this.execCommand(
        { root: true }, ...composeCommand, 'up', '-d',
        'postgres', 'redis',
      );
      this.assertManagedServicesGeneration(generation);
      await Promise.all([
        this.waitForDockerServiceHealthy('sulla_postgres', 300, generation),
        this.waitForDockerServiceHealthy('sulla_redis', 300, generation),
      ]);
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
          const accountsDatabaseExists = await this.execCommand(
            { capture: true, root: true }, 'docker', 'exec', 'sulla_postgres',
            'psql', '-U', 'sulla', '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='sulla_accounts'",
          );
          if (accountsDatabaseExists.trim() !== '1') {
            await this.execCommand(
              { root: true }, 'docker', 'exec', 'sulla_postgres',
              'createdb', '-U', 'sulla', '--encoding=UTF8', '--template=template0', 'sulla_accounts',
            );
          }
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

        // A slow Mac can take a minute or more to bring the vault up; keep
        // retrying long enough that Files and tools still start behind it.
        for (let attempt = 1; attempt <= OPTIONAL_SERVICE_ATTEMPTS; attempt++) {
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
              // Files can legitimately spend minutes applying a first-start
              // schema upgrade. Do not re-run compose against a live starter;
              // let it finish, then replace it only if a newer image exists.
              if (service === 'sulla_files') {
                const state = await this.execCommand(
                  { capture: true, root: true, expectFailure: true }, 'docker', 'inspect', '--format',
                  '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', container,
                ).catch(() => ''); // a fresh install has no container yet
                if (!state.trim().startsWith('running')) {
                  await startOptionalService(service);
                } else if (await this.sullaServiceImageIsStale(container, service, generation)) {
                  await startOptionalService(service);
                }
              } else {
                await startOptionalService(service);
              }
              await this.waitForDockerServiceHealthy(container, service === 'sulla_files' ? 600 : 20, generation);
              this.#activeOptionalSullaServices.add(service);
              bootStatus.set(service, 'healthy');
              if (service === 'sulla_vault') markVaultContainerReady();

              return true;
            } catch (error) {
              if (error instanceof ManagedServicesReconciliationCancelled) throw error;
              const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];

              bootStatus.set(service, `unhealthy (${ reason })`);
              console.warn(`[Sulla] Optional service ${ service } unavailable (attempt ${ attempt }/${ OPTIONAL_SERVICE_ATTEMPTS }); Desktop remains usable: ${ reason }`);

              return false;
            } finally {
              releaseStartSlot();
            }
          };

          await Promise.all(orderedOptionalServices.map(run));
          if (attempt === 1) {
            console.log(`[Sulla] Boot services: postgres=healthy, redis=healthy, ${
              [...bootStatus].map(([service, status]) => `${ service }=${ status }`).join(', ')
            }`);
          }
          if ([...bootStatus.values()].every(status => status === 'healthy')) return;
          await new Promise(resolve => setTimeout(resolve, Math.min(5_000 * attempt, 30_000)));
        }
      };

      // Optional services must never hold the backend STARTED/unlock transition.
      // Compose health dependencies preserve ordering; bounded retries repair a
      // cold or transiently broken service after Desktop is already usable.
      this.#optionalServicesSettled = reconcileInBackground().catch(error => {
        if (!(error instanceof ManagedServicesReconciliationCancelled)) {
          console.warn('[Sulla] Optional service background reconciliation stopped:', error);
        }
      });
      this.watchManagedContainerHealth(generation, composeCommand);
    });
  }

  /**
   * Keep managed containers honest: every minute, recreate any Sulla container that Docker
   * reports unhealthy (or restart-looping) past its grace period. The Files adapter's stale
   * guest mount is handled by the Files mount manager, not here.
   */
  private watchManagedContainerHealth(generation: number, composeCommand: string[]): void {
    this.#containerRecreates.clear();
    const tick = async(): Promise<void> => {
      this.assertManagedServicesGeneration(generation);
      const listing = await this.execCommand(
        { capture: true, root: true, expectFailure: true }, 'docker', 'ps', '-a',
        '--filter', 'label=com.docker.compose.project=sulla',
        '--format', '{{.Names}}\t{{.Label "com.docker.compose.service"}}',
      );
      const rows: ManagedContainerRow[] = [];

      for (const line of listing.split('\n').filter(Boolean)) {
        const [container, service] = line.split('\t');
        const state = (await this.execCommand(
          { capture: true, root: true, expectFailure: true }, 'docker', 'inspect', '--format',
          '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.StartedAt}}', container,
        ).catch(() => '')).trim().split(' ');

        if (state.length < 3) continue;
        rows.push({ container, service, state: state[0], health: state[1], runningForMs: Date.now() - Date.parse(state[2]) });
      }
      for (const action of planUnhealthyRecreates(rows, this.#containerRecreates)) {
        this.#containerRecreates.set(action.container, (this.#containerRecreates.get(action.container) ?? 0) + 1);
        console.warn(`[Sulla] ${ action.container } is ${ action.reason }; recreating it`);
        await this.execCommand({ root: true }, ...composeCommand, 'up', '-d', '--no-deps', '--force-recreate', action.service)
          .catch(error => console.warn(`[Sulla] Could not recreate ${ action.container }:`, (error as Error).message?.split('\n')[0]));
      }
    };
    const run = (): void => {
      tick().catch((error) => {
        if (error instanceof ManagedServicesReconciliationCancelled) clearInterval(timer);
      });
    };
    const timer = setInterval(run, 60_000);

    timer.unref?.();
    // Containers that survived a crash can be broken before Desktop even starts: sweep once soon
    // after startup settles instead of waiting a full interval.
    setTimeout(run, 45_000).unref?.();
  }

  /**
   * After a running service finishes starting, pull its published image and
   * report whether the container is still on an older one. Failures keep the
   * running container.
   */
  private async sullaServiceImageIsStale(container: string, service: string, generation?: number): Promise<boolean> {
    await this.waitForDockerServiceHealthy(container, 600, generation);
    const refreshImage = this.#managedSullaRefreshImages.get(service);
    const pinnedImage = this.#pinnedSullaImages.get(service);

    if (!refreshImage && pinnedImage) {
      // Bundled with this app: the container must run exactly that image, never a
      // leftover (e.g. :latest from an older build). Nothing to pull: it is loaded.
      try {
        const [running, pinned] = await Promise.all([
          this.execCommand({ capture: true, root: true }, 'docker', 'inspect', '--format', '{{.Image}}', container),
          this.execCommand({ capture: true, root: true }, 'docker', 'image', 'inspect', '--format', '{{.Id}}', pinnedImage),
        ]);

        return running.trim() !== pinned.trim();
      } catch (error) {
        console.warn(`[Sulla] Could not compare ${ container } with its bundled image ${ pinnedImage }; keeping it:`, error);

        return false;
      }
    }
    if (!refreshImage) return false;
    try {
      await this.execCommand({ root: true }, 'docker', 'pull', refreshImage);
      const [running, latest] = await Promise.all([
        this.execCommand({ capture: true, root: true }, 'docker', 'inspect', '--format', '{{.Image}}', container),
        this.execCommand({ capture: true, root: true }, 'docker', 'image', 'inspect', '--format', '{{.Id}}', refreshImage),
      ]);

      return running.trim() !== latest.trim();
    } catch (error) {
      console.warn(`[Sulla] Could not check ${ refreshImage } for ${ service }; keeping the running container:`, error);

      return false;
    }
  }

  /**
   * Waits for a specific Docker container to be healthy by polling its status.
   * @param serviceName The name of the Docker container to check.
   * @param timeoutSec Maximum time to wait in seconds (default 300).
   */
  private async waitForDockerServiceHealthy(serviceName: string, timeoutSec = 300, generation?: number): Promise<void> {
    const start = Date.now();
    let delayMs = 300;
    let lastStatus = 'not created';
    while (Date.now() - start < timeoutSec * 1000) {
      if (generation !== undefined) this.assertManagedServicesGeneration(generation);
      try {
        const status = await this.execCommand(
          { capture: true, root: true }, 'docker', 'inspect', '--format',
          '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', serviceName,
        );
        lastStatus = status.trim();
        if (lastStatus === 'running healthy' || lastStatus === 'running none') {
          console.log(`Docker service ${ serviceName } is ready`);
          return;
        }
      } catch {
        // Service not ready yet
      }
      await new Promise(r => setTimeout(r, delayMs));
      delayMs = Math.min(Math.round(delayMs * 1.5), 1_000);
    }
    throw new Error(`Docker service ${ serviceName } not healthy after ${ timeoutSec }s (last status: ${ lastStatus })`);
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
