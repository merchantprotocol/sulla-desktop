// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatArtifactTool } from './artifact_common';

export class ArtifactReopenWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifact = await this.service().reopen(this.threadId(), this.idOrName(input), this.expectedVersion(input), 'agent');
    return this.response('Reopened artifact', artifact);
  }
}
