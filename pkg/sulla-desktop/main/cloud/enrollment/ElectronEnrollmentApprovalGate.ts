// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BrowserWindow, dialog } from 'electron';
import type { EnrollmentRequest, HumanApprovalGate } from '@sulla/domain';

/** The owner's tap for a vault enrollment request: a native dialog, Allow / Not now (default Not now). */
export class ElectronEnrollmentApprovalGate implements HumanApprovalGate {
  async approve(request: EnrollmentRequest): Promise<boolean> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      type: 'question' as const, buttons: ['Allow', 'Not now'], defaultId: 1, cancelId: 1, noLink: true, title: 'Sulla Desktop',
      message: 'Allow this computer to use your Sulla vault?',
      detail: `Requester: ${ request.requesterId }\n\nA signed-in ${ request.requesterType.replace('_', ' ') } is asking to use your existing Sulla vault.`,
    };
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return result.response === 0;
  }
}
