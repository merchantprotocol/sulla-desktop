// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import type { SpeechGateClient } from './SpeechChunkGate';
import { SpeechChunkGate } from './SpeechChunkGate';

const pcm = Buffer.alloc(1024 * 2);
const client = (probability: number) => ({ infer: vi.fn<SpeechGateClient['infer']>(async({ audio }) => ({ id: 0, ok: true, probabilities: Array(Math.floor((audio.length - 64) / 512)).fill(probability), state: new Float32Array(256) })) });

describe('SpeechChunkGate', () => {
  it('warms a verified model outside the live chunk budget before enabling the gate', async () => {
    const vad = client(0.1);
    const gate = new SpeechChunkGate(vad, null, () => true, () => undefined);

    await gate.warmModel('/silero.onnx');

    expect(vad.infer).toHaveBeenCalledTimes(1);
    expect(vad.infer.mock.calls[0][0]).toMatchObject({ operation: 'vad-chunk', modelPath: '/silero.onnx' });
    expect(vad.infer.mock.calls[0][2]).toBe(10_000);
    // risk: user messages — after prewarm, actual noise must be gated rather than fail-open on cold ORT startup.
    expect(await gate.shouldTranscribe(pcm)).toBe(false);
  });

  it('keeps the model unavailable and the audio path fail-open if warm-up fails', async () => {
    const warn = vi.fn();
    const vad = { infer: vi.fn<SpeechGateClient['infer']>(async() => { throw new Error('ORT unavailable'); }) };
    const gate = new SpeechChunkGate(vad, null, () => true, warn);

    await expect(gate.warmModel('/silero.onnx')).rejects.toThrow('ORT unavailable');
    // risk: user messages — failed optional model initialization must never block or drop speech.
    expect(await gate.shouldTranscribe(pcm)).toBe(true);
  });

  it('drops noise and forwards speech through Silero inference', async () => {
    const vad = client(0.1);
    const gate = new SpeechChunkGate(vad, '/silero.onnx', () => true, () => undefined);
    // risk: user messages — a steady-noise chunk must never reach transcription.
    expect(await gate.shouldTranscribe(pcm)).toBe(false);
    expect(vad.infer).toHaveBeenCalledTimes(1);
    expect(vad.infer.mock.calls[0][0].audio).toHaveLength(1088); // 64 context + 2 frames

    const voice = client(0.8);
    const speechGate = new SpeechChunkGate(voice, '/silero.onnx', () => true, () => undefined);
    // risk: user messages — genuine speech must still be transcribed.
    expect(await speechGate.shouldTranscribe(pcm)).toBe(true);
  });

  it('retains a rejected onset chunk and exposes it before the admitted speech chunk', async () => {
    const infer = vi.fn<SpeechGateClient['infer']>();
    infer.mockResolvedValueOnce({ id: 0, ok: true, probabilities: [...Array(7).fill(0.1), 0.8], state: new Float32Array(256) });
    infer.mockResolvedValueOnce({ id: 0, ok: true, probabilities: [0.1, 0.1, ...Array(6).fill(0.8)], state: new Float32Array(256) });
    const vad = { infer };
    const gate = new SpeechChunkGate(vad, '/silero.onnx', () => true, () => undefined);
    const onset = Buffer.alloc(8192, 1);
    const speech = Buffer.alloc(8192, 2);
    expect(await gate.shouldTranscribe(onset)).toBe(false);
    expect(await gate.shouldTranscribe(speech)).toBe(true);
    // risk: lost speech — the latest rejected onset audio must precede admitted speech.
    expect(gate.takePreroll()).toEqual(onset);
    expect(gate.takePreroll()).toBeNull();
  });

  it('fails open on inference errors and a missing model, logging once', async () => {
    const warn = vi.fn();
    const broken = { infer: vi.fn<SpeechGateClient['infer']>(async() => { throw new Error('ORT unavailable'); }) };
    const gate = new SpeechChunkGate(broken, '/silero.onnx', () => true, warn);
    // risk: user messages — an unavailable optional gate must not lose speech.
    expect(await gate.shouldTranscribe(pcm)).toBe(true);
    expect(await gate.shouldTranscribe(pcm)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    const missingWarn = vi.fn();
    const missing = new SpeechChunkGate(client(0), '/missing.onnx', () => false, missingWarn);
    expect(await missing.shouldTranscribe(pcm)).toBe(true);
    expect(await missing.shouldTranscribe(pcm)).toBe(true);
    expect(missingWarn).toHaveBeenCalledTimes(1);
  });

  it('reports admitted and rejected chunk counters with mean inference duration', async () => {
    let now = 0;
    const stats = vi.fn();
    const gate = new SpeechChunkGate(client(0.1), '/silero.onnx', () => true, () => undefined, () => now, 400, stats);
    expect(await gate.shouldTranscribe(pcm)).toBe(false);
    now = 10_001;
    expect(await gate.shouldTranscribe(pcm)).toBe(false);
    expect(stats).toHaveBeenCalledWith('Silero gate stats', expect.objectContaining({ seen: 2, rejected: 2, admitted: 0, failedOpen: 0, meanInferenceMs: 0 }));
  });
});
