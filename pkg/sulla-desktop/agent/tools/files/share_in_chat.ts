// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesTool } from './common';
import { fileChatLink, MobileFileLink } from './chatLink';
import type { ToolResponse } from '../base';
import { CloudOriginResolver, CLOUD_ORIGIN_ENV } from '@pkg/utils/cloudOrigin';
import { DEFAULT_MOBILE_FILE_ORIGIN } from '@pkg/shared/filesReferences';

/** Web origin for private `/f/<id>` links: the configured Cloud origin when overridden (staging, Wrangler preview), else sulladesktop.com. */
function mobileFileOrigin(): string {
  const selection = new CloudOriginResolver(process.env[CLOUD_ORIGIN_ENV], console).selection;
  return selection.overridden ? selection.origin : DEFAULT_MOBILE_FILE_ORIGIN;
}

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
    // Best-effort nudge: ask the local Files sync to push now (202, async). A failure is ignored;
    // the descriptor lookup below decides whether the file is reachable yet.
    // TODO(files-instant-sync): replace the nudge with a confirmed push once the sync hook lands.
    await this.containerRequest('/v1/local/sync', input, { method: 'POST' }).catch(() => undefined);
    // containerJson derives identity exclusively from the trusted execution
    // context. No org/user/owner value from input is forwarded as authority.
    const file = await this.containerJson<any>(`/v1/files/${encodeURIComponent(String(fileId))}`, input);
    const chatLink = fileChatLink(file);
    const mobileUrl = new MobileFileLink(mobileFileOrigin()).url(file);
    if (!chatLink || !mobileUrl) throw new Error('File unavailable');
    return { successBoolean: true, responseString: JSON.stringify({ fileId, path: file.path, name: file.name, chatLink, mobileUrl, instruction: 'Put chatLink on its own line in the assistant message. mobileUrl is the private link for mobile; it needs sign-in.' }) };
  }
}
