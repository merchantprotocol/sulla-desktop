// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { DesktopFilesTransportRegistry } from './desktopFilesTransport';

describe('DesktopFilesTransportRegistry', () => {
  it('fails closed when Desktop main never registered a transport (Tools container path)', () => {
    // risk: a Desktop-origin Files call inside the Tools container must not reach a Desktop-only TLS path.
    const registry = new DesktopFilesTransportRegistry();
    expect(() => registry.resolve()).toThrow('Desktop Files transport is not available in this runtime');
  });

  it('hands back the registered origin and fetch so the Files client keeps its origin check', () => {
    // risk: the pinned origin and fetch must be the same pair Desktop main registered; a mismatch would send Files traffic to the wrong origin.
    const registry = new DesktopFilesTransportRegistry();
    const fetch = async(): Promise<Response> => new Response('ok');
    registry.register({ origin: 'https://127.0.0.1:30124', fetch });
    expect(registry.resolve().origin).toBe('https://127.0.0.1:30124');
    expect(registry.resolve().fetch).toBe(fetch);
  });
});
