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
    default: { app, screen: { getDisplayMatching: (b: { x: number }) => ({ scaleFactor: b.x > 0 ? 2 : 1 }) }, BrowserWindow: { fromWebContents: () => null } },
    app,
    BrowserWindow: { fromWebContents: () => null },
    WebContentsView: class {},
  };
});

import { BrowserTabCdpIpc } from '../main/startup/BrowserTabCdpIpc';
import { AgentScreenshotCapture, type CaptureOptions, type CaptureOverlays } from '../main/browserTabs/AgentScreenshotCapture';
import { AgentViewportPolicy } from '../main/browserTabs/AgentViewportPolicy';
import { ParkedViewportEmulation } from '../main/browserTabs/ParkedViewportEmulation';
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
  manager.parkedEmulation = new ParkedViewportEmulation();
  manager.sleepingTabs = new Set();
  manager.views = new Map([[tabId, view]]);
  manager.owners = new Map([[tabId, owner]]);
  manager.focusedTabIds = new Map([[owner.id, tabId]]);
  manager.trackedOwnerWindowIds = new Set<number>();
  manager.awaitingOwnerBounds = new Set<string>();
  manager.transferringTabs = new Set<string>();
  manager.latestBounds = new Map([[tabId, { x: 12, y: 24, width: 640, height: 480 }]]);
  manager.captureBounds = new WeakMap();
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
    const webContents = { ...new CaptureEdge().contents, id: 91, loadURL: vi.fn(), reload: vi.fn() };
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
    const { view } = new CaptureEdge();
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
    const layout = new HiddenTabLayout(new AgentViewportPolicy(), new ParkedViewportEmulation());
    const window = ownerWindow(1);
    const { view } = new CaptureEdge();
    layout.prepare(view as any, window as any, { width: 1280, height: 800 });
    expect(view.setBounds).toHaveBeenCalledWith({ x: -1380, y: 0, width: 1280, height: 800 });
    expect(view.setBounds.mock.invocationCallOrder[0]).toBeLessThan(window.contentView.addChildView.mock.invocationCallOrder[0]);
    expect(view.setVisible).toHaveBeenCalledWith(true);
    expect(layout.owner(view as any)).toBe(window);
    expect(window.contentView.removeChildView).not.toHaveBeenCalled();
    layout.detach(view as any);
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(layout.owner(view as any)).toBeNull();
  });
});

const phone = { width: 390, height: 844 };
const laptop = { width: 1280, height: 800 };
const pane = { x: 23, y: 99, width: 157, height: 3982 };

class CaptureEdge extends EventEmitter {
  attached = false;
  contentHeight = 1;
  rect = { ...pane };
  emulated?: { width: number; height: number };
  throttled = true;
  get size() {
    return this.emulated ?? (this.rect.x < 0 ? { width: 0, height: 0 } : { width: this.rect.width, height: this.rect.height });
  }
  readonly captureFrame = vi.fn(async() => ({ data: 'encoded' }));
  readonly isAttached = () => this.attached;
  readonly attach = () => { this.attached = true };
  readonly detach = vi.fn(() => { this.attached = false; this.emit('detach') });
  readonly sendCommand = vi.fn(async(name: string, _params?: unknown) => {
    if (name === 'Page.captureScreenshot') return this.captureFrame();
    if (name === 'Page.getLayoutMetrics') return {
      cssContentSize: { width: 1, height: this.contentHeight }, cssVisualViewport: { pageX: 0, pageY: 123 },
    };
    throw new Error(`Disallowed capture command: ${ name }`);
  });
  readonly executeJavaScript = vi.fn(async(_code: string) => this.size);
  readonly contents = {
    debugger: this, isDestroyed: () => false, executeJavaScript: this.executeJavaScript,
    on: this.on.bind(this),
    getBackgroundThrottling: () => this.throttled,
    setBackgroundThrottling: vi.fn((enabled: boolean) => { this.throttled = enabled }),
    enableDeviceEmulation: vi.fn((params: { viewSize: typeof laptop }) => { this.emulated = params.viewSize }),
    disableDeviceEmulation: vi.fn(() => { this.emulated = undefined }),
  };
  readonly view = {
    webContents: this.contents, setVisible: vi.fn(), setBounds: vi.fn((rect: typeof pane) => { this.rect = rect }),
  };
}

