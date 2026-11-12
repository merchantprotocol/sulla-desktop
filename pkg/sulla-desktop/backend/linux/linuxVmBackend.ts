// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import events from 'events';
import os from 'os';
import path from 'path';

import {
  BackendError, BackendEvents, BackendProgress, BackendSettings, FailureDetails, RestartReasons, State, VMBackend, VMExecutor,
} from '../backend';
import type { ContainerEngineClient } from '../containerClient';
import { MobyClient } from '../containerClient/mobyClient';

import { LinuxDockerHost, LinuxRuntimePaths, prepareLinuxRuntimePaths } from './dockerHost';
import { LinuxContainerExecutor, NodeDockerCli } from './linuxContainerExecutor';
import { LinuxManagedServices } from './linuxManagedServices';
import { createDesktopLinuxManagedServices } from './linuxServicesWiring';
import { LinuxPublishedPort, LinuxRuntimeComposeBuilder } from './linuxRuntimeCompose';

import { RecursivePartial } from '@pkg/utils/typeUtils';

export const LINUX_PROJECT_NAME = 'sulla-desktop-linux';
export const LINUX_CONTAINER_NAME = 'sulla-desktop-linux-runtime';
/**
 * The runtime image is built from assets/runtime/guest/Dockerfile (target
 * `linux-runtime`) by build-linux-runtime.sh. There is no silent fallback to a
 * generic image: a missing image fails start() with the build instruction.
 */
export const LINUX_DEFAULT_IMAGE = 'sulla-desktop-linux-runtime:0.3.0';

export interface LinuxBackendDependencies {
  host: LinuxDockerHost;
  composeBuilder: LinuxRuntimeComposeBuilder;
  executor: VMExecutor;
  preparePaths(appDataDirectory: string): Promise<LinuxRuntimePaths>;
  engineClientFactory(executor: VMExecutor, endpoint: string): ContainerEngineClient;
  /** Managed Postgres/Redis/function-runtime services. When absent the backend reports managesSullaServices=false. */
  services?: LinuxManagedServices;
}

export interface LinuxBackendOptions {
  appDataDirectory: string;
  image?: string;
  ports?: LinuxPublishedPort[];
}

/**
 * VMBackend for Linux: the "VM" is one app-owned container managed through a
 * user-installed rootless Docker Engine + Compose. There is no hypervisor, so
 * `ipAddress` is loopback and `reset()` is explicitly unsupported (compose
 * `down` never removes volumes; users remove data deliberately).
 */
export class LinuxDockerBackend extends events.EventEmitter implements VMBackend {
  static create(options: LinuxBackendOptions): LinuxDockerBackend {
    const cli = new NodeDockerCli();
    const host = new LinuxDockerHost();

    return new LinuxDockerBackend(options, {
      host,
      services:            createDesktopLinuxManagedServices(),
      composeBuilder:      new LinuxRuntimeComposeBuilder(),
      executor:            new LinuxContainerExecutor(cli, LINUX_CONTAINER_NAME),
      preparePaths:        prepareLinuxRuntimePaths,
      engineClientFactory: (executor, endpoint) => new MobyClient(executor, endpoint, { systemExecutable: true }),
    });
  }

  constructor(private readonly options: LinuxBackendOptions, private readonly deps: LinuxBackendDependencies) {
    super();
    this.executor = deps.executor;
  }

  readonly backend = 'linux-docker' as const;
  readonly executor: VMExecutor;
  /** True only when the services seam is wired: background.ts then waits for 'sulla-managed-services-ready'. */
  get managesSullaServices(): boolean {
    return this.deps.services !== undefined;
  }

  debug = false;
  noModalDialogs = false;
  progress: BackendProgress = { current: 0, max: 0 };
  emit: VMBackend['emit'] = events.EventEmitter.prototype.emit;

  private internalState: State = State.STOPPED;
  private cfg: BackendSettings | undefined;
  private engineClient: ContainerEngineClient | undefined;
  private lastCommand = '';
  private lastError = '';
  private operation: Promise<void> = Promise.resolve();

  get state(): State {
    return this.internalState;
  }

  get cpus(): Promise<number> {
    return Promise.resolve(this.running ? this.cfg?.virtualMachine.numberCPUs ?? 0 : 0);
  }

  get memory(): Promise<number> {
    return Promise.resolve(this.running ? this.cfg?.virtualMachine.memoryInGB ?? 0 : 0);
  }

  /** Published ports are bound to loopback only, so that is the reachable address. */
  get ipAddress(): Promise<string | undefined> {
    return Promise.resolve(this.running ? '127.0.0.1' : undefined);
  }

  get containerEngineClient(): ContainerEngineClient {
    if (!this.engineClient) throw new Error('Invalid state, no container engine client available.');

    return this.engineClient;
  }

  private get running(): boolean {
    return this.internalState === State.STARTED || this.internalState === State.DISABLED;
  }

  private setState(state: State): void {
    this.internalState = state;
    this.emit('state-changed', state);
  }

  private setProgress(description: string, current: number, max = 4): void {
    this.progress = { current, max, description, transitionTime: new Date() };
    this.emit('progress');
  }

