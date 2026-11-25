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
  emitCall(toolUseId: string, toolName: string, input: unknown, kind?: 'provider'): Promise<boolean>;
  emitResult(toolUseId: string, success: boolean, error: string | undefined, result: unknown): Promise<boolean>;
  log(toolUseId: string, toolName: string, input: unknown, result: unknown): void;
  warn(message: string, error: unknown): void;
}

export interface ProviderToolTranscriptSinkDependencies {
  readonly runId: string;
  readonly emitCall: (toolUseId: string, toolName: string, input: unknown, kind: 'provider') => Promise<boolean>;
  readonly emitResult: (toolUseId: string, success: boolean, error: string | undefined, result: unknown) => Promise<boolean>;
  readonly log: (toolName: string, input: unknown, result: unknown, toolUseId: string) => void;
  readonly warn: (message: string, error: unknown) => void;
}

/** Namespaces provider-local ids and marks their transcript rows as Detailed-only. */
export class ProviderToolTranscriptSink implements ProviderToolTranscriptSink {
  constructor(private readonly dependencies: ProviderToolTranscriptSinkDependencies) {}

  emitCall(toolUseId: string, toolName: string, input: unknown): Promise<boolean> {
    return this.dependencies.emitCall(this.scopedId(toolUseId), toolName, input, 'provider');
  }

  emitResult(toolUseId: string, success: boolean, error: string | undefined, result: unknown): Promise<boolean> {
    return this.dependencies.emitResult(this.scopedId(toolUseId), success, error, result);
  }

  log(toolUseId: string, toolName: string, input: unknown, result: unknown): void {
    this.dependencies.log(toolName, input, result, this.scopedId(toolUseId));
  }

  warn(message: string, error: unknown): void { this.dependencies.warn(message, error) }

  private scopedId(toolUseId: string): string {
    const safe = (value: string) => value.replace(/[^\w.-]/g, '-');
    return `${ safe(this.dependencies.runId) }-${ safe(toolUseId) }`;
  }
}

/**
 * Forwards tool calls run inside a provider CLI (Claude Code, Codex) to the
 * chat transcript in full: one call event when the tool starts and its
 * complete result or error once it lands, always in that order.
 */
export class ProviderToolTranscript {
  private readonly pendingCalls = new Map<string, { call: ProviderToolCall; emitted: Promise<boolean> }>();

  constructor(private readonly sink: ProviderToolTranscriptSink) {}

  started(call: ProviderToolCall): void {
    this.pendingCalls.set(call.toolUseId, { call, emitted: this.emitCall(call) });
  }

  finished(event: ProviderToolResult): void {
    const success = event.isError !== true && event.error === undefined;
    const pending = this.pendingCalls.get(event.toolUseId);
    const emitted = pending?.emitted ?? this.emitCall(event);
    this.pendingCalls.delete(event.toolUseId);
    void emitted
      .then(() => this.sink.emitResult(event.toolUseId, success, event.error, event.result))
      .catch(error => this.sink.warn('Failed to report provider tool result:', error));
    try { this.sink.log(event.toolUseId, event.toolName, event.input, this.loggedResult(event)) }
    catch (error) { this.sink.warn('Failed to log provider tool result:', error) }
  }

  /** Closes calls whose provider turn ended before a matching result arrived. */
  async interrupted(): Promise<void> {
    const pending = [...this.pendingCalls.values()];
    this.pendingCalls.clear();
    await Promise.all(pending.map(async({ call, emitted }) => {
      await emitted;
      try { await this.sink.emitResult(call.toolUseId, false, 'interrupted', undefined) }
      catch (error) { this.sink.warn('Failed to report interrupted provider tool call:', error) }
      try { this.sink.log(call.toolUseId, call.toolName, call.input, { error: 'interrupted' }) }
      catch (error) { this.sink.warn('Failed to log interrupted provider tool call:', error) }
    }));
  }

  private emitCall(call: ProviderToolCall): Promise<boolean> {
    return Promise.resolve().then(() => this.sink.emitCall(call.toolUseId, call.toolName, call.input ?? {}, 'provider'))
      .catch(error => { this.sink.warn('Failed to report provider tool call:', error); return false });
  }

  private loggedResult(event: ProviderToolResult): unknown {
    if (event.result === undefined) return event.error === undefined ? undefined : { error: event.error };
    return event.error === undefined ? event.result : { result: event.result, error: event.error };
  }
}
