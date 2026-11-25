// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';
import type { ConversationEvent } from './SullaLogger';

export class ToolCallLogWriter {
  constructor(
    private readonly append: (conversationId: string, event: ConversationEvent) => boolean,
    private readonly resolveJsonlPath: (conversationId: string) => string,
    private readonly getFileAssociation: (conversationId: string) => Promise<{ log_file: string | null }>,
    private readonly redactArgs: (toolName: string, args: unknown) => unknown,
  ) {}

  async write(conversationId: string, toolName: string, args: unknown, result?: unknown, toolCallId?: string): Promise<boolean> {
    const written = this.append(conversationId, {
      ts: new Date().toISOString(), type: 'tool_call', toolName,
      args: this.redactArgs(toolName, args),
      ...(result !== undefined ? { result } : {}), ...(toolCallId ? { toolCallId } : {}),
    });
    if (!written) return false;

    const { log_file: file } = await this.getFileAssociation(conversationId);
    return Boolean(file && path.resolve(file) === path.resolve(this.resolveJsonlPath(conversationId)));
  }
}
