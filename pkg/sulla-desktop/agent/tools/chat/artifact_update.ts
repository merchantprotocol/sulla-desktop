// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatArtifactTool } from './artifact_common';

export class ArtifactUpdateWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifact = await this.service().update(this.threadId(), this.idOrName(input), {
      content: input.content,
      name: input.newName,
      status: input.status,
      language: input.language,
      path: input.path,
      expectedVersion: this.expectedVersion(input),
      author: 'agent',
      focus: input.focus === true,
    });
    return this.response('Updated artifact', artifact, true);
  }
}
