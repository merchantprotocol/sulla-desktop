// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BrowserWindow, ipcMain } from 'electron';
import { FunctionDefinitionModel, IntegrationDefinitionModel } from '../agent/database/models/MarketplaceArtifactModel';
import { EXTENSION_HOOKS, ExtensionHookName, listExtensionHookAuditEvents, setExtensionHookGrant } from '../agent/extensions/HookRegistry';
import { extensionUI, ExtensionUISlot } from '../agent/extensions/ExtensionUIRegistry';
import { SullaSettingsModel } from '../agent/database/models/SullaSettingsModel';

async function listPermissions() {
  const [functions, integrations, grants, integrationGrants, hiddenRailItems] = await Promise.all([
    FunctionDefinitionModel.list(),
    IntegrationDefinitionModel.list(),
    SullaSettingsModel.get('extensionHookGrants', {}),
    SullaSettingsModel.get('integrationPackageGrants', {}),
    SullaSettingsModel.get('extensionHiddenRailItems', []),
  ]);
  const hookExtensions = functions.map(fn => {
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
  const integrationExtensions = integrations.map(item => {
    const version = item.version || item.manifest?.version || '0.0.0';
    const permissions = Array.isArray(item.manifest?.permissions) ? item.manifest.permissions : [];
    const key = `${ item.manifest?.id || item.slug }@${ version }`;
    return { extensionId: `integration:${ item.slug }`, slug:item.slug, name:item.name, description:item.description, publisher:item.marketplace_author || (item.source_kind === 'user' ? 'You' : 'Unknown publisher'), version, hooks:[], grants:{}, ui:[], hiddenFromRail:false, integration:{ id:item.manifest?.id || item.slug, version, permissions, granted:integrationGrants?.[key]?.granted === true } };
  }).filter(item => item.integration.permissions.length);
  return [...hookExtensions, ...integrationExtensions];
}

export function initExtensionUiIpc(): void {
  // Permission prompts are informational and never park the hook or chat.
  void import('../agent/extensions/HookRegistry').then(({ onExtensionHookAudit }) => onExtensionHookAudit(event => {
    if (event.outcome === 'permission_denied') for (const win of BrowserWindow.getAllWindows()) win.webContents.send('extension-permission-needed', event);
  }));
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
