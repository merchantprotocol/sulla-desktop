// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { getIpcMainProxy } from './ipcMain';

vi.mock('electron', () => ({ default: { ipcMain: {} } }));

describe('sensitive IPC logging', () => {
  it('redacts credential-bearing arguments before a rejecting handler runs', async() => {
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    const logs: string[] = [];
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler),
    };
    const proxy = getIpcMainProxy({ debug: (message: string) => logs.push(message) } as any, ipcMain as any);
    const marker = 'synthetic-clerk-secret-marker';
    proxy.handleSensitive('integration:connect-form', async(_event, payload) => {
      if (payload.integrationId === 'clerk') throw new Error('Clerk uses its dedicated settings form.');
      return { success: false };
    });

    await expect(handlers.get('integration:connect-form')!({}, {
      integrationId: 'clerk', values: { api_key: marker },
    })).rejects.toThrow('dedicated settings form');
    expect(logs.join('\n')).not.toContain(marker);
    expect(logs.join('\n')).toContain('arguments redacted');
  });
});
