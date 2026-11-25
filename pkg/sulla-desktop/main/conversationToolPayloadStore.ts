// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { isInsideLogsDir } from './agentConversationLog';

export interface ConversationToolLogIndex {
  getFileAssociations(threadId: string): Promise<{ log_file: string | null }>;
}

/** Resolves one complete tool event from its durable JSONL conversation log. */
export class ConversationToolPayloadStore {
  constructor(private readonly history: ConversationToolLogIndex, private readonly logsDirectory: () => string) {}

  async load(threadId: string, toolRunId: string): Promise<unknown | null> {
    if (!threadId || !toolRunId || toolRunId.length > 500 || /[\r\n]/.test(toolRunId)) return null;
    const { log_file: file } = await this.history.getFileAssociations(threadId);
    if (!file || !isInsideLogsDir(file, this.logsDirectory())) return null;
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event?.type === 'tool_call' && event.toolCallId === toolRunId) return event;
      } catch { /* Ignore malformed records and keep searching later lines. */ }
    }
    return null;
  }
}
