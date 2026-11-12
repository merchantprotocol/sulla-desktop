// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import path from 'path';

import type { DockerComposeCommandRunner } from '../containerClient/dockerComposeRuntime';
import { findHostBindMounts } from '../sullaComposeMounts';

import type { LinuxRuntimePaths } from './dockerHost';

/**
 * Managed Sulla services on Linux.
 *
 * Design (explicitly NOT a VM): the user's rootless Docker Engine is the outer
 * host. The runtime image container is only the command executor. Postgres,
 * Redis and the function runtimes run as *sibling* containers on that same
 * rootless engine, in their own Compose project, with loopback-only ports.
 * Nothing is nested, and no Docker socket is mounted into any container.
 *
 * Reused from the macOS backend (platform-neutral): the compose asset,
 * sullaComposeMounts (host-bind policy), serviceReconcile and the on-demand
 * function-runtime manager. Not reused: the macOS prepare/deploy methods,
 * which are coupled to the Virtualization.framework guest.
 */

export const LINUX_SERVICES_PROJECT = 'sulla-desktop-linux-services';
export const LINUX_SERVICES_COMPOSE_FILE = 'sulla-services-compose.json';

/** Started at boot, in order, and awaited before first-run may proceed. */
export const LINUX_CORE_SERVICES = ['postgres', 'redis'] as const;
/** Defined in the compose file but started on first use by onDemandServices. */
export const LINUX_ON_DEMAND_SERVICES = ['python_runtime', 'shell_runtime', 'node_runtime'] as const;
/**
 * Not generated on Linux yet: they need host-provisioned secrets/TLS identities
 * (accounts, vault, files) or the agent launcher image that the macOS backend
 * prepares. Reported to the caller rather than silently dropped.
 */
export const LINUX_DEFERRED_SERVICES = [
  'sulla_accounts', 'sulla_vault', 'sulla_files', 'sulla_files_fuse', 'sulla_relay', 'workflow_manager', 'tools', 'threat_proxy',
] as const;

type ComposeDocument = { services?: Record<string, any>; volumes?: Record<string, unknown> };

export interface LinuxServicesComposeOptions {
  paths: LinuxRuntimePaths;
  /** Maps a base port (e.g. 30116) to the instance's host port. */
  resolvePort(base: number): number;
  /** Database password. Raw value: escaping for Compose happens here. */
  servicePassword: string;
}

export interface LinuxServicesComposeResult {
  document: ComposeDocument;
  services: string[];
  deferred: string[];
}

export class LinuxServicesComposeBuilder {
  /** The base compose is loaded lazily so importing this module never pulls in the app's asset loaders. */
  constructor(private readonly loadBase: () => Promise<ComposeDocument> | ComposeDocument) {}

  async build(options: LinuxServicesComposeOptions): Promise<LinuxServicesComposeResult> {
    const document = JSON.parse(JSON.stringify(await this.loadBase())) as ComposeDocument;
    const allowed = new Set<string>([...LINUX_CORE_SERVICES, ...LINUX_ON_DEMAND_SERVICES]);
    const services = document.services ?? {};

    const deferred = Object.keys(services).filter(name => !allowed.has(name));

    for (const name of deferred) delete services[name];
    for (const name of allowed) {
      if (!services[name]) throw new Error(`The Sulla compose definition has no "${ name }" service.`);
    }

    // The same guest-path policy the macOS backend enforces: only app-owned
    // guest paths or named volumes, never a host path or the engine socket.
    const offenders = findHostBindMounts(document as Parameters<typeof findHostBindMounts>[0]);

    if (offenders.length) {
      throw new Error(`Refusing to generate host bind mounts for Sulla services: ${ offenders.map(o => `${ o.service } <- ${ o.source }`).join(', ') }`);
    }

    for (const [name, service] of Object.entries(services)) {
      service.ports = (service.ports ?? []).map((entry: unknown) => this.resolvePort(entry, options));
      service.volumes = (service.volumes ?? []).map((volume: unknown) => this.translateVolume(name, volume, options.paths));
      // The app starts and stops these; the rootless engine must not resurrect
      // them behind the app's back (and no orphan survives an uninstall).
      service.restart = 'no';
      service.labels = { ...(service.labels ?? {}), 'sulla.desktop.managed': 'linux' };
    }
    const postgres = services.postgres;

    postgres.environment = (postgres.environment as string[]).map(env =>
      env.startsWith('POSTGRES_PASSWORD=') ? `POSTGRES_PASSWORD=${ options.servicePassword.replace(/\$/g, '$$$$') }` : env);

    return { document, services: [...allowed], deferred };
  }

