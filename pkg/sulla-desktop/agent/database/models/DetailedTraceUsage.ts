// SPDX-License-Identifier: GPL-2.0-or-later

import { shallowRef } from 'vue';

import { TracePayloadRedactor } from '../../tools/TracePayloadRedactor';

export interface DetailedTraceUsageSample {
  readonly afterId?: string;
  readonly receivedAt: number;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly model?: string;
}

/** Live renderer-only usage. Never attach these samples to a message or thread state. */
export class DetailedTraceUsage {
  private readonly samples = shallowRef<readonly DetailedTraceUsageSample[]>([]);
  private readonly redactor = new TracePayloadRedactor();

  get value(): readonly DetailedTraceUsageSample[] { return this.samples.value }

  capture(data: Record<string, unknown>, afterId?: string, receivedAt = Date.now()): void {
    const durationMs = this.nonnegative(data.time_spent);
    const inputTokens = this.nonnegative(data.prompt_tokens);
    const outputTokens = this.nonnegative(data.completion_tokens);
    const model = typeof data.model === 'string' && data.model.trim() ? this.redactor.redactText(data.model) : undefined;
    if (durationMs === undefined && inputTokens === undefined && outputTokens === undefined && !model) return;
    this.samples.value = [...this.samples.value.slice(-2047), { afterId, receivedAt, durationMs, inputTokens, outputTokens, model }];
  }

  clear(): void { this.samples.value = [] }

  private nonnegative(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  }
}
