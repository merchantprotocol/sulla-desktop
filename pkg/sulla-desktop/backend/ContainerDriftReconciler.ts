// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ComposeServiceTarget, DockerCli } from './sullaComposeContainers';

/** Compose stamps every container it creates with the hash of its service definition. */
const CONFIG_HASH_LABEL = 'com.docker.compose.config-hash';

export type DriftOutcome =
  | { kind: 'recreated'; service: string }
  | { kind: 'unchanged'; service: string }
  | { kind: 'not-running'; service: string }
  | { kind: 'unknown'; service: string; reason: string };

/** A container's drift as seen without acting on it. */
export type DriftStatus = 'drifted' | Exclude<DriftOutcome['kind'], 'recreated'>;

export interface DriftLogger {
  log(message: string): void;
  warn(message: string): void;
}

/** Recreates one compose service from the current compose file (`up -d --no-deps <service>`). */
export type ServiceRecreator = (service: string) => Promise<void>;

/**
 * Runs before a drifted container is recreated. Used to let a service that is
 * still starting (Files applying a schema migration) reach healthy first, so
 * the recreate never interrupts it. Should not throw; a throw skips the recreate.
 */
export type BeforeRecreate = (target: ComposeServiceTarget) => Promise<void>;

/**
 * Detects a running compose container whose definition (env, image, mounts…)
 * no longer matches the compose file Desktop just generated, and recreates it.
 *
 * Desktop leaves some running containers alone at boot (a live Files starter,
 * any service still in its start period), so Compose's own desired-state diff
 * never ran for them and a container could keep stale env (for example an old
 * service secret) across boots. This compares Compose's desired hash
 * (`docker compose config --hash <service>`) with the hash label on the running
 * container: a difference recreates that service only; no difference does
 * nothing. Only service names and hash prefixes are logged, never env values.
 */
export class ContainerDriftReconciler {
  constructor(
    private readonly docker: DockerCli,
    private readonly composeArgs: readonly string[],
    private readonly recreate: ServiceRecreator,
    private readonly logger: DriftLogger = console,
    private readonly beforeRecreate: BeforeRecreate = async() => undefined,
  ) {}

  /** Desired hash each container was last recreated to; a repeat means compose cannot converge it. */
  private readonly recreatedTo = new Map<string, string>();

  /** Recreate the target when its running container drifted from the compose file. */
  async reconcile(target: ComposeServiceTarget): Promise<DriftOutcome> {
    const outcome = await this.detect(target);

    if (outcome.kind !== 'drifted') return outcome;
    // Never loop: if the last recreate aimed at this same definition and the
    // container still reports another hash, compose labels it differently
    // (e.g. a version skew); recreating again would not help.
    if (this.recreatedTo.get(target.container) === outcome.desired) {
      this.logger.warn(`[Sulla] ${ target.service } still reports a different config hash after a recreate; leaving it`);

      return { kind: 'unknown', service: target.service, reason: 'hash did not converge after a recreate' };
    }
    await this.beforeRecreate(target);
    this.logger.log(`[Sulla] ${ target.service } config drifted (running ${ outcome.running.slice(0, 8) }, desired ${ outcome.desired.slice(0, 8) }); recreating it`);
    this.recreatedTo.set(target.container, outcome.desired);
    await this.recreate(target.service);

    return { kind: 'recreated', service: target.service };
  }

  /** Reconcile several services, one at a time; one failure does not stop the rest. */
  async reconcileAll(targets: readonly ComposeServiceTarget[]): Promise<DriftOutcome[]> {
    const outcomes: DriftOutcome[] = [];

    for (const target of targets) {
      try {
        outcomes.push(await this.reconcile(target));
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];

        this.logger.warn(`[Sulla] Could not recreate drifted ${ target.service }: ${ reason }`);
        outcomes.push({ kind: 'unknown', service: target.service, reason });
      }
    }

    return outcomes;
  }

  /** True when the target's running container must be recreated. */
  async hasDrifted(target: ComposeServiceTarget): Promise<boolean> {
    return (await this.status(target)) === 'drifted';
  }

  /** What the hashes say about the target, without recreating anything. */
  async status(target: ComposeServiceTarget): Promise<DriftStatus> {
    return (await this.detect(target)).kind;
  }

  private async detect(target: ComposeServiceTarget): Promise<
    | { kind: 'drifted'; running: string; desired: string }
    | Exclude<DriftOutcome, { kind: 'recreated' }>
  > {
    const { service, container } = target;
    const running = await this.runningHash(container);

    if (running === undefined) return { kind: 'not-running', service };
    const desired = await this.desiredHash(service);

    if (!desired) {
      this.logger.warn(`[Sulla] Could not compute the desired compose hash for ${ service }; leaving it as-is`);

      return { kind: 'unknown', service, reason: 'desired hash unavailable' };
    }
    // A container created outside compose has no hash: it cannot match the file.
    if (running !== desired) return { kind: 'drifted', running: running || 'none', desired };

    return { kind: 'unchanged', service };
  }

  /** The hash label of the running container; undefined when it is missing or not running. */
  private async runningHash(container: string): Promise<string | undefined> {
    let output: string;

    try {
      output = await this.docker.run([
        'inspect', '--format', `{{.State.Running}} {{index .Config.Labels "${ CONFIG_HASH_LABEL }"}}`, container,
      ]);
    } catch {
      return undefined;
    }
    const [running, hash = ''] = output.trim().split(/\s+/);

    if (running !== 'true') return undefined;

    return hash === '<no' ? '' : hash; // `<no value>` when the label is absent
  }

  private async desiredHash(service: string): Promise<string | undefined> {
    try {
      const output = await this.docker.run([...this.composeArgs, 'config', '--hash', service]);
      const line = output.split('\n').map(entry => entry.trim().split(/\s+/)).find(([name]) => name === service);

      return line?.[1] || undefined;
    } catch {
      return undefined;
    }
  }
}
