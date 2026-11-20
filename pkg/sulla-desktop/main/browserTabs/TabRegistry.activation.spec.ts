// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => {
  const send = vi.fn();
  return { send, window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } } };
});
vi.mock('@pkg/window/browserTabViewManager', () => ({ BrowserTabViewManager: { getInstance: () => ({
  createView: vi.fn(), destroyView: vi.fn(), getOwnerWindow: () => ports.window,
}) } }));
vi.mock('./GuestBridge', () => ({ GuestBridge: class {} }));
import { tabRegistry } from './TabRegistry';

describe('owner-scoped explicit activation', () => {
  beforeEach(() => {
    for (const tab of tabRegistry.list()) tabRegistry.close(tab.assetId);
    ports.send.mockClear();
  });
  it('delivers the record only to its owning shell before asynchronous mirroring', () => {
    // risk: route requested before the renderer knows the new tab
    const owner = { kind: 'graph' as const, sessionId: 'one' };
    const record = tabRegistry.open({ assetId: 'owned', url: 'https://example.com', owner });
    expect(ports.send).not.toHaveBeenCalled();
    tabRegistry.requestActivation('owned', owner);
    expect(ports.send).toHaveBeenCalledWith('tabs:request-activation', record);
  });
  it('refuses another session and an unbound caller', () => {
    // risk: another graph hijacking an owned tab
    tabRegistry.open({ assetId: 'owned', url: 'https://example.com', owner: { kind: 'graph', sessionId: 'one' } });
    expect(() => tabRegistry.requestActivation('owned', { kind: 'graph', sessionId: 'two' })).toThrow('different browser session');
    expect(() => tabRegistry.requestActivation('owned')).toThrow('different browser session');
    expect(ports.send).not.toHaveBeenCalled();
  });
});
