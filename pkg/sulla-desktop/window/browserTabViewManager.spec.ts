// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';

import fc from 'fast-check';
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

import { AgentScreenshotCapture } from '../main/browserTabs/AgentScreenshotCapture';
import { AgentViewportPolicy } from '../main/browserTabs/AgentViewportPolicy';
import { HiddenTabLayout } from '../main/chromeApi/HiddenTabLayout';
import { BrowserTabViewManager } from './browserTabViewManager';

const ownerWindow = (id: number) => ({
  id,
  isDestroyed: () => false,
  once: vi.fn(),
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
});

const managerWith = (tabId: string, view: any, owner: any) => {
  const manager = Object.create(BrowserTabViewManager.prototype) as any;
  manager.agentViewports = new AgentViewportPolicy();
  manager.sleepingTabs = new Set();
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

    manager.agentViewports.set(webContents, { width: 1280, height: 800 });
    expect(manager.moveViewToWindow('tab-a', target, { focus: true })).toBe(true);

    expect(source.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(target.contentView.addChildView).toHaveBeenCalledWith(view, 0);
    expect(manager.getWebContents('tab-a')).toBe(webContents);
    expect(manager.getOwnerWindow('tab-a')).toBe(target);
    expect(manager.getFocusedTab(source)).toBeNull();
    expect(manager.getFocusedTab(target)).toBe('tab-a');
    expect(view.setBounds).toHaveBeenCalledWith({ x: -1380, y: 0, width: 1280, height: 800 });
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

describe('agent viewport lifecycle', () => {
  it('never intersects the window, or leaks an override to a different tab', () => {
    const policy = new AgentViewportPolicy();
    const first = {} as Electron.WebContents, other = {} as Electron.WebContents;
    const original = policy.resolve(other);
    fc.assert(fc.property(fc.integer({ min: 320, max: 3840 }), fc.integer({ min: 320, max: 2160 }), (width, height) => {
      policy.set(first, { width, height });
      const rect = policy.parked(first);
      expect(rect.x + rect.width).toBeLessThan(0);
      expect([rect.width, rect.height]).toEqual([width, height]);
      expect(policy.resolve(other)).toEqual(original);
    }));
    const valid = policy.resolve(first);
    for (const bad of [{ width: 12.5, height: 900 }, { width: 800, height: Infinity }, { width: 99999, height: 844 }]) {
      expect(() => policy.set(first, bad)).toThrow();
    }
    expect(policy.resolve(first)).toEqual(valid);
  });

  it('restores the latest human pane on focus, even after changing the agent viewport', () => {
    const owner = ownerWindow(10);
    const view = { setBounds: vi.fn(), setVisible: vi.fn(), webContents: { setBackgroundThrottling: vi.fn() } };
    const manager = managerWith('tab', view, owner);
    delete manager.reconcileVisibility;
    const pane = { x: 37, y: 19, width: 157, height: 3982 };
    manager.setBounds('tab', pane, owner);
    manager.setAgentViewport('tab', { width: 390, height: 844 });
    expect(view.setBounds).toHaveBeenLastCalledWith(pane);
    manager.setFocusedTab(null, undefined, undefined, owner);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: -490, y: 0, width: 390, height: 844 });
    const newPane = { ...pane, width: 682 };
    manager.setBounds('tab', newPane, owner);
    manager.setFocusedTab('tab', undefined, undefined, owner);
    expect(view.setBounds).toHaveBeenLastCalledWith(newPane);
  });

  it('parks the hidden surface before attaching it and releases it from that same owner on close', () => {
    const layout = new HiddenTabLayout(new AgentViewportPolicy());
    const window = ownerWindow(1);
    const view = { webContents: {}, setBounds: vi.fn() };
    layout.prepare(view as any, window as any, { width: 1280, height: 800 });
    expect(view.setBounds).toHaveBeenCalledWith({ x: -1380, y: 0, width: 1280, height: 800 });
    expect(view.setBounds.mock.invocationCallOrder[0]).toBeLessThan(window.contentView.addChildView.mock.invocationCallOrder[0]);
    expect(layout.owner(view as any)).toBe(window);
    expect(window.contentView.removeChildView).not.toHaveBeenCalled();
    layout.detach(view as any);
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(layout.owner(view as any)).toBeNull();
  });
});

class CdpEdge extends EventEmitter {
  attached = false;
  emulated: { width: number; height: number; mobile: boolean; deviceScaleFactor: number } | null = null;
  contentHeight = 1;
  captureFrame = vi.fn(async() => ({ data: 'encoded' }));
  isAttached = () => this.attached;
  attach = () => { this.attached = true };
  detach = vi.fn(() => { this.attached = false; this.emit('detach') });
  sendCommand = vi.fn(async(name: string, params?: any) => {
    switch (name) {
    case 'Emulation.setDeviceMetricsOverride': this.emulated = params; return {};
    case 'Emulation.clearDeviceMetricsOverride': this.emulated = null; return {};
    case 'Page.getLayoutMetrics': return {
      cssContentSize: { width: 1, height: this.contentHeight },
      cssLayoutViewport: { clientWidth: this.emulated!.mobile ? 980 : this.emulated!.width },
      cssVisualViewport: { pageX: 0, pageY: 123, scale: 1 },
    };
    case 'Page.captureScreenshot': return this.captureFrame();
    default: throw new Error('Unexpected command');
    }
  });
  contents = { debugger: this, isDestroyed: () => false } as unknown as Electron.WebContents;
}

