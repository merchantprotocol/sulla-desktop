// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcMain } from 'electron';

import { modelDefaultsState, resetModelDefaults, setModelDefaults } from '../agent/languagemodels/modelDefaults';
import { MODEL_DEFAULTS_IPC } from '../agent/languagemodels/modelDefaultsTypes';

/** Preferences → AI models → Defaults. What each default resolves to is computed in the renderer from the routing state. */
export function initModelDefaultsIpc(): void {
  for (const channel of Object.values(MODEL_DEFAULTS_IPC)) ipcMain.removeHandler(channel);
  ipcMain.handle(MODEL_DEFAULTS_IPC.get, () => modelDefaultsState());
  ipcMain.handle(MODEL_DEFAULTS_IPC.set, async(_event, patch) => {
    await setModelDefaults(patch && typeof patch === 'object' ? patch : {});
    return modelDefaultsState();
  });
  ipcMain.handle(MODEL_DEFAULTS_IPC.reset, async() => {
    await resetModelDefaults();
    return modelDefaultsState();
  });
}
