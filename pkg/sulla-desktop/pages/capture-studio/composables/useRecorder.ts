// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Composable — record active streams to disk as separate files.
 *
 * Uses MediaRecorder per stream, writes chunks directly to disk via
 * fs.createWriteStream (nodeIntegration enabled). No IPC for media data.
 *
 * Output: ~/sulla/captures/{sessionId}/ with manifest.json
 */

import { ref, onUnmounted } from 'vue';
import paths from '@pkg/utils/paths';

import { SpeakerCaptureIntegrity } from '../services/SpeakerCaptureIntegrity';
import { RecorderChunkQueue } from '../services/RecorderChunkQueue';
import type { QualityPreset } from './useMediaSources';

const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');


interface StreamEntry {
  id:           string;
  type:         'screen' | 'camera' | 'mic' | 'system-audio';
  filename:     string;
  stream:       MediaStream;
  recorder:     MediaRecorder;
  writeStream:  any; // fs.WriteStream
  startOffset:  number;
  bytesWritten: number;
  chunkQueue: RecorderChunkQueue;
  finalized: boolean;
}

interface ExternalStreamEntry {
  id:              string;
  type:            string;
  filename:        string;
  startOffset:     number;
  format:          string;
  getBytesWritten: () => number;
}

const STREAM_FILENAMES: Record<StreamEntry['type'], string> = {
  screen:         'screen.webm',
  camera:         'camera.webm',
  mic:            'mic.webm',
  'system-audio': 'speaker.webm',
};

