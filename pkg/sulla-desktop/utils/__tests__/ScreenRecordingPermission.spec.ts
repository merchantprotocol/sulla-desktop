// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ systemPreferences: { getMediaAccessStatus: vi.fn(() => 'granted') } }));

import { ScreenRecordingPermission, SCREEN_RECORDING_PERMISSION_MESSAGE } from '@pkg/utils/screenRecordingPermission';

describe('ScreenRecordingPermission', () => {
  // risk: a denied Screen Recording grant must surface as an actionable error, not a silent "cancelled"
  it('returns the actionable message when macOS Screen Recording is not granted', () => {
    for (const status of ['denied', 'not-determined', 'restricted', 'unknown'] as const) {
      expect(new ScreenRecordingPermission('darwin', () => status).blockedReason()).toBe(SCREEN_RECORDING_PERMISSION_MESSAGE);
    }
    expect(SCREEN_RECORDING_PERMISSION_MESSAGE).toContain('System Settings > Privacy & Security > Screen Recording');
  });

  // risk: a granted user must still be able to capture
  it('allows capture when Screen Recording is granted on macOS', () => {
    expect(new ScreenRecordingPermission('darwin', () => 'granted').blockedReason()).toBeUndefined();
  });

  // risk: non-mac platforms have no Screen Recording gate and must not be blocked by it
  it('never blocks on platforms without the macOS permission gate', () => {
    const read = vi.fn(() => 'denied' as const);

    expect(new ScreenRecordingPermission('linux', read).blockedReason()).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
