// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Logging from '../../utils/logging';

export type ParentInputWaitKind = 'completion' | 'orchestrator' | 'agent_inbox';
export type ParentInputWaitBoundary = 'api_prompt' | 'steer_listener' | 'claude_replay' | 'codex_resume' | 'followup';

export interface ParentInputWaitRecord {
  kind: ParentInputWaitKind;
  threadId: string;
  inputId: string;
  queuedAtMs: number;
  deferredAtMs: number;
  runId?: string;
}

export interface ParentInputWaitLogger {
  log(line: string): void;
}

export class ParentInputWaitRecorder {
  constructor(
    private readonly perf: ParentInputWaitLogger = Logging.perf,
    private readonly clock: () => number = Date.now,
  ) {}

  deferred(input: Omit<ParentInputWaitRecord, 'deferredAtMs'> & { deferredAtMs?: number }): ParentInputWaitRecord {
    const record: ParentInputWaitRecord = {
      ...input,
      queuedAtMs: this.timestamp(input.queuedAtMs),
      deferredAtMs: this.timestamp(input.deferredAtMs ?? this.clock()),
      threadId: String(input.threadId),
      inputId: String(input.inputId),
      ...(input.runId ? { runId: String(input.runId) } : {}),
    };
    this.perf.log(`[ParentInputWait] event=deferred kind=${ record.kind } threadId=${ this.id(record.threadId) } inputId=${ this.id(record.inputId) } queuedAtMs=${ record.queuedAtMs } deferredAtMs=${ record.deferredAtMs }${ record.runId ? ` runId=${ this.id(record.runId) }` : '' }`);
    return record;
  }

  injected(record: ParentInputWaitRecord, injectedAtMs = this.clock()): void {
    this.perf.log(`[ParentInputWait] event=injected kind=${ record.kind } threadId=${ this.id(record.threadId) } inputId=${ this.id(record.inputId) } injectedAtMs=${ this.timestamp(injectedAtMs) }${ record.runId ? ` runId=${ this.id(record.runId) }` : '' }`);
  }

  delivered(record: ParentInputWaitRecord, boundary: ParentInputWaitBoundary, deliveredAtMs = this.clock()): number {
    const delivered = this.timestamp(deliveredAtMs);
    const queuedAt = this.timestamp(record.queuedAtMs);
    const deferredAt = this.timestamp(record.deferredAtMs);
    const dwell = Math.max(0, delivered - deferredAt);
    const queueWait = Math.max(0, deferredAt - queuedAt);
    const totalWait = Math.max(0, delivered - queuedAt);
    const event = boundary === 'followup' ? 'fallback-delivered' : 'delivered';
    this.perf.log(`[ParentInputWait] event=${ event } kind=${ record.kind } threadId=${ this.id(record.threadId) } inputId=${ this.id(record.inputId) } queuedAtMs=${ queuedAt } deferredAtMs=${ deferredAt } deliveredAtMs=${ delivered } queueWaitMs=${ queueWait } dwellMs=${ dwell } totalWaitMs=${ totalWait } boundary=${ boundary }${ record.runId ? ` runId=${ this.id(record.runId) }` : '' }`);
    return dwell;
  }

  private timestamp(value: number): number {
    return Number.isFinite(value) ? Math.trunc(value) : this.clock();
  }

  private id(value: string): string {
    return String(value).replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 200) || 'unknown';
  }
}
