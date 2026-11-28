// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type UsageSessionMode = 'new' | 'resume' | 'reseed';

export interface ProviderUsageContext {
  runId: string | null | undefined;
  convId: string;
  threadId: string | null | undefined;
  model: string | null | undefined;
  effort: string | null | undefined;
  sessionMode: UsageSessionMode;
}

export interface CodexUsageSample {
  runId: string | null;
  convId: string;
  threadId: string | null;
  turnSeq: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  model: string;
  effort: string | null;
  sessionMode: UsageSessionMode;
}

export interface ClaudeUsageSample {
  runId: string | null;
  convId: string;
  threadId: string | null;
  turnSeq: number;
  input: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  output: number | null;
  model: string;
  effort: string | null;
  sessionMode: UsageSessionMode;
}

type Usage = Record<string, unknown>;

/** Formats id-only provider usage telemetry and numbers turns per session. */
export class UsageRecorder {
  private readonly turnSequences = new Map<string, number>();

  constructor(private readonly writePerfLine: (line: string) => void) {}

  recordCodex(usage: unknown, context: ProviderUsageContext): CodexUsageSample {
    const values = this.asUsage(usage);
    const sample: CodexUsageSample = {
      ...this.identifiers('codex', context),
      inputTokens:        this.tokenValue(values.input_tokens),
      cachedInputTokens:  this.tokenValue(values.cached_input_tokens ?? this.nested(values, 'input_tokens_details', 'cached_tokens')),
      outputTokens:       this.tokenValue(values.output_tokens),
      reasoningTokens:    this.tokenValue(values.reasoning_output_tokens ?? this.nested(values, 'output_tokens_details', 'reasoning_tokens')),
      model:              this.safeName(context.model),
      effort:             this.safeNullableName(context.effort),
      sessionMode:        context.sessionMode,
    };

    this.writePerfLine(`[CodexUsage] runId=${ sample.runId ?? 'null' } convId=${ sample.convId } threadId=${ sample.threadId ?? 'null' } turnSeq=${ sample.turnSeq } inputTokens=${ sample.inputTokens ?? 'null' } cachedInputTokens=${ sample.cachedInputTokens ?? 'null' } outputTokens=${ sample.outputTokens ?? 'null' } reasoningTokens=${ sample.reasoningTokens ?? 'null' } model=${ sample.model } effort=${ sample.effort ?? 'null' } sessionMode=${ sample.sessionMode }`);
    return sample;
  }

  recordClaude(usage: unknown, context: ProviderUsageContext): ClaudeUsageSample {
    const values = this.asUsage(usage);
    const sample: ClaudeUsageSample = {
      ...this.identifiers('claude', context),
      input:        this.tokenValue(values.input_tokens),
      cacheRead:    this.tokenValue(values.cache_read_input_tokens),
      cacheCreation: this.tokenValue(values.cache_creation_input_tokens),
      output:       this.tokenValue(values.output_tokens),
      model:        this.safeName(context.model),
      effort:       this.safeNullableName(context.effort),
      sessionMode:  context.sessionMode,
    };

    this.writePerfLine(`[ClaudeUsage] runId=${ sample.runId ?? 'null' } convId=${ sample.convId } threadId=${ sample.threadId ?? 'null' } turnSeq=${ sample.turnSeq } input=${ sample.input ?? 'null' } cache_read=${ sample.cacheRead ?? 'null' } cache_creation=${ sample.cacheCreation ?? 'null' } output=${ sample.output ?? 'null' } model=${ sample.model } effort=${ sample.effort ?? 'null' } sessionMode=${ sample.sessionMode }`);
    return sample;
  }

  private identifiers(provider: string, context: ProviderUsageContext): Pick<CodexUsageSample, 'runId' | 'convId' | 'threadId' | 'turnSeq'> {
    const convId = this.safeId(context.convId) ?? 'unknown';
    const threadId = this.safeId(context.threadId);
    const sessionKey = `${ provider }:${ threadId ?? convId }`;
    const turnSeq = (this.turnSequences.get(sessionKey) ?? 0) + 1;
    this.turnSequences.set(sessionKey, turnSeq);
    return {
      runId: this.safeId(context.runId),
      convId,
      threadId,
      turnSeq,
    };
  }

  private asUsage(value: unknown): Usage {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Usage : {};
  }

  private nested(values: Usage, key: string, nestedKey: string): unknown {
    return this.asUsage(values[key])[nestedKey];
  }

  private tokenValue(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }

  private safeId(value: unknown): string | null {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : null;
  }

  private safeName(value: unknown): string {
    return typeof value === 'string' && /^[A-Za-z0-9._/-]{1,120}$/.test(value) ? value : 'unknown';
  }

  private safeNullableName(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : 'unknown';
  }
}
