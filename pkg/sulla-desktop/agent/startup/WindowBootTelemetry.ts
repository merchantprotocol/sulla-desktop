// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

/** Correlates startup diagnostics within a single renderer window. */
export class WindowBootTelemetry {
  readonly startupId: string;
  readonly windowKey: string;
  private readonly startedAt = performance.now();

  constructor(startupId: string, windowKey: string, private readonly sendToMain?: (event: string, status: 'start' | 'end' | 'failure', elapsedMs: number) => Promise<unknown>) {
    this.startupId = startupId;
    this.windowKey = windowKey;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(() => this.emit('first-content-frame')));
    }
  }

  emit(event: string, status: 'start' | 'end' | 'failure' = 'end'): void {
    const elapsedMs = Math.round(performance.now() - this.startedAt);
    const record = {
      startupId: this.startupId,
      windowKey: this.windowKey,
      event,
      status,
      timestamp: new Date().toISOString(),
      elapsedMs,
      elapsedSource: 'renderer',
    };
    console.info(`[WindowBoot] ${ JSON.stringify(record) }`);
    void this.sendToMain?.(event, status, elapsedMs).catch(() => undefined);
  }
}
