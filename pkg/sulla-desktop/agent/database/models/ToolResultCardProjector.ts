// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChatMessage } from '../registry/AgentPersonaRegistry';

type ToolCard = NonNullable<ChatMessage['toolCard']>;
type ResultFormatter = (name: string, args: Record<string, unknown>, result: unknown, error?: string | null) => { output?: string; outputFormat?: ToolCard['outputFormat'] };

/** Keeps renderer tool cards small while the durable conversation log retains the full result. */
export class ToolResultCardProjector {
  constructor(private readonly formatResult: ResultFormatter, private readonly pointerThreshold = 150_000) {}

  project(card: ToolCard, data: any, defaultThreadId: string): void {
    const result = data?.result;
    const error = typeof data?.error === 'string' ? data.error : undefined;
    const hasInlineImage = this.hasInlineImage(result);
    const large = hasInlineImage || this.serializedLength(result) + (error?.length ?? 0) > this.pointerThreshold;
    const payloadThreadId = typeof data?.payloadThreadId === 'string' ? data.payloadThreadId : undefined;
    const sourceThreadId = payloadThreadId ?? defaultThreadId;
    const durablePayloadConfirmed = data?.payloadPersisted === true && Boolean(payloadThreadId);

    card.status = data?.success === true ? 'success' : 'failed';
    delete card.result;
    if (durablePayloadConfirmed && (payloadThreadId || large || hasInlineImage)) {
      card.toolPayloadRef = { threadId: sourceThreadId, toolRunId: card.toolRunId };
      delete card.output;
      card.error = undefined;
    } else {
      const display = this.formatResult(card.toolName, card.args ?? {}, result, error);
      const fullOutput = result === undefined ? display.output
        : typeof result === 'string' ? result : this.serialize(result);
      delete card.toolPayloadRef;
      card.output = fullOutput;
      card.error = error;
      if (display.outputFormat) card.outputFormat = display.outputFormat;
    }
  }

  private serialize(value: unknown): string {
    try { return JSON.stringify(value, null, 2) ?? String(value) }
    catch { return String(value) }
  }

  private serializedLength(value: unknown): number {
    if (typeof value === 'string') return value.length;
    if (value === undefined || value === null) return 0;
    try { return JSON.stringify(value).length }
    catch { return String(value).length }
  }

  private hasInlineImage(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
    if (typeof value === 'string') {
      if (/^data:image\//i.test(value)) return true;
      if (depth < 3 && /^[\[{]/.test(value.trim())) {
        try { return this.hasInlineImage(JSON.parse(value), seen, depth + 1) }
        catch { return false }
      }
      return false;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(item => this.hasInlineImage(item, seen, depth));
    const record = value as Record<string, unknown>;
    const source = record.source as Record<string, unknown> | undefined;
    if (record.type === 'image' && source?.type === 'base64' && typeof source.data === 'string') return true;
    for (const [key, item] of Object.entries(record)) {
      if (/^(?:screenshot|image)(?:_?base64|_?data)$/i.test(key) && typeof item === 'string') return true;
      if (this.hasInlineImage(item, seen, depth)) return true;
    }
    return false;
  }
}
