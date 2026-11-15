// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Finds Sulla's compose containers by their compose labels, not only their
 * name, and heals the leftovers of an interrupted re-create.
 *
 * When Docker Compose re-creates a service that has a fixed container_name it
 * first renames the old container to `<12-hex id>_<name>`, then creates the new
 * one, then removes the old one. If that is interrupted (the app quits, the VM
 * stops) the old container can survive under the temporary name while no
 * container has the real name. Compose itself finds containers by label, so it
 * keeps treating the renamed one as current and never fixes the name; anything
 * that looks the container up by its fixed name (`docker inspect sulla_redis`)
 * then waits forever for a container that "was never created".
 */

/** Runs `docker <args>` in the guest and returns stdout; rejects on a non-zero exit. */
export interface DockerCli {
  run(args: string[]): Promise<string>;
}

export interface ComposeLogger {
  warn(message: string): void;
}

/** A compose service and the fixed container_name it runs under. */
export interface ComposeServiceTarget {
  service: string;
  container: string;
}

export interface ComposeContainerRow {
  id: string;
  name: string;
  service: string;
  state: string;
}

export type NameHealAction =
  | { kind: 'renamed'; service: string; from: string; to: string }
  | { kind: 'removed-stray'; service: string; container: string; kept: string };

const LABEL_PROJECT = 'com.docker.compose.project';
const LABEL_SERVICE = 'com.docker.compose.service';

export class ComposeContainerNameReconciler {
  constructor(
    private readonly docker: DockerCli,
    private readonly project: string,
    private readonly log: ComposeLogger = console,
  ) {}

  /** The services in a compose document that run under a fixed container_name. */
  static targetsOf(compose: { services?: Record<string, unknown> }): ComposeServiceTarget[] {
    return Object.entries(compose.services ?? {}).flatMap(([service, definition]) => {
      const container = (definition as { container_name?: unknown } | undefined)?.container_name;

      return typeof container === 'string' ? [{ service, container }] : [];
    });
  }

  /** Every container (any state) that belongs to this compose project. */
  async list(service?: string): Promise<ComposeContainerRow[]> {
    const filters = ['--filter', `label=${ LABEL_PROJECT }=${ this.project }`];

    if (service) filters.push('--filter', `label=${ LABEL_SERVICE }=${ service }`);
    const output = await this.docker.run([
      'ps', '-a', '--no-trunc', ...filters,
      '--format', `{{.ID}}\t{{.Names}}\t{{.Label "${ LABEL_SERVICE }"}}\t{{.State}}`,
    ]);

    return output.split('\n').filter(line => line.trim()).map((line) => {
      const [id, name, rowService, state] = line.trim().split('\t');

      return { id, name: name.replace(/^\//, ''), service: rowService ?? '', state: state ?? '' };
    });
  }

  /** True when `name` is the temporary name compose gives `container` during a re-create. */
  isStrayName(name: string, container: string): boolean {
    return name.length === container.length + 13 &&
      name.endsWith(`_${ container }`) &&
      /^[0-9a-f]{12}$/.test(name.slice(0, 12));
  }

  /**
   * Put every target back under its fixed name. A stray alone is renamed back
   * (it keeps its volumes and data). When the fixed name is taken, that
   * container is the one compose created last and is kept; the stray is
   * removed without its volumes. Failures are logged and retried next time.
   */
  async reconcile(targets: ReadonlyArray<ComposeServiceTarget>, rows?: ComposeContainerRow[]): Promise<NameHealAction[]> {
    const all = rows ?? await this.list();
    const actions: NameHealAction[] = [];

    for (const target of targets) {
      const ofService = all.filter(row => row.service === target.service);
      const strays = ofService.filter(row => this.isStrayName(row.name, target.container));

      if (!strays.length) continue;
      try {
        const exact = ofService.find(row => row.name === target.container);
        let kept = exact;

        if (!kept) {
          // A running stray is the one serving; prefer it over a stopped one.
          kept = strays.find(row => row.state === 'running') ?? strays[0];
          await this.docker.run(['rename', kept.id, target.container]);
          actions.push({ kind: 'renamed', service: target.service, from: kept.name, to: target.container });
          this.log.warn(`[Sulla] Renamed ${ kept.name } back to ${ target.container } (left over from an interrupted compose re-create)`);
        }
        for (const stray of strays) {
          if (stray.id === kept.id) continue;
          // No -v: the stray's volumes are kept, so nothing is deleted with it.
          await this.docker.run(['rm', '-f', stray.id]);
          actions.push({ kind: 'removed-stray', service: target.service, container: stray.name, kept: target.container });
          this.log.warn(`[Sulla] Removed ${ stray.name }: ${ target.container } already runs ${ target.service } (left over from an interrupted compose re-create)`);
        }
      } catch (error) {
        this.log.warn(`[Sulla] Could not heal the name of ${ target.container }: ${ (error instanceof Error ? error.message : String(error)).split('\n')[0] }`);
      }
    }

    return actions;
  }

  /**
   * The container that runs a service: the fixed name when it exists, healing
   * a stray first; otherwise whatever compose labels say runs the service.
   */
  async resolve(target: ComposeServiceTarget): Promise<ComposeContainerRow | undefined> {
    const rows = await this.list(target.service);

    if (rows.some(row => this.isStrayName(row.name, target.container))) {
      await this.reconcile([target], rows);

      return (await this.list(target.service)).find(row => row.name === target.container) ?? rows[0];
    }

    return rows.find(row => row.name === target.container) ?? rows[0];
  }
}

export interface WaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: WaitClock = {
  now:   () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** Waits for a compose service to be running and healthy, wherever compose put it. */
export class ComposeServiceHealthWaiter {
  constructor(
    private readonly docker: DockerCli,
    private readonly containers: ComposeContainerNameReconciler,
    private readonly clock: WaitClock = realClock,
  ) {}

  /** `<state> <health>` of the service's container, or undefined when it has none. */
  async status(target: ComposeServiceTarget): Promise<string | undefined> {
    try {
      return (await this.inspect(target.container)).trim();
    } catch {
      // Not under its fixed name: resolve it by its compose labels (healing the name).
    }
    try {
      const row = await this.containers.resolve(target);

      return row ? (await this.inspect(row.name === target.container ? target.container : row.id)).trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async waitHealthy(target: ComposeServiceTarget, timeoutSec: number, checkpoint?: () => void): Promise<void> {
    const start = this.clock.now();
    let delayMs = 300;
    let lastStatus = 'not created';

    while (this.clock.now() - start < timeoutSec * 1000) {
      checkpoint?.();
      const status = await this.status(target);

      if (status) {
        lastStatus = status;
        if (status === 'running healthy' || status === 'running none') return;
      }
      await this.clock.sleep(delayMs);
      delayMs = Math.min(Math.round(delayMs * 1.5), 1_000);
    }
    throw new Error(`Docker service ${ target.container } not healthy after ${ timeoutSec }s (last status: ${ lastStatus })`);
  }

  private inspect(ref: string): Promise<string> {
    return this.docker.run([
      'inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', ref,
    ]);
  }
}