  /** Writes the compose file (0600) into the private compose directory. */
  async write(options: LinuxServicesComposeOptions): Promise<LinuxServicesComposeResult & { file: string }> {
    const result = await this.build(options);
    const file = path.join(options.paths.compose, LINUX_SERVICES_COMPOSE_FILE);

    // JSON is valid YAML; Compose reads it without a YAML writer.
    await fs.promises.writeFile(file, JSON.stringify(result.document, undefined, 2), { mode: 0o600 });

    return { ...result, file };
  }

  private resolvePort(entry: unknown, options: LinuxServicesComposeOptions): unknown {
    if (typeof entry !== 'string') return entry;
    const resolved = entry.replace(/\$\{SULLA_PORT_(\d+):-\d+\}/g, (_match, base) => String(options.resolvePort(Number(base))));

    if (!resolved.startsWith('127.0.0.1:')) throw new Error(`Service ports must be published on loopback only: ${ resolved }`);

    return resolved;
  }

  /** Guest path (/mnt/data/...) to the app-owned host directory; named volumes pass through. */
  private translateVolume(service: string, volume: unknown, paths: LinuxRuntimePaths): unknown {
    if (typeof volume !== 'string') throw new Error(`Unsupported volume definition for ${ service }.`);
    const [source, target, mode] = volume.split(':');

    if (!source.startsWith('/')) return volume;
    if (/docker\.sock/.test(source)) throw new Error(`${ service } must not mount the Docker socket.`);
    const mappings: Array<[string, string]> = [
      ['/mnt/data/sulla/runtime/functions/catalog', paths.functionCatalog],
      ['/mnt/data/sulla/runtime/functions/invocations', paths.functionInvocations],
    ];
    const match = mappings.find(([guest]) => source === guest);

    if (!match) throw new Error(`${ service } mounts ${ source }, which has no app-owned Linux host directory.`);

    return [match[1], target, mode].filter(Boolean).join(':');
  }
}

export interface ManagedServicesHooks {
  backendBooted(): void;
  /** Postgres and Redis are healthy. */
  coreServicesReady(): void;
  /** Everything deployed; run post-deploy startup (Sulla start). */
  servicesDeployed(assertCurrent: () => void): Promise<void>;
  servicesReady(): void;
  servicesFailed(error: unknown): void;
}

export interface ManagedServicesLogger { warn(...args: unknown[]): void; log(...args: unknown[]): void }

export interface LinuxManagedServicesDependencies {
  docker: DockerComposeCommandRunner;
  builder: LinuxServicesComposeBuilder;
  hooks: ManagedServicesHooks;
  composeOptions(paths: LinuxRuntimePaths): Promise<LinuxServicesComposeOptions>;
  /** Hands the on-demand function-runtime manager a host-docker runner. */
  configureOnDemand?(run: (args: string[]) => Promise<string>): void;
  clearOnDemand?(): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  logger?: ManagedServicesLogger;
  healthTimeoutSeconds?: number;
  retryDelaysMs?: number[];
}

class ServicesCancelled extends Error {}

const SULLA_COMPOSE_PREFIX = ['docker', 'compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla'];
const ON_DEMAND_ALLOWED_VERBS = new Set(['inspect', 'start', 'stop', 'pull', 'compose']);

/**
 * Deploys, health-gates and stops the Sulla service project on the outer
 * rootless engine. Every host-docker call goes through the injected runner.
 */
export class LinuxManagedServices {
  private generation = 0;
  private composeFile = '';
  private wake?: () => void;

  constructor(private readonly deps: LinuxManagedServicesDependencies) {}

