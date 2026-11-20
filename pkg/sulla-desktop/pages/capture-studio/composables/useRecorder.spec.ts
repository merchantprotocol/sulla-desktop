// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordingFilename, toRecorderManifestStream, useRecorder } from './useRecorder';

class MemoryWriteStream extends EventEmitter {
  destroyed = false;
  closed = false;
  writableFinished = false;
  errored: Error | null = null;
  private readonly chunks: Buffer[] = [];

  constructor(private readonly commit: (data: Buffer) => void, private readonly failOnce: () => boolean) { super(); }

  write(chunk: Buffer, callback: (error?: Error | null) => void): boolean {
    if (this.failOnce()) {
      const error = new Error('temporary disk write error');
      queueMicrotask(() => { this.emit('error', error); callback(error); });
    } else {
      this.chunks.push(Buffer.from(chunk));
      queueMicrotask(() => callback(null));
    }
    return true;
  }

  end(callback?: () => void): void {
    if (this.writableFinished) return;
    this.writableFinished = true;
    queueMicrotask(() => {
      this.commit(Buffer.concat(this.chunks));
      this.closed = true;
      this.emit('finish');
      callback?.();
    });
  }
}

class MemoryRecordingFileSystem {
  readonly files = new Map<string, Buffer | string>();
  writeAttempts = 0;
  constructor(private readonly failFirstWrite = false) {}
  mkdirSync(): void {}
  createWriteStream(filePath: string): MemoryWriteStream {
    return new MemoryWriteStream(data => this.files.set(filePath, data), () => ++this.writeAttempts === 1 && this.failFirstWrite);
  }
  statSync(filePath: string): { size: number } {
    const data = this.files.get(filePath);
    if (!data) throw new Error(`Missing file ${ filePath }`);
    return { size: Buffer.byteLength(data) };
  }
  writeFileSync(filePath: string, contents: string): void { this.files.set(filePath, contents); }
}

class FinalChunkRecorder {
  static isTypeSupported(): boolean { return true; }
  static finalData: { size: number; arrayBuffer: () => Promise<ArrayBuffer> } | undefined;
  static stopCount = 0;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(_stream: MediaStream, _options: MediaRecorderOptions) {}
  start(): void { this.state = 'recording'; }
  stop(): void {
    FinalChunkRecorder.stopCount++;
    this.state = 'inactive';
    if (FinalChunkRecorder.finalData) this.ondataavailable?.({ data: FinalChunkRecorder.finalData } as BlobEvent);
    this.onstop?.();
  }
}

function recordingStream(): MediaStream {
  return { getVideoTracks: () => [{}] } as unknown as MediaStream;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FinalChunkRecorder.finalData = undefined;
  FinalChunkRecorder.stopCount = 0;
});

describe('recordingFilename', () => {
  it('keeps primary filenames and gives every extra screen/camera a unique safe filename', () => {
    // risk: data integrity — independent screen streams must not overwrite one another or disappear from the manifest.
    expect(recordingFilename('screen', 'screen')).toBe('screen.webm');
    expect(recordingFilename('screen', 'custom_2')).toBe('screen-custom_2.webm');
    expect(recordingFilename('screen', '../display:2')).toBe('screen-___display_2.webm');
    expect(recordingFilename('camera', 'cam')).toBe('camera.webm');
    expect(recordingFilename('camera', 'custom_2')).toBe('camera-custom_2.webm');
  });

  it('publishes each extra display as its own named manifest track', () => {
    // risk: data integrity — editors must be able to locate every independently recorded display.
    expect(toRecorderManifestStream({
      id: 'custom_2', type: 'screen', filename: recordingFilename('screen', 'custom_2'), startOffset: 12.6, bytesWritten: 512,
    })).toEqual({ id: 'custom_2', type: 'screen', filename: 'screen-custom_2.webm', format: 'webm', startOffset: 13, bytes: 512 });
  });

  it('publishes each additional camera as its own named manifest track', () => {
    // risk: data integrity — two camera devices must not overwrite one another or share a manifest identity.
    expect(toRecorderManifestStream({
      id: 'custom_3', type: 'camera', filename: recordingFilename('camera', 'custom_3'), startOffset: 30, bytesWritten: 1024,
    })).toEqual({ id: 'custom_3', type: 'camera', filename: 'camera-custom_3.webm', format: 'webm', startOffset: 30, bytes: 1024 });
  });
});

