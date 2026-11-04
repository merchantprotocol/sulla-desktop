// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { Clock } from '@sulla/foundation';
export class JobIdGenerator {
  private counter = 0;
  constructor(private readonly clock: Clock) {}
  next(): string { this.counter += 1; return `agent-job-${ this.clock.now().getTime() }-${ this.counter }`; }
}
