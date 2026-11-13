// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Decides how Desktop heals Sulla containers that Docker reports unhealthy.
 *
 * Plain Docker restarts a container only when its process exits; a container that is
 * running but `unhealthy` is left alone. Desktop closes that gap:
 *
 * - Restart first (cheap, keeps the container and its anonymous state), then recreate
 *   when a restart did not bring it back.
 * - Stateless services and FUSE adapters act after a minute; services that hold state or
 *   run long first-start migrations (Postgres, Files, Vault, Accounts, Redis) get a much
 *   longer grace period so a slow migration is never interrupted. The grace is measured
 *   from the container's last start, so it applies again after every heal.
 * - While Postgres or Redis is not healthy, only they are healed: everything that depends
 *   on them is unhealthy because of them, and restarting dependents would not help.
 * - Every incident is capped. A container that stays healthy for HEALTHY_RESET_MS starts
 *   a fresh incident, so a failure days later is healed again.
 */
export interface ManagedContainerRow {
  /** Docker container name, e.g. sulla_files_fuse. */
  container: string;
  /** Compose service name, e.g. sulla_files_fuse or workflow_manager; the container name when not compose-managed. */
  service: string;
  /** Docker State.Status, e.g. running, exited, restarting. */
  state: string;
  /** Docker State.Health.Status, or 'none' when the image has no healthcheck. */
  health: string;
  /** Milliseconds since the container last (re)started. */
  runningForMs: number;
  /** 'compose' for services in the sulla compose project, 'docker' for containers Desktop runs directly. */
  managedBy?: 'compose' | 'docker';
}

export const STATEFUL_SERVICES: readonly string[] = ['postgres', 'redis', 'sulla_files', 'sulla_vault', 'sulla_accounts'];
/** Services every other Sulla service depends on. While one is down, only it is healed. */
export const DEPENDENCY_SERVICES: readonly string[] = ['postgres', 'redis'];
/**
 * Containers Desktop runs with `docker run` (not compose) that it still supervises.
 * Keep in sync with HOST_RELAY_NAME in agent/services/AgentContainerLauncher.ts.
 */
export const DOCKER_MANAGED_CONTAINERS: readonly string[] = ['sulla-host-relay'];
export const STATELESS_GRACE_MS = 60_000;
export const STATEFUL_GRACE_MS = 10 * 60_000;
/** Recreates allowed per incident, after the one restart. */
export const MAX_AUTO_RECREATES = 3;
/** A container healthy this long since its last start begins a fresh incident. */
export const HEALTHY_RESET_MS = 10 * 60_000;

/** The compose service that runs the Files FUSE adapter (it mounts /mnt/sulla-files). */
export const FILES_ADAPTER_SERVICE = 'sulla_files_fuse';

export type HealKind = 'restart' | 'recreate' | 'give-up';

export interface HealAction {
  container: string;
  service: string;
  kind: HealKind;
  reason: string;
  managedBy: 'compose' | 'docker';
  /** 1-based attempt within this incident (restart is 1, recreates follow). */
  attempt: number;
  /** Total attempts this incident allows. */
  maxAttempts: number;
}

interface IncidentHistory {
  restarts: number;
  recreates: number;
  gaveUp: boolean;
}

/** One line per heal, for the Desktop log. */
export function describeHealAction(action: HealAction): string {
  if (action.kind === 'give-up') {
    return `[Sulla] ${ action.container } is still ${ action.reason } after ${ action.maxAttempts } automatic repairs; leaving it for manual repair`;
  }
  const verb = action.kind === 'restart' ? 'restarting' : 'recreating';

  return `[Sulla] ${ action.container } is ${ action.reason }; ${ verb } it (attempt ${ action.attempt }/${ action.maxAttempts })`;
}

/**
 * Holds the heal history of one Desktop session (one managed-services generation) and plans
 * the next heal for each container. Pure apart from that history: callers run the actions.
 */
export class ContainerHealPlanner {
  readonly #history = new Map<string, IncidentHistory>();

  /** Forget every incident (a new managed-services generation starts). */
  reset(): void {
    this.#history.clear();
  }

  /** Attempts made in the current incident for one container. */
  attempts(container: string): number {
    const history = this.#history.get(container);

    return history ? history.restarts + history.recreates : 0;
  }

