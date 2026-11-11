// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createRequire } from 'node:module';
import path from 'node:path';

interface Request { id: number; modelPath: string; audio: Float32Array; sampleRate: number; appRoot: string; }
interface Response { id: number; ok: boolean; embedding?: number[]; error?: string; }

/** Utility-process entry; native sherpa inference stays off the main process. */
class SpeakerEmbeddingProcess {
  private extractor: any;
  private modelPath = '';
  constructor(private readonly port: NonNullable<NodeJS.Process['parentPort']>) {
    port.on('message', event => { void this.handle(event.data as Request); });
  }
  private async handle(request: Request): Promise<void> {
    try {
      if (!this.extractor || this.modelPath !== request.modelPath) {
        const sherpa = createRequire(path.join(request.appRoot, 'package.json'))('sherpa-onnx-node');
        this.extractor = new sherpa.SpeakerEmbeddingExtractor(new sherpa.SpeakerEmbeddingExtractorConfig({ model: request.modelPath, numThreads: 1, debug: false, provider: 'cpu' }));
        this.modelPath = request.modelPath;
      }
      const stream = this.extractor.createStream();
      stream.acceptWaveform(request.sampleRate, request.audio);
      const embedding = Array.from(this.extractor.compute(stream) as ArrayLike<number>);
      this.port.postMessage({ id: request.id, ok: true, embedding } satisfies Response);
    } catch (error) {
      this.port.postMessage({ id: request.id, ok: false, error: String(error) } satisfies Response);
    }
  }
}

if (process.parentPort) new SpeakerEmbeddingProcess(process.parentPort);
