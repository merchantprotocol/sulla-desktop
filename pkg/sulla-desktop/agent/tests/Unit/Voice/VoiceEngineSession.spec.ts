// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

import { HeuristicEndOfTurnDetector } from '@pkg/composables/voice/ConversationTurnPolicy';
import { VoiceEngineSession } from '@pkg/main/voice/engine/VoiceEngineSession';
import { SemanticEndOfTurnAdapter } from '@pkg/main/voice/engine/SemanticEndOfTurnAdapter';
import { ModelRepository } from '@pkg/main/voice/engine/ModelRepository';
import { OrtInferenceClient } from '@pkg/main/voice/inference/OrtInferenceClient';
import { OrtSileroVad } from '@pkg/main/voice/inference/OrtVoiceEngines';
import { WhisperLogMelExtractor } from '@pkg/main/voice/inference/WhisperLogMelExtractor';
import {
  FakeSemanticEndOfTurn,
  FakeSpeechToText,
  FakeTextToSpeech,
} from '@pkg/main/voice/testing/FakeVoiceEngines';

const logger = { debug: vi.fn() };

describe('VoiceEngineSession behavior', () => {
  it('drops stale sequence results', () => { // risk: stale cross-turn data
    const session = new VoiceEngineSession(new FakeSpeechToText(), new FakeTextToSpeech(), logger);
    const old = session.startTurn();
    const current = session.startTurn();

    expect(session.acceptTranscript({ sequenceId: old, kind: 'final', text: 'stale' })).toBe(false);
    expect(session.acceptTranscript({ sequenceId: current, kind: 'final', text: 'current' })).toBe(true);
  });

  it('aborts in-flight TTS on barge-in and emits no later audio', async () => { // risk: interrupted speech
    let signal: AbortSignal | undefined;
    const tts = {
      async *synthesize(_text: string, id: number, s: AbortSignal) {
        signal = s;
        yield { sequenceId: id, data: new Uint8Array([1]), sampleRate: 24000 };
        await new Promise(resolve => setTimeout(resolve, 0));
        yield { sequenceId: id, data: new Uint8Array([2]), sampleRate: 24000 };
      },
    };
    const session = new VoiceEngineSession(new FakeSpeechToText(), tts, logger);
    session.startTurn();
    const emitted: number[] = [];

    let firstAudio!: () => void;
    const audioStarted = new Promise<void>(resolve => {
      firstAudio = resolve;
    });
    const speaking = (async () => {
      for await (const _chunk of session.speak('hello', chunk => {
        emitted.push(chunk.data[0]);
        firstAudio();
      })) {
        // drain
      }
    })();

    await audioStarted;
    session.cancelTurn();
    await speaking;

    expect(signal?.aborted).toBe(true);
    expect(emitted).toEqual([1]);
  });

  it('returns a cancelled turn transcript intact for caller merge', () => { // risk: transcript word loss
    const session = new VoiceEngineSession(new FakeSpeechToText(), new FakeTextToSpeech(), logger);
    const id = session.startTurn();
    session.acceptTranscript({ sequenceId: id, kind: 'final', text: 'never lose these words' });

    expect(session.cancelTurn()).toBe('never lose these words');
  });

  it('keeps committed words out of the next turn, and carries cancelled words only when merged', () => { // risk: word leakage and transcript word loss
    const session = new VoiceEngineSession(new FakeSpeechToText(), new FakeTextToSpeech(), logger);

    const first = session.startTurn();
    session.acceptTranscript({ sequenceId: first, kind: 'final', text: 'committed words' });
    expect(session.commitTurn()).toBe('committed words');

    const second = session.startTurn();
    session.acceptTranscript({ sequenceId: second, kind: 'final', text: 'fresh turn' });
    expect(session.commitTurn()).toBe('fresh turn');

    const third = session.startTurn();
    session.acceptTranscript({ sequenceId: third, kind: 'final', text: 'cancelled words' });
    const fourth = session.startTurn({ mergePrevious: true });
    session.acceptTranscript({ sequenceId: fourth, kind: 'final', text: 'next words' });
    expect(session.commitTurn()).toBe('cancelled words next words');
  });

  it.each([
    new FakeSemanticEndOfTurn({ complete: 'unknown', probability: 0 }),
    new FakeSemanticEndOfTurn(new Error('offline')),
  ])('uses heuristic fallback on uncertainty or failure', async engine => { // risk: premature turn commit
    const adapter = new SemanticEndOfTurnAdapter(new HeuristicEndOfTurnDetector(), engine, logger);

    expect(await adapter.delayMsWithContext('and', new Float32Array(), 700, 1, new AbortController().signal)).toBe(1400);
  });

  it('uses heuristic fallback when semantic classification times out', async () => { // risk: premature turn commit
    const never = { classify: () => new Promise<never>(() => {}) };
    const adapter = new SemanticEndOfTurnAdapter(new HeuristicEndOfTurnDetector(), never, logger, { timeoutMs: 5 });

    expect(await adapter.delayMsWithContext('and', new Float32Array(), 700, 1, new AbortController().signal)).toBe(1400);
  });

  it('never shortens a confident completion below the minimum hold', async () => { // risk: cutting the speaker off mid-thought
    const confident = new FakeSemanticEndOfTurn({ complete: true, probability: 1 });
    const adapter = new SemanticEndOfTurnAdapter(new HeuristicEndOfTurnDetector(), confident, logger);

    expect(await adapter.delayMsWithContext('done', new Float32Array(), 700, 1, new AbortController().signal)).toBe(250);
  });
});

