// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send }) }));

import { ChannelTagExtractor } from '../../../controllers/ChannelTagExtractor';

describe('ChannelTagExtractor', () => {
  beforeEach(() => send.mockReset());

  it('labels a peer envelope with the stable agent identity rather than its transport channel', () => { // risk: message provenance
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:reviewer>independent finding</channel:reviewer>' } as any;
    extractor.processComplete(response, {
      channel: 'sulla-desktop', threadId: 'child-thread', state: { metadata: { agentId: 'codex-sol-worker', wsChannel: 'sulla-desktop' } },
    } as any);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1].data).toMatchObject({ senderId: 'codex-sol-worker', senderChannel: 'sulla-desktop' });
    expect(send.mock.calls[1][1].data.envelope).toMatchObject({ from: 'codex-sol-worker', kind: 'peer', body: 'independent finding' });
  });
});
