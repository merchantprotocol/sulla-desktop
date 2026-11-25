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
    const display = this.formatResult(card.toolName, card.args ?? {}, result, error);
    const fullOutput = result === undefined ? display.output
      : typeof result === 'string' ? result : this.serialize(result);
    const large = (typeof fullOutput === 'string' ? fullOutput.length : 0) + (error?.length ?? 0) > this.pointerThreshold;
    const sourceThreadId = typeof data?.payloadThreadId === 'string' ? data.payloadThreadId : defaultThreadId;

    card.status = data?.success === true ? 'success' : 'failed';
    delete card.result;
    if (data?.payloadThreadId || large) {
      card.toolPayloadRef = { threadId: sourceThreadId, toolRunId: card.toolRunId };
      delete card.output;
      card.error = undefined;
    } else {
      delete card.toolPayloadRef;
      card.output = fullOutput;
      card.error = error;
    }
    if (display.outputFormat) card.outputFormat = display.outputFormat;
  }

  private serialize(value: unknown): string {
    try { return JSON.stringify(value, null, 2) ?? String(value) }
    catch { return String(value) }
  }
}
