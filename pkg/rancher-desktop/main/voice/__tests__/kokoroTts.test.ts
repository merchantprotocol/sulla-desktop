import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@pkg/utils/paths', () => ({ __esModule: true, default: { sullaConfig: '/tmp/sulla-kokoro-test' } }));

import { KOKORO_DEFAULT_VOICE, KOKORO_VOICES, cleanForSpeech, encodeWav, kokoroVoiceFor } from '../kokoroTts';

describe('kokoro voices', () => {
  it('defaults to Bella (speaker 2 in the Kokoro v1.0 table)', () => {
    expect(KOKORO_DEFAULT_VOICE).toBe('af_bella');
    expect(kokoroVoiceFor(undefined)).toMatchObject({ key: 'af_bella', sid: 2, name: 'Bella' });
    expect(KOKORO_VOICES[0].key).toBe('af_bella');
  });

  it('falls back to Bella for voices from other providers', () => {
    expect(kokoroVoiceFor('cgSgspJ2msm6clMCkdW9').key).toBe('af_bella');
    expect(kokoroVoiceFor('eve').key).toBe('af_bella');
  });

  it('resolves a known voice', () => {
    expect(kokoroVoiceFor('bm_george')).toMatchObject({ sid: 26, accent: 'British', gender: 'Male' });
  });

  it('has 28 unique English speakers', () => {
    expect(new Set(KOKORO_VOICES.map(v => v.sid)).size).toBe(28);
  });
});

describe('cleanForSpeech', () => {
  it('strips markdown Kokoro would read aloud', () => {
    expect(cleanForSpeech('**Done.** See `main.ts` and [the PR](https://github.com/x/y/pull/1).')).toBe('Done. See main.ts and the PR.');
  });

  it('replaces bare URLs and drops code blocks', () => {
    expect(cleanForSpeech('Open https://example.com/a?b=c now.\n```js\nx()\n```\nThen reload.')).toBe('Open the link now. Then reload.');
  });

  it('drops heading and bullet markers', () => {
    expect(cleanForSpeech('## Status\n- build green\n- tests green')).toBe('Status build green tests green');
  });
});

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header and clamps samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 24000);

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect(wav.readInt16LE(44 + 2)).toBe(0x7FFF);
    expect(wav.readInt16LE(44 + 4)).toBe(-0x8000);
    expect(wav.readInt16LE(44 + 6)).toBe(0x7FFF);
  });
});
