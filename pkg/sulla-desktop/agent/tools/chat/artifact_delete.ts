// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatArtifactTool } from './artifact_common';

export class ArtifactDeleteWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    if (input.confirm !== true) {
      return { successBoolean: false, responseString: 'artifact_delete requires confirm: true. The artifact is soft-deleted so its revision history remains in the database.' };
    }
    const artifact = await this.service().delete(this.threadId(), this.idOrName(input), this.expectedVersion(input), 'agent');
    return this.response('Soft-deleted artifact', artifact);
  }
}
