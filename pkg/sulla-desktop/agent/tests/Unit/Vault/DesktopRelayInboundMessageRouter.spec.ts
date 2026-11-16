// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { DesktopRelayInboundMessageRouter, type RelayMessageRouteDependencies } from '../../../../main/cloud/session/DesktopRelayInboundMessageRouter';

describe('DesktopRelayInboundMessageRouter', () => {
  const createDependencies = (): RelayMessageRouteDependencies => ({
    deviceId: vi.fn().mockResolvedValue('desktop-1'),
    surfaceSignInCode: vi.fn(), connected: vi.fn(), error: vi.fn(),
    companion: vi.fn().mockResolvedValue(undefined), shareFetch: vi.fn().mockResolvedValue(undefined),
    shareFetchCancel: vi.fn(), chat: vi.fn().mockResolvedValue(undefined), cancel: vi.fn(), inject: vi.fn().mockResolvedValue(undefined),
    clearSecureRoute: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  });

  it('refuses targeted chats for another desktop and dispatches only matching targets', async() => {
    // risk: tenant/device isolation — a broadcast relay frame must not execute on a different targeted desktop.
    const dependencies = createDependencies();
    const router = new DesktopRelayInboundMessageRouter(dependencies);

    await router.route(JSON.stringify({ type: 'chat', targetDeviceId: 'desktop-2' }));
    expect(dependencies.chat).not.toHaveBeenCalled();

    await router.route(JSON.stringify({ type: 'chat', targetDeviceId: 'desktop-1' }));
    expect(dependencies.chat).toHaveBeenCalledOnce();
  });

  it('refuses targeted chats when device identity cannot be read', async() => {
    // risk: security — fail closed rather than execute a targeted frame without verifying its recipient.
    const dependencies = createDependencies();
    vi.mocked(dependencies.deviceId).mockRejectedValue(new Error('device identity unavailable'));
    const router = new DesktopRelayInboundMessageRouter(dependencies);

    await router.route(JSON.stringify({ type: 'chat', targetDeviceId: 'desktop-1' }));

    expect(dependencies.chat).not.toHaveBeenCalled();
    expect(dependencies.log.warn).toHaveBeenCalledOnce();
  });
});
