/**
 * Composable — voice-tracked teleprompter scrolling.
 *
 * Uses the internal whisper transcription pipeline (via MicrophoneDriverController)
 * for speech-to-text. Fuzzy-matches spoken words against a sliding window in the
 * script to advance the position.
 *
 * Forgiving matching: handles skipped words, filler words, stuttering,
 * paraphrasing, and imperfect pronunciation.
 */

import { ref } from 'vue';

const { ipcRenderer } = require('electron');

const FILLER_WORDS = new Set([
  'um', 'uh', 'uh', 'like', 'you', 'know', 'so', 'well', 'basically',
  'actually', 'right', 'okay', 'ok', 'yeah', 'yes', 'no', 'just',
  'really', 'very', 'literally', 'honestly', 'anyway', 'anyways',
  'mean', 'guess', 'think', 'ah', 'oh', 'er', 'hm', 'hmm', 'mm',
]);

// Common words that are too generic for single-word matching
const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'can', 'may', 'might', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our',
  'their', 'what', 'which', 'who', 'how', 'when', 'where', 'why', 'not',
]);

const WINDOW_SIZE = 40; // how far ahead to search in the script
const MATCH_RATIO = 0.85; // 85% of meaningful spoken words must match

/**
 * Normalize a word for comparison: lowercase, strip punctuation.
 */
function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9'']/g, '');
}

/**
 * Check if two normalized words are a fuzzy match.
 * Allows for slight mispronunciations by checking prefix overlap.
 */
function wordsMatch(spoken: string, script: string): boolean {
  if (spoken === script) return true;
  if (spoken.length < 2 || script.length < 2) return false;

  // Prefix match: if 75%+ of the shorter word matches the start of the longer
  const shorter = spoken.length <= script.length ? spoken : script;
  const longer = spoken.length > script.length ? spoken : script;
  const prefixLen = Math.ceil(shorter.length * 0.75);
  if (longer.startsWith(shorter.slice(0, prefixLen))) return true;

  // Also allow the script word to start with the spoken word (truncated speech)
  if (script.startsWith(spoken) && spoken.length >= 3) return true;
  if (spoken.startsWith(script) && script.length >= 3) return true;

  return false;
}

/**
 * Fuzzy Jaccard similarity between two word sets.
 * Uses wordsMatch() so prefix/truncation matches count.
 * Returns 0-1: |intersection| / |union|.
 */
