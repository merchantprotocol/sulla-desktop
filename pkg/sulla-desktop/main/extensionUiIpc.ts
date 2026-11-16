// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FunctionDefinitionModel, IntegrationDefinitionModel } from '../agent/database/models/MarketplaceArtifactModel';
import { SullaSettingsModel } from '../agent/database/models/SullaSettingsModel';
import { EXTENSION_HOOKS, ExtensionHookName, listExtensionHookAuditEvents, setExtensionHookGrant } from '../agent/extensions/HookRegistry';
import { extensionUI, ExtensionUISlot } from '../agent/extensions/ExtensionUIRegistry';

import type { IpcController, IpcRegistrar } from './ipc/IpcController';

export interface ExtensionUiIpcDependencies {
  readGuard: { run<T>(label: string, read: () => Promise<T>, fallback: T): Promise<T> };
  /** Subscribe to hook audit events (lazy-loaded HookRegistry). */
  onHookAudit(listener: (event: { outcome: string }) => void): Promise<unknown>;
  /** Push to every open window. */
  broadcast(channel: string, payload: unknown): void;
}

/** extensions-ui:* and extension-permissions:* — extension UI slots and hook/integration grants. */
export class ExtensionUiIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly deps: ExtensionUiIpcDependencies) {}

  async listPermissions() {
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

  register(): void {
    // Permission prompts are informational and never park the hook or chat.
    void this.deps.onHookAudit((event) => {
      if (event.outcome === 'permission_denied') this.deps.broadcast('extension-permission-needed', event);
    });
    this.ipc.handle('extensions-ui:list', (_event, slot?: ExtensionUISlot) => extensionUI.list(slot));
    this.ipc.handle('extension-permissions:list', () => this.deps.readGuard.run('extension-permissions:list', () => this.listPermissions(), []));
    this.ipc.handle('extension-permissions:audit', () => listExtensionHookAuditEvents());
    this.ipc.handle('extension-permissions:set-hook', async(_event, input: { extensionId: string; hook: ExtensionHookName; granted: boolean }) => {
      if (!(input.hook in EXTENSION_HOOKS)) throw new Error(`Unknown extension hook: ${ input.hook }`);
      await setExtensionHookGrant(input.extensionId, input.hook, input.granted);
    });
    this.ipc.handle('extension-permissions:revoke-all', async(_event, extensionId?: string) => {
      const grants = await SullaSettingsModel.get('extensionHookGrants', {});
      if (extensionId) delete grants[extensionId];
      else for (const key of Object.keys(grants)) delete grants[key];
      await SullaSettingsModel.set('extensionHookGrants', grants, 'json');
    });
    this.ipc.handle('extension-permissions:set-rail-hidden', async(_event, input: { extensionId: string; hidden: boolean }) => {
      const current = await SullaSettingsModel.get('extensionHiddenRailItems', []);
      const next = input.hidden ? [...new Set([...current, input.extensionId])] : current.filter((id: string) => id !== input.extensionId);
      await SullaSettingsModel.set('extensionHiddenRailItems', next, 'json');
    });
  }
}
