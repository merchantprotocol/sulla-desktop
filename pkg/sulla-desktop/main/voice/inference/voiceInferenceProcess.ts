// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as ort from 'onnxruntime-node';
import type { OrtRequest, OrtResponse } from './OrtInferenceClient';
import { WhisperLogMelExtractor } from './WhisperLogMelExtractor';

/** Owns model sessions and Smart Turn feature extraction in the utility process. */
export class VoiceInferenceProcess {
  private readonly sessions = new Map<string, Promise<ort.InferenceSession>>();

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
    try {
      const session = await this.session(request.modelPath, request.threads);
      const response =
        request.operation === 'vad'
          ? await this.runVad(session, request)
          : await this.runSmartTurn(session, request);
      this.port.postMessage({ id: request.id, ok: true, ...response } satisfies OrtResponse);
    } catch (error) {
      this.port.postMessage({ id: request.id, ok: false, error: String(error) } satisfies OrtResponse);
    }
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
