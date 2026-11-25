// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { DesktopRelayRequestHandlers } from '../../../main/cloud/relay/DesktopRelayRequestHandlers';

describe('DesktopRelayRequestHandlers decision actors', () => {
  it.each(['chat.answer', 'decisions.resolve'])('marks authenticated relay action %s as human', async method => {
    // risk: authorization — a trusted human relay response must be attributed to its actor before decision persistence.
    const result = method === 'chat.answer' ? { accepted: true } : { settled: false };
    const companionRequest = vi.fn(async() => result);
    const scribe = { scribeDerived: vi.fn(async() => 'derived-message') };
    const outbox = { activeConversationIds: () => [], setSecureRoute: vi.fn(), sendChatFrame: vi.fn() };
    const handlers = new DesktopRelayRequestHandlers(
      { deviceId: 'desktop-1' }, async() => 'desktop-1', outbox as any, {} as any, scribe as any,
      () => ({ connect: vi.fn(), send: vi.fn(), onMessage: vi.fn() }) as any,
      { companionRequest } as any,
      { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    const params = { id: 'decision-1', conversationId: 'chat-1' };

    await handlers.companion({ type: 'companion_request', requestId: 'request-1', method, params }, vi.fn());

    expect(companionRequest).toHaveBeenCalledWith(method, params, { kind: 'human' });
  });
});
