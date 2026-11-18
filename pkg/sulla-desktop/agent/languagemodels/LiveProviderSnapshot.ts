// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { RoutingModelInfo } from './modelRoutingTypes';

export interface LiveProviderState {
  connected: boolean;
  connectionUnknown: boolean;
  models: RoutingModelInfo[];
}

export type LiveProviderMap = Map<string, LiveProviderState>;

/** A snapshot younger than this is served as-is; older ones are served while a refresh runs. */
const SNAPSHOT_TTL_MS = 30_000;

/**
 * Holds the last live provider snapshot for the model router. Reads are stale-while-revalidate:
 * an old snapshot is returned immediately and one refresh runs behind it. Concurrent refreshes
 * share a single flight. `invalidate()` drops the snapshot and makes any refresh still running
 * from before the invalidation discard its result.
 */
export class LiveProviderSnapshot {
  private snapshot: LiveProviderMap | null = null;
  private snapshotAt = 0;
  private flight: Promise<LiveProviderMap> | null = null;
  private generation = 0;

  constructor(private readonly load: () => Promise<LiveProviderMap>) {}

  invalidate(): void {
    this.snapshotAt = 0;
    this.snapshot = null;
    this.generation++;
    this.flight = null;
  }

  async get(): Promise<LiveProviderMap> {
    if (this.snapshot && Date.now() - this.snapshotAt < SNAPSHOT_TTL_MS) return this.snapshot;
    if (this.snapshot && !this.flight) {
      void this.refresh().catch(() => undefined);
      return this.snapshot;
    }
    if (this.flight) return this.flight;
    return this.refresh();
  }

  refresh(): Promise<LiveProviderMap> {
    if (this.flight) return this.flight;
    const generation = this.generation;
    let flight: Promise<LiveProviderMap>;
    flight = this.load().then(snapshot => {
      if (generation === this.generation) {
        this.snapshot = snapshot;
        this.snapshotAt = Date.now();
      }
      return snapshot;
    }).finally(() => { if (this.flight === flight) this.flight = null; });
    this.flight = flight;
    return flight;
  }
}
