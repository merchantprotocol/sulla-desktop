// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  default: { app: { isPackaged: false } },
  app: { isPackaged: false },
  WebContentsView: class {
    webContents = {
      loadURL: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => { (this as any).listeners[event] = listener; }),
      listeners: {} as Record<string, (...args: any[]) => void>,
      isDestroyed: () => false,
      close: vi.fn(),
      reload: vi.fn(),
    };
    setBounds = vi.fn();
  },
}));

import { InternalTabViewManager } from './internalTabViewManager';

const ownerWindow = (id: number) => ({
  id,
  isDestroyed: () => false,
  once: vi.fn(),
  webContents: { send: vi.fn() },
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
});
const manager = () => new (InternalTabViewManager as any)() as InternalTabViewManager;

describe('InternalTabViewManager', () => {
  it('creates lazily on activation and retains real bounds when hidden', () => {
    // risk: renderer resource use and tab visibility lifecycle
    const owner = ownerWindow(1);
    const instance = manager() as any;
    const bounds = { x: 10, y: 20, width: 600, height: 400 };
    expect(instance.tabs.size).toBe(0);
    instance.activate(owner, 'one', 'main', bounds);
    const tab = instance.tabs.get('one');
    expect(tab.view.webContents.loadURL).toHaveBeenCalledWith('app://./agent.html?tabHost=1&tabId=one&windowKey=main');
    expect(owner.contentView.addChildView).toHaveBeenCalledWith(tab.view);
    instance.setVisible(owner, 'one', false);
    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(tab.view);
    instance.setBounds(owner, 'one', { ...bounds, width: 700 });
    instance.setVisible(owner, 'one', true);
    expect(tab.view.setBounds).toHaveBeenLastCalledWith({ ...bounds, width: 700 });
  });

  it('destroys only the closed tab view', () => {
    // risk: closing a tab must release its isolated Chromium renderer
    const owner = ownerWindow(2);
    const instance = manager() as any;
    instance.activate(owner, 'one', 'main', { x: 0, y: 0, width: 10, height: 10 });
    const view = instance.tabs.get('one').view;
    instance.destroy(owner, 'one');
    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(instance.tabs.has('one')).toBe(false);
  });

  it('moves the existing view between windows without reloading it', () => {
    // risk: unsaved editor text and running tab work must survive tear-off
    const source = ownerWindow(3);
    const target = ownerWindow(4);
    const instance = manager() as any;
    instance.activate(source, 'one', 'main', { x: 1, y: 2, width: 30, height: 40 });
    const tab = instance.tabs.get('one');
    expect(instance.moveToWindow('one', target)).toBe(true);
    expect(source.contentView.removeChildView).toHaveBeenCalledWith(tab.view);
    expect(target.contentView.addChildView).toHaveBeenCalledWith(tab.view);
    expect(tab.view.webContents.loadURL).toHaveBeenCalledOnce();
    expect(tab.owner).toBe(target);
  });

  it('isolates a renderer crash to its tab and exposes reload', () => {
    // risk: one tab crash must not blank or terminate the agent shell
    const owner = ownerWindow(5);
    const instance = manager() as any;
    instance.activate(owner, 'one', 'main', { x: 0, y: 0, width: 20, height: 20 });
    const tab = instance.tabs.get('one');
    tab.view.webContents.listeners['render-process-gone']();
    expect(owner.webContents.send).toHaveBeenCalledWith('internal-tab-view:crashed', 'one');
    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(tab.view);
    instance.reload(owner, 'one');
    expect(tab.view.webContents.reload).toHaveBeenCalledOnce();
  });
});
