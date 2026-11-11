// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { newMessageId } from '@pkg/pages/chat/types/chat';
import type { UseCaseIntentMetadata } from '@pkg/shared/useCaseSuggestions';

describe('ChatController use-case queue routing', () => {
  it('keeps a queued Ask-agent intent intact until the active run is idle', () => {
    // risk: agent routing metadata must not be lost when a queued turn is sent during another run
    const controller = new ChatController();
    const send = vi.fn();
    const inject = vi.fn();
    controller.setSendHandler(send);
    controller.setInjectHandler(inject);
    controller.transitionRun({ type: 'send', messageId: newMessageId() });
    const intent: UseCaseIntentMetadata = { type: 'agent', slug: 'analyst', title: 'Analyst' };
    controller.queueMessage('Ask the analyst', [], { useCaseIntent: intent, agentId: 'analyst' });

    controller.injectQueuedMessage(controller.queue.value[0].id);
    expect(inject).not.toHaveBeenCalled();
    expect(controller.queue.value).toHaveLength(1);
    expect(controller.queue.value[0]).toMatchObject({ useCaseIntent: intent, agentId: 'analyst' });
    expect(send).not.toHaveBeenCalled();

    controller.transitionRun({ type: 'idle' });
    controller.drainQueueIfIdle();
    expect(send).toHaveBeenCalledWith('Ask the analyst', [], { useCaseIntent: intent, agentId: 'analyst' });
    expect(controller.queue.value).toHaveLength(0);
    controller.dispose();
  });
});