/** Keep historic primary filenames and give every additional video source its own file. */
export function recordingFilename(type: StreamEntry['type'], id: string): string {
  if ((type !== 'screen' || id === 'screen') && (type !== 'camera' || id === 'cam')) return STREAM_FILENAMES[type];
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${ type }-${ safeId || 'extra' }.webm`;
}

export interface RecorderManifestStream {
  id: string; type: string; filename: string; format: string; startOffset: number; bytes: number;
}

export function toRecorderManifestStream(entry: Pick<StreamEntry, 'id' | 'type' | 'filename' | 'startOffset' | 'bytesWritten'>): RecorderManifestStream {
  return {
    id: entry.id, type: entry.type, filename: entry.filename,
    format: 'webm', startOffset: Math.round(entry.startOffset), bytes: entry.bytesWritten,
  };
}

export interface CaptureEvent {
  type:    'click' | 'keystroke' | 'window-focus' | 'scroll';
  time:    number; // ms since session start
  x?:      number;
  y?:      number;
  button?: string;
  key?:    string;
  label?:  string;
  app?:    string;
  title?:  string;
  bounds?: { x: number; y: number; width: number; height: number };
}

function getCapturesDir(): string {
  return path.join(paths.sullaHome, 'captures');
}

/** Bitrate targets per quality preset (bits per second). */
const VIDEO_BITRATES: Record<string, number> = {
  '480p':  1_500_000,   // 1.5 Mbps
  '720p':  3_000_000,   // 3 Mbps
  '1080p': 6_000_000,   // 6 Mbps
  '4k':    20_000_000,  // 20 Mbps
  auto:    8_000_000,   // 8 Mbps default
};

function pickMimeType(kind: 'video' | 'audio'): string {
  if (kind === 'video') {
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) return 'video/webm;codecs=vp9,opus';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) return 'video/webm;codecs=vp9';
    return 'video/webm';
  }
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  return 'audio/webm';
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function useRecorder(
  optionsOrIntegrity: { manageUnmount?: boolean; fileSystem?: any; capturesDir?: string } | SpeakerCaptureIntegrity = {},
  injectedIntegrity?: SpeakerCaptureIntegrity,
) {
  const options = optionsOrIntegrity instanceof SpeakerCaptureIntegrity ? {} : optionsOrIntegrity;
  const integrity = optionsOrIntegrity instanceof SpeakerCaptureIntegrity
    ? optionsOrIntegrity
    : injectedIntegrity ?? new SpeakerCaptureIntegrity();
  const isRecording = ref(false);
  const sessionId = ref('');
  const elapsedSeconds = ref(0);
  const bytesWritten = ref(0);
  const diskDisplay = ref('0 B');
  const error = ref<string | null>(null);
  const recordingFs = options.fileSystem ?? fs;
  const capturesRoot = options.capturesDir ?? getCapturesDir();

  let sessionDir = '';
  let entries: StreamEntry[] = [];
  let stopping: Promise<string> | undefined;
  let externalEntries: ExternalStreamEntry[] = [];
  let captureEvents: CaptureEvent[] = [];
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let sessionStartTime = 0;
  let sessionStartedAtEpochMs = 0;

  /**
   * Start recording all provided streams to disk.
   */
  function startSession(streams: {
    id:       string;
    type:     'screen' | 'camera' | 'mic' | 'system-audio';
    stream:   MediaStream;
    quality?: QualityPreset;
  }[]): string {
    if (isRecording.value || stopping) {
      error.value = 'A recording session is already active';
      return '';
    }

    error.value = null;
    const id = randomUUID().slice(0, 13);
    sessionId.value = id;
    sessionDir = path.join(capturesRoot, id);

    try {
      recordingFs.mkdirSync(sessionDir, { recursive: true });
    } catch (e: any) {
      error.value = `Failed to create capture directory: ${ e.message }`;
      console.error('[useRecorder]', error.value);
      return '';
    }

    entries = [];
    bytesWritten.value = 0;
    diskDisplay.value = '0 B';

    // Phase 1: Create all write streams, MediaRecorders, and wire handlers BEFORE starting any.
    // This ensures all .start() calls happen in the same tick with zero stagger.
    const prepared: { entry: StreamEntry; recorder: MediaRecorder; ws: any }[] = [];

    for (const src of streams) {
      const hasVideo = src.stream.getVideoTracks().length > 0;
      const mimeType = pickMimeType(hasVideo ? 'video' : 'audio');
      const filename = recordingFilename(src.type, src.id);
      const filePath = path.join(sessionDir, filename);

      let ws: any;
      try {
        ws = recordingFs.createWriteStream(filePath);
      } catch (e: any) {
        console.error(`[useRecorder] Failed to create write stream for ${ filename }:`, e.message);
        continue;
      }

      ws.on('error', (e: any) => {
        console.error(`[useRecorder] Write stream error for ${ filename }:`, e.message);
        error.value = `Disk write error: ${ e.message }`;
      });

      let recorder: MediaRecorder;
      try {
        const recorderOpts: MediaRecorderOptions = { mimeType };
        if (hasVideo && src.quality) {
          recorderOpts.videoBitsPerSecond = VIDEO_BITRATES[src.quality] || VIDEO_BITRATES['auto'];
        }
        recorder = new MediaRecorder(src.stream, recorderOpts);
      } catch (e: any) {
        console.error(`[useRecorder] Failed to create MediaRecorder for ${ src.type }:`, e.message);
        ws.end();
        continue;
      }

      const entry: StreamEntry = {
        id:           src.id,
        type:         src.type,
        filename,
        stream:       src.stream,
        recorder,
        writeStream:  ws,
        startOffset:  0,
        bytesWritten: 0,
        chunkQueue: new RecorderChunkQueue(),
        finalized: false,
      };

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) {
          entry.chunkQueue.enqueue(async() => {
            const buffer = Buffer.from(await e.data.arrayBuffer());
            if (ws.destroyed || ws.errored) throw ws.errored || new Error(`Recording stream closed before chunk write: ${ filename }`);
            await new Promise<void>((resolve, reject) => {
              ws.write(buffer, (error: Error | null | undefined) => error ? reject(error) : resolve());
            });
            entry.bytesWritten += buffer.length;
            bytesWritten.value = entries.reduce((sum, en) => sum + en.bytesWritten, 0);
            diskDisplay.value = formatBytes(bytesWritten.value);
          });
          void entry.chunkQueue.flush().catch(err => {
            error.value = `Recording chunk write failed for ${ entry.type }: ${ err?.message || err }`;
          });
        }
      };

      recorder.onerror = (e: any) => {
        console.error(`[useRecorder] MediaRecorder error for ${ src.type }:`, e.error?.message || e);
        error.value = `Recording error on ${ src.type }: ${ e.error?.message || 'unknown' }`;
      };

      prepared.push({ entry, recorder, ws });
    }

    // Phase 2: Start all recorders in one tight loop — same JS tick, zero offset
    sessionStartTime = performance.now();
    sessionStartedAtEpochMs = Date.now();
    for (const { entry, recorder, ws } of prepared) {
      try {
        recorder.start(250); // 250ms chunks — smoother playback, less keyframe issues
        entry.startOffset = performance.now() - sessionStartTime;
        entries.push(entry);
      } catch (e: any) {
        console.error(`[useRecorder] MediaRecorder.start() failed for ${ entry.type }:`, e.message);
        ws.end();
      }
    }

    // Audio-only sessions have no MediaRecorder entries yet: mic and the
    // BlackHole fallback are attached immediately after this call as external
    // socket writers. Only fail when media streams were requested and every
    // recorder failed to start.
    if (streams.length > 0 && entries.length === 0) {
      error.value = 'No streams could be recorded';
      return '';
    }

    isRecording.value = true;
    elapsedSeconds.value = 0;
    externalEntries = [];
    captureEvents = [];
    timerInterval = setInterval(() => { elapsedSeconds.value++ }, 1000);

    return id;
  }

  /**
   * Register an external stream (e.g. speaker WAV written by useSpeakerCapture)
   * so it appears in the session manifest.
   */
  function registerExternalStream(entry: {
    id:              string;
    type:            string;
    filename:        string;
    format:          string;
    getBytesWritten: () => number;
    startOffset?:    number;
  }): void {
    externalEntries.push({
      ...entry,
      startOffset: entry.startOffset ?? performance.now() - sessionStartTime,
    });
  }

  /** Finalize one video source and keep its completed file in the session manifest. */
  async function finalizeSource(id: string): Promise<boolean> {
    const entry = entries.find(candidate => candidate.id === id && !candidate.finalized);
    if (!entry) return false;
    if (entry.recorder.state !== 'inactive') {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
        entry.recorder.onstop = () => { void entry.chunkQueue.flush().then(() => finish(), finish); };
        try { entry.recorder.stop(); } catch (error) { finish(error); }
      });
    } else await entry.chunkQueue.flush();
    await entry.chunkQueue.flush();
    await new Promise<void>((resolve, reject) => {
      const ws = entry.writeStream;
      if (!ws || ws.closed || ws.destroyed) return ws?.errored ? reject(ws.errored) : resolve();
      ws.once('error', reject); ws.end(resolve);
    });
    entry.finalized = true;
    return true;
  }

  /**
   * Log an interaction event with timestamp relative to session start.
   * Events are written to the manifest for post-production use.
   */
  function logEvent(event: Omit<CaptureEvent, 'time'>): void {
    if (!isRecording.value) return;
    captureEvents.push({
      ...event,
      time: Math.round(performance.now() - sessionStartTime),
    } as CaptureEvent);
  }

  /**
   * Get the session directory path (for external writers to place files).
   */
  function getSessionDir(): string {
    return sessionDir;
  }

  /**
   * Stop all recorders, wait for final chunks, then write manifest.
   */
  function stopSession(): Promise<string> {
    if (stopping) return stopping;
    if (!isRecording.value && entries.length === 0 && externalEntries.length === 0) return Promise.resolve('');
    const operation = flushSession();
    stopping = operation;
    void operation.finally(() => { if (stopping === operation) stopping = undefined; }).catch(() => undefined);
    return operation;
  }

  async function flushSession(): Promise<string> {

    if (timerInterval) { clearInterval(timerInterval); timerInterval = null }

    // Stop all recorders and wait for their final ondataavailable to fire
    const stopPromises = entries.map(entry => new Promise<void>((resolve, reject) => {
      if (entry.recorder.state === 'inactive') {
        void entry.chunkQueue.flush().then(resolve, reject);
        return;
      }

      let settled = false;
      const safeResolve = () => { if (!settled) { settled = true; resolve() } };
      const safeReject = (error: unknown) => { if (!settled) { settled = true; reject(error) } };

      const origHandler = entry.recorder.ondataavailable;
      entry.recorder.ondataavailable = (e: BlobEvent) => {
        try { origHandler?.call(entry.recorder, e); }
        catch (error) { safeReject(error); return; }
        void entry.chunkQueue.flush().then(safeResolve, safeReject);
      };

      entry.recorder.onstop = () => {
        // MediaRecorder dispatches the final dataavailable before stop. Drain
        // that exact queue here; a timer can publish the manifest while a
        // slow Blob.arrayBuffer() or filesystem write is still in flight.
        void entry.chunkQueue.flush().then(safeResolve, safeReject);
      };
      entry.recorder.onerror = (event: Event) => safeReject(new Error(`MediaRecorder failed while stopping ${ entry.type}: ${ (event as any).error?.message || 'unknown error' }`));

      try { entry.recorder.stop(); } catch (error) { safeReject(error); }
    }));

    let recorderTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(stopPromises),
        new Promise<void>((_resolve, reject) => { recorderTimeout = setTimeout(() => reject(new Error('Timed out waiting for recording chunks to flush.')), 5000); }),
      ]);
    } finally { if (recorderTimeout) clearTimeout(recorderTimeout); }
    await Promise.all(entries.map(entry => entry.chunkQueue.flush()));

    // Close all write streams and wait until every final chunk is flushed to
    // disk. The editor may open the manifest immediately after recorder_stop,
    // so publishing it before `finish` can expose truncated WebM files.
    await Promise.all(entries.map(entry => new Promise<void>((resolve, reject) => {
      const ws = entry.writeStream;
      if (!ws || ws.destroyed || ws.closed) {
        if (ws?.errored) reject(ws.errored);
        else resolve();
        return;
      }
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        ws.removeListener('finish', onFinish);
        ws.removeListener('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onFinish = () => finish();
      const onError = (error: Error) => finish(error);
      ws.once('finish', onFinish);
      ws.once('error', onError);
      timeout = setTimeout(() => finish(new Error(`Timed out flushing recording stream ${ entry.filename }.`)), 5000);
      ws.end();
    })));

    // Write manifest (includes both MediaRecorder and external streams)
    let allStreams = [
      ...entries.map(toRecorderManifestStream),
      ...externalEntries.map(e => {
        let bytes = 0;
        bytes = e.getBytesWritten();
        return {
          id:          e.id,
          type:        e.type,
          filename:    e.filename,
          format:      e.format,
          startOffset: Math.round(e.startOffset),
          bytes,
        };
      }),
    ];

    // Stat the finalized files instead of trusting queued-write counters.
    // This includes container/header bytes and guarantees downstream editors
    // see the size of the exact file named by each manifest entry.
    for (const stream of allStreams) {
      stream.bytes = recordingFs.statSync(path.join(sessionDir, stream.filename)).size;
    }

    // A finalized 44-byte WAV contains only its header. Do not advertise it
    // as a successful speaker track; zero-amplitude PCM frames still count.
    allStreams = allStreams.filter(stream => integrity.shouldPublish(stream));

    const totalBytes = allStreams.reduce((sum, s) => sum + s.bytes, 0);

    const durationMs = Math.max(0, Math.round(performance.now() - sessionStartTime));
    const manifest = {
      sessionId: sessionId.value,
      startedAt: new Date(sessionStartedAtEpochMs).toISOString(),
      duration:  durationMs / 1000,
      durationMs,
      totalBytes,
      streams:   allStreams,
      events:    captureEvents,
    };

    recordingFs.writeFileSync(path.join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const returnId = sessionId.value;
    entries = [];
    externalEntries = [];
    isRecording.value = false;

    return returnId;
  }

  onUnmounted(() => {
    // Capture Studio owns ordered recorder flush -> effect/raw disposal.
    if (options.manageUnmount !== false && isRecording.value) stopSession();
  });

  return {
    isRecording,
    sessionId,
    elapsedSeconds,
    bytesWritten,
    diskDisplay,
    error,
    startSession,
    stopSession,
    registerExternalStream,
    finalizeSource,
    logEvent,
    getSessionDir,
  };
}
