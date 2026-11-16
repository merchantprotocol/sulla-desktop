// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { TurnOutputCounter } from './TurnOutputCounter';

/**
 * Detects whether one delegated graph turn produced real output.
 *
 * Counting assistant messages is not enough: context trimming and summary
 * restoration replace `state.messages`, and CLI-managed loops (Claude Code /
 * Codex, local or container) run tool calls inside the provider without adding
 * a Sulla message. Activity timestamps are not enough either: BaseNode stamps
 * `lastActivityMs` / `lastAgentActivityAt` on every model call, empty
 * streaming sentinel and "Preparing your turn…" heartbeat, so a truly empty
 * turn would look busy. A turn made progress only when a new output message
 * object appeared (assistant with content or tool calls, or a tool result), or
 * when the {@link TurnOutputCounter} advanced (non-blank token, Sulla tool
 * batch, provider-managed tool call or file patch).
 */
export class DelegatedTurnProgressProbe {
  private readonly priorOutputs: Set<unknown>;
  private readonly priorOutputCount: number;

  constructor(private readonly state: any) {
    this.priorOutputs = new Set(this.outputs());
    this.priorOutputCount = this.outputCount();
  }

  madeProgress(): boolean {
    if (this.outputCount() !== this.priorOutputCount) return true;
    return this.outputs().some(message => !this.priorOutputs.has(message));
  }

  private outputs(): unknown[] {
    const messages = Array.isArray(this.state?.messages) ? this.state.messages : [];
    return messages.filter((message: any) => this.isOutput(message));
  }

  private isOutput(message: any): boolean {
    if (message?.role === 'tool') return true;
    if (message?.role === 'user') return this.isToolResult(message);
    // AgentNode's error notice ("LLM returned empty response") is not output.
    if (message?.role !== 'assistant' || message.metadata?.kind === 'agent_error') return false;
    if (message.metadata?.tool_calls?.length || message.tool_calls?.length) return true;
    const content = message.content;
    if (typeof content === 'string') return content.trim().length > 0;
    return Array.isArray(content) && content.length > 0;
  }

  /** ToolExecutor stores tool results as user messages of tool_result blocks. */
  private isToolResult(message: any): boolean {
    if (message.metadata?.kind === 'tool_result') return true;
    return Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'tool_result');
  }

  private outputCount(): number {
    return new TurnOutputCounter(this.state?.metadata).read();
  }
}
