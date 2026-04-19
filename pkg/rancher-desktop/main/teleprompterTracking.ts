/**
 * @module teleprompterTracking
 *
 * Main-process teleprompter speech tracking.
 *
 * Runs fuzzy matching + VAD-gated predictive scrolling entirely in the
 * main process so it is never affected by renderer background throttling.
 * Receives whisper transcripts and VAD state from the audio-driver
 * subsystem and broadcasts position updates to all renderer windows
 * (capture studio + floating teleprompter).
 *
 * Renderers interact via IPC:
 *   teleprompter-tracking:set-script  — provide the word list
 *   teleprompter-tracking:start       — begin tracking (starts mic + whisper)
 *   teleprompter-tracking:stop        — stop tracking  (stops mic + whisper)
 *   teleprompter-tracking:jump-to     — user clicked a word
 *   teleprompter-tracking:position    — (outbound) position + confidence
 */

import { BrowserWindow, ipcMain } from 'electron';

import { MicrophoneDriverController } from './audio-driver/controller/MicrophoneDriverController';
import * as whisper from './audio-driver/model/whisper';
import * as whisperTranscribe from './audio-driver/service/whisper-transcribe';
import { sendPosition as sendFloatPosition } from './teleprompterWindow';

// ─── Text matching helpers (moved from renderer composable) ───────

const FILLER_WORDS = new Set([
  'um', 'uh', 'uh', 'like', 'you', 'know', 'so', 'well', 'basically',
  'actually', 'right', 'okay', 'ok', 'yeah', 'yes', 'no', 'just',
  'really', 'very', 'literally', 'honestly', 'anyway', 'anyways',
  'mean', 'guess', 'think', 'ah', 'oh', 'er', 'hm', 'hmm', 'mm',
]);

const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'can', 'may', 'might', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our',
  'their', 'what', 'which', 'who', 'how', 'when', 'where', 'why', 'not',
]);

const WINDOW_SIZE = 40;
const MATCH_RATIO = 0.85;

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9'']/g, '');
}

function wordsMatch(spoken: string, script: string): boolean {
  if (spoken === script) return true;
  if (spoken.length < 2 || script.length < 2) return false;

  const shorter = spoken.length <= script.length ? spoken : script;
  const longer = spoken.length > script.length ? spoken : script;
  const prefixLen = Math.ceil(shorter.length * 0.75);
  if (longer.startsWith(shorter.slice(0, prefixLen))) return true;

  if (script.startsWith(spoken) && spoken.length >= 3) return true;
  if (spoken.startsWith(script) && script.length >= 3) return true;

  return false;
}

function fuzzyJaccard(setA: string[], setB: string[]): number {
  if (setA.length === 0 && setB.length === 0) return 0;

  const matchedInB = new Set<number>();
  let intersectionCount = 0;

  for (const a of setA) {
    for (let j = 0; j < setB.length; j++) {
      if (!matchedInB.has(j) && wordsMatch(a, setB[j])) {
        intersectionCount++;
        matchedInB.add(j);
        break;
      }
    }
  }

  const unionCount = setA.length + setB.length - intersectionCount;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

function findBestMatch(
  spokenWords: string[],
  scriptWords: string[],
  currentIndex: number,
): number {
  const meaningful = spokenWords.filter(w => !FILLER_WORDS.has(w) && !COMMON_WORDS.has(w));
  if (meaningful.length === 0) return -1;

  const windowStart = Math.max(0, currentIndex - 3);
  const windowEnd = Math.min(scriptWords.length, currentIndex + WINDOW_SIZE);

  const normalizedScript: string[] = [];
  for (let i = windowStart; i < windowEnd; i++) {
    normalizedScript.push(normalize(scriptWords[i]));
  }

  let bestPos = -1;
  let bestScore = 0;

  const sliceLen = meaningful.length + 2;
  for (let winPos = 0; winPos <= normalizedScript.length - meaningful.length; winPos++) {
    const scriptSlice = normalizedScript
      .slice(winPos, winPos + sliceLen)
      .filter(w => !COMMON_WORDS.has(w));

    const score = fuzzyJaccard(meaningful, scriptSlice);
    const absolutePos = windowStart + winPos + sliceLen;
    const forwardBonus = absolutePos > currentIndex ? 0.01 : 0;
    const adjusted = score + forwardBonus;

    if (score >= MATCH_RATIO && adjusted > bestScore) {
      bestScore = adjusted;
      bestPos = absolutePos;
    }
  }

  return bestPos;
}

// ─── Predictive scrolling constants ───────────────────────────────

const PREDICTION_TICK_MS = 200;
const SPEED_HISTORY_SIZE = 6;
const DEFAULT_WPM = 150;
const PAUSE_TIMEOUT_MS = 3000;
const VAD_BUDGET_MARGIN = 4;

const SERVICE_ID = 'teleprompter-tracking';

// ─── Tracking state ───────────────────────────────────────────────

let isTracking = false;
let confidence = 0;
let scriptWords: string[] = [];
let currentIndex = 0;

// Speed estimation
let lastConfirmedIndex = 0;
let lastConfirmedTime = 0;
const speedHistory: number[] = [];
let wordsPerSec = DEFAULT_WPM / 60;

// Prediction
let predictionTimer: ReturnType<typeof setInterval> | null = null;
let predictedIndex = 0;
let lastTranscriptTime = 0;
let matchActive = false;

// VAD state
let vadSpeaking = false;
let speakingMsSinceConfirm = 0;
let lastVadTime = 0;

// ─── Internal helpers ─────────────────────────────────────────────

function broadcastPosition(): void {
  const payload = { currentIndex, confidence };

  // Send to the floating teleprompter window via its existing API
  sendFloatPosition(currentIndex);

  // Send to all renderer windows (capture studio, etc.)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('teleprompter-tracking:position', payload);
    }
  }
}

