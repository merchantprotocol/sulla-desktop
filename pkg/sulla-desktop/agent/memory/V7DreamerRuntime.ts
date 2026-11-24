// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Production wiring for V7Dreamer: the Postgres v7 store, the Settings-backed
 * cursor and the subconscious model slot. One Dreamer per process, so the
 * single-flight guard covers every caller (the routine's tool-call node, a
 * manual tool call, a schedule catch-up fire).
 */

import { V7DreamRepository } from '../app/Repositories/V7DreamRepository';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import {
  DEFAULT_DREAMER_INTERVAL_MINUTES,
  V7Dreamer,
  type DreamCursorStore,
  type DreamModel,
} from './V7Dreamer';
import { DreamDuplicateSweeper, type DuplicateSweepCursor, type SweepCursorValue } from './V7DuplicateSweeper';

export const DREAMER_INTERVAL_SETTING = 'dreamerIntervalMinutes';
export const DREAMER_CURSOR_SETTING = 'dreamerLastWindowEndMs';
export const DREAMER_SWEEP_CURSOR_SETTING = 'dreamerDuplicateSweepBeforeTs';

/** @deprecated use V7DreamRepository (app/Repositories/V7DreamRepository) */
export { V7DreamRepository as PostgresV7DreamStore };

export class SettingsDreamCursor implements DreamCursorStore {
  async getLastWindowEnd(): Promise<number | null> {
    const value = Number(await SullaSettingsModel.get(DREAMER_CURSOR_SETTING, null));

    return Number.isFinite(value) && value > 0 ? value : null;
  }

  async setLastWindowEnd(ms: number): Promise<void> {
    await SullaSettingsModel.set(DREAMER_CURSOR_SETTING, ms, 'number');
  }

  async getIntervalMinutes(): Promise<number> {
    return Number(await SullaSettingsModel.get(DREAMER_INTERVAL_SETTING, DEFAULT_DREAMER_INTERVAL_MINUTES));
  }
}

/** Persisted backward page for the duplicate sweeper; independent from the dream window cursor. */
export class SettingsDreamSweepCursor implements DuplicateSweepCursor {
  async getBeforeCursor(): Promise<SweepCursorValue | null> {
    const value = await SullaSettingsModel.get(DREAMER_SWEEP_CURSOR_SETTING, 0);

    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== 'string') return null;

    const separator = value.indexOf(':');
    if (separator < 0) {
      const legacyTs = Number(value);

      return Number.isFinite(legacyTs) && legacyTs > 0 ? legacyTs : null;
    }

    const ts = Number(value.slice(0, separator));
    const id = value.slice(separator + 1);

    return Number.isFinite(ts) && ts > 0 && id.length > 0 ? { ts, id } : null;
  }

  async setBeforeCursor(before: SweepCursorValue | null): Promise<void> {
    if (before === null || typeof before === 'number') {
      await SullaSettingsModel.set(DREAMER_SWEEP_CURSOR_SETTING, before ?? 0, 'number');
      return;
    }

    await SullaSettingsModel.set(DREAMER_SWEEP_CURSOR_SETTING, `${ before.ts }:${ before.id }`, 'string');
  }
}

/** One subconscious-slot model call, bounded by the process-wide writer gate. */
export class SubconsciousDreamModel implements DreamModel {
  async dream(systemPrompt: string, userMessage: string): Promise<string | null> {
    const [{ GraphRegistry }, { runThroughWriterGate }] = await Promise.all([
      import('../services/GraphRegistry'),
      import('../services/SubconsciousWriterGate'),
    ]);

    return runThroughWriterGate(async() => {
      const created = await GraphRegistry.createV7Dreamer(systemPrompt, userMessage);
      // maxIterations 1: one node pass, so exactly one model call per batch.
      await created.graph.execute(created.state, 'subconscious', { maxIterations: 1 });
      const output = (created.state.metadata as any).v7DreamerOutput;

      return typeof output === 'string' ? output : null;
    });
  }
}

/** Owns the one process-wide V7Dreamer, so its single-flight guard covers every caller. */
export class V7DreamerRuntime {
  private static instance: V7Dreamer | undefined;

  static shared(): V7Dreamer {
    if (!V7DreamerRuntime.instance) {
      const store = new V7DreamRepository();
      V7DreamerRuntime.instance = new V7Dreamer({
        store,
        cursor:  new SettingsDreamCursor(),
        model:   new SubconsciousDreamModel(),
        sweeper: new DreamDuplicateSweeper(store, new SettingsDreamSweepCursor()),
      });
    }

    return V7DreamerRuntime.instance;
  }
}

/** @deprecated use V7DreamerRuntime.shared() */
export const getV7Dreamer = (): V7Dreamer => V7DreamerRuntime.shared();
