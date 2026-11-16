// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Shared admission ceiling for concurrently dispatched routine workers. */
import { randomUUID } from 'node:crypto';

import { WORKER_CONCURRENCY_KEY, DEFAULT_WORKER_CONCURRENCY, normalizeWorkerConcurrency } from '../../shared/workerConcurrency';

import { postgresClient } from '../database/PostgresClient';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { RoutineSlotRepository } from '../app/Repositories/RoutineSlotRepository';

export type ProtectedRoutineKind =
  | 'planning'
  | 'execution'
  | 'review'
  | 'repair'
  | 'dreaming'
  | 'other';

export const PROTECTED_ROUTINE_KINDS: ProtectedRoutineKind[] = [
  'planning', 'execution', 'review', 'repair', 'dreaming', 'other',
];

/** Slots un-heartbeated for longer than this are treated as crashed. */
const DEFAULT_STALE_SLOT_MINUTES = 45;

export interface RoutineSlotContext {
  owner?:  string | null;
  taskId?: string | null;
}

/** Collaborators the policy needs; every one can be swapped in tests. */
export interface RoutineConcurrencyDependencies {
  slots:        RoutineSlotRepository;
  readSetting:  (property: string, defaultValue: unknown) => Promise<unknown>;
  newSlotId:    () => string;
  sleep:        (milliseconds: number) => Promise<void>;
}

export class RoutineConcurrencyPolicy {
  private static sharedInstance: RoutineConcurrencyPolicy | undefined;

  constructor(private readonly deps: RoutineConcurrencyDependencies) {}

  /** Production wiring: Postgres slots and the stored worker-concurrency setting. */
  static shared(): RoutineConcurrencyPolicy {
    this.sharedInstance ??= new RoutineConcurrencyPolicy({
      slots:       new RoutineSlotRepository(postgresClient),
      readSetting: (property, defaultValue) => SullaSettingsModel.get(property, defaultValue),
      newSlotId:   () => randomUUID(),
      sleep:       milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    });
    return this.sharedInstance;
  }

  /** Keep worker capacity independent of whole-board consideration. */
  async resolveLimit(_kind: ProtectedRoutineKind, _legacyFallback?: number): Promise<number> {
    return this.resolveTotalLimit();
  }

  async resolveTotalLimit(): Promise<number> {
    return normalizeWorkerConcurrency(await this.deps.readSetting(WORKER_CONCURRENCY_KEY, DEFAULT_WORKER_CONCURRENCY) as any);
  }

  /** Count active reservations of a kind (or all kinds when omitted). */
  async runningCount(kind?: ProtectedRoutineKind): Promise<number> {
    return this.deps.slots.countActive(kind ?? null);
  }

  /** Reserve against the current shared worker limit under one database lock. */
  async acquire(kind: ProtectedRoutineKind, _limit: number, context: RoutineSlotContext = {}): Promise<string | null> {
    const limit = await this.resolveTotalLimit();
    return this.deps.slots.reserveUnderLimit(limit, {
      id: this.deps.newSlotId(), kind, owner: context.owner ?? null, taskId: context.taskId ?? null,
    });
  }

  /** Queue behind capacity instead of converting routine backpressure into failure. */
  async acquireWhenAvailable(kind: ProtectedRoutineKind, limit: number, context: RoutineSlotContext = {}, pollMs = 1_000): Promise<string> {
    for (;;) {
      await this.reclaimStale();
      const slot = await this.acquire(kind, limit, context);
      if (slot) return slot;
      await this.deps.sleep(Math.max(100, pollMs));
    }
  }

  async release(slotId: string): Promise<void> {
    await this.deps.slots.delete(slotId);
  }

  async heartbeat(slotId: string): Promise<void> {
    await this.deps.slots.touch(slotId);
  }

  /** Reclaim slots whose owner crashed without releasing them. */
  async reclaimStale(staleMinutes: number = DEFAULT_STALE_SLOT_MINUTES): Promise<number> {
    return this.deps.slots.deleteStale(Math.max(1, Math.floor(staleMinutes)));
  }

  // Static facade kept for existing callers (main/sullaRoutineTemplateEvents.ts).

  /** @deprecated Use RoutineConcurrencyPolicy.shared().resolveLimit(). */
  static resolveLimit(kind: ProtectedRoutineKind, legacyFallback?: number): Promise<number> { return this.shared().resolveLimit(kind, legacyFallback); }
  /** @deprecated Use RoutineConcurrencyPolicy.shared().resolveTotalLimit(). */
  static resolveTotalLimit(): Promise<number> { return this.shared().resolveTotalLimit(); }
  /** @deprecated Use RoutineConcurrencyPolicy.shared().runningCount(). */
  static runningCount(kind?: ProtectedRoutineKind): Promise<number> { return this.shared().runningCount(kind); }
  /** @deprecated Use RoutineConcurrencyPolicy.shared().acquire(). */
  static acquire(kind: ProtectedRoutineKind, limit: number, context: RoutineSlotContext = {}): Promise<string | null> { return this.shared().acquire(kind, limit, context); }
  /** @deprecated Use RoutineConcurrencyPolicy.shared().acquireWhenAvailable(). */
  static acquireWhenAvailable(kind: ProtectedRoutineKind, limit: number, context: RoutineSlotContext = {}, pollMs = 1_000): Promise<string> {
    return this.shared().acquireWhenAvailable(kind, limit, context, pollMs);
  }
  /** @deprecated Use RoutineConcurrencyPolicy.shared().release(). */
  static release(slotId: string): Promise<void> { return this.shared().release(slotId); }
  /** @deprecated Use RoutineConcurrencyPolicy.shared().heartbeat(). */
  static heartbeat(slotId: string): Promise<void> { return this.shared().heartbeat(slotId); }
  /** @deprecated Use RoutineConcurrencyPolicy.shared().reclaimStale(). */
  static reclaimStale(staleMinutes: number = DEFAULT_STALE_SLOT_MINUTES): Promise<number> { return this.shared().reclaimStale(staleMinutes); }
}