describe('useRecorder finalization', () => {
  it('waits for the final asynchronous MediaRecorder chunk before publishing the manifest', async() => {
    // risk: recording integrity — a close cannot release streams or publish a manifest before the final chunk is persisted.
    vi.stubGlobal('MediaRecorder', FinalChunkRecorder);
    const fileSystem = new MemoryRecordingFileSystem();
    let finishChunk!: (buffer: ArrayBuffer) => void;
    FinalChunkRecorder.finalData = { size: 3, arrayBuffer: () => new Promise(resolve => { finishChunk = resolve; }) };
    const recorder = useRecorder({ manageUnmount: false, fileSystem, capturesDir: '/memory/captures' });
    const sessionId = recorder.startSession([{ id: 'screen', type: 'screen', stream: recordingStream() }]);
    const stopping = recorder.stopSession();
    let finalized = false;
    void stopping.then(() => { finalized = true; });

    await new Promise(resolve => setImmediate(resolve));
    expect(finalized).toBe(false);
    expect([...fileSystem.files.keys()].some(filePath => filePath.endsWith('manifest.json'))).toBe(false);

    finishChunk(new Uint8Array([1, 2, 3]).buffer);
    await expect(stopping).resolves.toBe(sessionId);
    const manifestPath = [...fileSystem.files.keys()].find(filePath => filePath.endsWith('manifest.json'))!;
    const manifest = JSON.parse(fileSystem.files.get(manifestPath) as string);
    expect(manifest.streams).toEqual([expect.objectContaining({ id: 'screen', bytes: 3 })]);
    expect(recorder.isRecording.value).toBe(false);
  });

  it('shares concurrent per-source finalization so removing a source cannot stop its recorder twice', async() => {
    // risk: recording integrity — concurrent close requests must not truncate or race the same source file.
    vi.stubGlobal('MediaRecorder', FinalChunkRecorder);
    FinalChunkRecorder.finalData = { size: 2, arrayBuffer: async() => new Uint8Array([7, 8]).buffer };
    const recorder = useRecorder({ manageUnmount: false, fileSystem: new MemoryRecordingFileSystem(), capturesDir: '/memory/captures' });
    recorder.startSession([{ id: 'screen', type: 'screen', stream: recordingStream() }]);

    const first = recorder.finalizeSource('screen');
    const second = recorder.finalizeSource('screen');
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(FinalChunkRecorder.stopCount).toBe(1);
  });

  it('keeps the failed final chunk and retries it before a later save completes', async() => {
    // risk: recording integrity — transient write errors must not silently omit the final chunk from a successful manifest.
    vi.stubGlobal('MediaRecorder', FinalChunkRecorder);
    const fileSystem = new MemoryRecordingFileSystem(true);
    FinalChunkRecorder.finalData = { size: 2, arrayBuffer: async() => new Uint8Array([4, 5]).buffer };
    const recorder = useRecorder({ manageUnmount: false, fileSystem, capturesDir: '/memory/captures' });
    recorder.startSession([{ id: 'screen', type: 'screen', stream: recordingStream() }]);

    await expect(recorder.stopSession()).rejects.toThrow('temporary disk write error');
    expect([...fileSystem.files.keys()].some(filePath => filePath.endsWith('manifest.json'))).toBe(false);
    await expect(recorder.stopSession()).resolves.toBeTruthy();

    const manifestPath = [...fileSystem.files.keys()].find(filePath => filePath.endsWith('manifest.json'))!;
    const manifest = JSON.parse(fileSystem.files.get(manifestPath) as string);
    expect(fileSystem.writeAttempts).toBe(2);
    expect(manifest.streams).toEqual([expect.objectContaining({ id: 'screen', bytes: 2 })]);
  });
});