function updateSpeed(confirmedIndex: number, now: number): void {
  if (lastConfirmedTime > 0 && confirmedIndex > lastConfirmedIndex) {
    const elapsed = (now - lastConfirmedTime) / 1000;
    if (elapsed > 0.2 && elapsed < 15) {
      const wordsDelta = confirmedIndex - lastConfirmedIndex;
      const sample = wordsDelta / elapsed;
      speedHistory.push(sample);
      if (speedHistory.length > SPEED_HISTORY_SIZE) speedHistory.shift();
      let weightedSum = 0;
      let weightTotal = 0;
      for (let i = 0; i < speedHistory.length; i++) {
        const weight = i + 1;
        weightedSum += speedHistory[i] * weight;
        weightTotal += weight;
      }
      wordsPerSec = weightedSum / weightTotal;
    }
  }
  lastConfirmedIndex = confirmedIndex;
  lastConfirmedTime = now;
  speakingMsSinceConfirm = 0;
}

function startPrediction(): void {
  if (predictionTimer) return;
  predictionTimer = setInterval(() => {
    if (!isTracking) return;
    if (!matchActive) return;

    const now = Date.now();
    const silenceMs = now - lastTranscriptTime;

    if (silenceMs > PAUSE_TIMEOUT_MS) return;
    if (!vadSpeaking) return;

    const estimatedWordsSpoken = (speakingMsSinceConfirm / 1000) * wordsPerSec;
    const maxPredicted = lastConfirmedIndex + estimatedWordsSpoken + VAD_BUDGET_MARGIN;
    if (predictedIndex >= maxPredicted) return;

    const advance = wordsPerSec * (PREDICTION_TICK_MS / 1000);
    predictedIndex = Math.min(predictedIndex + advance, maxPredicted, scriptWords.length - 1);

    const nextIndex = Math.floor(predictedIndex);
    if (nextIndex > currentIndex && nextIndex < scriptWords.length) {
      currentIndex = nextIndex;
      broadcastPosition();
    }
  }, PREDICTION_TICK_MS);
}

function stopPrediction(): void {
  if (predictionTimer) {
    clearInterval(predictionTimer);
    predictionTimer = null;
  }
}

function resetState(): void {
  currentIndex = 0;
  predictedIndex = 0;
  lastConfirmedIndex = 0;
  lastConfirmedTime = 0;
  lastTranscriptTime = 0;
  speedHistory.length = 0;
  wordsPerSec = DEFAULT_WPM / 60;
  matchActive = false;
  vadSpeaking = false;
  speakingMsSinceConfirm = 0;
  lastVadTime = 0;
  confidence = 0;
}

// ─── Public API (called from other main-process modules) ──────────

/**
 * Called by teleprompterWindow.ts when the user clicks/scrolls in the
 * floating window. Updates tracking position and broadcasts to all windows.
 */
export function onJumpTo(index: number): void {
  if (typeof index !== 'number') return;
  currentIndex = index;
  predictedIndex = index;
  lastConfirmedIndex = index;
  lastConfirmedTime = Date.now();
  speakingMsSinceConfirm = 0;
  broadcastPosition();
}

/**
 * Called by audio-driver/init.ts when whisper produces a transcript.
 * This is the main entry point for speech data.
 */
export function onWhisperTranscript(event: { text?: string }): void {
  if (!isTracking || !event?.text) return;

  const transcript = event.text.trim();
  if (!transcript) return;

  const now = Date.now();
  lastTranscriptTime = now;

  const spokenRaw = transcript.toLowerCase().replace(/[^a-z0-9'' ]/g, '').split(/\s+/);
  const spoken = spokenRaw.map(normalize).filter(w => w.length > 0 && !FILLER_WORDS.has(w));
  if (spoken.length === 0) return;

  const recentSpoken = spoken.slice(-5);
  const matchPos = findBestMatch(recentSpoken, scriptWords, currentIndex);

  if (matchPos >= 0 && matchPos !== currentIndex) {
    matchActive = true;
    updateSpeed(matchPos, now);
    currentIndex = Math.min(matchPos, scriptWords.length - 1);
    predictedIndex = currentIndex;
    confidence = Math.min(1, recentSpoken.length / 3);
    broadcastPosition();
  } else {
    matchActive = false;
    speakingMsSinceConfirm = 0;
    confidence = Math.max(0, confidence - 0.3);
  }
}