  async getBackendInvalidReason(): Promise<BackendError | null> {
    if (os.platform() !== 'linux') return new BackendError('Unsupported platform', `The Linux backend cannot run on "${ os.platform() }".`, true);
    const inspection = await this.deps.host.inspect();

    return inspection.errors.length ? new BackendError('Docker prerequisites', inspection.errors.join(' '), true) : null;
  }

  /** Serializes lifecycle operations so start/stop can never interleave. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);

    this.operation = result.then(() => undefined, () => undefined);

    return result;
  }

  async start(config: BackendSettings): Promise<void> {
    return this.serialize(async() => {
      if (this.internalState !== State.STOPPED && this.internalState !== State.ERROR) await this.stopInternal();
      this.cfg = config;
      this.lastError = '';
      this.setState(State.STARTING);
      try {
        this.lastCommand = 'verify rootless Docker prerequisites';
        this.setProgress('Checking Docker Engine', 0);
        const inspection = await this.deps.host.assertReady();

        this.lastCommand = 'verify runtime image';
        const image = this.options.image ?? LINUX_DEFAULT_IMAGE;

        await this.deps.host.assertImagePresent(image, 'Build it with assets/runtime/guest/build-linux-runtime.sh (docker buildx build --target linux-runtime).');

        this.lastCommand = 'prepare app-owned runtime paths';
        this.setProgress('Preparing runtime directories', 1);
        const paths = await this.deps.preparePaths(this.options.appDataDirectory);

        this.lastCommand = 'write compose file';
        const composeFile = await this.deps.composeBuilder.write(paths, {
          image,
          containerName: LINUX_CONTAINER_NAME,
          cpus:          config.virtualMachine.numberCPUs,
          memoryMiB:     Math.round(config.virtualMachine.memoryInGB * 1024),
          ports:         this.options.ports ?? [],
        });

        this.lastCommand = `docker compose up ${ LINUX_PROJECT_NAME }`;
        this.setProgress('Starting runtime container', 2);
        await this.deps.host.startProject({ composeFile, projectName: LINUX_PROJECT_NAME });

        this.lastCommand = 'verify runtime container';
        await this.deps.executor.execCommand({ expectFailure: true }, 'true');
        this.engineClient = this.deps.engineClientFactory(this.deps.executor, inspection.endpoint ?? '');
        this.setProgress('Runtime ready', 4);
        this.setState(State.STARTED);
        if (this.deps.services) {
          this.lastCommand = 'prepare Sulla managed services';
          await this.deps.services.prepare(paths);
          // Postgres/Redis are health-gated in the background, as on macOS; the
          // first-run flow waits for 'sulla-managed-services-ready'.
          void this.deps.services.run().catch((error) => {
            this.lastError = error instanceof Error ? error.message : String(error);
          });
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.engineClient = undefined;
        this.setState(State.ERROR);
        throw error;
      }
    });
  }

  async stop(): Promise<void> {
    return this.serialize(() => this.stopInternal());
  }

  private async stopInternal(): Promise<void> {
    if (this.internalState === State.STOPPED) return;
    this.setState(State.STOPPING);
    try {
      const paths = await this.deps.preparePaths(this.options.appDataDirectory);

      await this.deps.services?.stop();
      this.lastCommand = `docker compose down ${ LINUX_PROJECT_NAME }`;
      await this.deps.host.stopProject({ composeFile: path.join(paths.compose, 'docker-compose.json'), projectName: LINUX_PROJECT_NAME });
      this.engineClient = undefined;
      this.setState(State.STOPPED);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setState(State.ERROR);
      throw error;
    }
  }

  /** Removes the runtime container; persistent data is deliberately kept (same as stop). */
  async del(): Promise<void> {
    await this.stop();
  }

  async reset(_config: BackendSettings): Promise<void> {
    throw new BackendError('Unsupported operation', 'Reset is not supported on Linux: Sulla never removes Docker volumes or user data automatically. Remove the sulla-desktop-linux Compose volumes manually if you want a clean slate.');
  }

  async handleSettingsUpdate(_config: BackendSettings): Promise<void> {}

  async requiresRestartReasons(config: RecursivePartial<BackendSettings>): Promise<RestartReasons> {
    const reasons: RestartReasons = {};

    if (!this.cfg) return reasons;
    for (const key of ['numberCPUs', 'memoryInGB'] as const) {
      const desired = config.virtualMachine?.[key];
      const current = this.cfg.virtualMachine[key];

      if (desired !== undefined && desired !== current) {
        reasons[`virtualMachine.${ key }` as keyof RestartReasons] = { current, desired, severity: 'restart' };
      }
    }

    return reasons;
  }

  async getFailureDetails(exception: any): Promise<FailureDetails> {
    return {
      lastCommand:        this.lastCommand,
      lastCommandComment: this.lastCommand ? `Linux runtime step: ${ this.lastCommand }` : 'No Linux runtime step recorded',
      lastLogLines:       [this.lastError || String(exception?.message ?? exception ?? '')].filter(Boolean),
    };
  }

  eventNames(): (keyof BackendEvents)[] {
    return super.eventNames() as (keyof BackendEvents)[];
  }
}
