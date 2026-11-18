// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { WindowLookup } from './MainProcessIpcContext';
import { isAgentWindowSender } from '@pkg/window/agentWindowTrust';

/** Minimal shape of an Electron invoke event the trust checks read. */
export interface IpcCallerEvent {
  sender: unknown;
  senderFrame?: unknown;
}

/** Input validation and caller trust checks shared by the vault and accounts IPC handlers. */
export class VaultIpcInputPolicy {
  constructor(private readonly window: WindowLookup) {}

  /** Legacy renderer secret channels are closed: secrets only cross in the isolated vault window. */
  denyLegacyVaultIpc(): never {
    throw new Error('unsupported_secret_egress: use the isolated vault window');
  }

  metadataId(value: unknown, name: 'integrationId' | 'accountId'): string {
    const pattern = name === 'integrationId'
      ? /^[a-z0-9][a-z0-9._:-]{0,127}$/i
      : /^[a-z0-9][a-z0-9._:@+-]{0,191}$/i;
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new Error(`Invalid ${ name }`);
    }
    return value;
  }

  requireTrustedVaultRenderer(event: IpcCallerEvent): void {
    const mainWindow = this.window.getWindow('main-agent');
    const sender = event.sender as Electron.WebContents | undefined;
    const trusted = !!sender && (isAgentWindowSender(sender) || sender === mainWindow?.webContents);
    if (!trusted || event.senderFrame !== sender?.mainFrame) {
      throw new Error('Untrusted vault metadata caller');
    }
  }

  requireTrustedAccountsRenderer(event: IpcCallerEvent): void {
    const mainWindow = this.window.getWindow('main-agent');
    const sender = event.sender as Electron.WebContents | undefined;
    const trusted = !!sender && (isAgentWindowSender(sender) || sender === mainWindow?.webContents);
    if (!trusted || event.senderFrame !== sender?.mainFrame) {
      throw new Error('Untrusted Accounts caller');
    }
  }

  /** Public form layout for the vault's guided "Connect" screen (labels, hints, setup notes; no values). */
  sanitizeConnectSpec(raw: unknown) {
    if (!raw || typeof raw !== 'object') return undefined;
    const spec = raw as Record<string, any>;
    const str = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
    const fields = (Array.isArray(spec.fields) ? spec.fields : []).slice(0, 20)
      .filter((field: any) => typeof field?.key === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(field.key))
      .map((field: any) => ({
        key:         field.key,
        title:       str(field.title, 120),
        hint:        str(field.hint, 400),
        type:        ['password', 'url'].includes(field.type) ? field.type : 'text',
        required:    field.required === true,
        placeholder: str(field.placeholder, 200),
      }));
    const guide = spec.guide && typeof spec.guide === 'object' ? spec.guide : {};

    return {
      name:        str(spec.name, 120),
      description: str(spec.description, 400),
      formGuide:   str(spec.formGuide, 2000),
      fields,
      guide:       {
        title:       str(guide.title, 200),
        description: str(guide.description, 1000),
        steps:       (Array.isArray(guide.steps) ? guide.steps : []).slice(0, 20).map((step: any) => ({ title: str(step?.title, 200), content: str(step?.content, 2000) })),
        notes:       (Array.isArray(guide.notes) ? guide.notes : []).slice(0, 20).map((note: unknown) => str(note, 1000)),
      },
    };
  }
}
