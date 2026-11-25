// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { blockingTool } from './RunLivenessClock';

export interface ToolInFlight { name: string; startedAt: number }

/**
 * Tool calls that have started but not finished, per run activity key. A
 * long shell command emits nothing until it ends, so without this a busy
 * agent looks silent. Keys follow RunActivity: a graph state's
 * `metadata.activityKeys`, so a sub-agent's call also counts for its run.
 */
export class RunToolTracker {
  private readonly calls = new Map<string, Map<string, ToolInFlight>>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  started(metadata: any, callId: string, name: string): void {
    if (!callId) return;
    const call = { name: name || 'a tool', startedAt: this.clock() };
    for (const key of this.keys(metadata)) {
      let open = this.calls.get(key);
      if (!open) this.calls.set(key, open = new Map());
      if (!open.has(callId)) open.set(callId, call);
    }
  }

  finished(metadata: any, callId: string): void {
    for (const key of this.keys(metadata)) {
      const open = this.calls.get(key);
      open?.delete(callId);
      if (open && !open.size) this.calls.delete(key);
    }
  }

  /** The run's process ended: nothing it started is still running. */
  clear(metadata: any): void {
    for (const key of this.keys(metadata)) this.calls.delete(key);
  }

  /** The call this key is blocked on (a human wait first, then the oldest), if any. */
  inFlight(key: string, _now: number = this.clock()): ToolInFlight | undefined {
    return blockingTool(this.calls.get(key)?.values() ?? []);
  }

  /** Forget every call recorded under one key (its run ended). */
  clearKey(key: string): void {
    this.calls.delete(key);
  }

  private keys(metadata: any): string[] {
    const keys = metadata?.activityKeys;
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string' && key.length > 0) : [];
  }
}

export const runTools = new RunToolTracker();
