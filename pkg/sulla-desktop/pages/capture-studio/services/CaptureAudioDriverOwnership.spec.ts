// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { CaptureAudioDriverOwnership } from './CaptureAudioDriverOwnership';

describe('CaptureAudioDriverOwnership', () => {
  it('releases only its own mic and speaker holds once when a source is removed', async() => {
    // risk: audio ownership — removing one source must not stop another driver's consumers.
    const driver = { startMic: vi.fn().mockResolvedValue({}), stopMic: vi.fn().mockResolvedValue(undefined), startSpeaker: vi.fn().mockResolvedValue(undefined), stopSpeaker: vi.fn().mockResolvedValue(undefined) };
    const ownership = new CaptureAudioDriverOwnership(driver);
    await ownership.acquireMic(['pcm-s16le']);
    await ownership.acquireSpeaker();
    await ownership.releaseMic();
    await ownership.releaseMic();
    await ownership.releaseSpeaker();
    await ownership.releaseSpeaker();
    expect(driver.stopMic).toHaveBeenCalledTimes(1);
    expect(driver.stopSpeaker).toHaveBeenCalledTimes(1);
  });

  it('does not release a mic hold when acquisition was cancelled before ownership transfer', async() => {
    // risk: audio ownership — cancellation must not double-release a hold already released by startMic.
    const driver = { startMic: vi.fn().mockResolvedValue({}), stopMic: vi.fn().mockResolvedValue(undefined), startSpeaker: vi.fn().mockResolvedValue(undefined), stopSpeaker: vi.fn().mockResolvedValue(undefined) };
    const ownership = new CaptureAudioDriverOwnership(driver);
    await ownership.acquireMic(undefined, () => true);
    await ownership.releaseMic();
    expect(driver.stopMic).not.toHaveBeenCalled();
  });

  it('keeps another consumer active after source removal and Capture Studio close release its hold', async() => {
    // risk: audio ownership — Capture Studio cleanup must not mute or stop a separate microphone consumer.
    const holders = new Set(['voice-session']);
    const driver = {
      startMic: vi.fn(async() => { holders.add('capture-studio'); return { micRunning: true }; }),
      stopMic: vi.fn(async() => { holders.delete('capture-studio'); }),
      startSpeaker: vi.fn().mockResolvedValue(undefined),
      stopSpeaker: vi.fn().mockResolvedValue(undefined),
    };
    const ownership = new CaptureAudioDriverOwnership(driver);
    await ownership.acquireMic();
    await ownership.releaseMic(); // source removal
    await ownership.releaseMic(); // later Capture Studio close
    expect(holders.has('voice-session')).toBe(true);
    expect(holders.has('capture-studio')).toBe(false);
    expect(driver.stopMic).toHaveBeenCalledTimes(1);
  });
});
