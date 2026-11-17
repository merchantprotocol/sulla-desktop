// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type FirstRunTraceDetails = Record<string, unknown>;

/**
 * The Desktop-only first-run timeline writer. Desktop main registers the real implementation
 * (main/firstRun/firstRunTrace.ts) at startup. The Tools container never does, so its traces are dropped
 * instead of importing Electron-only main code.
 */
export interface FirstRunTraceSink {
  trace(area: string, event: string, details?: FirstRunTraceDetails): void;
  /** Starts the first-run window's trace events listener. Optional: a sink without a window has nothing to listen to. */
  listenForUiEvents?(): void;
}

class NoopFirstRunTraceSink implements FirstRunTraceSink {
  trace(): void {
    // No timeline in this runtime.
  }
}

export class FirstRunTraceRegistry {
  private sink: FirstRunTraceSink = new NoopFirstRunTraceSink();

  register(sink: FirstRunTraceSink): void {
    this.sink = sink;
  }

  resolve(): FirstRunTraceSink {
    return this.sink;
  }
}

export const firstRunTraceSink = new FirstRunTraceRegistry();

/** Record one first-run event through the registered sink. Dropped when no sink is registered. */
export function firstRunTrace(area: string, event: string, details?: FirstRunTraceDetails): void {
  firstRunTraceSink.resolve().trace(area, event, details);
}

/** Let the first-run window add its own steps and clicks to the timeline. Dropped when no sink is registered. */
export function initFirstRunTraceEvents(): void {
  firstRunTraceSink.resolve().listenForUiEvents?.();
}
