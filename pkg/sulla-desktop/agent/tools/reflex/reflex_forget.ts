// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ReflexModel } from '../../database/models/ReflexModel';
import { BaseTool, ToolResponse } from '../base';

export class ReflexForgetWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = String(input.id ?? '').trim();
    const ok = await ReflexModel.forget(id);
    return { successBoolean: ok, responseString: ok ? `Forgot reflex example ${ id }.` : `No active reflex example with id: ${ id }` };
  }
}
