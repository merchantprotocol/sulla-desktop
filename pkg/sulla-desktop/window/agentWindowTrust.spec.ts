// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

const { browserWindowFromWebContents } = vi.hoisted(() => ({ browserWindowFromWebContents: vi.fn(() => null) }));
vi.mock('electron', () => ({
  default: { app: { isPackaged: true } },
  app: { isPackaged: true },
  BrowserWindow: { fromWebContents: browserWindowFromWebContents },
  WebContentsView: class {
    webContents = { loadURL: vi.fn(), on: vi.fn(), isDestroyed: () => false, close: vi.fn() };
    setBounds = vi.fn();
  },
}));
vi.mock('@pkg/window', () => ({ windowMapping: {} }));

import { InternalTabViewManager } from './internalTabViewManager';
import { agentWindowFromSender, isAgentWindowSender } from './agentWindowTrust';

describe('agent window trust for hosted tabs', () => {
  it('resolves a registered tab-host sender to its owning agent window', () => {
    // risk: vault and other trusted agent IPC must work from a hosted renderer
    const manager = InternalTabViewManager.getInstance() as any;
    const owner = { id: 71, isDestroyed: () => false, once: vi.fn(), webContents: { send: vi.fn() }, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
    manager.activate(owner, `trust-${Date.now()}`, 'main', { x: 0, y: 0, width: 20, height: 20 });
    const sender = manager.tabs.get([...manager.tabs.keys()].at(-1)).view.webContents;
    expect(isAgentWindowSender(sender)).toBe(true);
    expect(agentWindowFromSender(sender)).toBe(owner);
  });

  it('rejects an unknown renderer', () => {
    // risk: unregistered renderer cannot impersonate an agent window
    const sender = { id: -999 } as Electron.WebContents;
    expect(isAgentWindowSender(sender)).toBe(false);
    expect(agentWindowFromSender(sender)).toBeNull();
  });
});
