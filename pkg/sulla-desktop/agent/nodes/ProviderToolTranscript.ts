// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ProviderToolCall {
  toolUseId: string;
  toolName:  string;
  input?:    unknown;
}

export interface ProviderToolResult extends ProviderToolCall {
  result?:  unknown;
  error?:   string;
  isError?: boolean;
}

export interface ProviderToolTranscriptSink {
  emitCall(toolUseId: string, toolName: string, input: unknown): Promise<boolean>;
  emitResult(toolUseId: string, success: boolean, error: string | undefined, result: unknown): Promise<boolean>;
  log(toolName: string, input: unknown, result: unknown): void;
  warn(message: string, error: unknown): void;
}

/**
 * Forwards tool calls run inside a provider CLI (Claude Code, Codex) to the
 * chat transcript in full: one call event when the tool starts and its
 * complete result or error once it lands, always in that order.
 */
export class ProviderToolTranscript {
  private readonly pendingCalls = new Map<string, Promise<boolean>>();

  constructor(private readonly sink: ProviderToolTranscriptSink) {}

  started(call: ProviderToolCall): void {
    this.pendingCalls.set(call.toolUseId, this.sink.emitCall(call.toolUseId, call.toolName, call.input ?? {}));
  }

  finished(event: ProviderToolResult): void {
    const success = event.isError !== true && event.error === undefined;
    const call = this.pendingCalls.get(event.toolUseId) ?? this.sink.emitCall(event.toolUseId, event.toolName, event.input ?? {});
    this.pendingCalls.delete(event.toolUseId);
    void call.catch(() => false)
      .then(() => this.sink.emitResult(event.toolUseId, success, event.error, event.result))
      .catch(error => this.sink.warn('Failed to report provider tool result:', error));
    this.sink.log(event.toolName, event.input, this.loggedResult(event));
  }

  private loggedResult(event: ProviderToolResult): unknown {
    if (event.result === undefined) return event.error === undefined ? undefined : { error: event.error };
    return event.error === undefined ? event.result : { result: event.result, error: event.error };
  }
}
