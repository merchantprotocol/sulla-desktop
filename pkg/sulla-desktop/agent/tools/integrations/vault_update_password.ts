// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { requireConfiguredCredentialBroker } from '../../../vault-broker';
import { BaseTool, ToolResponse } from '../base';

export class VaultUpdatePasswordWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!this.executionContext) throw new Error('Vault writes require a verified execution context');
    if (input.password === undefined && input.generate !== true) return { successBoolean: false, responseString: 'Provide password or generate:true.' };
    const result = await requireConfiguredCredentialBroker().updateItem(this.executionContext, {
      itemId: input.item_id, password: input.password, generate: input.generate === true,
      title: input.title, username: input.username, url: input.url, notes: input.notes, folder: input.folder, tags: input.tags,
    });
    return { successBoolean: true, responseString: `Vault item ${ result.itemId } was updated. The secret was not returned.` };
  }
}
