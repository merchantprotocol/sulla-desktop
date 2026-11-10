// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as ort from 'onnxruntime-node';
import { readFile } from 'node:fs/promises';
import type { OrtRequest, OrtResponse } from './OrtInferenceClient';
import { WhisperLogMelExtractor } from './WhisperLogMelExtractor';
import { WhisperGreedyDecoder, type WhisperTensor } from './WhisperGreedyDecoder';
import { WhisperTokenizerDecoder } from './WhisperTokenizerDecoder';

/** Owns model sessions and Smart Turn feature extraction in the utility process. */
export class VoiceInferenceProcess {
  private readonly sessions = new Map<string, Promise<ort.InferenceSession>>();
  private readonly cancelled = new Set<number>();
  private readonly tokenizerDecoders = new Map<string, Promise<WhisperTokenizerDecoder>>();

  constructor(
    private readonly runtime: typeof ort,
    private readonly port: NonNullable<NodeJS.Process['parentPort']>,
    private readonly extractor: WhisperLogMelExtractor,
  ) {
    this.port.on('message', event => {
      void this.handle(event.data as OrtRequest);
    });
  }

  private async handle(request: OrtRequest): Promise<void> {
    if (request.operation === 'cancel') {
      if (request.targetId !== undefined) this.cancelled.add(request.targetId);
      return;
    }
    try {
      const session = await this.session(request.modelPath, request.threads);
      const response =
        request.operation === 'vad'
          ? await this.runVad(session, request)
          : request.operation === 'smart-turn'
            ? await this.runSmartTurn(session, request)
            : await this.runWhisper(session, request);
      this.port.postMessage({ id: request.id, ok: true, ...response } satisfies OrtResponse);
    } catch (error) {
      this.port.postMessage({ id: request.id, ok: false, error: String(error) } satisfies OrtResponse);
    } finally {
      this.cancelled.delete(request.id);
    }
  }

  private async runWhisper(
    encoder: ort.InferenceSession,
    request: OrtRequest,
  ): Promise<Pick<OrtResponse, 'text'>> {
    if (!request.decoderPath || !request.tokenizerPath) throw new Error('Whisper model paths are required');
    const signal = { get aborted() { return thisProcess.cancelled.has(request.id); } };
    const thisProcess = this;
    const features = new WhisperLogMelExtractor(30, false, false).extract(request.audio);
    const featureTensor = new this.runtime.Tensor('float32', features, [1, 80, 3000]);
    const encoderInput = encoder.inputNames.find(name => name.includes('input_features')) ?? encoder.inputNames[0];
    const encoded = await encoder.run({ [encoderInput]: featureTensor });
    if (signal.aborted) throw new Error('Whisper transcription aborted');
    const hiddenName = encoder.outputNames.find(name => name.includes('last_hidden_state')) ?? encoder.outputNames[0];
    const hidden = encoded[hiddenName] as unknown as WhisperTensor;
    if (!hidden) throw new Error('Whisper encoder returned no hidden states');
    const decoder = await this.session(request.decoderPath, request.threads);
    let tokenizer = this.tokenizerDecoders.get(request.tokenizerPath);
    if (!tokenizer) {
      tokenizer = readFile(request.tokenizerPath, 'utf8').then(json => new WhisperTokenizerDecoder(json));
      this.tokenizerDecoders.set(request.tokenizerPath, tokenizer);
    }
    const decoderLoop = new WhisperGreedyDecoder({
      int64: (values, dims) => new this.runtime.Tensor('int64', values, dims) as unknown as WhisperTensor,
      bool: (values, dims) => new this.runtime.Tensor('bool', values, dims) as unknown as WhisperTensor,
      float32: (values, dims) => new this.runtime.Tensor('float32', values, dims) as unknown as WhisperTensor,
    });
    const ids = await decoderLoop.decode(decoder as unknown as Parameters<WhisperGreedyDecoder['decode']>[0], hidden, signal);
    return { text: (await tokenizer).decode(ids).trim() };
  }

  private session(modelPath: string, threads: number): Promise<ort.InferenceSession> {
    let value = this.sessions.get(modelPath);
    if (!value) {
      value = this.runtime.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
      });
      this.sessions.set(modelPath, value);
    }
    return value;
  }

  private async runVad(
    session: ort.InferenceSession,
    request: OrtRequest,
  ): Promise<Pick<OrtResponse, 'probability' | 'state'>> {
    if (request.audio.length !== 576) {
      throw new Error('Silero VAD requires 64 context + 512 samples at 16 kHz');
    }
    const state = request.state ?? new Float32Array(2 * 1 * 128);
    const output = await session.run({
      input: new this.runtime.Tensor('float32', request.audio, [1, 576]),
      state: new this.runtime.Tensor('float32', state, [2, 1, 128]),
      sr: new this.runtime.Tensor('int64', BigInt64Array.from([16_000n]), [1]),
    });
    const probability = Number((output.output?.data as Float32Array)?.[0]);
    const next = output.stateN?.data as Float32Array;
    if (!Number.isFinite(probability) || !next) throw new Error('Unexpected Silero output signature');
    return { probability, state: new Float32Array(next) };
  }

  private async runSmartTurn(
    session: ort.InferenceSession,
    request: OrtRequest,
  ): Promise<Pick<OrtResponse, 'probability'>> {
    const features = this.extractor.extract(request.audio);
    const input = new this.runtime.Tensor('float32', features, [1, 80, 800]);
    const output = await session.run({ input_features: input });
    const probability = Number(Object.values(output)[0].data[0]);
    if (!Number.isFinite(probability)) throw new Error('Invalid Smart Turn probability');
    return { probability };
  }
}

if (process.parentPort) {
  new VoiceInferenceProcess(ort, process.parentPort, new WhisperLogMelExtractor());
}