function fixture(focused = false, displayDpr = 1, persisted: typeof laptop | null = laptop) {
  const edge = new CaptureEdge();
  const owner = { ...ownerWindow(101), getBounds: () => ({ x: displayDpr === 2 ? 2000 : 0 }) };
  const wc = edge.contents as unknown as Electron.WebContents;
  const service = new AgentScreenshotCapture();
  const manager: BrowserTabViewManager = Reflect.construct(BrowserTabViewManager as any, [new AgentViewportPolicy(), service, new ParkedViewportEmulation()]);
  // Seed Electron's registered view and owner without launching Chromium.
  (manager as any).views.set('tab', edge.view);
  (manager as any).owners.set('tab', owner);
  const focus = (selected: boolean) => manager.setFocusedTab(selected ? 'tab' : null, undefined, undefined, owner as any);
  if (persisted) manager.setAgentViewport('tab', persisted);
  else (manager as any).reconcileVisibility(owner);
  manager.setBounds('tab', pane, owner as any);
  if (focused) focus(true);
  edge.view.setBounds.mockClear();
  edge.contents.enableDeviceEmulation.mockClear();
  edge.contents.disableDeviceEmulation.mockClear();
  const capture = (options?: CaptureOptions, overlays?: CaptureOverlays) =>
    service.capture(wc, once => manager.beginTabCapture('tab', wc, once), options, overlays);
  return { edge, wc, owner, manager, service, focus, capture };
}

