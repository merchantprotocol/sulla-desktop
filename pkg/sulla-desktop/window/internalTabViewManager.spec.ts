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
      on: vi.fn((event: string, listener: (...args: any[]) => void) => { (this as any).webContents.listeners[event] = listener; }),
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
    expect(tab.view.webContents.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^app:\/\/\.\/agent\.html\?tabHost=1&tabId=one&windowKey=main&startupId=/));
    expect(owner.contentView.addChildView).toHaveBeenCalledWith(tab.view);
    instance.setVisible(owner, 'one', false);
    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(tab.view);
    instance.setBounds(owner, 'one', { ...bounds, width: 700 });
    instance.setVisible(owner, 'one', true);
    expect(tab.view.setBounds).toHaveBeenLastCalledWith({ ...bounds, width: 700 });
  });

  it('keeps child views with a background tab and notifies only when its host is disposed', () => {
    // risk: switching tabs must hide a vault child without leaving it on top of the next tab
    const owner = ownerWindow(10);
    const instance = manager() as any;
    instance.activate(owner, 'vault-tab', 'main', { x: 0, y: 0, width: 20, height: 20 });
    const host = instance.tabs.get('vault-tab').view;
    const sender = host.webContents;
    const disposed = vi.fn();
    expect(instance.hostViewForSender(sender)).toBe(host);
    expect(instance.onHostDisposed(sender, disposed)).toEqual(expect.any(Function));
    instance.setVisible(owner, 'vault-tab', false);
    expect(disposed).not.toHaveBeenCalled();
    instance.setVisible(owner, 'vault-tab', true);
    expect(disposed).not.toHaveBeenCalled();
    instance.destroy(owner, 'vault-tab');
    expect(disposed).toHaveBeenCalledOnce();
    expect(instance.hostViewForSender(sender)).toBeNull();
  });

  it('asks the owning shell to refresh its measured bounds after the tab-host page loads', () => {
    // risk: stale initial renderer geometry can leave a visible gap after shell layout settles
    const owner = ownerWindow(11);
    const instance = manager() as any;
    instance.activate(owner, 'one', 'main', { x: 0, y: 56, width: 800, height: 600 });
    const tab = instance.tabs.get('one');

    tab.view.webContents.listeners['did-finish-load']();

    expect(owner.webContents.send).toHaveBeenCalledWith('internal-tab-view:loaded', 'one');
    instance.destroy(owner, 'one');
    owner.webContents.send.mockClear();
    tab.view.webContents.listeners['did-finish-load']();
    expect(owner.webContents.send).not.toHaveBeenCalled();
  });
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

  it('destroys every internal tab host during final application shutdown', () => {
    // risk: lingering tab-host renderers can keep the process alive after quit
    const owner = ownerWindow(9);
    const instance = manager() as any;
    instance.activate(owner, 'one', 'main', { x: 0, y: 0, width: 10, height: 10 });
    instance.activate(owner, 'two', 'main', { x: 0, y: 0, width: 10, height: 10 });
    const views = [...instance.tabs.values()].map((tab: any) => tab.view);
    instance.destroyAll();
    expect(instance.tabs.size).toBe(0);
    for (const view of views) expect(view.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(owner.contentView.removeChildView).toHaveBeenCalledTimes(2);
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

  it('keeps a released view alive until transfer finishes', () => {
    // risk: a close notification from the source renderer must not destroy a tab mid-tear-off
    const owner = ownerWindow(6);
    const instance = manager() as any;
    instance.activate(owner, 'moving', 'main', { x: 0, y: 0, width: 20, height: 20 });
    const tab = instance.tabs.get('moving');
    instance.markTransferring('moving', true);
    instance.destroy(owner, 'moving');
    expect(tab.view.webContents.close).not.toHaveBeenCalled();
    expect(instance.tabs.has('moving')).toBe(true);
    instance.markTransferring('moving', false);
    instance.destroy(owner, 'moving');
    expect(tab.view.webContents.close).toHaveBeenCalledOnce();
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
    instance.activate(owner, 'one', 'main', { x: 0, y: 0, width: 20, height: 20 });
    expect(owner.contentView.addChildView).toHaveBeenCalledOnce();
    instance.reload(owner, 'one');
    expect(owner.contentView.addChildView).toHaveBeenCalledTimes(2);
    expect(tab.view.webContents.reload).toHaveBeenCalledOnce();
  });

  it('hands a tab its descriptor only through its own renderer', () => {
    // risk: a new tab host boots before the tab list is saved and must still learn its tab
    const owner = ownerWindow(6);
    const instance = manager() as any;
    const bounds = { x: 0, y: 0, width: 20, height: 20 };
    instance.activate(owner, 'one', 'main', bounds, { id: 'one', mode: 'chat' });
    instance.activate(owner, 'two', 'main', bounds, { id: 'two', mode: 'files' });
    const one = instance.tabs.get('one').view.webContents;
    expect(instance.descriptorFor(one, 'one')).toEqual({ id: 'one', mode: 'chat' });
    expect(instance.descriptorFor(one, 'two')).toBeNull();
    expect(instance.descriptorFor(owner.webContents, 'one')).toBeNull();
    instance.notifyTabUpdate(one, 'one', { id: 'one', mode: 'paper' });
    expect(instance.descriptorFor(one, 'one')).toEqual({ id: 'one', mode: 'paper' });
  });
});
