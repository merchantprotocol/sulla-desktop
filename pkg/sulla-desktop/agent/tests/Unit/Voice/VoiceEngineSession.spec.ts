// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { HeuristicEndOfTurnDetector } from '@pkg/composables/voice/ConversationTurnPolicy';
import { VoiceEngineSession } from '@pkg/main/voice/engine/VoiceEngineSession';
import { SemanticEndOfTurnAdapter } from '@pkg/main/voice/engine/SemanticEndOfTurnAdapter';
import { ModelRepository } from '@pkg/main/voice/engine/ModelRepository';
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
