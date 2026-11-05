// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentFleetProjectionService } from './AgentFleetProjectionService';
import type { StrandedEpisodeRepository } from '../Repositories/StrandedEpisodeRepository';
import type { StrandedAlertDispatcher } from './StrandedManagerAlertService';
import type { StrandedManagerDetector } from './StrandedManagerDetector';

export interface SchedulerLogger { error(message: string, error: unknown): void }

/** Serialized stranded detection and durable outbox delivery. */
export class StrandedManagerScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<number>;
  constructor(private readonly fleet: Pick<AgentFleetProjectionService, 'supervisionCandidates'>, private readonly detector: StrandedManagerDetector,
    private readonly episodes: StrandedEpisodeRepository, private readonly alerts: StrandedAlertDispatcher,
    private readonly logger: SchedulerLogger = console) {}

  start(intervalMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => { void this.tick().catch(error => this.logger.error('Stranded-manager tick failed', error)); }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  tick(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const run = this.runTick().catch(error => { this.logger.error('Stranded-manager reconciliation failed', error); return 0; })
      .finally(() => { if (this.inFlight === run) this.inFlight = undefined; });
    this.inFlight = run;
    return run;
  }

  private async runTick(): Promise<number> {
    const jobs = await this.fleet.supervisionCandidates();
    const candidates = this.detector.detect(jobs);
    await this.episodes.reconcile(this.detector.managerRefs(jobs), candidates);
    for (const candidate of candidates) await this.episodes.insertPending(candidate);
    let delivered = 0;
    for (const episode of await this.episodes.pending()) {
      await this.episodes.markAttempt(episode.stateKey);
      try {
        const acknowledged = await this.alerts.alert(episode);
        if (acknowledged && await this.episodes.markDelivered(episode)) delivered++;
      } catch (error) { this.logger.error(`Stranded-manager delivery failed for ${ episode.stateKey }`, error); }
    }
    return delivered;
  }
}
