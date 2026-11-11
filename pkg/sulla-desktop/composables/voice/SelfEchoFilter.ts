// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

interface SpokenEntry { words: string[]; expiresAt: number }

export interface SelfEchoFilterOptions {
  now?: () => number;
  /** Seconds of playback assumed per word, used to keep an entry alive while it is heard. */
  secondsPerWord?: number;
  /** Extra time after estimated playback to catch delayed recognition chunks. */
  tailMs?: number;
  /** Fraction of a transcript's words that must match recent speech to count as echo. */
  overlap?: number;
}

/**
 * Recognises transcripts that are Sulla hearing her own voice through the speakers.
 * The mic runs without echo cancellation, so Kokoro playback comes back as "user" speech;
 * treating it as a turn made Sulla interrupt herself.
 */
export class SelfEchoFilter {
  private entries: SpokenEntry[] = [];
  private readonly now: () => number;
  private readonly secondsPerWord: number;
  private readonly tailMs: number;
  private readonly overlap: number;

  constructor(options: SelfEchoFilterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.secondsPerWord = options.secondsPerWord ?? 0.5;
    this.tailMs = options.tailMs ?? 6000;
    this.overlap = options.overlap ?? 0.6;
  }

  private static words(text: string): string[] {
    return text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
  }

  /** Record text that is about to be spoken aloud. */
  recordSpoken(text: string): void {
    const words = SelfEchoFilter.words(text);
    if (!words.length) return;
    const start = Math.max(this.now(), this.entries.at(-1)?.expiresAt ? this.entries.at(-1)!.expiresAt - this.tailMs : 0);
    this.entries.push({ words, expiresAt: start + words.length * this.secondsPerWord * 1000 + this.tailMs });
  }

  clear(): void { this.entries = []; }

  /** Remove a ≥4-word contiguous echo at either transcript edge, preserving user words. */
  stripEchoSpans(transcript: string): string {
    const heard = SelfEchoFilter.words(transcript);
    const spoken = this.entries.filter(e => e.expiresAt > this.now()).flatMap(e => e.words);
    if (!heard.length || !spoken.length) return transcript;
    const overlapAt = (start: number): number => {
      let best = 0;
      for (let i = 0; i < spoken.length; i++) {
        let n = 0;
        while (start + n < heard.length && i + n < spoken.length && heard[start + n] === spoken[i + n]) n++;
        best = Math.max(best, n);
      }
      return best >= 4 ? best : 0;
    };
    const leading = overlapAt(0, 'leading');
    const trailing = (() => { let best = 0; for (let n = 4; n <= heard.length; n++) { const suffix = heard.slice(heard.length - n); if (spoken.some((_, i) => suffix.every((w, j) => spoken[i + j] === w))) best = n; } return best; })();
    // Token-aware slicing keeps punctuation and casing on the retained user span.
    const tokens = transcript.match(/\S+/g) ?? [];
    const cleanWord = (v: string) => v.toLowerCase().replace(/[^a-z0-9']/g, '');
    let from = 0, to = tokens.length;
    for (let i = 0; i < tokens.length && from < leading; i++) if (cleanWord(tokens[i])) from++;
    for (let i = tokens.length - 1; i >= 0 && to > tokens.length - trailing; i--) if (cleanWord(tokens[i])) to--;
    return tokens.slice(from, Math.max(from, to)).join(' ').trim();
  }

  isEcho(transcript: string): boolean {
    const now = this.now();
    this.entries = this.entries.filter(e => e.expiresAt > now);
    if (!this.entries.length) return false;
    const heard = SelfEchoFilter.words(transcript);
    if (!heard.length) return false;
    const spoken = new Set<string>();
    for (const e of this.entries) for (const w of e.words) spoken.add(w);
    const matches = heard.filter(w => spoken.has(w)).length;
    return matches / heard.length >= this.overlap;
  }
}
