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
    expect(owner.contentView.addChildView).not.toHaveBeenCalled();
    instance.markChromeReady(owner);
    expect(owner.contentView.addChildView).toHaveBeenCalledWith(tab.view);
    instance.setVisible(owner, 'one', false);
    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(tab.view);
    instance.setBounds(owner, 'one', { ...bounds, width: 700 });
    instance.setVisible(owner, 'one', true);
    expect(tab.view.setBounds).toHaveBeenLastCalledWith({ ...bounds, width: 700 });
  });

  it('keeps activated views detached until chrome readiness and attaches them together on signal', () => {
    // risk: startup tab content must not cover the rail and tab strip before the shell paints
    const owner = ownerWindow(101);
    const instance = manager() as any;
    instance.activate(owner, 'one', 'main', { x: 0, y: 0, width: 20, height: 20 });
    instance.activate(owner, 'two', 'main', { x: 20, y: 0, width: 20, height: 20 });
    expect(owner.contentView.addChildView).not.toHaveBeenCalled();
    instance.markChromeReady(owner);
    expect(owner.contentView.addChildView.mock.calls.map(([view]: any[]) => view)).toEqual([
      instance.tabs.get('one').view, instance.tabs.get('two').view,
    ]);
  });

  it('does not reattach hidden, reloaded, or transferred views before their destination shell is ready', () => {
    // risk: restored, lazy-opened, or torn-off tab content must not bypass the startup cover
    const source = ownerWindow(103);
    const target = ownerWindow(104);
    const instance = manager() as any;
    instance.activate(source, 'one', 'main', { x: 0, y: 0, width: 20, height: 20 });
    const tab = instance.tabs.get('one');
    instance.setVisible(source, 'one', false);
    instance.setVisible(source, 'one', true);
    instance.reload(source, 'one');
    expect(instance.moveToWindow('one', target)).toBe(true);
    expect(source.contentView.addChildView).not.toHaveBeenCalled();
    expect(target.contentView.addChildView).not.toHaveBeenCalled();
    expect(tab.view.webContents.reload).toHaveBeenCalledOnce();
    instance.markChromeReady(target);
    expect(target.contentView.addChildView).toHaveBeenCalledOnce();
    expect(target.contentView.addChildView).toHaveBeenCalledWith(tab.view);
  });

  it('reveals tabs after the readiness safety timeout and logs the fallback', () => {
    // risk: a missed renderer readiness signal must not leave the window unusable
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const owner = ownerWindow(102);
    const instance = manager() as any;
    instance.activate(owner, 'one', 'main', { x: 0, y: 0, width: 20, height: 20 });
    expect(owner.contentView.addChildView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(owner.contentView.addChildView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(owner.contentView.addChildView).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('startup readiness timed out after 5 minutes'));
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('keeps child views with a background tab and notifies only when its host is disposed', () => {
    // risk: switching tabs must hide a vault child without leaving it on top of the next tab
    const owner = ownerWindow(10);
    const instance = manager() as any;
    instance.activate(owner, 'vault-tab', 'main', { x: 0, y: 0, width: 20, height: 20 });
    instance.markChromeReady(owner);
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
    instance.markChromeReady(owner);
    const tab = instance.tabs.get('one');

    tab.view.webContents.listeners['did-finish-load']();

    expect(owner.webContents.send).toHaveBeenCalledWith('internal-tab-view:loaded', 'one');
    instance.destroy(owner, 'one');
    owner.webContents.send.mockClear();
    tab.view.webContents.listeners['did-finish-load']();
    expect(owner.webContents.send).not.toHaveBeenCalled();
  });

  it('destroys only the closed tab view', () => {
    // risk: closing a tab must release its isolated Chromium renderer
    const owner = ownerWindow(2);
    const instance = manager() as any;
    instance.activate(owner, 'one', 'main', { x: 0, y: 0, width: 10, height: 10 });
    instance.markChromeReady(owner);
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
    instance.markChromeReady(source);
    instance.markChromeReady(target);
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
    instance.markChromeReady(owner);
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

  it('opens verified reports and agent Try chats in the owning shell', () => {
    const owner = ownerWindow(12);
    const other = ownerWindow(13);
    const instance = manager() as any;
    const bounds = { x: 0, y: 0, width: 20, height: 20 };
    instance.activate(owner, 'chat', 'main', bounds);
    instance.activate(other, 'studio', 'other', bounds);
    const chat = instance.tabs.get('chat').view.webContents;
    const studio = instance.tabs.get('studio').view.webContents;
    const report = { mode: 'paper', documentFile: { fileId: 'audit', path: 'Projects/audit.md', collectionId: 'files' } };
    const review = { mode: 'chat', title: 'Reviewer · Chat', initialAgentId: 'reviewer' };
    instance.openWorkspaceTab(chat, report);
    instance.openWorkspaceTab(studio, review);
    expect(owner.webContents.send).toHaveBeenCalledExactlyOnceWith('internal-tab-view:open-workspace-tab', report);
    expect(other.webContents.send).toHaveBeenCalledExactlyOnceWith('internal-tab-view:open-workspace-tab', review);
    expect(() => instance.openWorkspaceTab(owner.webContents, report)).toThrow('Invalid workspace tab request');
    expect(() => instance.openWorkspaceTab(chat, { mode: 'browser', url: 'file:///private/report.md' })).toThrow('Invalid workspace tab request');
  });

  it('keeps hosted chat activity with its current owner and clears it on renderer loss', () => {
    const owner = ownerWindow(14);
    const other = ownerWindow(15);
    const instance = manager() as any;
    instance.activate(owner, 'chat', 'main', { x: 0, y: 0, width: 20, height: 20 });
    const chat = instance.tabs.get('chat').view.webContents;
    instance.notifyChatRunning(owner.webContents, 'chat', true);
    expect(owner.webContents.send).not.toHaveBeenCalled();
    instance.notifyChatRunning(chat, 'chat', true);
    instance.notifyChatRunning(chat, 'chat', true);
    expect(owner.webContents.send).toHaveBeenCalledExactlyOnceWith('internal-tab-view:chat-running', 'chat', true);
    instance.moveToWindow('chat', other);
    expect(owner.webContents.send).toHaveBeenLastCalledWith('internal-tab-view:chat-running', 'chat', false);
    expect(other.webContents.send).toHaveBeenLastCalledWith('internal-tab-view:chat-running', 'chat', true);
    chat.listeners['render-process-gone']();
    expect(other.webContents.send).toHaveBeenCalledWith('internal-tab-view:chat-running', 'chat', false);
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
