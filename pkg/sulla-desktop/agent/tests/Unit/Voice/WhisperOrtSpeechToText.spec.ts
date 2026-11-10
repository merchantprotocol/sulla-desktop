// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { WhisperGreedyDecoder, type WhisperDecoderSession, type WhisperTensor } from '@pkg/main/voice/inference/WhisperGreedyDecoder';
import { WhisperTokenizerDecoder } from '@pkg/main/voice/inference/WhisperTokenizerDecoder';

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
