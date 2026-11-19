// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

const { browserWindowFromWebContents, windowMapping, browserSession } = vi.hoisted(() => ({ browserWindowFromWebContents: vi.fn((sender: any) => sender?.window ?? null), windowMapping: {} as Record<string, number>, browserSession: {} }));
vi.mock('electron', () => ({
  default: { app: { isPackaged: true } },
  app: { isPackaged: true },
  BrowserWindow: { fromWebContents: browserWindowFromWebContents },
  session: { fromPartition: () => browserSession },
  WebContentsView: class {
    webContents = { loadURL: vi.fn(), on: vi.fn(), isDestroyed: () => false, close: vi.fn() };
    setBounds = vi.fn();
  },
}));
vi.mock('@pkg/window', () => ({ windowMapping }));

import { InternalTabViewManager } from './internalTabViewManager';
import { agentWindowFromSender, isAgentWindowSender, trustedStartupSender } from './agentWindowTrust';

describe('agent window trust for hosted tabs', () => {
  it('resolves a registered tab-host sender to its owning agent window', () => {
    // risk: vault and other trusted agent IPC must work from a hosted renderer
    const manager = InternalTabViewManager.getInstance() as any;
    const owner = { id: 71, isDestroyed: () => false, once: vi.fn(), webContents: { send: vi.fn(), getURL: () => 'app://./agent.html?windowKey=main&startupId=boot-id' }, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
    (owner.webContents as any).window = owner;
    windowMapping['main-agent'] = owner.id;
    manager.activate(owner, `trust-${Date.now()}`, 'main', { x: 0, y: 0, width: 20, height: 20 });
    const sender = manager.tabs.get([...manager.tabs.keys()].at(-1)).view.webContents;
    sender.getURL = () => 'app://./agent.html?tabHost=1&windowKey=main&startupId=boot-id';
    sender.session = {} as any;
    expect(isAgentWindowSender(sender)).toBe(true);
    expect(agentWindowFromSender(sender)).toBe(owner);
    expect(trustedStartupSender(sender, 'main', 'boot-id', 'boot-id')).toBe(true);
  });

  it('rejects an unknown renderer', () => {
    // risk: unregistered renderer cannot impersonate an agent window
    const sender = { id: -999 } as Electron.WebContents;
    expect(isAgentWindowSender(sender)).toBe(false);
    expect(agentWindowFromSender(sender)).toBeNull();
    expect(trustedStartupSender(sender, 'main', 'boot-id', 'boot-id')).toBe(false);
  });

  it('rejects a renderer in the untrusted sulla-browser session', () => {
    // risk: external browser content must never call startup readiness IPC
    const owner = { id: 72, isDestroyed: () => false, webContents: { getURL: () => 'app://./agent.html?windowKey=main&startupId=boot-id' } };
    windowMapping['main-agent'] = owner.id;
    const sender = { window: owner, session: browserSession, getURL: () => 'app://./agent.html?windowKey=main&startupId=boot-id' } as any;
    expect(trustedStartupSender(sender, 'main', 'boot-id', 'boot-id')).toBe(false);
  });
});
