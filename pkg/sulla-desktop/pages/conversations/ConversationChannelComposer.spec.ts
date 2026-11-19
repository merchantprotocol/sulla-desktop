// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ConversationChannelComposer } from './ConversationChannelComposer';

describe('ConversationChannelComposer', () => {
  it('pins Enter submission to the text and channel captured from the composer', async () => {
    // risk: privacy; switching channels between key press and async send must not disclose text to another channel
    const composer = new ConversationChannelComposer();
    const oldTarget = { serverId: 'server-a', channelId: 'channel-a' };
    const newTarget = { serverId: 'server-a', channelId: 'channel-b' };
    composer.updateDraft(oldTarget, '  private note  ');
    const submission = composer.capture(oldTarget, composer.draft(oldTarget));
    const sendMessage = vi.fn(async () => undefined);

    await sendMessage(submission!);

    expect(submission).toEqual({ ...oldTarget, body: 'private note' });
    expect(sendMessage).toHaveBeenCalledWith({ ...oldTarget, body: 'private note' });
    expect(composer.draft(newTarget)).toBe('');
  });

  it('keeps drafts isolated by channel and preserves edits made while a send is in flight', () => {
    // risk: draft integrity; channel changes or a pending send must not overwrite another channel's text or newer edits
    const composer = new ConversationChannelComposer();
    const first = { serverId: 'server-a', channelId: 'channel-a' };
    const second = { serverId: 'server-a', channelId: 'channel-b' };
    composer.updateDraft(first, 'first draft');
    composer.updateDraft(second, 'second draft');
    const submission = composer.capture(first, composer.draft(first))!;
    composer.updateDraft(first, 'newer first draft');
    composer.clearAfterSend(submission);

    expect(composer.draft(first)).toBe('newer first draft');
    expect(composer.draft(second)).toBe('second draft');
  });
});
