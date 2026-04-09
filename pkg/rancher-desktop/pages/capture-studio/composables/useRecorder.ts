/**
 * Composable — record active streams to disk as separate files.
 *
 * Uses MediaRecorder per stream, writes chunks directly to disk via
 * fs.createWriteStream (nodeIntegration enabled). No IPC for media data.
 *
 * Output: ~/sulla/captures/{sessionId}/ with manifest.json
 */

import { ref, onUnmounted } from 'vue';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

interface StreamEntry {
  id: string;
  type: 'screen' | 'camera' | 'mic' | 'system-audio';
  filename: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  writeStream: any; // fs.WriteStream
  startOffset: number;
  bytesWritten: number;
}

interface ExternalStreamEntry {
  id: string;
  type: string;
  filename: string;
  startOffset: number;
  format: string;
  getBytesWritten: () => number;
}

export interface CaptureEvent {
  type: 'click' | 'keystroke' | 'window-focus' | 'scroll';
  time: number; // ms since session start
  x?: number;
  y?: number;
  button?: string;
  key?: string;
  label?: string;
  app?: string;
  title?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

function getCapturesDir(): string {
  return path.join(os.homedir(), 'sulla', 'captures');
}

import type { QualityPreset } from './useMediaSources';

/** Bitrate targets per quality preset (bits per second). */
const VIDEO_BITRATES: Record<string, number> = {
  '480p':  1_500_000,   // 1.5 Mbps
  '720p':  3_000_000,   // 3 Mbps
  '1080p': 6_000_000,   // 6 Mbps
  '4k':    20_000_000,  // 20 Mbps
  'auto':  8_000_000,   // 8 Mbps default
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

export function useRecorder() {
  const isRecording = ref(false);
  const sessionId = ref('');
  const elapsedSeconds = ref(0);
  const bytesWritten = ref(0);
  const diskDisplay = ref('0 B');
  const error = ref<string | null>(null);

  let sessionDir = '';
  let entries: StreamEntry[] = [];
  let externalEntries: ExternalStreamEntry[] = [];
  let captureEvents: CaptureEvent[] = [];
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let sessionStartTime = 0;

  /**
   * Start recording all provided streams to disk.
   */
  function startSession(streams: Array<{
    id: string;
    type: 'screen' | 'camera' | 'mic' | 'system-audio';
    stream: MediaStream;
    quality?: QualityPreset;
  }>): string {
    if (isRecording.value) stopSession();

    error.value = null;
    const id = randomUUID().slice(0, 13);
    sessionId.value = id;
    sessionDir = path.join(getCapturesDir(), id);

    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (e: any) {
      error.value = `Failed to create capture directory: ${e.message}`;
      console.error('[useRecorder]', error.value);
      return '';
    }

    entries = [];
    bytesWritten.value = 0;
    diskDisplay.value = '0 B';

    // Phase 1: Create all write streams, MediaRecorders, and wire handlers BEFORE starting any.
    // This ensures all .start() calls happen in the same tick with zero stagger.
    const prepared: Array<{ entry: StreamEntry; recorder: MediaRecorder; ws: any }> = [];

    for (const src of streams) {
      const hasVideo = src.stream.getVideoTracks().length > 0;
      const mimeType = pickMimeType(hasVideo ? 'video' : 'audio');
      const ext = 'webm';
      const filename = `${src.type}${src.id ? `-${src.id}` : ''}.${ext}`;
      const filePath = path.join(sessionDir, filename);

      let ws: any;
      try {
        ws = fs.createWriteStream(filePath);
      } catch (e: any) {
        console.error(`[useRecorder] Failed to create write stream for ${filename}:`, e.message);
        continue;
      }

      ws.on('error', (e: any) => {
        console.error(`[useRecorder] Write stream error for ${filename}:`, e.message);
        error.value = `Disk write error: ${e.message}`;
      });

      let recorder: MediaRecorder;
      try {
        const recorderOpts: MediaRecorderOptions = { mimeType };
        if (hasVideo && src.quality) {
          recorderOpts.videoBitsPerSecond = VIDEO_BITRATES[src.quality] || VIDEO_BITRATES['auto'];
        }
        recorder = new MediaRecorder(src.stream, recorderOpts);
      } catch (e: any) {
        console.error(`[useRecorder] Failed to create MediaRecorder for ${src.type}:`, e.message);
        ws.end();
        continue;
      }

      const entry: StreamEntry = {
        id: src.id,
        type: src.type,
        filename,
        stream: src.stream,
        recorder,
        writeStream: ws,
        startOffset: 0,
        bytesWritten: 0,
      };

      recorder.ondataavailable = async (e: BlobEvent) => {
        if (e.data.size > 0 && ws && !ws.destroyed) {
          try {
            const buffer = Buffer.from(await e.data.arrayBuffer());
            if (ws.destroyed) return; // re-check after async
            ws.write(buffer);
            entry.bytesWritten += buffer.length;
            bytesWritten.value = entries.reduce((sum, en) => sum + en.bytesWritten, 0);
            diskDisplay.value = formatBytes(bytesWritten.value);
          } catch (err: any) {
            console.error(`[useRecorder] Chunk write failed for ${filename}:`, err.message);
          }
        }
      };

      recorder.onerror = (e: any) => {
        console.error(`[useRecorder] MediaRecorder error for ${src.type}:`, e.error?.message || e);
        error.value = `Recording error on ${src.type}: ${e.error?.message || 'unknown'}`;
      };

      prepared.push({ entry, recorder, ws });
    }

    // Phase 2: Start all recorders in one tight loop — same JS tick, zero offset
    sessionStartTime = performance.now();
    for (const { entry, recorder, ws } of prepared) {
      try {
        recorder.start(250); // 250ms chunks — smoother playback, less keyframe issues
        entry.startOffset = performance.now() - sessionStartTime;
        entries.push(entry);
      } catch (e: any) {
        console.error(`[useRecorder] MediaRecorder.start() failed for ${entry.type}:`, e.message);
        ws.end();
      }
    }

    if (entries.length === 0) {
      error.value = 'No streams could be recorded';
      return '';
    }

    isRecording.value = true;
    elapsedSeconds.value = 0;
    externalEntries = [];
    captureEvents = [];
    timerInterval = setInterval(() => { elapsedSeconds.value++; }, 1000);

    return id;
  }

  /**
   * Register an external stream (e.g. speaker WAV written by useSpeakerCapture)
   * so it appears in the session manifest.
   */
  function registerExternalStream(entry: {
    id: string;
    type: string;
    filename: string;
    format: string;
    getBytesWritten: () => number;
  }): void {
    externalEntries.push({
      ...entry,
      startOffset: performance.now() - sessionStartTime,
    });
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
  async function stopSession(): Promise<string> {
    if (!isRecording.value) return '';

    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    isRecording.value = false;

    // Stop all recorders and wait for their final ondataavailable to fire
    const stopPromises = entries.map(entry => new Promise<void>((resolve) => {
      if (entry.recorder.state === 'inactive') {
        resolve();
        return;
      }

      let resolved = false;
      const safeResolve = () => { if (!resolved) { resolved = true; resolve(); } };

      const origHandler = entry.recorder.ondataavailable;
      entry.recorder.ondataavailable = async (e: BlobEvent) => {
        // Process the final chunk
        try {
          if (origHandler) await (origHandler as any)(e);
        } catch (err: any) {
          console.warn('[useRecorder] Final chunk handler error:', err.message);
        }
        safeResolve();
      };

      entry.recorder.onstop = () => {
        // Safety: resolve if ondataavailable never fires (empty final chunk)
        setTimeout(safeResolve, 100);
      };

      entry.recorder.stop();
    }));

    // Wait for stop promises with a 5-second timeout to prevent hanging forever
    await Promise.race([
      Promise.all(stopPromises),
      new Promise<void>(resolve => setTimeout(resolve, 5000)),
    ]);

    // Close all write streams
    for (const entry of entries) {
      entry.writeStream.end();
    }

    // Write manifest (includes both MediaRecorder and external streams)
    const allStreams = [
      ...entries.map(e => ({
        id: e.id,
        type: e.type,
        filename: e.filename,
        format: 'webm',
        startOffset: Math.round(e.startOffset),
        bytes: e.bytesWritten,
      })),
      ...externalEntries.map(e => {
        let bytes = 0;
        try { bytes = e.getBytesWritten(); } catch (err: any) {
          console.warn('[useRecorder] getBytesWritten failed for', e.id, err.message);
        }
        return {
          id: e.id,
          type: e.type,
          filename: e.filename,
          format: e.format,
          startOffset: Math.round(e.startOffset),
          bytes,
        };
      }),
    ];

    const totalBytes = allStreams.reduce((sum, s) => sum + s.bytes, 0);

    const manifest = {
      sessionId: sessionId.value,
      startedAt: new Date(Date.now() - elapsedSeconds.value * 1000).toISOString(),
      duration: elapsedSeconds.value,
      totalBytes,
      streams: allStreams,
      events: captureEvents,
    };

    try {
      fs.writeFileSync(
        path.join(sessionDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
      );
    } catch (e: any) {
      console.error('[useRecorder] Failed to write manifest:', e.message);
    }

    const returnId = sessionId.value;
    entries = [];

    return returnId;
  }

  onUnmounted(() => {
    if (isRecording.value) stopSession();
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
    logEvent,
    getSessionDir,
  };
}
