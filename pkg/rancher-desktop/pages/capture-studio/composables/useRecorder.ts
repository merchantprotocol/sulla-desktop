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

export function useRecorder() {
  const isRecording = ref(false);
  const sessionId = ref('');
  const elapsedSeconds = ref(0);
  const bytesWritten = ref(0);

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

    const id = randomUUID().slice(0, 13);
    sessionId.value = id;
    sessionDir = path.join(getCapturesDir(), id);
    fs.mkdirSync(sessionDir, { recursive: true });

    sessionStartTime = performance.now();
    entries = [];
    bytesWritten.value = 0;

    for (const src of streams) {
      const hasVideo = src.stream.getVideoTracks().length > 0;
      const mimeType = pickMimeType(hasVideo ? 'video' : 'audio');
      const ext = 'webm';
      const filename = `${src.type}${src.id ? `-${src.id}` : ''}.${ext}`;
      const filePath = path.join(sessionDir, filename);
      const ws = fs.createWriteStream(filePath);

      const recorder = new MediaRecorder(src.stream, { mimeType });
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
          const buffer = Buffer.from(await e.data.arrayBuffer());
          ws.write(buffer);
          entry.bytesWritten += buffer.length;
          bytesWritten.value = entries.reduce((sum, en) => sum + en.bytesWritten, 0);
        }
      };

      recorder.start(1000); // 1-second chunks
      entries.push(entry);
    }

    isRecording.value = true;
    elapsedSeconds.value = 0;
    timerInterval = setInterval(() => { elapsedSeconds.value++; }, 1000);

    return id;
  }

  /**
   * Stop all recorders, finalize files, write manifest.
   */
  function stopSession(): string {
    if (!isRecording.value) return '';

    for (const entry of entries) {
      if (entry.recorder.state !== 'inactive') {
        entry.recorder.stop();
      }
      entry.writeStream.end();
    }

    // Write manifest
    const manifest = {
      sessionId: sessionId.value,
      startedAt: new Date(Date.now() - elapsedSeconds.value * 1000).toISOString(),
      duration: elapsedSeconds.value,
      streams: entries.map(e => ({
        id: e.id,
        type: e.type,
        filename: e.filename,
        startOffset: Math.round(e.startOffset),
        bytes: e.bytesWritten,
      })),
    };

    fs.writeFileSync(
      path.join(sessionDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    isRecording.value = false;
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
    startSession,
    stopSession,
  };
}
