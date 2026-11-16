// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SULLA_COMPOSE_COMMAND } from './onDemandServices';
import type { ComposeServiceTarget, DockerCli } from './sullaComposeContainers';
import { reconcileComposeService, type RootCommandRunner } from './sullaServiceReconcile';

export type HealthWait = (target: ComposeServiceTarget, timeoutSec: number) => Promise<void>;

export interface ComposeDriftActionsLogger {
  warn(message: string): void;
}

/** What the drift reconciler does to a drifted container in the running guest. */
export class ComposeDriftActions {
  /** Files may spend minutes on a first-start schema migration. */
  static readonly SETTLE_TIMEOUT_SEC: Readonly<Record<string, number>> = { sulla_files: 600 };
  static readonly DEFAULT_SETTLE_TIMEOUT_SEC = 120;

  constructor(
    private readonly docker: DockerCli,
    private readonly run: RootCommandRunner,
    private readonly waitHealthy: HealthWait,
    private readonly logger: ComposeDriftActionsLogger = console,
  ) {}

  /** Recreate one service from the current compose file (compose's own diff decides). */
  async recreate(service: string): Promise<void> {
    await reconcileComposeService({ composeCommand: [...SULLA_COMPOSE_COMMAND], service, run: this.run });
  }

  /**
   * Before a drifted container is recreated: if it is still in its start
   * period (Files may be applying a schema migration), give it a bounded wait
   * to become healthy so the recreate never interrupts a migration. Never throws.
   */
  async settle(target: ComposeServiceTarget): Promise<void> {
    const health = (await this.docker.run([
      'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', target.container,
    ]).catch(() => '')).trim();

    if (health !== 'starting') return;
    const timeout = ComposeDriftActions.SETTLE_TIMEOUT_SEC[target.service] ?? ComposeDriftActions.DEFAULT_SETTLE_TIMEOUT_SEC;

    await this.waitHealthy(target, timeout).catch((error: unknown) => {
      this.logger.warn(`[Sulla] ${ target.service } did not become healthy before its recreate: ${ (error instanceof Error ? error.message : String(error)).split('\n')[0] }`);
    });
  }
}
