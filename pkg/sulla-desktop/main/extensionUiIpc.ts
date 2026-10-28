// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcMain } from 'electron';
import { FunctionDefinitionModel } from '../agent/database/models/MarketplaceArtifactModel';
import { EXTENSION_HOOKS, ExtensionHookName, listExtensionHookAuditEvents, setExtensionHookGrant } from '../agent/extensions/HookRegistry';
import { extensionUI, ExtensionUISlot } from '../agent/extensions/ExtensionUIRegistry';
import { SullaSettingsModel } from '../agent/database/models/SullaSettingsModel';

async function listPermissions() {
  const [functions, grants, hiddenRailItems] = await Promise.all([
    FunctionDefinitionModel.list(),
    SullaSettingsModel.get('extensionHookGrants', {}),
    SullaSettingsModel.get('extensionHiddenRailItems', []),
  ]);
  return functions.map(fn => {
    const hooks = Array.isArray(fn.manifest?.hooks) ? fn.manifest.hooks.map((item: any) => typeof item === 'string' ? item : item?.name)
      .filter((name: string) => name in EXTENSION_HOOKS) : [];
    const extensionId = `function:${ fn.slug }`;
    return {
      extensionId, slug: fn.slug, name: fn.name, description: fn.description,
      publisher: fn.marketplace_author || (fn.source_kind === 'user' ? 'You' : 'Unknown publisher'),
      version: fn.version, hooks, grants: grants?.[extensionId] || {},
      ui: extensionUI.list().filter(item => item.extensionId === extensionId),
      hiddenFromRail: hiddenRailItems.includes(extensionId),
    };
  }).filter(item => item.hooks.length || item.ui.length);
}

export function initExtensionUiIpc(): void {
  ipcMain.handle('extensions-ui:list', (_event, slot?: ExtensionUISlot) => extensionUI.list(slot));
  ipcMain.handle('extension-permissions:list', listPermissions);
  ipcMain.handle('extension-permissions:audit', () => listExtensionHookAuditEvents());
  ipcMain.handle('extension-permissions:set-hook', async(_event, input: { extensionId: string; hook: ExtensionHookName; granted: boolean }) => {
    if (!(input.hook in EXTENSION_HOOKS)) throw new Error(`Unknown extension hook: ${ input.hook }`);
    await setExtensionHookGrant(input.extensionId, input.hook, input.granted);
  });
  ipcMain.handle('extension-permissions:revoke-all', async(_event, extensionId?: string) => {
    const grants = await SullaSettingsModel.get('extensionHookGrants', {});
    if (extensionId) delete grants[extensionId];
    else for (const key of Object.keys(grants)) delete grants[key];
    await SullaSettingsModel.set('extensionHookGrants', grants, 'json');
  });
  ipcMain.handle('extension-permissions:set-rail-hidden', async(_event, input: { extensionId: string; hidden: boolean }) => {
    const current = await SullaSettingsModel.get('extensionHiddenRailItems', []);
    const next = input.hidden ? [...new Set([...current, input.extensionId])] : current.filter(id => id !== input.extensionId);
    await SullaSettingsModel.set('extensionHiddenRailItems', next, 'json');
  });
}
