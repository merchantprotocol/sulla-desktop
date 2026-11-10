// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { SpeechChunkGate } from './SpeechChunkGate';

const pcm = Buffer.alloc(1024 * 2);
const client = (probability: number) => ({ infer: vi.fn(async () => ({ ok: true, probability, state: new Float32Array(256) })) });

describe('SpeechChunkGate', () => {
  it('drops noise and forwards speech through Silero inference', async () => {
    const vad = client(0.1);
    const gate = new SpeechChunkGate(vad, '/silero.onnx', () => true, () => undefined);
    // risk: user messages — a steady-noise chunk must never reach transcription.
    expect(await gate.shouldTranscribe(pcm)).toBe(false);
    expect(vad.infer).toHaveBeenCalledTimes(2);

    const voice = client(0.8);
    const speechGate = new SpeechChunkGate(voice, '/silero.onnx', () => true, () => undefined);
    // risk: user messages — genuine speech must still be transcribed.
    expect(await speechGate.shouldTranscribe(pcm)).toBe(true);
  });

  it('fails open on inference errors and a missing model, logging once', async () => {
    const warn = vi.fn();
    const broken = { infer: vi.fn(async () => { throw new Error('ORT unavailable'); }) };
    const gate = new SpeechChunkGate(broken, '/silero.onnx', () => true, warn);
    // risk: user messages — an unavailable optional gate must not lose speech.
    expect(await gate.shouldTranscribe(pcm)).toBe(true);
    expect(await gate.shouldTranscribe(pcm)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    const missing = new SpeechChunkGate(client(0), '/missing.onnx', () => false, warn);
    expect(await missing.shouldTranscribe(pcm)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
