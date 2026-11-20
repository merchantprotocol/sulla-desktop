// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  // window/index.ts registers app.on('before-quit') at module load, so the import chain needs app.
  const app = { on: () => {}, off: () => {}, getPath: () => '/tmp', quit: () => {}, isPackaged: false, dock: undefined };
  return {
    default: { app, BrowserWindow: { fromWebContents: () => null } },
    app,
    BrowserWindow: { fromWebContents: () => null },
    WebContentsView: class {},
  };
});

import { BrowserTabViewManager } from './browserTabViewManager';

const ownerWindow = (id: number) => ({
  id,
  isDestroyed: () => false,
  once: vi.fn(),
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
});

const managerWith = (tabId: string, view: any, owner: any) => {
  const manager = Object.create(BrowserTabViewManager.prototype) as any;
  manager.views = new Map([[tabId, view]]);
  manager.owners = new Map([[tabId, owner]]);
  manager.focusedTabIds = new Map([[owner.id, tabId]]);
  manager.trackedOwnerWindowIds = new Set<number>();
  manager.awaitingOwnerBounds = new Set<string>();
  manager.transferringTabs = new Set<string>();
  manager.latestBounds = new Map([[tabId, { x: 12, y: 24, width: 640, height: 480 }]]);
  manager.appliedPlacement = new WeakMap();
  manager.retryTimers = new Map();
  manager.healthMonitor = null;
  manager.viewHealth = new Map([[tabId, { captureFailures: 0, stuckScrolls: 0, probeInFlight: false, recovering: false, lastRecoveryAt: 0, recoveryStage: null }]]);
  manager.lastActiveAt = new Map();
  manager.reconcileVisibility = vi.fn();
  return manager;
};

