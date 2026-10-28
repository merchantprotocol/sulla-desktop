// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatArtifactTool } from './artifact_common';

export class ArtifactListWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifacts = await this.service().list(this.threadId(), !!input.includeClosed);
    const body = artifacts.length
      ? artifacts.map(a => `${ a.id } | ${ a.name } | ${ a.kind } | ${ a.status } | v${ a.version } | ${ a.isOpen ? 'open' : 'closed' } | Files: ${ a.filesRegistrationStatus }${ a.filesRegistrationStatus === 'error' ? ` (${ a.filesRegistrationError ?? 'unknown error' })` : '' } | ${ a.updatedAt }`).join('\n')
      : 'No artifacts found for this chat.';
    return { successBoolean: true, responseString: body };
  }
}
