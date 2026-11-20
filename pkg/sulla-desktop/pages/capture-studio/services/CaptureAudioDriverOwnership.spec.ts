// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { CaptureSessionLifecycle } from '../effects/CaptureSessionLifecycle';
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

  it('releases a cancelled mic acquisition once without retaining a phantom hold', async() => {
    // risk: audio ownership — a cancelled acquisition must release exactly once and later close must be a no-op.
    const driver = { startMic: vi.fn().mockResolvedValue({}), stopMic: vi.fn().mockResolvedValue(undefined), startSpeaker: vi.fn().mockResolvedValue(undefined), stopSpeaker: vi.fn().mockResolvedValue(undefined) };
    const ownership = new CaptureAudioDriverOwnership(driver);
    await ownership.acquireMic(undefined, () => true);
    await ownership.releaseMic();
    expect(driver.stopMic).toHaveBeenCalledTimes(1);
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

  it('retains ownership after a failed release so cleanup can retry', async() => {
    // risk: audio ownership — a transient IPC stop error must not erase the only record of a live hold.
    const driver = { startMic: vi.fn().mockResolvedValue({}), stopMic: vi.fn().mockRejectedValueOnce(new Error('temporary stop failure')).mockResolvedValue(undefined), startSpeaker: vi.fn().mockResolvedValue(undefined), stopSpeaker: vi.fn().mockResolvedValue(undefined) };
    const ownership = new CaptureAudioDriverOwnership(driver);
    await ownership.acquireMic();
    await expect(ownership.releaseMic()).rejects.toThrow('temporary stop failure');
    await ownership.releaseMic();
    expect(driver.stopMic).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent releases and serializes a reacquisition after stop settles', async() => {
    // risk: audio ownership — overlapping source removal, close, and re-enable must not drop or double-release a holder.
    let finishStop!: () => void;
    let stopCalls = 0;
    const driver = {
      startMic: vi.fn().mockResolvedValue({}),
      stopMic: vi.fn(() => ++stopCalls === 1
        ? new Promise<void>(resolve => { finishStop = resolve; })
        : Promise.resolve()),
      startSpeaker: vi.fn().mockResolvedValue(undefined),
      stopSpeaker: vi.fn().mockResolvedValue(undefined),
    };
    const ownership = new CaptureAudioDriverOwnership(driver);
    await ownership.acquireMic();
    const firstRelease = ownership.releaseMic();
    const secondRelease = ownership.releaseMic();
    expect(driver.stopMic).toHaveBeenCalledTimes(1);
    const reacquire = ownership.acquireMic();
    expect(driver.startMic).toHaveBeenCalledTimes(1);
    finishStop();
    await Promise.all([firstRelease, secondRelease, reacquire]);
    expect(driver.startMic).toHaveBeenCalledTimes(2);
    await ownership.releaseMic();
  });

  it('releases a mic acquired just as the lifecycle close guard rejects startup', async() => {
    // risk: audio ownership — the lifecycle guard may reject after IPC acquired the mic but before the adapter records the hold.
    const lifecycle = new CaptureSessionLifecycle();
    let completeStart!: () => void;
    let held = false;
    const driver = {
      startMic: () => new Promise<void>(resolve => {
        completeStart = () => { held = true; resolve(); };
      }),
      stopMic: vi.fn(async() => { held = false; }),
      startSpeaker: vi.fn().mockResolvedValue(undefined),
      stopSpeaker: vi.fn().mockResolvedValue(undefined),
    };
    const ownership = new CaptureAudioDriverOwnership(driver);
    const acquisition = lifecycle.protect(() => ownership.acquireMic())();
    expect(completeStart).toBeDefined();
    const closing = lifecycle.close(() => ownership.releaseMic());
    completeStart();
    await expect(acquisition).rejects.toThrow('Capture Studio is closing');
    await closing;
    expect(held).toBe(false);
    expect(driver.stopMic).toHaveBeenCalledTimes(1);
  });

  it('does not release an unowned mic when startup fails before acquisition during close', async() => {
    // risk: audio ownership — a failed start before driver custody must not stop another consumer.
    const lifecycle = new CaptureSessionLifecycle();
    const driver = {
      startMic: vi.fn().mockRejectedValue(new Error('start failed before holder registration')),
      stopMic: vi.fn().mockResolvedValue(undefined),
      startSpeaker: vi.fn().mockResolvedValue({ ok: true }),
      stopSpeaker: vi.fn().mockResolvedValue(undefined),
    };
    const ownership = new CaptureAudioDriverOwnership(driver);
    const acquisition = lifecycle.protect(() => ownership.acquireMic())();
    const closing = lifecycle.close(() => ownership.releaseMic());
    await expect(acquisition).rejects.toThrow('start failed before holder registration');
    await closing;
    expect(driver.stopMic).not.toHaveBeenCalled();
  });
});
