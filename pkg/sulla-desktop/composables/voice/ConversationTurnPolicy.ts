// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Buffers transcript segments without losing words when recognition resumes. */
export class TurnBuffer {
  private segments: string[] = [];

  append(text: string): string {
    const clean = text.trim();
    if (clean) this.segments.push(clean);
    return this.text;
  }

  get text(): string { return this.segments.join(' '); }
  clear(): void { this.segments = []; }
}

/** Pluggable decision point for a future semantic end-of-turn model. */
export interface EndOfTurnDetector {
  delayMs(transcript: string, defaultHoldMs: number): number;
}

/** Extends the silence hold when the last words suggest an unfinished thought. */
export class HeuristicEndOfTurnDetector implements EndOfTurnDetector {
  private readonly unfinished = /(?:\b(?:and|so|but|a|an|the|to|of|for|with|because|if|when|that)|,)\s*$/i;
  delayMs(transcript: string, defaultHoldMs: number): number {
    return this.unfinished.test(transcript.trim()) ? defaultHoldMs * 2 : defaultHoldMs;
  }
}

/** Emits complete sentence fragments within a configurable spoken word/sentence budget. */
export class SentenceFragmenter {
  private pending = '';
  private words = 0;
  private sentences = 0;
  private readonly maxWords: number;
  private readonly maxSentences: number;

  constructor(maxWords = 60, maxSentences = 3) {
    if (maxWords < 1 || maxSentences < 1) throw new Error('voice reply limits must be positive');
    this.maxWords = maxWords;
    this.maxSentences = maxSentences;
  }

  feed(text: string): string[] {
    this.pending += text;
    const emitted: string[] = [];
    const boundary = /(?<=[.!?])\s+/g;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.pending))) {
      const sentence = this.pending.slice(0, match.index + 1).trim();
      const count = sentence.split(/\s+/).filter(Boolean).length;
      if (this.words + count > this.maxWords || this.sentences >= this.maxSentences) break;
      emitted.push(sentence);
      this.words += count;
      this.sentences++;
      this.pending = this.pending.slice(match.index + match[0].length);
      boundary.lastIndex = 0;
    }
    return emitted;
  }

  finish(): string[] {
    const tail = this.pending.trim();
    const count = tail.split(/\s+/).filter(Boolean).length;
    if (!tail || this.words + count > this.maxWords || this.sentences >= this.maxSentences) return [];
    this.pending = '';
    this.words += count;
    this.sentences++;
    return [tail];
  }
}

/** Applies a hard sentence/word budget without ever slicing a sentence. */
export class SpokenReplyGovernor {
  private words = 0;
  private sentences = 0;
  private noticeSent = false;
  private readonly maxWords: number;
  private readonly maxSentences: number;

  constructor(maxWords = 60, maxSentences = 3) {
    if (maxWords < 1 || maxSentences < 1) throw new Error('voice reply limits must be positive');
    this.maxWords = maxWords;
    this.maxSentences = maxSentences;
  }

  accept(text: string): { fragments: string[]; showScreenNotice: boolean } {
    const sentences = text.trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
    const fragments: string[] = [];
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      const count = sentence.split(/\s+/).length;
      if (this.sentences >= this.maxSentences || this.words + count > this.maxWords) {
        const showScreenNotice = !this.noticeSent;
        this.noticeSent = true;
        return { fragments, showScreenNotice };
      }
      fragments.push(sentence);
      this.words += count;
      this.sentences++;
    }
    return { fragments, showScreenNotice: false };
  }
}
