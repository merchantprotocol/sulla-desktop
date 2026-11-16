// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BrowserWindow, ipcMain } from 'electron';
import { MODEL_CLASSES, MODEL_ROUTING_IPC, type ModelClass, type ModelRoutingState } from '../agent/languagemodels/modelRoutingTypes';
import { modelRouter, recommendedState } from '../agent/languagemodels/modelRouter';
import { getIntegrationService } from '../agent/services/IntegrationService';

/** Enabled agents whose model choice is a class, by class, so the page can say who uses each role. */
async function classUsers(): Promise<Partial<Record<ModelClass, string[]>>> {
  const out: Partial<Record<ModelClass, string[]>> = {};
  try {
    const { AgentDefinitionModel } = await import('../agent/database/models/AgentDefinitionModel');
    for (const agent of await AgentDefinitionModel.list()) {
      const choice = agent.model_choice;
      if (!agent.enabled || choice?.mode !== 'class' || !MODEL_CLASSES.includes(choice.class)) continue;
      (out[choice.class] ??= []).push(agent.name);
    }
  } catch { /* the page still works without the names */ }
  return out;
}

async function state(): Promise<ModelRoutingState> {
  const [editable, providers, catalog, users] = await Promise.all([modelRouter.getEditableState(), modelRouter.providerInfo(), modelRouter.catalogReport(), classUsers()]);
  return { ...editable, providers, recommended: recommendedState(), catalog, classUsers: users };
}

export function initModelRoutingIpc(): void {
  ipcMain.removeHandler(MODEL_ROUTING_IPC.get);
  ipcMain.removeHandler(MODEL_ROUTING_IPC.set);
  ipcMain.removeHandler(MODEL_ROUTING_IPC.reset);
  ipcMain.removeHandler(MODEL_ROUTING_IPC.refresh);
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
  ipcMain.handle(MODEL_ROUTING_IPC.refresh, async() => {
    await modelRouter.refreshCatalog();
    return state();
  });
  const pushStatus = () => void modelRouter.providerInfo().then(providers => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(MODEL_ROUTING_IPC.status, providers);
  });
  modelRouter.onStatusChange(pushStatus);
  getIntegrationService().onValueChange(value => {
    if (value.property === 'connection_status' || value.property === 'model') pushStatus();
  });
}
