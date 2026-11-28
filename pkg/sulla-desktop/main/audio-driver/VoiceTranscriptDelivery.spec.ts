// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { VoiceTranscriptDelivery, type VoiceTranscriptTarget } from './VoiceTranscriptDelivery';

function renderer(destroyed = false): VoiceTranscriptTarget & { send: ReturnType<typeof vi.fn> } {
  return { isDestroyed: () => destroyed, send: vi.fn() };
}

describe('VoiceTranscriptDelivery', () => {
  // risk: transcript privacy across chat tabs
  it('sends Whisper partials only to the tab renderer that started transcription', () => {
    const ownerWindow = renderer();
    const chatTab = renderer();
    const unrelatedTab = renderer();
    const event = { event_type: 'transcript_partial', text: 'Here is the live transcript.' } as const;
    const delivery = new VoiceTranscriptDelivery(chatTab);

    delivery.deliver(event);

    expect(chatTab.send).toHaveBeenCalledWith('gateway-transcript', event);
    expect(ownerWindow.send).not.toHaveBeenCalled();
    expect(unrelatedTab.send).not.toHaveBeenCalled();
  });

  it('drops a final event if its originating tab renderer has been destroyed', () => {
    const chatTab = renderer(true);
    const event = { event_type: 'transcript_turn', text: 'finish this turn' } as const;
    const delivery = new VoiceTranscriptDelivery(chatTab);

    delivery.deliver(event);

    expect(chatTab.send).not.toHaveBeenCalled();
  });
});
