// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { requireConfiguredCredentialBroker } from '../../../vault-broker';
import { BaseTool, ToolResponse } from '../base';

export class VaultGeneratePasswordWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!this.executionContext) throw new Error('Vault writes require a verified execution context');
    const result = await requireConfiguredCredentialBroker().createItem(this.executionContext, {
      title: input.title, username: input.username, generate: true, url: input.url,
      notes: input.notes, folder: input.folder, tags: input.tags,
    });
    return { successBoolean: true, responseString: `A strong password was generated and stored as vault item ${ result.itemId }. The secret never left the vault.` };
  }
}
