// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export interface ToolPayloadReference { threadId: string; toolRunId: string }

export class ToolPayloadRepository {
  constructor(private readonly ipc: Pick<typeof ipcRenderer, 'invoke'> = ipcRenderer) {}

  async load(reference: ToolPayloadReference): Promise<unknown> {
    const response = await this.ipc.invoke('chat-messages:tool-payload', reference);
    if (!response?.success || response.data === undefined || response.data === null) {
      throw new Error(response?.error || 'The full tool result is not available in the conversation log.');
    }
    return response.data;
  }
}
