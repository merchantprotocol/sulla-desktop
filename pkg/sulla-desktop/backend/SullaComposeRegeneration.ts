// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ContainerDriftReconciler, DriftLogger, DriftOutcome } from './ContainerDriftReconciler';
import type { ComposeServiceTarget } from './sullaComposeContainers';

/** Rewrites the compose file and returns every service with a fixed container name. */
export type ComposeFileWriter = () => Promise<readonly ComposeServiceTarget[]>;

export interface RegenerationOptions {
  /** Throws when this regeneration was superseded (a newer startup took over). */
  checkpoint?:  () => void;
  /** Runs after the file is written and before the drift sweep (e.g. bring one service up first). */
  beforeSweep?: () => Promise<void>;
}

/**
 * A mid-session compose regeneration: rewrite the compose file, then recreate
 * every running container whose definition no longer matches it.
 *
 * Boot applies the file through compose for each managed service; a
 * regeneration after boot (Files guest-mount recovery, a service secret
 * change) used to bring up only one service, leaving every other running
 * container on its old definition until the next boot, or until a health
 * repair recreated it from the new file at an arbitrary time. Here the sweep
 * covers all of them, now. Containers that are not running are left alone.
 * Runs are serialised.
 *
 * PostgreSQL and Redis are never swept: POSTGRES_PASSWORD has no effect on an
 * existing data directory (trust auth inside the guest), so recreating them
 * mid-session is a pure outage. Boot applies their definition.
 */
export class SullaComposeRegeneration {
  static readonly NEVER_SWEPT: ReadonlySet<string> = new Set(['postgres', 'redis']);

  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly writeComposeFile: ComposeFileWriter,
    private readonly drift: ContainerDriftReconciler,
    private readonly logger: DriftLogger = console,
    private readonly reconcileFilesFuseDefinition: () => Promise<void> = async() => undefined,
  ) {}

  run(reason: string, options: RegenerationOptions = {}): Promise<DriftOutcome[]> {
    return this.serialize(() => this.regenerate(reason, options));
  }

  /** Keep a lifecycle operation and its Compose inputs ordered against regeneration. */
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);

    this.queue = next;

    return next;
  }

  private async regenerate(reason: string, { checkpoint = () => undefined, beforeSweep }: RegenerationOptions): Promise<DriftOutcome[]> {
    const targets = await this.writeComposeFile();

    checkpoint();
    if (beforeSweep) {
      await beforeSweep();
      checkpoint();
    }
    await this.reconcileFilesFuseDefinition();
    checkpoint();
    const outcomes = await this.drift.reconcileAll(targets.filter(target => !SullaComposeRegeneration.NEVER_SWEPT.has(target.service)));
    const recreated = outcomes.filter(outcome => outcome.kind === 'recreated').map(outcome => outcome.service);

    this.logger.log(`[Sulla] Compose regenerated (${ reason }); ${ recreated.length ? `recreated drifted: ${ recreated.join(', ') }` : 'no running container drifted' }`);

    return outcomes;
  }
}
