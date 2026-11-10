// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface WhisperTensor {
  data: ArrayLike<number | bigint>;
  dims: readonly number[];
}

export interface WhisperDecoderSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(inputs: Record<string, WhisperTensor | unknown>): Promise<Record<string, WhisperTensor>>;
}

export interface WhisperTensorFactory {
  int64(values: BigInt64Array, dims: number[]): WhisperTensor;
  bool(values: Uint8Array, dims: number[]): WhisperTensor;
  float32(values: Float32Array, dims: number[]): WhisperTensor;
}

/** Greedy Whisper decoder for Xenova's merged decoder, including its optional KV cache. */
export class WhisperGreedyDecoder {
  static readonly endOfText = 50257;
  static readonly prefix = [50258, 50259, 50359, 50363];
  static readonly maxTokens = 224;

  constructor(private readonly tensors: WhisperTensorFactory) {}

  async decode(
    session: WhisperDecoderSession,
    encoderHiddenStates: WhisperTensor,
    signal: { readonly aborted: boolean },
  ): Promise<number[]> {
    const generated: number[] = [];
    const cacheInputs = session.inputNames.filter(name => name.startsWith('past_key_values.'));
    let past: Record<string, WhisperTensor> = {};
    let previous = WhisperGreedyDecoder.prefix;
    for (let step = 0; step < WhisperGreedyDecoder.maxTokens; step++) {
      if (signal.aborted) throw new Error('Whisper transcription aborted');
      const first = step === 0;
      const idName = session.inputNames.find(name => name.includes('input_ids'));
      const hiddenName = session.inputNames.find(name => name.includes('encoder_hidden_states'));
      if (!idName || !hiddenName) throw new Error('Unexpected Whisper decoder input signature');
      const feed: Record<string, WhisperTensor | unknown> = {
        [idName]: this.tensors.int64(BigInt64Array.from(previous, BigInt), [1, previous.length]),
        [hiddenName]: encoderHiddenStates,
      };
      const cacheBranchName = session.inputNames.find(name => name.includes('use_cache_branch'));
      if (cacheBranchName) {
        feed[cacheBranchName] = this.tensors.bool(Uint8Array.of(first ? 0 : 1), [1]);
      }
      for (const name of cacheInputs) {
        feed[name] = past[name] ?? this.tensors.float32(new Float32Array(0), [1, 6, 0, 64]);
      }
      const output = await session.run(feed);
      if (signal.aborted) throw new Error('Whisper transcription aborted');
      const logitsName = session.outputNames.find(name => name.includes('logits')) ?? session.outputNames[0];
      const logits = output[logitsName];
      if (!logits?.data?.length) throw new Error('Whisper decoder returned no logits');
      const vocabSize = logits.dims[logits.dims.length - 1];
      const offset = (logits.dims.length >= 3 ? logits.data.length - vocabSize : 0);
      let token = 0;
      let maximum = -Infinity;
      for (let index = 0; index < vocabSize; index++) {
        const value = Number(logits.data[offset + index]);
        if (value > maximum) { maximum = value; token = index; }
      }
      if (token === WhisperGreedyDecoder.endOfText) return generated;
      generated.push(token);
      previous = [token];
      const nextPast: Record<string, WhisperTensor> = {};
      for (const name of session.outputNames) {
        if (!name.startsWith('present.')) continue;
        const inputName = name.replace(/^present\./, 'past_key_values.');
        if (cacheInputs.includes(inputName) && output[name]) nextPast[inputName] = output[name];
      }
      if (Object.keys(nextPast).length) past = nextPast;
    }
    return generated;
  }
}
