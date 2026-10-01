/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: { invoke: jest.fn(() => Promise.resolve()), on: jest.fn(), send: jest.fn() },
}));

const { TTSPlayerService } = await import('../TTSPlayerService');

function settingsAnd(speak: (...args: any[]) => Promise<any>) {
  return jest.fn(async(channel: string, ...args: any[]) => {
    if (channel === 'sulla-settings-get') return args[1];
    if (channel === 'audio-speak') return speak(...args);

    return undefined;
  });
}

describe('TTSPlayerService', () => {
  const synthSpeak = jest.fn();

  beforeEach(() => {
    synthSpeak.mockReset();
    (window as any).speechSynthesis = { speak: synthSpeak, cancel: jest.fn(), getVoices: () => [] };
  });

  afterEach(() => {
    delete (window as any).speechSynthesis;
  });

  it('never falls back to the OS voice when Kokoro cannot synthesize', async() => {
    const ipcInvoke = settingsAnd(() => Promise.reject(new Error('Kokoro voice model is not ready (downloading)')));
    const player = new TTSPlayerService({ ipcInvoke });
    const drained = new Promise<void>(resolve => player.on('queueEmpty', () => resolve()));

    player.enqueue('Hello there. This should stay silent.');
    await drained;

    expect(ipcInvoke).toHaveBeenCalledWith('audio-speak', expect.anything());
    expect(synthSpeak).not.toHaveBeenCalled();
    expect(player.isPlaying).toBe(false);
  });
});

describe('TTSPlayerService one voice', () => {
  it('silences another player when a second one starts speaking', async() => {
    const pending: (() => void)[] = [];
    const slow = settingsAnd(() => new Promise((resolve) => {
      pending.push(() => resolve({}));
    }));
    const first = new TTSPlayerService({ ipcInvoke: slow });
    const second = new TTSPlayerService({ ipcInvoke: slow });
    const firstStopped = new Promise<void>(resolve => first.on('queueEmpty', () => resolve()));

    first.enqueue('First conversation is talking.');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(first.isPlaying).toBe(true);

    second.enqueue('Second conversation starts talking.');
    await firstStopped;

    expect(first.isPlaying).toBe(false);
    expect(second.isPlaying).toBe(true);
    second.stop();
    pending.forEach(r => r());
  });
});
