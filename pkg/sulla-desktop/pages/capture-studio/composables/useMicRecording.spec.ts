// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ invoke: vi.fn(), createWriteStream: vi.fn(), createConnection: vi.fn(), openSync: vi.fn(() => 1), writeSync: vi.fn(), closeSync: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: { invoke: mocked.invoke } }));
vi.mock('fs', () => ({ createWriteStream: mocked.createWriteStream, openSync: mocked.openSync, writeSync: mocked.writeSync, closeSync: mocked.closeSync }));
vi.mock('net', () => ({ createConnection: mocked.createConnection }));

import { useMicRecording } from './useMicRecording';

class FakeWriteStream extends EventEmitter {
  destroyed = false;
  writableFinished = false;
  writes: Buffer[] = [];
  write(chunk: Buffer): boolean { this.writes.push(Buffer.from(chunk)); return true; }
  end(): void { this.writableFinished = true; queueMicrotask(() => this.emit('finish')); }
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): void { this.destroyed = true; this.emit('close'); }
}

function pcmFrame(value: number): Buffer {
  const payload = Buffer.alloc(960, 0);
  payload.writeInt16LE(value, 0);
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

describe('useMicRecording pause and format behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.invoke.mockImplementation(async(channel: string) => {
      if (channel === 'audio-driver:get-mic-pcm-socket-path') return '/mic-pcm';
      if (channel === 'audio-driver:get-state') return { micSampleRate: 48000 };
      return undefined;
    });
  });

  it('holds a pre-start pause, writes valid PCM WAV across streaming-mode pauses, and inserts resumed timeline silence', async() => {
    // risk: recording integrity — no first-frame leak or broken WebM chunks when a compressed preference is paused.
    const output = new FakeWriteStream();
    const socket = new FakeSocket();
    mocked.createWriteStream.mockReturnValue(output);
    mocked.createConnection.mockReturnValue(socket);
    const recording = useMicRecording();

    recording.setPaused(true);
    const start = recording.start('/tmp/mic.wav', 'streaming');
    await vi.waitFor(() => expect(mocked.createConnection).toHaveBeenCalled());
    socket.emit('connect');
    expect(await start).toBe(true);
    expect(mocked.invoke).toHaveBeenCalledWith('audio-driver:get-mic-pcm-socket-path');

    socket.emit('data', pcmFrame(1200));
    expect(output.writes).toHaveLength(1); // WAV header only: paused first frame did not leak.
    expect(output.writes[0].subarray(0, 4).toString()).toBe('RIFF');
    expect(output.writes[0].subarray(8, 12).toString()).toBe('WAVE');
    expect(recording.level.value).toBe(0);

    await new Promise(resolve => setTimeout(resolve, 25));
    recording.setPaused(false);
    const bytesAfterResume = recording.bytesWritten.value;
    expect(bytesAfterResume).toBeGreaterThan(0); // pause duration represented as silence.
    socket.emit('data', pcmFrame(1200));
    const resumedBytes = recording.bytesWritten.value;
    expect(resumedBytes).toBeGreaterThan(bytesAfterResume);
    expect(recording.level.value).toBeGreaterThan(0);

    recording.setPaused(true);
    socket.emit('data', pcmFrame(2400));
    expect(recording.bytesWritten.value).toBe(resumedBytes);
    expect(recording.level.value).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 25));
    recording.setPaused(false);
    expect(recording.bytesWritten.value).toBeGreaterThan(resumedBytes);
    expect(output.writes.slice(1).every(chunk => chunk.length > 0)).toBe(true);
    await recording.stop();
    expect(mocked.openSync).toHaveBeenCalledWith('/tmp/mic.wav', 'r+');
  });
});
