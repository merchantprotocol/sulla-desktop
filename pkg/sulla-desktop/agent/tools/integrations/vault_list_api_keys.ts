// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { requireConfiguredCredentialBroker } from '../../../vault-broker';
import { BaseTool, type ToolResponse } from '../base';

export class VaultListApiKeysWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(): Promise<ToolResponse> {
    if (!this.executionContext) throw new Error('Vault item tools require a verified execution context');
    const result = await requireConfiguredCredentialBroker().listItems(this.executionContext);
    return { successBoolean: true, responseString: JSON.stringify(result) };
  }
}
