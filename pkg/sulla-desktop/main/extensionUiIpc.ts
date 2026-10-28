// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcMain } from 'electron';
import { extensionUI, ExtensionUISlot } from '../agent/extensions/ExtensionUIRegistry';

/** Read-only renderer API. Rendering contributions in the left rail is the next wiring step. */
export function initExtensionUiIpc(): void {
  ipcMain.handle('extensions-ui:list', (_event, slot?: ExtensionUISlot) => extensionUI.list(slot));
}
