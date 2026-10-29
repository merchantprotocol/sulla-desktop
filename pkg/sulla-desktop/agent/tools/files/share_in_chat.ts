// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesTool } from './common';
import { fileChatLink } from './chatLink';
import type { ToolResponse } from '../base';

export class FilesShareInChatWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    let fileId = input.file_id;
    if (!fileId && input.path) {
      const absolutePath = String(input.path).startsWith('/mnt/sulla-files/') ? String(input.path) : `/mnt/sulla-files/${String(input.path).replace(/^\/+/, '')}`;
      const resolved = await this.resolvePath({ path: absolutePath });
      if (!resolved?.fileId || resolved.kind !== 'file') throw new Error('File unavailable');
      fileId = resolved.fileId;
    }
    if (!fileId) throw new Error('Supply file_id or path');
    // containerJson derives identity exclusively from the trusted execution
    // context. No org/user/owner value from input is forwarded as authority.
    const file = await this.containerJson<any>(`/v1/files/${encodeURIComponent(String(fileId))}`, input);
    const chatLink = fileChatLink(file);
    if (!chatLink) throw new Error('File unavailable');
    return { successBoolean: true, responseString: JSON.stringify({ fileId, path: file.path, name: file.name, chatLink, instruction: 'Put chatLink on its own line in the assistant message.' }) };
  }
}
