// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { WhisperGreedyDecoder, type WhisperDecoderSession, type WhisperTensor } from '@pkg/main/voice/inference/WhisperGreedyDecoder';
import { WhisperTokenizerDecoder } from '@pkg/main/voice/inference/WhisperTokenizerDecoder';
import { WhisperOrtSpeechToText } from '@pkg/main/voice/inference/WhisperOrtSpeechToText';
import { WhisperWindowPlanner } from '@pkg/main/voice/inference/WhisperWindowPlanner';

class TestTensorFactory {
  int64(values: BigInt64Array, dims: number[]): WhisperTensor { return { data: values, dims }; }
  bool(values: Uint8Array, dims: number[]): WhisperTensor { return { data: values, dims }; }
  float32(values: Float32Array, dims: number[]): WhisperTensor { return { data: values, dims }; }
}

class FakeWhisperDecoderSession implements WhisperDecoderSession {
  readonly inputNames = ['input_ids', 'encoder_hidden_states', 'use_cache_branch'];
  readonly outputNames = ['logits'];
  readonly seenInputIds: number[][] = [];
  runCount = 0;

  constructor(private readonly onRun?: () => void) {}

  async run(inputs: Record<string, WhisperTensor | unknown>): Promise<Record<string, WhisperTensor>> {
    this.runCount += 1;
    const ids = inputs.input_ids as WhisperTensor;
    this.seenInputIds.push(Array.from(ids.data, Number));
    this.onRun?.();
    const logits = new Float32Array(50_258);
    logits[this.runCount === 1 ? 10 : WhisperGreedyDecoder.endOfText] = 1;
    return { logits: { data: logits, dims: [1, 1, logits.length] } };
  }
}

describe('WhisperTokenizerDecoder', () => {
  it('reconstructs byte-level BPE spaces, punctuation and UTF-8 text exactly', () => { // risk: recognized words corrupted or lost
    const tokenizer = new WhisperTokenizerDecoder(JSON.stringify({
      model: { vocab: { hello: 1, 'Ġ': 2, ',': 3, 'Ã©': 4, '!': 5 } },
      added_tokens: [{ id: 99, content: '<|endoftext|>', special: true }],
    }));

    expect(tokenizer.decode([1, 2, 3, 2, 4, 5, 99])).toBe('hello , é!');
  });
});

describe('WhisperGreedyDecoder', () => {
  it('feeds forced English transcribe prefix, greedily decodes, then stops at end-of-text', async () => { // risk: no transcript or truncated words
    const session = new FakeWhisperDecoderSession();
    const decoder = new WhisperGreedyDecoder(new TestTensorFactory());

    await expect(decoder.decode(session, { data: new Float32Array(2), dims: [1, 1, 2] }, new AbortController().signal))
      .resolves.toEqual([10]);
    expect(session.seenInputIds).toEqual([[50258, 50259, 50359, 50363], [10]]);
  });

  it('honors abort immediately between decoder steps', async () => { // risk: canceled audio continues running and emits stale words
    const controller = new AbortController();
    const session = new FakeWhisperDecoderSession(() => controller.abort());
    const decoder = new WhisperGreedyDecoder(new TestTensorFactory());

    await expect(decoder.decode(session, { data: new Float32Array(2), dims: [1, 1, 2] }, controller.signal))
      .rejects.toThrow(/aborted/);
    expect(session.runCount).toBe(1);
  });
});

class FakeWhisperModels {
  async resolve(id: string): Promise<string> { return id; }
}

class FakeWhisperInference {
  readonly seen: Float32Array[] = [];
  constructor(private readonly result: () => Promise<{ ok: boolean; text?: string; error?: string }> = async () => ({ ok: true, text: 'word' })) {}
  async infer(request: { audio: Float32Array }): Promise<{ ok: boolean; text?: string; error?: string }> {
    this.seen.push(request.audio.slice());
    return this.result();
  }
}

async function* audioOf(samples: Float32Array): AsyncIterable<Float32Array> { yield samples; }

describe('WhisperOrtSpeechToText', () => {
  it('decodes long audio in ordered windows covering each sample once and returns one joined event', async () => { // risk: long utterances lose spoken words
    const input = Float32Array.from({ length: 75 * 16_000 }, (_, i) => i / (75 * 16_000));
    const inference = new FakeWhisperInference();
    const stt = new WhisperOrtSpeechToText(new FakeWhisperModels() as never, inference as never, { debug() {} });
    await expect(stt.transcribe(audioOf(input), 7, new AbortController().signal)).resolves.toEqual([
      { kind: 'final', text: 'word word word', sequenceId: 7 },
    ]);
    expect(inference.seen).toHaveLength(3);
    expect(inference.seen.flatMap(window => Array.from(window))).toEqual(Array.from(input));
  });

  it('chooses a quiet 20ms boundary near the 30s limit instead of a loud frame', () => { // risk: splitting words at loud boundaries harms recognition
    const input = new Float32Array(31 * 16_000).fill(1);
    const quietEnd = 29 * 16_000 + 320;
    input.fill(0, quietEnd - 320, quietEnd);
    const [first] = new WhisperWindowPlanner().plan(input);
    expect(first.length).toBe(quietEnd);
    expect(first.length % 320).toBe(0);
  });

  it.each([
    ['rejection', async () => { throw new Error('offline'); }],
    ['negative response', async () => ({ ok: false, error: 'offline' })],
    ['missing text', async () => ({ ok: true })],
  ])('surfaces inference %s instead of silently returning an empty transcript', async (_name, result) => { // risk: inference failures silently erase user speech
    const inference = new FakeWhisperInference(result as never);
    const stt = new WhisperOrtSpeechToText(new FakeWhisperModels() as never, inference as never, { debug() {} });
    await expect(stt.transcribe(audioOf(new Float32Array(100)), 1, new AbortController().signal)).rejects.toThrow();
  });

  it('returns no events and performs no inference when already aborted', async () => { // risk: canceled utterance produces stale transcript
    const inference = new FakeWhisperInference();
    const stt = new WhisperOrtSpeechToText(new FakeWhisperModels() as never, inference as never, { debug() {} });
    const controller = new AbortController(); controller.abort();
    await expect(stt.transcribe(audioOf(new Float32Array(100)), 1, controller.signal)).resolves.toEqual([]);
    expect(inference.seen).toHaveLength(0);
  });
});
