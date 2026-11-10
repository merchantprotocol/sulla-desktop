// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import type { KokoroSynthesis, KokoroSynthesizer } from '@pkg/main/voice/tts/KokoroSynthesizer';
import { KokoroTextToSpeech } from '@pkg/main/voice/tts/KokoroTextToSpeech';
import { LocalTurnEngineFactory } from '@pkg/main/voice/inference/LocalTurnEngineFactory';

const logger = { debug: vi.fn() };

/** Fake Kokoro: records every sentence it was asked to speak and encodes the sentence in the chunk bytes. */
class ScriptedKokoro implements KokoroSynthesizer {
  readonly spoken: string[] = [];

  constructor(private readonly behave: (text: string, call: number) => Promise<KokoroSynthesis> | KokoroSynthesis = ok) {}

  async synthesize(text: string): Promise<KokoroSynthesis> {
    this.spoken.push(text);
    return this.behave(text, this.spoken.length);
  }
}

function ok(text: string): KokoroSynthesis {
  return { data: new Uint8Array(Buffer.from(text, 'utf8')), sampleRate: 24000 };
}

async function collect(
  tts: KokoroTextToSpeech,
  text: string,
  signal: AbortSignal,
  onChunk: (decoded: string, index: number) => void = () => undefined,
): Promise<string[]> {
  const decoded: string[] = [];
  for await (const chunk of tts.synthesize(text, 7, signal)) {
    const value = Buffer.from(chunk.data).toString('utf8');
    decoded.push(value);
    onChunk(value, decoded.length);
  }
  return decoded;
}

describe('KokoroTextToSpeech behavior', () => {
  it('stops yielding and never calls the engine again after the turn is aborted mid-reply', async () => { // risk: interrupted speech
    const kokoro = new ScriptedKokoro();
    const tts = new KokoroTextToSpeech(kokoro, logger);
    const controller = new AbortController();

    const chunks = await collect(tts, 'One. Two. Three. Four.', controller.signal, () => controller.abort());

    expect(chunks).toEqual(['One.']);
    expect(kokoro.spoken).toHaveLength(1);
  });

  it('drops a sentence that finishes synthesis after the abort fired', async () => { // risk: cancelled turn audio
    const controller = new AbortController();
    const kokoro = new ScriptedKokoro((text, call) => {
      if (call === 2) controller.abort();
      return ok(text);
    });
    const tts = new KokoroTextToSpeech(kokoro, logger);

    const chunks = await collect(tts, 'One. Two. Three.', controller.signal);

    expect(chunks).toEqual(['One.']);
    expect(kokoro.spoken).toHaveLength(2);
  });

  it('skips a sentence Kokoro cannot speak and keeps speaking the rest without a system voice', async () => { // risk: missing words and system-voice fallback
    const kokoro = new ScriptedKokoro((text, call) => {
      if (call === 2) throw new Error('TTS settlement failed');
      return ok(text);
    });
    const tts = new KokoroTextToSpeech(kokoro, logger);

    const chunks = await collect(tts, 'Alpha one. Beta two. Gamma three.', new AbortController().signal);

    expect(chunks).toEqual(['Alpha one.', 'Gamma three.']);
    expect(kokoro.spoken).toEqual(['Alpha one.', 'Beta two.', 'Gamma three.']);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it('synthesizes every sentence of a long reply with no length cap and no lost words', async () => { // risk: word loss
    const sentences = Array.from({ length: 300 }, (_, index) => `Sentence ${index} has words.`);
    const longRun = Array.from({ length: 120 }, (_, index) => `clause${index}`).join(' ') + '.';
    const reply = [...sentences, longRun].join(' ');
    const kokoro = new ScriptedKokoro();
    const tts = new KokoroTextToSpeech(kokoro, logger);

    const chunks = await collect(tts, reply, new AbortController().signal);

    expect(chunks.join(' ').split(/\s+/)).toEqual(reply.split(/\s+/));
    expect(kokoro.spoken.length).toBeGreaterThanOrEqual(sentences.length + 1);
  });

  it('constructs no local engines, including Kokoro, while the flag is off', async () => { // risk: live path changed by default
    const resolve = vi.fn();
    const factory = new LocalTurnEngineFactory(
      { resolve } as never,
      {} as never,
      logger,
      { now: () => 0 } as never,
      false,
      new ScriptedKokoro(),
    );

    await expect(factory.create()).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
