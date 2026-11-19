// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'crypto';

import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

/** Stable identity and monotonic clock for one main-process app boot. */
export class AppStartupTelemetry {
  static readonly startupId = randomUUID();
  private static readonly startedAt = performance.now();

  static emit(event: string, status: 'start' | 'end' | 'failure', windowKey = 'main-process', details: Record<string, string | number | boolean> = {}): void {
    console.info(`[WindowBoot] ${ JSON.stringify({
      startupId: this.startupId,
      windowKey,
      event,
      status,
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - this.startedAt),
      elapsedSource: 'main',
      ...details,
    }) }`);
  }
}
