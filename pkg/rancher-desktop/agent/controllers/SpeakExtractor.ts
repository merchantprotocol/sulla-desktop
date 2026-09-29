/**
 * SpeakExtractor — extracts <speak> tags from LLM output and dispatches
 * sentences for TTS playback.
 *
 * Two-way extractor:
 *   IN:  enrichPrompt() appends VOICE_MODE_PROMPT to the system prompt
 *   OUT: processChunk() detects <speak> tags during streaming, splits into
 *        sentences, and dispatches each sentence immediately for TTS playback.
 *        processComplete() flushes remaining buffer and strips all <speak> tags.
 *
 * This is the ONLY code path that dispatches speak content. If TTS plays
 * something it shouldn't, the bug is in this file.
 *
 * Grep tags: VOICE:SPEAK:OPEN, VOICE:SPEAK:CLOSE, VOICE:SPEAK:SENTENCE,
 *            VOICE:SPEAK:FLUSH, VOICE:SPEAK:EXTRACT_POST
 */

import { VOICE_MODE_PROMPT } from '../prompts/voiceModes';

import type { Extractor, StreamContext, DispatchFn, VoiceLogFn } from './Extractor';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';

// ─── Constants ──────────────────────────────────────────────────

const MIN_SENTENCE_LENGTH = 20;

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'inc', 'ltd', 'corp', 'dept', 'univ', 'approx', 'est', 'govt',
  'e.g', 'i.e', 'a.m', 'p.m',
]);

// ─── Extractor ──────────────────────────────────────────────────

export class SpeakExtractor implements Extractor {
  readonly name = 'speak';

  private readonly dispatch: DispatchFn;
  private readonly voiceLog: VoiceLogFn;

  // Streaming state
  private contentBuffer = '';
  private insideSpeakTag = false;
  private sentenceBuffer = '';
  private readonly spokenSentences: string[] = [];

  constructor(dispatch: DispatchFn, voiceLog: VoiceLogFn) {
    this.dispatch = dispatch;
    this.voiceLog = voiceLog;
  }

  // ─── Prompt Enrichment ──────────────────────────────────────

  enrichPrompt(systemPrompt: string, _ctx: StreamContext): string {
    return systemPrompt + VOICE_MODE_PROMPT;
  }

  // ─── Chunk Processing (real-time during streaming) ──────────

  processChunk(chunk: string, ctx: StreamContext): string {
    // `contentBuffer` holds only text not yet consumed — everything before it has
    // been passed through, buffered for speech, or dispatched. Consuming as we go
    // is what keeps a closed <speak> block from being found (and spoken) again on
    // the next token.
    this.contentBuffer += chunk;
    let output = '';

    for (;;) {
      if (!this.insideSpeakTag) {
        const openIdx = this.contentBuffer.indexOf('<speak>');

        if (openIdx === -1) {
          // Hold back a possible partial "<speak" so a tag split across tokens is still seen.
          const keep = partialTagSuffix(this.contentBuffer, '<speak>');

          output += this.contentBuffer.slice(0, this.contentBuffer.length - keep);
          this.contentBuffer = this.contentBuffer.slice(this.contentBuffer.length - keep);

          return output;
        }

        output += this.contentBuffer.slice(0, openIdx);
        this.contentBuffer = this.contentBuffer.slice(openIdx + '<speak>'.length);
        this.insideSpeakTag = true;
        this.sentenceBuffer = '';
        this.voiceLog(ctx.state, 'SPEAK', 'OPEN');
      }

      const closeIdx = this.contentBuffer.indexOf('</speak>');

      if (closeIdx === -1) {
        const keep = partialTagSuffix(this.contentBuffer, '</speak>');

        this.sentenceBuffer += this.contentBuffer.slice(0, this.contentBuffer.length - keep);
        this.contentBuffer = this.contentBuffer.slice(this.contentBuffer.length - keep);
        // Sentence boundary detection — dispatch complete sentences during streaming
        this.tryDispatchSentence(ctx);

        return output; // Inside speak tag — don't output to chat
      }

      // Block closed: speak only what hasn't been dispatched sentence-by-sentence yet.
      this.sentenceBuffer += this.contentBuffer.slice(0, closeIdx);
      this.contentBuffer = this.contentBuffer.slice(closeIdx + '</speak>'.length);
      const remaining = this.sentenceBuffer.trim();

      if (remaining.length > 0) {
        this.voiceLog(ctx.state, 'SPEAK', 'CLOSE', { text: remaining.slice(0, 200) });
        this.dispatchSpeak(ctx, remaining);
        this.spokenSentences.push(remaining);
      }
      this.insideSpeakTag = false;
      this.sentenceBuffer = '';
      // Loop: the rest of the buffer may hold more text or another <speak> block.
    }
  }