  /**
   * Plan the heals for one supervisor tick and record them as taken. The caller runs each
   * restart/recreate; a give-up is reported once per incident and needs no action.
   */
  plan(rows: ReadonlyArray<ManagedContainerRow>): HealAction[] {
    const actions: HealAction[] = [];
    const dependencyDown = rows.some(row => DEPENDENCY_SERVICES.includes(row.service) && !this.isHealthyDependency(row));

    for (const row of rows) {
      const history = this.#history.get(row.container);

      if (history && row.health === 'healthy' && row.state === 'running' && row.runningForMs >= HEALTHY_RESET_MS) {
        this.#history.delete(row.container);
        continue;
      }
      const reason = this.troubleOf(row);

      if (!reason) continue;
      if (dependencyDown && !DEPENDENCY_SERVICES.includes(row.service)) continue;
      const stuckCreated = reason === 'stuck created';
      const grace = STATEFUL_SERVICES.includes(row.service) ? STATEFUL_GRACE_MS : STATELESS_GRACE_MS;

      if (!stuckCreated && row.runningForMs < grace) continue;

      const managedBy = row.managedBy ?? 'compose';
      const current = history ?? { restarts: 0, recreates: 0, gaveUp: false };
      const maxAttempts = 1 + MAX_AUTO_RECREATES;
      const base = { container: row.container, service: row.service, reason, managedBy, maxAttempts };

      if (current.restarts + current.recreates >= maxAttempts) {
        if (!current.gaveUp) {
          current.gaveUp = true;
          this.#history.set(row.container, current);
          actions.push({ ...base, kind: 'give-up', attempt: maxAttempts });
        }
        continue;
      }
      // A container that never started, or that Docker is already restarting in a loop,
      // gains nothing from another restart: rebuild it. Otherwise restart once first.
      const kind: HealKind = stuckCreated || row.state === 'restarting' || current.restarts > 0 ? 'recreate' : 'restart';

      if (kind === 'restart') current.restarts += 1;
      else current.recreates += 1;
      this.#history.set(row.container, current);
      actions.push({ ...base, kind, attempt: current.restarts + current.recreates });
    }

    return actions;
  }

  private isHealthyDependency(row: ManagedContainerRow): boolean {
    return row.state === 'running' && (row.health === 'healthy' || row.health === 'none');
  }

  /** Why a container needs healing, or undefined when it does not. */
  private troubleOf(row: ManagedContainerRow): string | undefined {
    // A container that was stopped on purpose (an idle on-demand service) keeps the last
    // health status Docker saw, which can be "unhealthy"; healing it would start it again.
    if (row.state === 'exited' || row.state === 'dead') return undefined;
    // The Files adapter whose bind source was already a dead FUSE mount never starts and
    // never gets a health status (Docker State.Status stays "created"). Heal it at once.
    if (row.state === 'created' && row.service === FILES_ADAPTER_SERVICE) return 'stuck created';
    if (row.state === 'restarting') return 'restart loop';
    if (row.health === 'unhealthy') return 'unhealthy';

    return undefined;
  }
}

/** What the person did to a container from the Docker tab. */
export type ContainerIntent = 'stop' | 'start' | 'restart' | 'remove';

/**
 * Sulla containers the person stopped on purpose. Supervision (the missing-service
 * reconcile and the unhealthy-container heal) leaves these stopped until they start,
 * restart or remove them again, or until Docker itself is restarted. Without this a
 * Stop from the Docker tab was undone by the reconcile within a minute.
 */
export class UserStoppedContainers {
  readonly #names = new Set<string>();

  /** Record a Docker tab action on these containers (names or `/names`). */
  record(intent: ContainerIntent, names: ReadonlyArray<string>): void {
    for (const raw of names) {
      const name = UserStoppedContainers.normalize(raw);

      if (!name) continue;
      if (intent === 'stop') this.#names.add(name);
      else this.#names.delete(name);
    }
  }

  has(name: string): boolean {
    return this.#names.has(UserStoppedContainers.normalize(name));
  }

  /** The entries whose container the person did not stop on purpose. */
  withoutStopped<T extends { container: string }>(entries: ReadonlyArray<T>): T[] {
    return entries.filter(entry => !this.has(entry.container));
  }

  /** Forget every stop (Docker restarted, so everything comes back). */
  clear(): void {
    this.#names.clear();
  }

  private static normalize(name: string): string {
    return String(name ?? '').trim().replace(/^\//, '');
  }
}