describe('native screenshot transactions', () => {
  it('never mutates a selected pane, even for a one-shot request with overlays and a borrowed debugger', async() => {
    const { edge, capture } = fixture(true, 2);
    edge.attached = true;
    const overlays = { prepare: vi.fn(), remove: vi.fn() };
    const { metadata } = await capture({ viewport: phone }, overlays);
    expect(metadata).toMatchObject({ liveHumanView: true, viewport: edge.size, displayDpr: 2, devicePixelRatio: 1 });
    expect(edge.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
      clip: { x: 0, y: 123, width: pane.width, height: pane.height, scale: 0.5 },
    }));
    expect(edge.view.setBounds).not.toHaveBeenCalled();
    expect(edge.contents.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(edge.contents.disableDeviceEmulation).not.toHaveBeenCalled();
    expect(overlays.prepare).not.toHaveBeenCalled();
    expect(overlays.remove).not.toHaveBeenCalled();
    expect(edge.detach).not.toHaveBeenCalled();
  });

  it.each([[1, 1], [2, 1], [1, 2], [2, 2]] as const)('clips native CSS pixels on DPR %i at requested scale %i', async(dpr, scale) => {
    const { edge, capture } = fixture(false, dpr);
    const { metadata } = await capture({ scale });
    expect(metadata).toMatchObject({ liveHumanView: false, viewport: laptop, displayDpr: dpr, devicePixelRatio: scale });
    expect(edge.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
      clip: { x: 0, y: 123, ...laptop, scale: scale / dpr }, fromSurface: true, captureBeyondViewport: false,
    }));
    expect(edge.view.setBounds).not.toHaveBeenCalled();
  });

  it('waits for native layout and paint, survives reconcile, and restores the latest persisted size', async() => {
    const { edge, capture, manager } = fixture();
    let frames = 0;
    edge.executeJavaScript.mockImplementation(async(code: string) => {
      if (code.includes('requestAnimationFrame')) frames++;
      return frames < 2 ? laptop : edge.size;
    });
    const updated = { width: 1024, height: 768 };
    edge.captureFrame.mockImplementationOnce(async() => {
      expect(frames).toBeGreaterThanOrEqual(3);
      manager.setAgentViewport('tab', updated);
      expect(edge.rect).toEqual({ ...phone, x: -490, y: 0 });
      return { data: 'encoded' };
    });
    expect((await capture({ viewport: phone })).metadata.viewport).toEqual(phone);
    expect(edge.rect).toEqual({ ...updated, x: -1124, y: 0 });
  });

  it.each([false, true])('restores bounds and decorations after a compositor error (borrowed=%s)', async(borrowed) => {
    const { edge, capture } = fixture();
    edge.attached = borrowed;
    const overlays = { prepare: vi.fn(), remove: vi.fn() };
    edge.captureFrame.mockRejectedValueOnce(new Error('compositor failure'));
    await expect(capture({ viewport: phone }, overlays)).rejects.toThrow('compositor failure');
    expect(overlays.remove).toHaveBeenCalledOnce();
    expect(edge.size).toEqual(laptop);
    expect(edge.detach).toHaveBeenCalledTimes(borrowed ? 0 : 1);
    expect(edge.isAttached()).toBe(borrowed);
  });

  it.each(['zero frames', 'no rAF', 'no initial reply'])('falls back by 3 seconds (%s), leaving no late capture', async(mode) => {
    vi.useFakeTimers();
    const { edge, capture } = fixture();
    let resume: (() => void) | undefined;
    const zero = { width: 0, height: 0 };
    edge.executeJavaScript.mockImplementation(async code => {
      if (mode === 'no initial reply' || (mode === 'no rAF' && code.includes('requestAnimationFrame'))) {
        await new Promise<void>(resolve => { resume = resolve });
      } else if (code.includes('requestAnimationFrame')) {
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      return zero;
    });
    try {
      const pending = capture({ viewport: phone, fullPage: true });
      await vi.advanceTimersByTimeAsync(2999);
      expect(edge.captureFrame).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(edge.captureFrame).toHaveBeenCalledOnce();
      expect((await pending).metadata).toMatchObject({ viewport: phone, viewportSettled: false,
        observedViewport: mode === 'no initial reply' ? null : zero, fullPage: false });
      expect(edge.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
        clip: { x: 0, y: 123, ...phone, scale: 1 }, captureBeyondViewport: true,
      }));
      expect(edge.size).toEqual(laptop);
      resume?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(edge.captureFrame).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports both sizes if the fallback capture also fails', async() => {
    vi.useFakeTimers();
    const { edge, capture } = fixture();
    edge.executeJavaScript.mockResolvedValueOnce({ width: 0, height: 0 }).mockImplementationOnce(() => new Promise(() => {}));
    edge.captureFrame.mockRejectedValueOnce(new Error('no surface'));
    try {
      const failed = expect(capture()).rejects.toThrow('Agent viewport did not settle: expected 1280x800, page reports 0x0');
      await vi.advanceTimersByTimeAsync(3001);
      await failed;
      expect(edge.size).toEqual(laptop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lays out a never-shown tab at 1440x900, including after a one-shot capture and renderer swaps', async() => {
    const { edge, capture, focus } = fixture(false, 1, null);
    const defaultSize = { width: 1440, height: 900 };
    expect(edge.size).toEqual(defaultSize);
    edge.captureFrame.mockImplementationOnce(async() => {
      edge.emulated = undefined;
      edge.emit('did-navigate');
      expect(edge.size).toEqual(phone); // navigation honors even the transient size
      return { data: 'encoded' };
    });
    expect((await capture({ viewport: phone })).metadata.viewportSettled).toBe(true);
    expect(edge.size).toEqual(defaultSize);
    edge.emulated = undefined;
    edge.emit('dom-ready');
    expect(edge.size).toEqual(defaultSize);
    focus(true);
    expect(edge.contents.disableDeviceEmulation.mock.invocationCallOrder[0]).toBeLessThan(edge.view.setBounds.mock.invocationCallOrder.at(-1)!);
    edge.emit('did-navigate');
    edge.emit('dom-ready');
    expect(edge.emulated).toBeUndefined();
    expect(edge.size).toEqual({ width: pane.width, height: pane.height });
  });

  it('lets focus win synchronously during an in-flight parked capture and rejects the stale image', async() => {
    const { edge, capture, focus } = fixture();
    edge.captureFrame.mockImplementationOnce(async() => {
      expect(edge.size).toEqual(phone);
      focus(true);
      expect(edge.rect).toEqual(pane);
      return { data: 'stale' };
    });
    await expect(capture({ viewport: phone })).rejects.toThrow('placement changed');
    expect(edge.rect).toEqual(pane);
    expect(edge.emulated).toBeUndefined();
    expect((await capture()).metadata.liveHumanView).toBe(true);
  });

  it('also rejects a parked result if the tab gains focus during overlay cleanup', async() => {
    const { capture, focus, edge } = fixture();
    await expect(capture({ viewport: phone }, {
      prepare: async() => {},
      remove: async() => { focus(true) },
    })).rejects.toThrow('placement changed');
    expect(edge.rect).toEqual(pane);
  });

  it('does not detach a replacement debugger session', async() => {
    const { edge, capture } = fixture();
    edge.captureFrame.mockImplementationOnce(async() => {
      edge.emit('detach');
      edge.attached = true;
      throw new Error('session replaced');
    });
    await expect(capture()).rejects.toThrow('session replaced');
    expect(edge.detach).not.toHaveBeenCalled();
  });

  it('bounds full-page height in output pixels while preserving scroll origin for a normal capture', async() => {
    const { edge, capture } = fixture(false, 2);
    for (const h of [4900, 10 ** 8]) {
      edge.contentHeight = h;
      edge.captureFrame.mockImplementationOnce(async() => {
        edge.emulated = undefined; // Chromium may drop widget emulation when restoring a beyond-viewport clip
        return { data: 'encoded' };
      });
      const { metadata } = await capture({ fullPage: true, scale: 2 });
      expect(edge.size).toEqual(laptop);
      expect(metadata.cssHeight).toEqual(Math.min(h, 8192, Math.floor(32 * 1024 ** 2 / (4 * laptop.width))));
      expect(metadata.capped).toBe(metadata.cssHeight < h);
      expect(edge.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
        captureBeyondViewport: true, clip: { x: 0, y: 0, width: laptop.width, height: metadata.cssHeight, scale: 1 },
      }));
    }
  });

  it('queues the real human screenshot IPC behind the agent transaction without blocking another tab', async() => {
    const { manager, service, edge, wc, capture } = fixture();
    const handlers = new Map();
    await new BrowserTabCdpIpc().register({ ipc: { handle: (name: string, cb: unknown) => handlers.set(name, cb) } } as any);
    const instance = vi.spyOn(BrowserTabViewManager, 'getInstance').mockReturnValue(manager);
    let resume!: () => void, start!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve });
    const started = new Promise<void>(resolve => { start = resolve });
    edge.captureFrame.mockImplementationOnce(async() => { start(); await pending; return { data: 'agent' } });
    try {
      const agent = capture({ viewport: phone });
      await started;
      const human = handlers.get('browser-tab:capture-screenshot')({ sender: wc }, { format: 'png' });
      const other = new CaptureEdge();
      await service.capturePane(other.contents as unknown as Electron.WebContents, () => {});
      expect(edge.captureFrame).toHaveBeenCalledTimes(1);
      edge.captureFrame.mockImplementationOnce(async() => {
        expect(edge.size).toEqual(laptop);
        return { data: 'live' };
      });
      resume();
      expect((await agent).metadata.viewport).toEqual(phone);
      expect(await human).toEqual({ base64: 'live', mediaType: 'image/png' });
      expect(edge.sendCommand).toHaveBeenLastCalledWith('Page.captureScreenshot', {
        format: 'png', quality: 80, captureBeyondViewport: false,
      });
    } finally {
      resume();
      instance.mockRestore();
    }
  });

  it('lays out windowless hidden pages and keeps overlapping operations awake until the last finishes', async() => {
    const layout = new HiddenTabLayout(new AgentViewportPolicy(), new ParkedViewportEmulation());
    const edge = new CaptureEdge();
    const wc = edge.contents as unknown as Electron.WebContents;
    layout.prepare(edge.view as any, null, phone);
    expect(edge.size).toEqual(phone);
    let finishRead!: () => void;
    const read = layout.whileAwake(wc, () => new Promise<void>(resolve => { finishRead = resolve }));
    expect(edge.throttled).toBe(false);
    await expect(layout.whileAwake(wc, async() => { throw new Error('capture failed') })).rejects.toThrow('capture failed');
    expect(edge.throttled).toBe(false);
    finishRead();
    await read;
    expect(edge.throttled).toBe(true);
  });

  it('captures attached hidden views without reparenting, restoring their native bounds', async() => {
    const { owner, manager, service } = fixture();
    const edge = new CaptureEdge();
    const wc = edge.contents as unknown as Electron.WebContents;
    const layout = new HiddenTabLayout(manager.agentViewports, manager.parkedEmulation);
    layout.prepare(edge.view as any, owner as any, laptop);
    expect(edge.size).toEqual(laptop);
    const captureHidden = () => service.capture(wc, once => manager.beginHiddenCapture(edge.view as any, owner as any, once), { viewport: phone });
    expect((await captureHidden()).metadata.viewport).toEqual(phone);
    expect(edge.size).toEqual(laptop);
    edge.captureFrame.mockRejectedValueOnce(new Error('closed'));
    await expect(captureHidden()).rejects.toThrow('closed');
    expect(edge.size).toEqual(laptop);
    expect(owner.contentView.removeChildView).not.toHaveBeenCalled();
    expect(edge.emulated).toEqual(laptop);
  });
});
