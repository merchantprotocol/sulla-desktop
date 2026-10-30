// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { listServices } from '@pkg/main/serviceDirectory';
import { BaseTool, ToolResponse } from '../base';

export class ServicesListWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(): Promise<ToolResponse> { return { successBoolean: true, responseString: JSON.stringify(listServices()) } }
}
