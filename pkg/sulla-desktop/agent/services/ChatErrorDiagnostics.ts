// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ChatErrorScope {
  channelId:        string;
  threadId:         string;
  agentId?:         string;
  state?:           { metadata?: any } | undefined;
  wakeTurnJobId?:   string;
  wakeTurnTaskIdx?: number;
}

/**
 * Builds the trace fields for a chat turn that failed with an unexpected
 * error. Before this, `chat error surfaced` logged only the message, so a
 * one-off TypeError ("Cannot set properties of undefined (setting 'status')")
 * could not be traced to its write site, thread or delegated job.
 */
export class ChatErrorDiagnostics {
  constructor(private readonly maxStackChars = 4096) {}

  describe(err: unknown, scope: ChatErrorScope): Record<string, unknown> {
    const error = err as { name?: unknown; message?: unknown; stack?: unknown } | null | undefined;
    const metadata = scope.state?.metadata ?? {};
    const stack = typeof error?.stack === 'string' ? error.stack : '';
    const fields: Record<string, unknown> = {
      name:      typeof error?.name === 'string' ? error.name : typeof err,
      message:   typeof error?.message === 'string' ? error.message : String(err),
      stack:     this.stackLines(stack),
      channelId: scope.channelId,
      threadId:  scope.threadId,
    };
    const optional: Record<string, unknown> = {
      agentId:        scope.agentId,
      delegatedJobId: metadata.delegatedJobId,
      wakeTurnJobId:  scope.wakeTurnJobId,
      wakeTurnTask:   scope.wakeTurnTaskIdx,
      runLocation:    metadata.agent?.runLocation,
      provider:       metadata.agent?.provider,
      currentNodeId:  metadata.currentNodeId,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined && value !== null && value !== '') fields[key] = value;
    }
    return fields;
  }

  /**
   * The stack as frame lines, capped at `maxStackChars` in total. Lines (not
   * one string) because the trace writer cuts any single string at 2,000
   * characters and keeps up to 50 array items.
   */
  private stackLines(stack: string): string[] {
    const lines: string[] = [];
    let used = 0;
    for (const raw of stack.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (used + line.length > this.maxStackChars || lines.length >= 40) {
        lines.push('…[truncated]');
        break;
      }
      lines.push(line);
      used += line.length;
    }
    return lines;
  }
}
