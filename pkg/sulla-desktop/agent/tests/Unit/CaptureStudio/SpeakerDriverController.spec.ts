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
});
