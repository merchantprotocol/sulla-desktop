/**
 * Model — speaker (system audio) turn segmenter.
 *
 * Gates speaker PCM with the speaker VAD and cuts it on speech turns, so only
 * the other side's speech reaches transcription — not music, hold tones or
 * silence — and each segment is a whole utterance instead of a fixed slice.
 *
 * The capture helper writes one analysis frame (stdout JSON) and one PCM chunk
 * (fd 3) per CoreAudio render callback, so levels and PCM arrive interleaved at
 * the same ~94/s cadence. Levels drive the VAD; PCM is routed by its state:
 *
 *   - idle     → a short pre-roll ring, so the onset the VAD needs a few frames
 *                to confirm is not clipped from the first word
 *   - speaking → the open turn (pre-roll is prepended when the turn opens)
 *   - hangover → still the open turn, until the VAD has been quiet for
 *                `turnEndMs`; then the turn closes into the pending queue
 *
 * Long turns are cut at `maxSegmentMs` so transcripts keep flowing. If level
 * frames stop arriving (a backend without analysis data), the segmenter falls
 * back to ungated fixed slices via tick() rather than dropping speaker audio.
 *
 * Pure — no Electron, no I/O; `now` is passed in so it can be unit tested.
 */

import { createSpeakerVad, type SpeakerLevel, type SpeakerVad } from './speaker-vad';

const BYTES_PER_MS = 32; // s16le mono 16kHz

export interface SpeakerTurnOptions {
  /** Audio kept from before the VAD confirms speech. */
  preRollMs?:       number;
  /** VAD-quiet time that ends a turn (covers pauses between sentences). */
  turnEndMs?:       number;
  /** Hard cut for long turns so transcripts don't stall. */
  maxSegmentMs?:    number;
  /** Ungated fallback slice length when no level frames are arriving. */
  fallbackSliceMs?: number;
  /** Level frames older than this mean the VAD has no data → fallback. */
  levelStaleMs?:    number;
  /** Pending segments beyond this are dropped oldest-first (slow STT). */
  maxPending?:      number;
  vad?:             SpeakerVad;
}

export interface SpeakerTurnSegmenter {
  onLevel(level: SpeakerLevel, now: number): void;
  onPcm(pcm: Buffer, now: number): void;
  /** Periodic housekeeping: ungated slicing and closing turns once levels go stale. */
  tick(now: number): void;
  /** Close any open turn now (e.g. session stop). */
  closeTurn(): void;
  takeSegment(): Buffer | null;
  pendingCount(): number;
  isSpeaking(): boolean;
  reset(): void;
}

export function createSpeakerTurnSegmenter(opts: SpeakerTurnOptions = {}): SpeakerTurnSegmenter {
  const preRollBytes = (opts.preRollMs ?? 300) * BYTES_PER_MS;
  const turnEndMs = opts.turnEndMs ?? 700;
  const maxSegmentBytes = (opts.maxSegmentMs ?? 15_000) * BYTES_PER_MS;
  const fallbackSliceMs = opts.fallbackSliceMs ?? 2000;
  const levelStaleMs = opts.levelStaleMs ?? 1000;
  const maxPending = opts.maxPending ?? 8;
  const vad = opts.vad ?? createSpeakerVad();

  let preRoll: Buffer[] = [];
  let preRollLen = 0;
  let turn: Buffer[] = [];
  let turnLen = 0;
  let turnOpen = false;
  let speaking = false;
  let lastSpeechAt = 0;
  let lastLevelAt = 0;
  let lastSliceAt = 0;
  // Pipe reads can split a 16-bit sample; hold the odd byte for the next chunk.
  let carry: Buffer | null = null;
  const pending: Buffer[] = [];

  const gated = (now: number) => lastLevelAt > 0 && now - lastLevelAt <= levelStaleMs;

  function cut(): void {
    if (turnLen > 0) {
      pending.push(Buffer.concat(turn, turnLen));
      if (pending.length > maxPending) pending.shift();
    }
    turn = [];
    turnLen = 0;
  }

  function closeTurn(): void {
    cut();
    turnOpen = false;
  }

  function onLevel(level: SpeakerLevel, now: number): void {
    lastLevelAt = now;
    speaking = vad.process(level).speaking;

    if (speaking) {
      lastSpeechAt = now;
      if (!turnOpen) {
        turnOpen = true;
        turn = preRoll;
        turnLen = preRollLen;
        preRoll = [];
        preRollLen = 0;
      }
    } else if (turnOpen && now - lastSpeechAt >= turnEndMs) {
      closeTurn();
    }
  }

  function onPcm(chunk: Buffer, now: number): void {
    let pcm = carry ? Buffer.concat([carry, chunk]) : chunk;

    carry = null;
    if (pcm.length % 2 === 1) {
      carry = pcm.subarray(pcm.length - 1);
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    if (pcm.length === 0) return;

    if (turnOpen || !gated(now)) {
      turn.push(pcm);
      turnLen += pcm.length;
      if (turnLen >= maxSegmentBytes) cut();
      return;
    }

    // Idle: keep only the most recent pre-roll window.
    preRoll.push(pcm);
    preRollLen += pcm.length;
    while (preRollLen > preRollBytes && preRoll.length > 0) {
      const excess = preRollLen - preRollBytes;
      const head = preRoll[0];

      if (head.length <= excess) {
        preRoll.shift();
        preRollLen -= head.length;
      } else {
        // Chunks are even-length, so an even trim keeps sample alignment.
        const drop = excess + (excess % 2);

        preRoll[0] = head.subarray(drop);
        preRollLen -= drop;
      }
    }
  }

  function tick(now: number): void {
    if (gated(now)) return;

    // No analysis data: the open turn can never see a VAD-quiet frame, so close
    // it, and otherwise behave like the old fixed-slice path.
    if (turnOpen) {
      closeTurn();
      lastSliceAt = now;
    } else if (turnLen > 0 && now - lastSliceAt >= fallbackSliceMs) {
      cut();
      lastSliceAt = now;
    }
    speaking = false;
  }

  function reset(): void {
    vad.reset();
    preRoll = [];
    preRollLen = 0;
    turn = [];
    turnLen = 0;
    turnOpen = false;
    speaking = false;
    lastSpeechAt = 0;
    lastLevelAt = 0;
    lastSliceAt = 0;
    carry = null;
    pending.length = 0;
  }

  return {
    onLevel,
    onPcm,
    tick,
    closeTurn,
    takeSegment: () => pending.shift() ?? null,
    pendingCount: () => pending.length,
    isSpeaking:   () => speaking,
    reset,
  };
}
