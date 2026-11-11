// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { SpeechChunkGate } from './SpeechChunkGate';

const pcm = Buffer.alloc(1024 * 2);
const client = (probability: number) => ({ infer: vi.fn(async ({ audio }: { audio: Float32Array }) => ({ ok: true, probabilities: Array(Math.floor((audio.length - 64) / 512)).fill(probability), state: new Float32Array(256) })) });

describe('SpeechChunkGate', () => {
  it('passes cold chunks through, then gates noise after warm-up', async () => {
    const vad = client(0.1);
    const gate = new SpeechChunkGate(vad, null, () => true, () => undefined);

    // risk: user messages — no chunk is dropped before the model session is ready.
    expect(await gate.shouldTranscribe(pcm)).toBe(true);
    await gate.warmModel('/silero.onnx');

    expect(vad.infer).toHaveBeenCalledTimes(2);
    expect(vad.infer.mock.calls[0][0]).toMatchObject({ operation: 'vad-chunk', modelPath: '/silero.onnx' });
    expect(vad.infer.mock.calls[0][2]).toBe(10_000);
    // risk: user messages — after prewarm, actual noise must be gated rather than fail-open on cold ORT startup.
    expect(await gate.shouldTranscribe(pcm)).toBe(false);
  });

  it('fails open for one timeout, retries inference, and reports interval counters', async () => {
    const success = (probability: number) => ({ ok: true, probabilities: [probability, probability], state: new Float32Array(256) });
    const vad = { infer: vi.fn()
      .mockResolvedValueOnce(success(0)) // warm-up
      .mockRejectedValueOnce(new Error('ONNX inference timed out'))
      .mockResolvedValueOnce(success(0.1))
      .mockResolvedValueOnce(success(0.9)) };
    const gate = new SpeechChunkGate(vad, null, () => true, () => undefined);
    await gate.warmModel('/silero.onnx');

    // risk: user messages — a transient timeout fails open for only that chunk; subsequent noise is still rejected.
    expect(await gate.shouldTranscribe(pcm)).toBe(true);
    expect(gate.takeStats()).toMatchObject({ chunksSeen: 1, admitted: 0, rejected: 0, failedOpen: 1, state: 'warm', consecutiveFailures: 1 });
    expect(await gate.shouldTranscribe(pcm)).toBe(false);
    expect(await gate.shouldTranscribe(pcm)).toBe(true);

    expect(gate.takeStats()).toMatchObject({ chunksSeen: 2, admitted: 1, rejected: 1, failedOpen: 0, state: 'warm', consecutiveFailures: 0 });
    expect(vad.infer).toHaveBeenCalledTimes(4);
  });

  it('keeps the model unavailable and the audio path fail-open if warm-up fails', async () => {
    const warn = vi.fn();
    const vad = { infer: vi.fn(async () => { throw new Error('ORT unavailable'); }) };
    const gate = new SpeechChunkGate(vad, null, () => true, warn);

    await expect(gate.warmModel('/silero.onnx')).rejects.toThrow('ORT unavailable');
    // risk: user messages — failed optional model initialization must never block or drop speech.
    expect(await gate.shouldTranscribe(pcm)).toBe(true);
  });

  it('drops noise and forwards speech through Silero inference', async () => {
    const vad = client(0.1);
    const gate = new SpeechChunkGate(vad, null, () => true, () => undefined);
    await gate.warmModel('/silero.onnx');
    // risk: user messages — a steady-noise chunk must never reach transcription.
    expect(await gate.shouldTranscribe(pcm)).toBe(false);
    expect(vad.infer).toHaveBeenCalledTimes(2);
    expect(vad.infer.mock.calls[1][0].audio).toHaveLength(1088); // 64 context + 2 frames

    const voice = client(0.8);
    const speechGate = new SpeechChunkGate(voice, null, () => true, () => undefined);
    await speechGate.warmModel('/silero.onnx');
    // risk: user messages — genuine speech must still be transcribed.
    expect(await speechGate.shouldTranscribe(pcm)).toBe(true);
  });

  it('retains a rejected onset chunk and exposes it before the admitted speech chunk', async () => {
    const vad = { infer: vi.fn()
      .mockResolvedValueOnce({ ok: true, probabilities: [0.1], state: new Float32Array(256) }) // warm-up
      .mockResolvedValueOnce({ ok: true, probabilities: [...Array(7).fill(0.1), 0.8], state: new Float32Array(256) })
      .mockResolvedValueOnce({ ok: true, probabilities: [0.1, 0.1, ...Array(6).fill(0.8)], state: new Float32Array(256) }) };
    const gate = new SpeechChunkGate(vad, '/silero.onnx', () => true, () => undefined);
    await gate.warmModel('/silero.onnx');
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
    const broken = { infer: vi.fn(async () => { throw new Error('ORT unavailable'); }) };
    const gate = new SpeechChunkGate(broken, '/silero.onnx', () => true, warn);
    await expect(gate.warmModel('/silero.onnx')).rejects.toThrow('ORT unavailable');
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
});
