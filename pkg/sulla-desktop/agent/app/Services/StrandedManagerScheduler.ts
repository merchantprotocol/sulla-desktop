// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentFleetProjectionService } from './AgentFleetProjectionService';
import type { StrandedEpisodeRepository } from '../Repositories/StrandedEpisodeRepository';
import type { StrandedManagerAlertService } from './StrandedManagerAlertService';
import type { StrandedManagerDetector } from './StrandedManagerDetector';

/** Runs stranded detection, durable episode CAS, stale-state clearing, and parent notice delivery. */
export class StrandedManagerScheduler {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly fleet: AgentFleetProjectionService, private readonly detector: StrandedManagerDetector,
    private readonly episodes: StrandedEpisodeRepository, private readonly alerts: StrandedManagerAlertService) {}

  // TODO(#1991): replace this temporary timer with one injected tick call from AgentLivenessReconciler after its final green head lands.
  start(intervalMs = 30_000): void { this.stop(); this.timer = setInterval(() => void this.tick(), intervalMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async tick(): Promise<number> {
    const jobs = await this.fleet.list({ scope: 'all', limit: 100, includeFinished: true });
    const candidates = this.detector.detect(jobs);
    const active = new Map(candidates.map(candidate => [this.detector.ref(candidate.managerJobId, candidate.managerTaskIndex), candidate]));
    for (const ref of this.detector.managerRefs(jobs)) {
      if (active.has(ref)) continue;
      const split = ref.lastIndexOf('#');
      await this.episodes.clear(ref.slice(0, split), Number(ref.slice(split + 1)));
    }
    let alerted = 0;
    for (const candidate of candidates) if (await this.episodes.claim(candidate)) { this.alerts.alert(candidate); alerted++; }
    return alerted;
  }
}