describe('BrowserTabViewManager window ownership', () => {
  it('moves the existing WebContents between windows without loading or reloading it', () => {
    // risk: session/history/CDP continuity during tab tear-off
    const source = ownerWindow(1);
    const target = ownerWindow(2);
    const webContents = { id: 91, loadURL: vi.fn(), reload: vi.fn() };
    const view = { webContents, setBounds: vi.fn() };
    const manager = managerWith('tab-a', view, source);

    expect(manager.moveViewToWindow('tab-a', target, { focus: true })).toBe(true);

    expect(source.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(target.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(manager.getWebContents('tab-a')).toBe(webContents);
    expect(manager.getOwnerWindow('tab-a')).toBe(target);
    expect(manager.getFocusedTab(source)).toBeNull();
    expect(manager.getFocusedTab(target)).toBe('tab-a');
    expect(view.setBounds).toHaveBeenCalledWith({ x: -740, y: 24, width: 640, height: 480 });
    expect(webContents.loadURL).not.toHaveBeenCalled();
    expect(webContents.reload).not.toHaveBeenCalled();
  });

  it('detaches browser tabs at shutdown and blocks transfer or visibility reconciliation', () => {
    // risk: native browser pages must not cover the shutdown overlay or reattach during shutdown
    const owner = ownerWindow(20);
    const target = ownerWindow(21);
    const view = { webContents: { id: 95 }, setBounds: vi.fn() };
    const manager = managerWith('tab-shutdown', view, owner);

    manager.beginShutdown();
    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(manager.moveViewToWindow('tab-shutdown', target)).toBe(false);
    delete manager.reconcileVisibility;
    expect((BrowserTabViewManager.prototype as any).reconcileVisibility.call(manager)).toBe(0);
    expect(target.contentView.addChildView).not.toHaveBeenCalled();
  });

  it('ignores stale bounds from the former window without changing the view placement', () => {
    // risk: cross-window tab control; late IPC must never reposition another window's view
    const oldOwner = ownerWindow(31);
    const newOwner = ownerWindow(32);
    const view = { webContents: { id: 93 }, setBounds: vi.fn() };
    const manager = managerWith('transferred-tab', view, newOwner);
    manager.reconcileVisibility = vi.fn();
    const oldBounds = { x: 12, y: 24, width: 640, height: 480 };
    const staleBounds = { x: 90, y: 110, width: 900, height: 700 };

    expect(manager.setBounds('transferred-tab', staleBounds, oldOwner)).toBe(false);
    expect(manager.latestBounds.get('transferred-tab')).toEqual(oldBounds);
    expect(manager.reconcileVisibility).not.toHaveBeenCalled();
    expect(view.setBounds).not.toHaveBeenCalled();
  });

  it('keeps focus independent per owner and refuses another window focusing a tab', () => {
    // risk: cross-window tab control and focus isolation
    const first = ownerWindow(11);
    const second = ownerWindow(12);
    const manager = Object.create(BrowserTabViewManager.prototype) as any;
    manager.views = new Map([['first-tab', {}], ['second-tab', {}]]);
    manager.owners = new Map([['first-tab', first], ['second-tab', second]]);
    manager.focusedTabIds = new Map();
    manager.trackedOwnerWindowIds = new Set<number>();
    manager.awaitingOwnerBounds = new Set<string>();
    manager.transferringTabs = new Set<string>();
    manager.viewHealth = new Map();
    manager.lastActiveAt = new Map();
    manager.newViewHealth = () => ({ captureFailures: 0 });
    manager.reconcileVisibility = vi.fn();

    manager.setFocusedTab('first-tab', undefined, undefined, first);
    manager.setFocusedTab('second-tab', undefined, undefined, second);

    expect(manager.getFocusedTab(first)).toBe('first-tab');
    expect(manager.getFocusedTab(second)).toBe('second-tab');
    expect(() => manager.setFocusedTab('first-tab', undefined, undefined, second)).toThrow('not owned');
  });

  it('destroys views when their owner closes but preserves views marked as transferring', () => {
    // risk: losing a live tab during a cross-window handoff
    const owner = ownerWindow(21);
    const transferringOwner = ownerWindow(22);
    const manager = Object.create(BrowserTabViewManager.prototype) as any;
    manager.owners = new Map([['owned', owner], ['handoff', transferringOwner]]);
    manager.transferringTabs = new Set(['handoff']);
    manager.awaitingOwnerBounds = new Set<string>();
    manager.focusedTabIds = new Map([[owner.id, 'owned'], [transferringOwner.id, 'handoff']]);
    manager.trackedOwnerWindowIds = new Set([owner.id, transferringOwner.id]);
    manager.destroyView = vi.fn();

    manager.destroyWindowViews(owner);
    manager.destroyWindowViews(transferringOwner);

    expect(manager.destroyView).toHaveBeenCalledTimes(1);
    expect(manager.destroyView).toHaveBeenCalledWith('owned');
    expect(manager.destroyView).not.toHaveBeenCalledWith('handoff');
    expect(manager.focusedTabIds.has(owner.id)).toBe(false);
  });
});

describe('hidden mount bounds ordering', () => {
  it('preserves drawable geometry when repeated create arrives with zero layout', () => {
    // risk: hidden renderer initialization overwrites the agent compositor with 0x0
    const owner = ownerWindow(101);
    const view = { webContents: { getURL: () => 'https://example.com' }, setBounds: vi.fn() };
    const manager = managerWith('tab', view, owner);
    manager.reconcileVisibility = vi.fn();
    const original = manager.latestBounds.get('tab');
    manager.createView('tab', 'https://example.com', { x: 0, y: 0, width: 0, height: 900 }, owner);
    expect(manager.latestBounds.get('tab')).toEqual(original);
    expect(view.setBounds).not.toHaveBeenCalled();
    expect(manager.setBounds('tab', { x: 0, y: 0, width: 900, height: 600 }, owner)).toBe(true);
    expect(manager.latestBounds.get('tab').width).toBe(900);
    expect(manager.setBounds('tab', { x: 0, y: 0, width: 0, height: 0 }, owner)).toBe(false);
    expect(manager.latestBounds.get('tab').width).toBe(900);
  });
});
