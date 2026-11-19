// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ConversationShellPolicy } from './ConversationShellPolicy';

describe('ConversationShellPolicy', () => {
  it('hides the desktop sidebar only while Conversations is active', () => {
    const policy = new ConversationShellPolicy();
    expect(policy.showsDesktopRail('conversations')).toBe(false);
    expect(policy.showsDesktopRail('chat')).toBe(true);
    expect(policy.showsDesktopRail(undefined)).toBe(true);
  });

  it('returns to the previous location, or opens default chat when there is none', () => {
    const policy = new ConversationShellPolicy();
    let activeMode = 'conversations';
    const goBack = vi.fn(() => { activeMode = 'chat'; }), openChat = vi.fn(() => { activeMode = 'chat'; });
    policy.exit(true, goBack, openChat);
    expect(goBack).toHaveBeenCalledOnce();
    expect(openChat).not.toHaveBeenCalled();
    expect(policy.showsDesktopRail(activeMode)).toBe(true);
    policy.exit(false, goBack, openChat);
    expect(openChat).toHaveBeenCalledOnce();
  });
});
