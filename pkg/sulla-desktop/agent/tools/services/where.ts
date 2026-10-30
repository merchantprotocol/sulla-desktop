// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { serviceOrigin, servicePort } from '@pkg/main/serviceDirectory';
import { BaseTool, ToolResponse } from '../base';

export class ServicesWhereWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(input: { service: string; protocol?: string }): Promise<ToolResponse> {
    try { const port = servicePort(input.service); return { successBoolean: true, responseString: JSON.stringify({ service: input.service, port, origin: serviceOrigin(input.service, input.protocol) }) } }
    catch (error) { return { successBoolean: false, responseString: (error as Error).message } }
  }
}