describe('ModelRepository integrity', () => {
  it('rejects and deletes a hash-mismatched download, and accepts a match', async () => { // risk: untrusted model execution
    const dir = await mkdtemp(join(tmpdir(), 'voice-model-'));
    const bodyText = 'verified model';
    const digest = createHash('sha256').update(bodyText).digest('hex');
    const response = (text: string) => ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
    });
    let payload = 'wrong';
    const repo = new ModelRepository(
      () => dir,
      { defaults: [{ id: 'model', url: 'local://model', sha256: digest, sizeBytes: bodyText.length }] },
      { fetch: async () => response(payload) },
    );

    try {
      await expect(repo.resolve('model')).rejects.toThrow(/SHA-256 mismatch/);
      await expect(access(join(dir, 'voice-models/model.model'))).rejects.toThrow();
      payload = bodyText;
      const path = await repo.resolve('model');
      expect(await readFile(path, 'utf8')).toBe(bodyText);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe('local ONNX turn inference safety', () => {
  it('prepends Silero context and timestamps events with its injected clock', async () => { // risk: missing speech context can drop boundary words
    class FakeChild {
      handlers: Record<string, (value: any) => void> = {};
      requests: any[] = [];
      on(event: string, callback: (value: any) => void): void { this.handlers[event] = callback; }
      postMessage(request: any): void { this.requests.push(request); }
      respond(index: number): void { this.handlers.message({ id: index + 1, ok: true, probability: 0.9, state: new Float32Array(256) }); }
    }
    const child = new FakeChild();
    const client = new OrtInferenceClient('unused', 1000, 3, 1, () => child);
    const vad = new OrtSileroVad(client, 'silero', 0.5, 0.35, 300, { now: () => 1_234 });
    const first = Float32Array.from({ length: 512 }, (_, index) => index);
    const firstEvents = vad.process(first, 1, new AbortController().signal);
    expect(child.requests[0].audio).toHaveLength(576);
    expect([...child.requests[0].audio.slice(0, 64)]).toEqual(new Array(64).fill(0));
    child.respond(0);
    await expect(firstEvents).resolves.toEqual([{ kind: 'speech-start', sequenceId: 1, timestampMs: 1_234 }]);

    const second = new Float32Array(512).fill(900);
    const secondEvents = vad.process(second, 2, new AbortController().signal);
    expect([...child.requests[1].audio.slice(0, 64)]).toEqual(Array.from({ length: 64 }, (_, index) => index + 448));
    child.respond(1);
    await expect(secondEvents).resolves.toEqual([]);
  });

  it('rejects pending calls on utility exit and respawns for the next call', async () => { // risk: stale/hung inference after crash
    class FakeChild {
      handlers: Record<string, (value: any) => void> = {};
      on(event: string, callback: (value: any) => void): void { this.handlers[event] = callback; }
      postMessage(): void {}
      exit(): void { this.handlers.exit(1); }
    }
    const children: FakeChild[] = [];
    const client = new OrtInferenceClient('unused', 1000, 3, 1, () => {
      const next = new FakeChild();
      children.push(next);
      return next;
    });
    const pending = client.infer({ operation: 'vad', modelPath: 'silero', audio: new Float32Array(512) });
    children[0].exit();
    await expect(pending).rejects.toThrow(/exited/);
    const next = client.infer({ operation: 'vad', modelPath: 'silero', audio: new Float32Array(512) });
    expect(children).toHaveLength(2);
    children[1].handlers.message({ id: 2, ok: true, probability: 0.1, state: new Float32Array(256) });
    await expect(next).resolves.toMatchObject({ ok: true, probability: 0.1 });
  });
  it.each([0, 16_001, 160_000])('creates the fixed 800-frame Smart Turn window for %s samples', samples => { // risk: malformed model input from padding/cropping
    const features = new WhisperLogMelExtractor().extract(new Float32Array(samples));
    expect(features).toHaveLength(800 * 80);
    expect([...features].every(Number.isFinite)).toBe(true);
  });

  it('places a 1 kHz tone in the expected mel row across frames', () => { // risk: scrambled Smart Turn model input
    const audio = Float32Array.from({ length: 128_000 }, (_, index) => Math.sin((2 * Math.PI * 1_000 * index) / 16_000));
    const features = new WhisperLogMelExtractor().extract(audio);
    const rowEnergy = Array.from({ length: 80 }, (_, bin) => {
      let total = 0;
      for (let frame = 100; frame < 700; frame++) total += features[bin * 800 + frame];
      return total / 600;
    });

    expect(rowEnergy.indexOf(Math.max(...rowEnergy))).toBe(26);
  });

  it('matches the exact 400-point FFT power bins against the direct DFT', () => { // risk: corrupted business-critical Smart Turn features
    const extractor = new WhisperLogMelExtractor();
    const frame = Float32Array.from({ length: 400 }, (_, index) => Math.sin(index * 12.34) + Math.cos(index * 0.91) * 0.25);
    const hann = (index: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / 400);
    const expected = Array.from({ length: 201 }, (_, frequency) => {
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < 400; index++) {
        const sample = frame[index] * hann(index);
        const angle = (2 * Math.PI * frequency * index) / 400;
        real += sample * Math.cos(angle);
        imaginary -= sample * Math.sin(angle);
      }
      return real ** 2 + imaginary ** 2;
    });

    const actual = extractor.powerSpectrumForFrame(frame);
    for (let index = 0; index < expected.length; index++) {
      expect(actual[index]).toBeCloseTo(expected[index], 7);
    }
  });
});
