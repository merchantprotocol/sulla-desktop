// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { closeTeleprompterWindow, isTeleprompterOpen } from '@pkg/main/teleprompterWindow';

import { BaseTool, ToolResponse } from '../base';

export class TeleprompterCloseWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    if (!isTeleprompterOpen()) {
      return { successBoolean: true, responseString: 'Teleprompter was already closed.' };
    }
    closeTeleprompterWindow();
    return { successBoolean: true, responseString: 'Teleprompter window closed.' };
  }
}
