// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ systemPreferences: { getMediaAccessStatus: vi.fn() } }));

import { ScreencaptureExit, ScreenRecordingPermission, SCREEN_RECORDING_PERMISSION_MESSAGE } from './screenRecordingPermission';

describe('ScreenRecordingPermission', () => {
  // risk: a denied capture must say how to fix it, not report a silent "Screenshot cancelled"
  it('returns the actionable message when macOS Screen Recording is not granted', () => {
    for (const status of ['denied', 'not-determined', 'restricted']) {
      expect(new ScreenRecordingPermission('darwin', () => status).deniedMessage()).toBe(SCREEN_RECORDING_PERMISSION_MESSAGE);
    }
    expect(SCREEN_RECORDING_PERMISSION_MESSAGE).toBe('Sulla needs Screen Recording permission: System Settings > Privacy & Security > Screen Recording > enable Sulla, then retry.');
  });

  it('lets capture proceed when Screen Recording is granted, and skips the check off macOS', () => {
    const status = vi.fn(() => 'granted');

    expect(new ScreenRecordingPermission('darwin', status).deniedMessage()).toBeUndefined();

    const linux = vi.fn(() => 'denied');

    expect(new ScreenRecordingPermission('linux', linux).deniedMessage()).toBeUndefined();
    expect(linux).not.toHaveBeenCalled();
  });
});

describe('ScreencaptureExit', () => {
  // risk: a real screencapture failure in full-screen mode must not be hidden as a user cancel
  it('treats exit 1 as a cancel only for interactive area and window captures', () => {
    expect(ScreencaptureExit.isCancel('area', 1)).toBe(true);
    expect(ScreencaptureExit.isCancel('window', 1)).toBe(true);
    expect(ScreencaptureExit.isCancel('full', 1)).toBe(false);
  });

  it('never treats other exit codes as a cancel', () => {
    expect(ScreencaptureExit.isCancel('area', 2)).toBe(false);
    expect(ScreencaptureExit.isCancel('full', 0)).toBe(false);
    expect(ScreencaptureExit.isCancel('area', null)).toBe(false);
  });
});
