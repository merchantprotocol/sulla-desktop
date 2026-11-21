// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatArtifactTool } from './artifact_common';

export class ArtifactOpenWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const threadId = this.threadId();
    const report = this.bindChatToolActivity();
    const result = await this.service().openFile(threadId, String(input.file_id ?? ''), input.focus !== false);
    const response = this.response(result.created ? 'Opened Files file as artifact' : 'Focused existing file artifact', result.artifact, true);
    if (response.successBoolean) await report('artifact-opened');
    return response;
  }
}
