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

import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';
import type { Extractor, StreamContext, DispatchFn, VoiceLogFn } from './Extractor';
import { VOICE_MODE_PROMPT } from '../prompts/voiceModes';

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
  private speakBuffer = '';
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
    this.contentBuffer += chunk;

    // Detect <speak> tag opening
    if (!this.insideSpeakTag) {
      const openIdx = this.contentBuffer.indexOf('<speak>');

      if (openIdx !== -1) {
        this.insideSpeakTag = true;
        const afterTag = this.contentBuffer.slice(openIdx + 7);

        this.voiceLog(ctx.state, 'SPEAK', 'OPEN');

        this.speakBuffer = afterTag;
        this.sentenceBuffer = afterTag;
        // Fall through to check for </speak> in same pass
      } else {
        return chunk; // No speak tag yet — pass through
      }
    } else {
      // Inside <speak> tag — accumulate
      this.speakBuffer += chunk;
      this.sentenceBuffer += chunk;
    }

    // Check for closing </speak> tag
    const closeIdx = this.speakBuffer.indexOf('</speak>');

    if (closeIdx !== -1) {
      const speakContent = this.speakBuffer.slice(0, closeIdx).trim();

      if (speakContent.length > 0) {
        this.voiceLog(ctx.state, 'SPEAK', 'CLOSE', { text: speakContent.slice(0, 200) });
        this.dispatchSpeak(ctx, speakContent);
        this.spokenSentences.push(speakContent);
      }
      this.insideSpeakTag = false;
      this.speakBuffer = '';
      this.sentenceBuffer = '';

      return ''; // Speak content stripped from chat output
    }

    // Sentence boundary detection — dispatch complete sentences during streaming
    this.tryDispatchSentence(ctx);

    return ''; // Inside speak tag — don't output to chat
  }

  // ─── Complete Processing (after streaming ends) ─────────────

  processComplete(reply: NormalizedResponse, ctx: StreamContext): string {
    // Flush any remaining buffered sentence content
    if (this.insideSpeakTag && this.sentenceBuffer.trim()) {
      const remaining = this.sentenceBuffer.replace('</speak>', '').trim();

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
    this.speakBuffer = '';
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
