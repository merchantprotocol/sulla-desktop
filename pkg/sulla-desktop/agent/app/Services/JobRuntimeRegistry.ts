// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service } from '@sulla/foundation';
import type { AgentJob } from '../../tools/agents/jobRegistry';
export class JobRuntimeRegistry extends Service {
  readonly jobs = new Map<string, AgentJob>();
  readonly abortControllers = new Map<string, AbortController>();
  readonly watchers = new Map<string, () => void>();
  private started = false;
  start(): void { this.started = true; }
  stop(): void { for (const value of this.abortControllers.values()) value.abort(); for (const stop of this.watchers.values()) stop(); this.reset(); this.started = false; }
  reset(): void { this.jobs.clear(); this.abortControllers.clear(); this.watchers.clear(); }
  isStarted(): boolean { return this.started; }
}
