// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { shouldQuitOnAgentWindowClosed } from './agentWindowClose';

describe('shouldQuitOnAgentWindowClosed', () => {
  // risk: data loss. Closing the last tab must not quit the whole app, even as the only agent window.
  it('does not quit when the window closed itself via its last tab, even as the only agent window', () => {
    expect(shouldQuitOnAgentWindowClosed({ closingViaLastTab: true, remainingAgentWindows: 0, quitOnClose: true })).toBe(false);
  });

  it('quits when the last agent window is closed normally and quitOnClose is on', () => {
    expect(shouldQuitOnAgentWindowClosed({ closingViaLastTab: false, remainingAgentWindows: 0, quitOnClose: true })).toBe(true);
  });

  it('does not quit when the last agent window is closed and quitOnClose is off', () => {
    expect(shouldQuitOnAgentWindowClosed({ closingViaLastTab: false, remainingAgentWindows: 0, quitOnClose: false })).toBe(false);
  });

  // risk: data loss. Closing one of several windows must never end the other windows' sessions.
  it('does not quit while another agent window is still open', () => {
    expect(shouldQuitOnAgentWindowClosed({ closingViaLastTab: false, remainingAgentWindows: 1, quitOnClose: true })).toBe(false);
  });
});
