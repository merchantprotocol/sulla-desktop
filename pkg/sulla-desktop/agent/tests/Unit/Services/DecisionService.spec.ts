// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

const busFactory = vi.hoisted(() => vi.fn(() => ({ send: vi.fn() })));
vi.mock('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: busFactory }));

import { DecisionService } from '../../../services/DecisionService';

describe('DecisionService', () => {
  it('constructs without touching the renderer WebSocket client', () => {
    // risk: availability — decision handling must not depend on the renderer; constructing it outside the renderer must not crash or load the bus.
    expect(() => new DecisionService()).not.toThrow();
    expect(busFactory).not.toHaveBeenCalled();
  });
});
