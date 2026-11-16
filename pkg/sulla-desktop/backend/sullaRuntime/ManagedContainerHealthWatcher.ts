// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VMExecutor } from '../backend';
import {
  ContainerHealPlanner, DOCKER_MANAGED_CONTAINERS, describeHealAction, type HealAction, type ManagedContainerRow,
  UserStoppedContainers,
} from '../sullaContainerHealth';

export interface ManagedServiceEntry { service: string; container: string }

/**
 * Keep managed containers honest: every minute, heal any Sulla container that Docker
 * reports unhealthy (or restart-looping) past its grace period: restart it first, then
 * recreate it if the restart did not help (see ContainerHealPlanner). Covers the sulla
 * compose project and the containers Desktop runs directly (the agent host relay). The
 * Files adapter's stale guest mount is handled by the Files mount manager, not here.
 */
export class ManagedContainerHealthWatcher {
  constructor(
    private readonly guest: Pick<VMExecutor, 'execCommand'>,
    private readonly userStopped: UserStoppedContainers,
    /** Rebuilds the agent host relay; it is never recreated by compose. */
    private readonly repairHostRelay: () => Promise<void>,
    /** True for the error that ends a managed-services generation. */
    private readonly isCancellation: (error: unknown) => boolean,
    private readonly healPlanner = new ContainerHealPlanner(),
  ) {}

  watch(
    assertGeneration: () => void,
    composeCommand: string[],
    desired: ReadonlyArray<ManagedServiceEntry>,
    onMissing: (missing: ManagedServiceEntry[]) => void,
  ): void {
    this.healPlanner.reset();
    let ticking = false;
    let lastMissing = '';
    const tick = async(): Promise<void> => {
      assertGeneration();
      const listing = await this.guest.execCommand(
        { capture: true, root: true, expectFailure: true }, 'docker', 'ps', '-a',
        '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
      );
      const rows: ManagedContainerRow[] = [];

      for (const line of listing.split('\n').filter(Boolean)) {
        const [container, project, service] = line.split('\t');
        const managedBy = project === 'sulla' ? 'compose' : DOCKER_MANAGED_CONTAINERS.includes(container) ? 'docker' : undefined;

        if (!managedBy) continue;
        const state = (await this.guest.execCommand(
          { capture: true, root: true, expectFailure: true }, 'docker', 'inspect', '--format',
          '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.StartedAt}}', container,
        ).catch(() => '')).trim().split(' ');

        if (state.length < 3) continue;
        rows.push({
          container, service: managedBy === 'compose' ? service : container, managedBy,
          state: state[0], health: state[1], runningForMs: Date.now() - Date.parse(state[2]),
        });
      }
      // Missing, or stopped for good (exited/dead is not restart-looping, so
      // the unhealthy check below leaves it alone).
      const present = new Set(rows.filter(row => row.state !== 'exited' && row.state !== 'dead').map(row => row.container));
      // A container the person stopped from the Docker tab is not missing; it stays stopped.
      const missing = this.userStopped.withoutStopped(desired.filter(entry => !present.has(entry.container)));

      const missingKey = missing.map(entry => entry.container).join(', ');

      if (missingKey !== lastMissing) {
        if (missingKey) console.warn(`[Sulla] ${ missingKey } not running; reconciling`);
        lastMissing = missingKey;
      }
      if (missing.length) onMissing(missing);
      for (const action of this.healPlanner.plan(rows.filter(row => !this.userStopped.has(row.container)))) {
        console.warn(describeHealAction(action));
        await this.runHealAction(action, composeCommand)
          .catch(error => console.warn(`[Sulla] Could not ${ action.kind } ${ action.container }:`, (error as Error).message?.split('\n')[0]));
      }
    };
    // A failed tick is logged and the next one runs as usual; only the end
    // of the generation stops the watch. Ticks never overlap.
    const run = (): void => {
      if (ticking) return;
      ticking = true;
      tick().catch((error) => {
        if (this.isCancellation(error)) clearInterval(timer);
        else console.warn('[Sulla] Container health check failed; retrying next minute:', (error as Error)?.message?.split('\n')[0]);
      }).finally(() => { ticking = false });
    };
    const timer = setInterval(run, 60_000);

    timer.unref?.();
    // Containers that survived a crash can be broken before Desktop even starts: sweep once soon
    // after startup settles instead of waiting a full interval.
    setTimeout(run, 45_000).unref?.();
  }

  /** Run one planned heal. The host relay is rebuilt by its launcher, never by compose. */
  async runHealAction(action: HealAction, composeCommand: string[]): Promise<void> {
    if (action.kind === 'give-up') return;
    if (action.kind === 'restart') {
      await this.guest.execCommand({ root: true }, 'docker', 'restart', '--time', '10', action.container);

      return;
    }
    if (action.managedBy === 'docker') {
      await this.repairHostRelay();

      return;
    }
    await this.guest.execCommand({ root: true }, ...composeCommand, 'up', '-d', '--no-deps', '--force-recreate', action.service);
  }
}
