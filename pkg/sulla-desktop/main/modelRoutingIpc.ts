// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BrowserWindow, ipcMain } from 'electron';
import { MODEL_ROUTING_IPC, type ModelRoutingState } from '../agent/languagemodels/modelRoutingTypes';
import { modelRouter } from '../agent/languagemodels/modelRouter';

async function state(): Promise<ModelRoutingState> {
  return { ...(await modelRouter.getEditableState()), providers: await modelRouter.providerInfo() };
}

export function initModelRoutingIpc(): void {
  ipcMain.removeHandler(MODEL_ROUTING_IPC.get);
  ipcMain.removeHandler(MODEL_ROUTING_IPC.set);
  ipcMain.removeHandler(MODEL_ROUTING_IPC.reset);
  ipcMain.handle(MODEL_ROUTING_IPC.get, state);
  ipcMain.handle(MODEL_ROUTING_IPC.set, async(_event, patch) => {
    await modelRouter.set(patch || {});
    return state();
  });
  ipcMain.handle(MODEL_ROUTING_IPC.reset, async(_event, target) => {
    if (!target || !['agents', 'subconscious', 'classes'].includes(target.section)) throw new Error('Invalid model routing reset target');
    await modelRouter.reset(target);
    return state();
  });
  modelRouter.onStatusChange(() => void modelRouter.providerInfo().then(providers => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(MODEL_ROUTING_IPC.status, providers);
  }));
}
