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

function getCapturesDir(): string {
  return path.join(os.homedir(), 'sulla', 'captures');
}

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
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let sessionStartTime = 0;

  /**
   * Start recording all provided streams to disk.
   */
  function startSession(streams: Array<{
    id: string;
    type: 'screen' | 'camera' | 'mic' | 'system-audio';
    stream: MediaStream;
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

    sessionStartTime = performance.now();
    entries = [];
    bytesWritten.value = 0;
    diskDisplay.value = '0 B';

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
        recorder = new MediaRecorder(src.stream, { mimeType });
      } catch (e: any) {
        console.error(`[useRecorder] Failed to create MediaRecorder for ${src.type}:`, e.message);
        ws.end();
        continue;
      }

      const startOffset = performance.now() - sessionStartTime;

      const entry: StreamEntry = {
        id: src.id,
        type: src.type,
        filename,
        stream: src.stream,
        recorder,
        writeStream: ws,
        startOffset,
        bytesWritten: 0,
      };

      recorder.ondataavailable = async (e: BlobEvent) => {
        if (e.data.size > 0) {
          try {
            const buffer = Buffer.from(await e.data.arrayBuffer());
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

      recorder.start(1000); // 1-second chunks
      entries.push(entry);
    }

    if (entries.length === 0) {
      error.value = 'No streams could be recorded';
      return '';
    }

    isRecording.value = true;
    elapsedSeconds.value = 0;
    timerInterval = setInterval(() => { elapsedSeconds.value++; }, 1000);

    return id;
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

      const origHandler = entry.recorder.ondataavailable;
      entry.recorder.ondataavailable = async (e: BlobEvent) => {
        // Process the final chunk
        if (origHandler) await (origHandler as any)(e);
        resolve();
      };

      entry.recorder.onstop = () => {
        // Safety: resolve if ondataavailable never fires (empty final chunk)
        setTimeout(resolve, 100);
      };

      entry.recorder.stop();
    }));

    await Promise.all(stopPromises);

    // Close all write streams
    for (const entry of entries) {
      entry.writeStream.end();
    }

    // Write manifest
    const manifest = {
      sessionId: sessionId.value,
      startedAt: new Date(Date.now() - elapsedSeconds.value * 1000).toISOString(),
      duration: elapsedSeconds.value,
      totalBytes: bytesWritten.value,
      streams: entries.map(e => ({
        id: e.id,
        type: e.type,
        filename: e.filename,
        startOffset: Math.round(e.startOffset),
        bytes: e.bytesWritten,
      })),
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
  };
}