function fuzzyJaccard(setA: string[], setB: string[]): number {
  if (setA.length === 0 && setB.length === 0) return 0;

  // For each word in A, check if any word in B fuzzy-matches it
  const matchedInB = new Set<number>();
  let intersectionCount = 0;

  for (const a of setA) {
    for (let j = 0; j < setB.length; j++) {
      if (!matchedInB.has(j) && wordsMatch(a, setB[j])) {
        intersectionCount++;
        matchedInB.add(j); // each B word can only match once
        break;
      }
    }
  }

  const unionCount = setA.length + setB.length - intersectionCount;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

/**
 * Find the best matching position in the script for the spoken words.
 * Slides a window across the script and picks the position whose
 * word set has the highest fuzzy Jaccard similarity to the spoken words.
 * Returns the script index to jump to, or -1 if no match found.
 */
function findBestMatch(
  spokenWords: string[],
  scriptWords: string[],
  currentIndex: number,
): number {
  const meaningful = spokenWords.filter(w => !FILLER_WORDS.has(w) && !COMMON_WORDS.has(w));
  if (meaningful.length === 0) return -1;

  const windowStart = Math.max(0, currentIndex - 3);
  const windowEnd = Math.min(scriptWords.length, currentIndex + WINDOW_SIZE);

  // Normalize script words in the search range
  const normalizedScript: string[] = [];
  for (let i = windowStart; i < windowEnd; i++) {
    normalizedScript.push(normalize(scriptWords[i]));
  }

  let bestPos = -1;
  let bestScore = 0;

  // Slide a window the size of the spoken words across the script
  const sliceLen = meaningful.length + 2; // small padding for skipped words
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

// ─── Predictive scrolling ──────────────────────────────────
// Measures reading speed from confirmed transcript matches and
// smoothly advances the teleprompter between transcription events
// so the scroll feels continuous instead of jumping in chunks.
//
// Prediction is gated by VAD: the teleprompter only advances when
// the mic detects speech. Speaking frames are counted to estimate
// a "word budget" that caps how far ahead prediction can go before
// the next transcript confirmation arrives.

const PREDICTION_TICK_MS = 200;        // how often to advance predicted position
const SPEED_HISTORY_SIZE = 6;          // number of speed samples to average
const DEFAULT_WPM = 150;              // starting guess: ~2.5 words/sec
const PAUSE_TIMEOUT_MS = 3000;         // stop predicting if no transcript for this long
const VAD_BUDGET_MARGIN = 4;           // max words prediction can lead beyond VAD estimate

export function useTeleprompterTracking(
  onIndexUpdate: (index: number) => void,
) {
  const isTracking = ref(false);
  const confidence = ref(0);

  let transcriptHandler: ((_event: any, msg: any) => void) | null = null;
  let vadHandler: ((_event: any, state: any) => void) | null = null;
  let scriptWords: string[] = [];
  let currentIndex = 0;

  // Speed estimation state
  let lastConfirmedIndex = 0;
  let lastConfirmedTime = 0;
  const speedHistory: number[] = [];   // words per second samples
  let wordsPerSec = DEFAULT_WPM / 60;

  // Prediction state
  let predictionTimer: ReturnType<typeof setInterval> | null = null;
  let predictedIndex = 0;              // fractional index for smooth advance
  let lastTranscriptTime = 0;         // when we last heard from whisper
  let isPaused = false;                // true when reader seems to have stopped

  // VAD-gated word budget: only allow prediction to advance while
  // the user is actually speaking, and only as many words as the
  // cumulative speaking duration suggests.
  let vadSpeaking = false;             // current VAD state
  let speakingMsSinceConfirm = 0;      // ms of speaking time since last confirmed match
  let lastVadTime = 0;                 // timestamp of the last VAD frame we processed

  function updateSpeed(confirmedIndex: number, now: number) {
    if (lastConfirmedTime > 0 && confirmedIndex > lastConfirmedIndex) {
      const elapsed = (now - lastConfirmedTime) / 1000;
      if (elapsed > 0.2 && elapsed < 15) {
        const wordsDelta = confirmedIndex - lastConfirmedIndex;
        const sample = wordsDelta / elapsed;
        speedHistory.push(sample);
        if (speedHistory.length > SPEED_HISTORY_SIZE) speedHistory.shift();
        // Weighted average — recent samples count more
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
    // Reset speaking accumulator — the confirmed match anchors our position
    speakingMsSinceConfirm = 0;
  }

  // Prediction only runs after a confirmed transcript match.
  // A non-matching transcript kills prediction until the next match.
  let matchActive = false;             // true after a confirmed match, false on miss

  function startPrediction() {
    if (predictionTimer) return;
    predictionTimer = setInterval(() => {
      if (!isTracking.value) return;
      if (!matchActive) return;

      const now = Date.now();
      const silenceMs = now - lastTranscriptTime;

      // If no transcript for a while, assume the reader paused
      if (silenceMs > PAUSE_TIMEOUT_MS) {
        isPaused = true;
        return;
      }

      isPaused = false;

      // Only advance when VAD indicates the user is speaking
      if (!vadSpeaking) return;

      // Cap prediction by speaking duration since last confirmed match
      const estimatedWordsSpoken = (speakingMsSinceConfirm / 1000) * wordsPerSec;
      const maxPredicted = lastConfirmedIndex + estimatedWordsSpoken + VAD_BUDGET_MARGIN;
      if (predictedIndex >= maxPredicted) return;

      // Advance fractional index by speed * tick
      const advance = wordsPerSec * (PREDICTION_TICK_MS / 1000);
      predictedIndex = Math.min(predictedIndex + advance, maxPredicted, scriptWords.length - 1);

      const nextIndex = Math.floor(predictedIndex);
      if (nextIndex > currentIndex && nextIndex < scriptWords.length) {
        currentIndex = nextIndex;
        onIndexUpdate(currentIndex);
      }
    }, PREDICTION_TICK_MS);
  }

  function stopPrediction() {
    if (predictionTimer) {
      clearInterval(predictionTimer);
      predictionTimer = null;
    }
  }

  function processTranscript(transcript: string) {
    if (!transcript) return;

    const now = Date.now();
    lastTranscriptTime = now;
    isPaused = false;

    // Normalize spoken words, filter fillers
    const spokenRaw = transcript.toLowerCase().replace(/[^a-z0-9'' ]/g, '').split(/\s+/);
    const spoken = spokenRaw
      .map(normalize)
      .filter(w => w.length > 0 && !FILLER_WORDS.has(w));

    if (spoken.length === 0) return;

    // Take the last 5 meaningful words for matching
    const recentSpoken = spoken.slice(-5);

    const matchPos = findBestMatch(recentSpoken, scriptWords, currentIndex);

    if (matchPos >= 0 && matchPos !== currentIndex) {
      // Snap to confirmed position and enable prediction
      matchActive = true;
      updateSpeed(matchPos, now);
      currentIndex = Math.min(matchPos, scriptWords.length - 1);
      predictedIndex = currentIndex;
      confidence.value = Math.min(1, recentSpoken.length / 3);
      onIndexUpdate(currentIndex);
    } else {
      // Transcript didn't match — freeze prediction until next match
      matchActive = false;
      speakingMsSinceConfirm = 0;
      confidence.value = Math.max(0, confidence.value - 0.3);
    }
  }

  async function startTracking(words: string[], startIndex: number = 0) {
    scriptWords = words;
    currentIndex = startIndex;
    predictedIndex = startIndex;
    lastConfirmedIndex = startIndex;
    lastConfirmedTime = 0;
    lastTranscriptTime = Date.now();
    speedHistory.length = 0;
    wordsPerSec = DEFAULT_WPM / 60;
    isPaused = false;
    matchActive = false;
    vadSpeaking = false;
    speakingMsSinceConfirm = 0;

    // Start mic with PCM format for whisper
    await ipcRenderer.invoke('audio-driver:start-mic', 'teleprompter', ['pcm-s16le']);

    // Start whisper transcription
    const result = await ipcRenderer.invoke('audio-driver:transcribe-start', {
      mode: 'conversation',
    });

    if (!result?.ok) {
      console.warn('[TeleprompterTracking] Whisper transcription failed to start');
      await ipcRenderer.invoke('audio-driver:stop-mic', 'teleprompter').catch(() => {});
      return;
    }

    // Listen for transcript events from whisper
    transcriptHandler = (_event: any, msg: any) => {
      if (!isTracking.value || !msg?.text) return;
      processTranscript(msg.text.trim());
    };
    ipcRenderer.on('gateway-transcript', transcriptHandler);

    // Listen for VAD state to gate prediction and track speaking duration
    lastVadTime = Date.now();
    vadHandler = (_event: any, state: any) => {
      if (!isTracking.value || !state) return;
      const now = Date.now();
      // Accumulate speaking time
      if (vadSpeaking) {
        speakingMsSinceConfirm += now - lastVadTime;
      }
      vadSpeaking = !!state.speaking;
      lastVadTime = now;
    };
    ipcRenderer.on('audio-driver:mic-vad', vadHandler);

    isTracking.value = true;
    startPrediction();
    console.log('[TeleprompterTracking] Started — whisper + VAD-gated predictive scrolling active');
  }

  function stopTracking() {
    isTracking.value = false;
    confidence.value = 0;

    stopPrediction();

    if (transcriptHandler) {
      ipcRenderer.removeListener('gateway-transcript', transcriptHandler);
      transcriptHandler = null;
    }
    if (vadHandler) {
      ipcRenderer.removeListener('audio-driver:mic-vad', vadHandler);
      vadHandler = null;
    }

    // Stop whisper + release mic
    ipcRenderer.invoke('audio-driver:transcribe-stop').catch(() => {});
    ipcRenderer.invoke('audio-driver:stop-mic', 'teleprompter').catch(() => {});

    // Reset speed state
    speedHistory.length = 0;
    wordsPerSec = DEFAULT_WPM / 60;
    vadSpeaking = false;
    speakingMsSinceConfirm = 0;
    matchActive = false;

    console.log('[TeleprompterTracking] Stopped');
  }

  /**
   * Update the current index externally (e.g. user clicked a word).
   */
  function setCurrentIndex(index: number) {
    currentIndex = index;
    predictedIndex = index;
    lastConfirmedIndex = index;
    lastConfirmedTime = Date.now();
  }

  return {
    isTracking,
    confidence,
    startTracking,
    stopTracking,
    setCurrentIndex,
  };
}