  // ─── Complete Processing (after streaming ends) ─────────────

  processComplete(reply: NormalizedResponse, ctx: StreamContext): string {
    // Flush any remaining buffered sentence content (stream ended inside an unclosed <speak>)
    // (contentBuffer can only hold a partial "</speak" here — never speak it.)
    if (this.insideSpeakTag && this.sentenceBuffer.trim()) {
      const remaining = this.sentenceBuffer.trim();

      if (remaining.length > 0) {
        this.voiceLog(ctx.state, 'SPEAK', 'FLUSH', { text: remaining.slice(0, 200) });
        this.dispatchSpeak(ctx, remaining);
        this.spokenSentences.push(remaining);
      }
    }

    // Strip all <speak> tags from the final content
    const speakTagRegex = /<speak>([\s\S]*?)<\/speak>/gi;

    reply.content = reply.content.replace(speakTagRegex, '').trim();

    return reply.content;
  }

  // ─── Reset ──────────────────────────────────────────────────

  reset(): void {
    this.contentBuffer = '';
    this.insideSpeakTag = false;
    this.sentenceBuffer = '';
    this.spokenSentences.length = 0;
  }

  // ─── Post-completion extraction (non-voice mode fallback) ───

  /**
   * Extract <speak> tags from a complete response (not during streaming).
   * Used when the controller processes a non-voice response that still
   * contains <speak> tags (e.g. text mode where the LLM spontaneously
   * included them).
   */
  extractAndDispatchFromComplete(reply: NormalizedResponse, ctx: StreamContext): void {
    const speakTagRegex = /<speak>([\s\S]*?)<\/speak>/gi;
    const tagMatches = reply.content.match(speakTagRegex);

    if (!tagMatches) return;

    this.voiceLog(ctx.state, 'SPEAK', 'EXTRACT_POST', {
      contentLength: reply.content.length,
    });

    const spoken = tagMatches
      .map(m => m.replace(/<\/?speak>/gi, '').trim())
      .filter(Boolean)
      .join('\n');

    reply.content = reply.content.replace(speakTagRegex, '').trim();

    if (spoken) {
      this.dispatchSpeak(ctx, spoken);
    }
  }

  // ─── Internal ───────────────────────────────────────────────

  private dispatchSpeak(ctx: StreamContext, text: string): void {
    const callerStack = new Error().stack?.split('\n').slice(1, 4).map(l => l.trim()).join(' < ') || '';

    this.voiceLog(ctx.state, 'SPEAK', 'DISPATCH', {
      text:   text.slice(0, 200),
      caller: callerStack,
    });

    // Include pipelineSequence for turn correlation (voice barge-in filtering)
    const pipelineSequence = (ctx.state as any)?.metadata?.pipelineSequence ?? null;

    this.dispatch(ctx.state, 'speak_dispatch', {
      text,
      thread_id: ctx.threadId,
      timestamp: Date.now(),
      pipelineSequence,
    });
  }

  /**
   * Check if the sentence buffer contains a complete sentence and dispatch it.
   * Splits at `. ? !` boundaries, skipping abbreviations and short fragments.
   */
  private tryDispatchSentence(ctx: StreamContext): void {
    const buffer = this.sentenceBuffer;
    const sentenceEndPattern = /([.!?])(\s+)/g;
    let lastSplit = 0;
    let match: RegExpExecArray | null;

    while ((match = sentenceEndPattern.exec(buffer)) !== null) {
      const splitPos = match.index + match[1].length;
      const candidate = buffer.slice(lastSplit, splitPos).trim();

      if (candidate.length < MIN_SENTENCE_LENGTH) continue;

      // Check for abbreviations
      const lastWord = candidate.split(/\s+/).pop()?.replace(/[.!?]$/, '').toLowerCase() || '';

      if (ABBREVIATIONS.has(lastWord)) continue;

      // Dispatch this sentence
      this.voiceLog(ctx.state, 'SPEAK', 'SENTENCE', { text: candidate.slice(0, 200) });
      this.dispatchSpeak(ctx, candidate);
      this.spokenSentences.push(candidate);
      lastSplit = splitPos + match[2].length;
    }

    if (lastSplit > 0) {
      this.sentenceBuffer = buffer.slice(lastSplit);
    }
  }
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag` (a tag split across tokens). */
function partialTagSuffix(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }

  return 0;
}