  private get logger(): ManagedServicesLogger {
    return this.deps.logger ?? console;
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;

      function done() { clearTimeout(timer); self.wake = undefined; resolve() }
      this.wake = done;
    });
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async docker(args: string[]): Promise<string> {
    const result = await this.deps.docker(args);

    if (result.exitCode !== 0) throw new Error(`docker ${ args.slice(0, 3).join(' ') } failed (exit ${ result.exitCode }): ${ result.stderr.trim().slice(0, 300) }`);

    return result.stdout;
  }

  private composeArgs(...rest: string[]): string[] {
    return ['compose', '--project-name', LINUX_SERVICES_PROJECT, '--project-directory', path.posix.dirname(this.composeFile), '--file', this.composeFile, ...rest];
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new ServicesCancelled('Managed services deployment was superseded.');
  }

  /** Writes the compose file and wires on-demand services. Awaited by the backend; failures here fail the start. */
  async prepare(paths: LinuxRuntimePaths): Promise<void> {
    const written = await this.deps.builder.write(await this.deps.composeOptions(paths));

    this.generation++;
    this.composeFile = written.file;
    if (written.deferred.length) this.logger.log(`[Sulla] Linux services deferred (not yet supported): ${ written.deferred.join(', ') }`);
    this.deps.configureOnDemand?.(args => this.runOnDemand(args));
  }

  /** Deploys the prepared project. Settles when ready, or when stop() supersedes it; never rejects. */
  async run(): Promise<void> {
    if (!this.composeFile) throw new Error('Managed services were not prepared.');
    this.deps.hooks.backendBooted();
    await this.deployWithRetries(this.generation);
  }

  /** Retry now instead of waiting out the back-off. */
  repair(): void {
    this.wake?.();
  }

  private async deployWithRetries(generation: number): Promise<void> {
    const delays = this.deps.retryDelaysMs ?? [5_000, 15_000, 30_000, 60_000];

    for (let attempt = 0; ; attempt++) {
      try {
        await this.deploy(generation);

        return;
      } catch (error) {
        if (error instanceof ServicesCancelled || generation !== this.generation) return;
        this.logger.warn(`[Sulla] Linux services failed (attempt ${ attempt + 1 }):`, error);
        if (attempt === 3) this.deps.hooks.servicesFailed(error);
        await this.sleep(delays[Math.min(attempt, delays.length - 1)]);
        if (generation !== this.generation) return;
      }
    }
  }

  private async deploy(generation: number): Promise<void> {
    await this.docker(this.composeArgs('up', '--detach', ...LINUX_CORE_SERVICES));
    this.assertCurrent(generation);
    await Promise.all(LINUX_CORE_SERVICES.map(name => this.waitHealthy(`sulla_${ name }`, generation)));
    this.deps.hooks.coreServicesReady();
    this.assertCurrent(generation);
    await this.deps.hooks.servicesDeployed(() => this.assertCurrent(generation));
    this.assertCurrent(generation);
    this.deps.hooks.servicesReady();
  }

  private async waitHealthy(container: string, generation: number): Promise<void> {
    const timeout = (this.deps.healthTimeoutSeconds ?? 300) * 1000;
    const started = this.now();
    let last = 'not created';
    let delay = 300;

    while (this.now() - started < timeout) {
      this.assertCurrent(generation);
      try {
        last = (await this.docker(['inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', container])).trim();
        if (last === 'running healthy' || last === 'running none') return;
      } catch {
        // not created yet
      }
      await (this.deps.sleep ? this.deps.sleep(delay) : new Promise(resolve => setTimeout(resolve, delay)));
      delay = Math.min(Math.round(delay * 1.5), 1_000);
    }
    throw new Error(`Docker service ${ container } not healthy after ${ timeout / 1000 }s (last status: ${ last })`);
  }

  /**
   * The on-demand manager speaks the macOS guest's command line. Translate its
   * compose prefix to this project and refuse anything outside a small verb
   * allowlist, so it can never run arbitrary host commands.
   */
  private async runOnDemand(args: string[]): Promise<string> {
    if (args[0] !== 'docker' || !ON_DEMAND_ALLOWED_VERBS.has(args[1])) throw new Error(`Refused host Docker command: ${ args.slice(0, 2).join(' ') }`);
    if (args[1] === 'compose') {
      if (SULLA_COMPOSE_PREFIX.some((part, index) => args[index] !== part)) throw new Error('Refused compose command outside the Sulla project.');

      return this.docker(this.composeArgs(...args.slice(SULLA_COMPOSE_PREFIX.length)));
    }

    return this.docker(args.slice(1));
  }

  /** Stops only this project. Volumes (Postgres data) are kept. Safe to call twice. */
  async stop(): Promise<void> {
    this.generation++;
    this.wake?.();
    this.deps.clearOnDemand?.();
    if (!this.composeFile) return;
    await this.docker(this.composeArgs('down', '--remove-orphans'));
  }
}