/**
 * Called by MicrophoneDriverController.processVadUpdate() on every
 * VAD frame (~60fps). Updates the speaking-duration accumulator
 * that gates predictive scrolling.
 */
export function onVadUpdate(data: { speaking?: boolean }): void {
  if (!isTracking || !data) return;

  const now = Date.now();
  if (vadSpeaking) {
    speakingMsSinceConfirm += now - lastVadTime;
  }
  vadSpeaking = !!data.speaking;
  lastVadTime = now;
}

// ─── IPC ──────────────────────────────────────────────────────────

async function handleStart(): Promise<{ ok: boolean; error?: string }> {
  if (isTracking) {
    // Already running — restart cleanly
    handleStop();
  }

  resetState();
  lastTranscriptTime = Date.now();
  lastVadTime = Date.now();

  const mic = MicrophoneDriverController.getInstance();

  // Start mic (reference-counted — safe to call if already running).
  // The capture studio already holds the mic with webm-opus + pcm-s16le,
  // so this just adds another holder — the tray panel mic stays running.
  await mic.start(SERVICE_ID, undefined, { formats: ['pcm-s16le'] });

  // Start whisper if not already running
  if (!whisperTranscribe.isActive()) {
    if (!whisper.isAvailable()) {
      console.log('[TeleprompterTracking] Whisper not cached — running detect()');
      await whisper.detect();
    }

    if (!whisper.isAvailable()) {
      console.error('[TeleprompterTracking] Whisper is not installed — cannot start voice tracking');
      await mic.stop(SERVICE_ID).catch(() => {});
      return { ok: false, error: 'whisper-not-available' };
    }

    const whisperStarted = whisperTranscribe.start({
      mode:         'conversation',
      onTranscript: (event) => {
        // Broadcast to renderers (voice session, secretary, etc.)
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('gateway-transcript', event);
          }
        }
        // Feed our own tracking
        onWhisperTranscript(event);
      },
    });

    if (!whisperStarted) {
      console.error('[TeleprompterTracking] whisperTranscribe.start() returned false — no models?');
      await mic.stop(SERVICE_ID).catch(() => {});
      return { ok: false, error: 'whisper-start-failed' };
    }

    console.log('[TeleprompterTracking] Whisper started successfully');
  } else {
    console.log('[TeleprompterTracking] Whisper already active — reusing');
  }
  // If whisper was already active (started by another service), we
  // receive transcripts via the onWhisperTranscript() hook in init.ts.

  isTracking = true;
  startPrediction();
  console.log('[TeleprompterTracking] Started — main-process tracking active');
  return { ok: true };
}

function handleStop(): { ok: boolean } {
  isTracking = false;
  stopPrediction();

  const mic = MicrophoneDriverController.getInstance();
  mic.stop(SERVICE_ID).catch(() => {});

  // Only stop whisper if we were the ones who started it
  // (other services may still need it)
  // The ref-counted mic stop is sufficient — whisper will starve
  // of audio and produce no more transcripts.

  resetState();
  console.log('[TeleprompterTracking] Stopped');
  return { ok: true };
}

/**
 * Register all teleprompter-tracking IPC handlers.
 * Called once during app startup, after audio-driver is initialized.
 */
export function registerTeleprompterTrackingIpc(): void {
  ipcMain.handle('teleprompter-tracking:set-script', (_event: unknown, data: {
    words:         string[];
    currentIndex?: number;
  }) => {
    scriptWords = data.words || [];
    if (typeof data.currentIndex === 'number') {
      currentIndex = data.currentIndex;
      predictedIndex = data.currentIndex;
      lastConfirmedIndex = data.currentIndex;
    }
    return { ok: true };
  });

  ipcMain.handle('teleprompter-tracking:start', async() => {
    return handleStart();
  });

  ipcMain.handle('teleprompter-tracking:stop', () => {
    return handleStop();
  });

  ipcMain.handle('teleprompter-tracking:jump-to', (_event: unknown, data: {
    currentIndex: number;
  }) => {
    if (typeof data?.currentIndex !== 'number') return { ok: false };
    currentIndex = data.currentIndex;
    predictedIndex = data.currentIndex;
    lastConfirmedIndex = data.currentIndex;
    lastConfirmedTime = Date.now();
    speakingMsSinceConfirm = 0;
    broadcastPosition();
    return { ok: true };
  });

  ipcMain.handle('teleprompter-tracking:state', () => {
    return { isTracking, confidence, currentIndex };
  });

  console.log('[TeleprompterTracking] IPC handlers registered');
}
