// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  activate: vi.fn(),
  deactivate: vi.fn().mockResolvedValue(undefined),
  speakerVolumeUp: vi.fn(), speakerVolumeDown: vi.fn(), speakerMuteToggle: vi.fn(), speakerVolumeGet: vi.fn(),
  setOnVolumeChanged: vi.fn(),
}));
const savePrefs = vi.hoisted(() => vi.fn());

vi.mock('@pkg/main/audio-driver/controller/lifecycle', () => lifecycle);
vi.mock('@pkg/main/audio-driver/model/audio', () => ({ loadPrefs: () => ({}), savePrefs }));
vi.mock('@pkg/main/audio-driver/model/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { SpeakerDriverController } from '@pkg/main/audio-driver/controller/SpeakerDriverController';

class SenderStub {
  readonly once = vi.fn();
  readonly removeListener = vi.fn();
  isDestroyed(): boolean { return false }
}

describe('SpeakerDriverController activation accounting', () => {
  let controller: SpeakerDriverController;
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.deactivate.mockResolvedValue(undefined);
    controller = SpeakerDriverController.getInstance();
  });
  afterEach(async() => { await controller.shutdown() });

  it('rejects ok:false and releases the failed holder and listener', async() => { // risk: false running state and leaked custody
    lifecycle.activate.mockResolvedValue({ ok: false, mirrorActive: false });
    const sender = new SenderStub();

    await expect(controller.start('capture-studio', sender as any)).rejects.toThrow('did not activate');

    expect(controller.running).toBe(false);
    expect(controller.holders).toEqual([]);
    expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
    expect(lifecycle.deactivate).toHaveBeenCalledWith({ removeDriver: false });
  });

  it('rejects mirrorActive:false instead of marking the pipeline running', async() => { // risk: capture starts against an inactive mirror
    lifecycle.activate.mockResolvedValue({ ok: true, mirrorActive: false });
    await expect(controller.start('capture-studio')).rejects.toThrow('did not activate');
    expect(controller.running).toBe(false);
    expect(controller.isHolder('capture-studio')).toBe(false);
  });

  it('orders a stop behind pending activation so the pipeline cannot be stranded', async() => { // risk: leaked audio pipeline after rapid stop
    let finishActivation!: (value: { ok: boolean; mirrorActive: boolean }) => void;
    lifecycle.activate.mockReturnValue(new Promise(resolve => { finishActivation = resolve }));

    const started = controller.start('capture-studio');
    const stopped = controller.stop('capture-studio');
    await Promise.resolve();
    finishActivation({ ok: true, mirrorActive: true });

    await Promise.all([started, stopped]);
    expect(controller.running).toBe(false);
    expect(controller.holders).toEqual([]);
    expect(lifecycle.deactivate).toHaveBeenCalledTimes(1);
  });

  it('finishes failed activation cleanup before activating the next holder', async() => { // risk: one holder tears down another holder's pipeline
    let failActivation!: (value: { ok: boolean; mirrorActive: boolean }) => void;
    lifecycle.activate
      .mockReturnValueOnce(new Promise(resolve => { failActivation = resolve }))
      .mockResolvedValueOnce({ ok: true, mirrorActive: true });

    const first = controller.start('first-holder');
    const second = controller.start('second-holder');
    await Promise.resolve();
    failActivation({ ok: false, mirrorActive: false });

    await expect(first).rejects.toThrow('did not activate');
    await expect(second).resolves.toBeUndefined();
    expect(controller.running).toBe(true);
    expect(controller.holders).toEqual(['second-holder']);
    expect(lifecycle.activate).toHaveBeenCalledTimes(2);
    expect(lifecycle.deactivate).toHaveBeenCalledTimes(1);
  });

  it('clears holder custody when shutdown deactivation rejects', async() => { // risk: failed teardown strands stale holders and singleton state
    lifecycle.activate.mockResolvedValue({ ok: true, mirrorActive: true });
    const sender = new SenderStub();
    await controller.start('capture-studio', sender as any);
    lifecycle.deactivate.mockRejectedValueOnce(new Error('deactivate failed'));

    await expect(controller.shutdown()).rejects.toThrow('deactivate failed');

    expect(controller.running).toBe(false);
    expect(controller.holders).toEqual([]);
    expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
    const replacement = SpeakerDriverController.getInstance();
    expect(replacement).not.toBe(controller);
    await replacement.shutdown();
  });
});
