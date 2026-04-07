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
const MIN_MATCH_WORDS = 2; // minimum words to match for a jump

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
 * Find the best matching position in the script for the spoken words.
 * Returns the script index to jump to, or -1 if no match found.
 */
function findBestMatch(
  spokenWords: string[],
  scriptWords: string[],
  currentIndex: number,
): number {
  if (spokenWords.length === 0) return -1;

  const windowStart = Math.max(0, currentIndex - 3); // allow small backward movement
  const windowEnd = Math.min(scriptWords.length, currentIndex + WINDOW_SIZE);

  // Normalize script words in the window
  const normalizedScript: string[] = [];
  for (let i = windowStart; i < windowEnd; i++) {
    normalizedScript.push(normalize(scriptWords[i]));
  }

  let bestPos = -1;
  let bestScore = 0;

  // Try each starting position in the window
  for (let winPos = 0; winPos < normalizedScript.length; winPos++) {
    let matched = 0;
    let scriptOffset = 0;

    // Try to match spoken words against script starting at winPos
    for (let spIdx = 0; spIdx < spokenWords.length && (winPos + scriptOffset) < normalizedScript.length; spIdx++) {
      const spWord = spokenWords[spIdx];

      // Skip filler words in spoken text
      if (FILLER_WORDS.has(spWord)) continue;

      // Look ahead a few positions in script for this spoken word (handles skipped script words)
      let found = false;
      for (let lookahead = 0; lookahead < 3 && (winPos + scriptOffset + lookahead) < normalizedScript.length; lookahead++) {
        if (wordsMatch(spWord, normalizedScript[winPos + scriptOffset + lookahead])) {
          matched++;
          scriptOffset += lookahead + 1;
          found = true;
          break;
        }
      }

      if (!found) {
        scriptOffset++;
      }
    }

    // Score: number of matched words, weighted by being further ahead (prefer forward progress)
    const absolutePos = windowStart + winPos + scriptOffset;
    const forwardBonus = absolutePos > currentIndex ? 0.1 : 0;
    const score = matched + forwardBonus;

    if (matched >= MIN_MATCH_WORDS && score > bestScore) {
      bestScore = score;
      bestPos = absolutePos;
    }

    // Single-word match only if the word is unique (not common)
    if (matched === 1 && spokenWords.length <= 2) {
      const matchedWord = spokenWords.find(w => !FILLER_WORDS.has(w)) || '';
      if (COMMON_WORDS.has(matchedWord)) {
        // Don't jump on common single words
        if (bestPos === absolutePos) bestPos = -1;
      }
    }
  }

  return bestPos;
}

export function useTeleprompterTracking(
  onIndexUpdate: (index: number) => void,
) {
  const isTracking = ref(false);
  const confidence = ref(0);

  let transcriptHandler: ((_event: any, msg: any) => void) | null = null;
  let scriptWords: string[] = [];
  let currentIndex = 0;

  function processTranscript(transcript: string) {
    if (!transcript) return;

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
      currentIndex = Math.min(matchPos, scriptWords.length - 1);
      confidence.value = Math.min(1, recentSpoken.length / 3);
      onIndexUpdate(currentIndex);
    }
  }

  async function startTracking(words: string[], startIndex: number = 0) {
    scriptWords = words;
    currentIndex = startIndex;

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
      // Use both partial and final transcripts for responsive tracking
      processTranscript(msg.text.trim());
    };
    ipcRenderer.on('gateway-transcript', transcriptHandler);

    isTracking.value = true;
    console.log('[TeleprompterTracking] Started — whisper pipeline active');
  }

  function stopTracking() {
    isTracking.value = false;
    confidence.value = 0;

    if (transcriptHandler) {
      ipcRenderer.removeListener('gateway-transcript', transcriptHandler);
      transcriptHandler = null;
    }

    // Stop whisper + release mic
    ipcRenderer.invoke('audio-driver:transcribe-stop').catch(() => {});
    ipcRenderer.invoke('audio-driver:stop-mic', 'teleprompter').catch(() => {});

    console.log('[TeleprompterTracking] Stopped');
  }

  /**
   * Update the current index externally (e.g. user clicked a word).
   */
  function setCurrentIndex(index: number) {
    currentIndex = index;
  }

  return {
    isTracking,
    confidence,
    startTracking,
    stopTracking,
    setCurrentIndex,
  };
}