describe('agent capture transaction', () => {
  it('clips the visible viewport at its current scroll position rather than a one-pixel document extent', async() => {
    const policy = new AgentViewportPolicy(), cdp = new CdpEdge();
    const service = new AgentScreenshotCapture(policy);
    policy.set(cdp.contents, { width: 1280, height: 800 });
    const result = await service.capture(cdp.contents, () => 2, { viewport: { width: 390, height: 844 } });
    expect(cdp.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
      clip: { x: 0, y: 123, width: 390, height: 844, scale: 1 }, fromSurface: true,
    }));
    expect(cdp.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
    });
    expect(result.metadata).toMatchObject({ displayDpr: 2, devicePixelRatio: 1, capped: false, viewport: { width: 390, height: 844 } });
    expect(cdp.emulated).toBeNull();
    expect(policy.resolve(cdp.contents)).toEqual({ width: 1280, height: 800 });
  });

  it('captures normal scroll height and bounds decoded pixels at high DPR', async() => {
    const service = new AgentScreenshotCapture(new AgentViewportPolicy()), cdp = new CdpEdge();
    for (const height of [4900, 10 ** 8]) {
      cdp.contentHeight = height;
      const { metadata } = await service.capture(cdp.contents, () => 1, { fullPage: true, scale: 2 });
      expect(metadata.cssHeight * metadata.viewport.width * 4).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(metadata.capped).toBe(height > metadata.cssHeight);
      if (height === 4900) expect(metadata.cssHeight).toBe(height);
      expect(cdp.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
        clip: { x: 0, y: 0, width: 1440, height: metadata.cssHeight, scale: 1 },
      }));
    }
  });

  it.each([false, true])('clears overrides and overlays on failure, preserving debugger ownership (already attached: %s)', async(attached) => {
    const cdp = new CdpEdge(), service = new AgentScreenshotCapture(new AgentViewportPolicy());
    cdp.attached = attached;
    cdp.captureFrame.mockRejectedValueOnce(new Error('compositor failure'));
    const overlays = { prepare: vi.fn(async() => {}), remove: vi.fn(async() => {}) };
    await expect(service.capture(cdp.contents, () => 2, {}, overlays)).rejects.toThrow('compositor failure');
    expect(overlays.remove).toHaveBeenCalledOnce();
    expect(cdp.emulated).toBeNull();
    expect(cdp.detach).toHaveBeenCalledTimes(attached ? 0 : 1);
    expect(cdp.isAttached()).toBe(attached);
  });

  it('restores a borrowed debugger after a compositor timeout without running late capture steps', async() => {
    vi.useFakeTimers();
    const cdp = new CdpEdge(), service = new AgentScreenshotCapture(new AgentViewportPolicy());
    cdp.attached = true;
    let resume!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve });
    cdp.captureFrame.mockImplementationOnce(async() => { await pending; return { data: 'late' } });
    try {
      const failed = expect(service.capture(cdp.contents, () => 1)).rejects.toThrow('Timed out');
      await vi.advanceTimersByTimeAsync(10_001);
      await failed;
      expect(cdp.emulated).toBeNull();
      expect(cdp.detach).not.toHaveBeenCalled();
      resume();
      await service.capture(cdp.contents, () => 1, { viewport: { width: 390, height: 844 } });
      expect(cdp.emulated).toBeNull();
    } finally {
      resume();
      vi.useRealTimers();
    }
  });

  it('does not detach a replacement debugger session when the original one disconnects', async() => {
    const cdp = new CdpEdge(), service = new AgentScreenshotCapture(new AgentViewportPolicy());
    cdp.captureFrame.mockImplementationOnce(async() => {
      cdp.emit('detach');
      cdp.attached = true; // another debugger has already attached
      throw new Error('session replaced');
    });
    await expect(service.capture(cdp.contents, () => 1)).rejects.toThrow('session replaced');
    expect(cdp.detach).not.toHaveBeenCalled();
    expect(cdp.sendCommand).not.toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {});
  });

  it('does not overlap two captures of one WebContents or serialize unrelated tabs', async() => {
    const service = new AgentScreenshotCapture(new AgentViewportPolicy()), first = new CdpEdge(), other = new CdpEdge();
    let unblock!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { unblock = resolve });
    const active = new Promise<void>(resolve => { started = resolve });
    first.captureFrame.mockImplementationOnce(async() => { started(); await pending; return { data: 'encoded' } });
    const one = service.capture(first.contents, () => 1, { viewport: { width: 1280, height: 800 } });
    await active;
    const two = service.capture(first.contents, () => 1, { viewport: { width: 390, height: 844 } });
    const independent = await service.capture(other.contents, () => 2);
    expect(independent.metadata.viewport.width).toBe(1440);
    expect(first.emulated?.width).toBe(1280);
    unblock();
    expect((await one).metadata.viewport.width).toBe(1280);
    expect((await two).metadata.viewport.width).toBe(390);
    expect(first.emulated).toBeNull();
  });
});
