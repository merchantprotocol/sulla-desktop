import * as childProcess from 'child_process';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason } from './BaseLanguageModel';
import { resolveLimactlPath, resolveLimaHome } from '../tools/util/CommandRunner';
import Logging from '@pkg/utils/logging';

const log = Logging.background;

/**
 * ClaudeCodeService — runs `claude -p` inside the Lima VM and streams the
 * stream-json NDJSON output back into Sulla's agent loop.
 *
 * Unlike Anthropic/Grok/OpenAI peers, Claude Code already owns its own agent
 * loop, tool execution, and context management inside the CLI process. From
 * Sulla's perspective it behaves as a "one-shot completion" peer: the final
 * text answer is what Sulla consumes; any tool work Claude does happens
 * internally (through the `sulla` CLI + its built-in Bash/Read/Edit).
 *
 * Token strategy — hybrid (first-turn seed + --resume thereafter):
 *   - First turn for a conversation (no cached session id): serialize the
 *     full curated state.messages[] as a transcript so Claude catches up to
 *     wherever Sulla is. The subconscious middleware has already trimmed
 *     this to fit context, so we trust it.
 *   - Subsequent turns: look up the cached session id for this
 *     conversationId and pass --resume <sessionId>. We send ONLY the latest
 *     user message as -p; Claude's own session (and Anthropic's prompt
 *     cache) keeps the prior context warm at ~1/10th the cost.
 *   - Session-lock collisions (another spawn holds the same session): drop
 *     the cached id and retry once with a fresh session (full history).
 *
 * OAuth token refresh is the CLI's job. We only pass CLAUDE_CODE_OAUTH_TOKEN
 * (or ANTHROPIC_API_KEY) and stay out of its auth lifecycle.
 */
export class ClaudeCodeService extends BaseLanguageModel {
  // conversationId → Claude session_id captured from a prior spawn.
  private sessions = new Map<string, string>();

  override getContextWindow(): number {
    return 200_000;
  }

  override getModel(): string {
    return this.model || 'claude-code';
  }

  override getProviderName(): string {
    return 'Claude Code';
  }

  protected async healthCheck(): Promise<boolean> {
    // Credentials presence is deferred until spawn time (see runClaude).
    return true;
  }

  constructor() {
    super({ id: 'claude-code', model: 'claude-code', baseUrl: 'local-vm' });
  }

  /** Non-streaming chat — buffers the whole response and returns it. */
  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    const { text } = await this.runClaude(messages, {}, options);
    return { text };
  }

  protected normalizeResponse(raw: any): NormalizedResponse {
    const text: string = raw?.text ?? '';
    return {
      content:  text,
      metadata: {
        tokens_used:       0,
        time_spent:        0,
        prompt_tokens:     0,
        completion_tokens: 0,
        model:             this.getModel(),
        finish_reason:     FinishReason.Stop,
      },
    };
  }

  /** Streaming path — forwards text_delta chunks to onToken. */
  override async chatStream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options: {
      signal?:         AbortSignal;
      conversationId?: string;
    } = {},
  ): Promise<NormalizedResponse | null> {
    const startTime = performance.now();

    try {
      const { text } = await this.runClaude(messages, callbacks, options);

      return {
        content:  text,
        metadata: {
          tokens_used:       0,
          time_spent:        Math.round(performance.now() - startTime),
          prompt_tokens:     0,
          completion_tokens: 0,
          model:             this.getModel(),
          finish_reason:     FinishReason.Stop,
        },
      };
    } catch (err) {
      console.warn('[ClaudeCodeService] chatStream failed:', err);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────

  /**
   * Extract the last user message. Walks backward to find the newest
   * user-role content, flattening string + content-block shapes. When a
   * --resume session exists, this is all we send — Claude already has
   * everything earlier in its session state.
   */
  private extractLatestUserMessage(messages: ChatMessage[]): string {
    const blockToText = (b: any): string => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string') return b.content;
        if (Array.isArray(b.content)) return b.content.map(blockToText).filter(Boolean).join('\n');
      }
      return '';
    };

    const msgToText = (m: ChatMessage): string => {
      const c: any = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(blockToText).filter(Boolean).join('\n');
      return '';
    };

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const text = msgToText(messages[i]).trim();
        if (text) return text;
      }
    }
    // Fallback — pick any extractable text so a tool_result-dominated turn
    // still has something to send.
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = msgToText(messages[i]).trim();
      if (text) return text;
    }
    return '';
  }

  /**
   * Serialize Sulla's curated conversation into a full transcript — used
   * only when seeding a fresh Claude session (no existing session id).
   * tool_use / tool_result blocks render inline so Claude can follow prior
   * tool traces.
   */
  private serializeFullTranscript(messages: ChatMessage[]): string {
    const blockToText = (b: any): string => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'tool_use') {
        const name = b.name ?? 'tool';
        const input = b.input ? JSON.stringify(b.input) : '';
        return `[tool_use ${ name }${ input ? ` ${ input }` : '' }]`;
      }
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string') return `[tool_result] ${ b.content }`;
        if (Array.isArray(b.content)) return `[tool_result] ${ b.content.map(blockToText).filter(Boolean).join('\n') }`;
      }
      return '';
    };

    const msgToText = (m: ChatMessage): string => {
      const c: any = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(blockToText).filter(Boolean).join('\n');
      return '';
    };

    const labelFor = (role: string) => {
      switch (role) {
      case 'assistant': return 'Assistant';
      case 'user':      return 'User';
      case 'system':    return 'System';
      default:          return role;
      }
    };

    const lines: string[] = [];
    for (const m of messages) {
      const text = msgToText(m).trim();
      if (!text) continue;
      lines.push(`${ labelFor(m.role) }: ${ text }`);
    }
    return lines.join('\n\n');
  }

  /**
   * Spawn claude -p in the VM, stream text_delta chunks to the callback,
   * return the final text.
   *
   * @param retryWithoutSession — internal flag for the session-lock retry
   *   path; do not pass from callers.
   */
  private async runClaude(
    messages: ChatMessage[],
    callbacks: Partial<StreamCallbacks>,
    options: { signal?: AbortSignal; conversationId?: string },
    retryWithoutSession = false,
  ): Promise<{ text: string }> {
    // Prefer the integration vault (new path). Fall back to SullaSettingsModel
    // so users configured via Language Model Settings keep working during the
    // transition.
    let oauthToken = '';
    let apiKey = '';
    try {
      const { getIntegrationService } = await import('../services/IntegrationService');
      const values = await getIntegrationService().getFormValues('claude-code');
      for (const v of values) {
        if (v.property === 'oauth_token' && v.value) oauthToken = v.value;
        if (v.property === 'api_key' && v.value) apiKey = v.value;
      }
    } catch (err) {
      console.warn('[ClaudeCodeService] Vault lookup failed, falling back to SullaSettingsModel:', err);
    }

    if (!oauthToken && !apiKey) {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
      oauthToken = (await SullaSettingsModel.get('claudeOAuthToken', '')) ?? '';
      apiKey = (await SullaSettingsModel.get('claudeApiKey', '')) ?? '';
    }

    if (!oauthToken && !apiKey) {
      throw new Error('No Claude credentials configured. Sign in via Integrations → Claude Code.');
    }

    const convId = options.conversationId ?? '__default__';
    const existingSession = retryWithoutSession ? undefined : this.sessions.get(convId);

    // Prompt strategy:
    //   - existingSession → send only the latest user message (Claude has the
    //     rest via --resume + prompt cache)
    //   - no session    → seed Claude with the full curated transcript
    const prompt = existingSession
      ? this.extractLatestUserMessage(messages)
      : this.serializeFullTranscript(messages);

    if (!prompt.trim()) {
      const roles = messages.map(m => m.role).join(',');
      throw new Error(`Claude Code got no extractable prompt from ${ messages.length } messages (roles=${ roles })`);
    }

    log.log(`[ClaudeCodeService] runClaude: messages=${ messages.length } promptLen=${ prompt.length } conversationId=${ convId } session=${ existingSession ?? '(new)' } hasOAuth=${ !!oauthToken } hasApiKey=${ !!apiKey }`);

    const limactlPath = resolveLimactlPath({});
    const limaHome = resolveLimaHome({});

    // POSIX single-quote escape. Single-quoted strings are literal in sh, so
    // no backtick/$VAR/! expansion can fire against untrusted text.
    const shq = (s: string) => `'${ s.replace(/'/g, "'\\''") }'`;

    const envAssignments: string[] = [];
    if (oauthToken) envAssignments.push(`CLAUDE_CODE_OAUTH_TOKEN=${ shq(oauthToken) }`);
    if (apiKey) envAssignments.push(`ANTHROPIC_API_KEY=${ shq(apiKey) }`);

    // Build the full Sulla system prompt fresh each turn so Claude sees the
    // current identity, skills, extensions, integrations, and any durable
    // observational memory. Failures here must not block the chat.
    let appendSystemPrompt = '';
    try {
      const { buildFullSystemPrompt } = await import('../prompts/buildFullSystemPrompt');
      appendSystemPrompt = await buildFullSystemPrompt({ provider: 'anthropic' });
    } catch (err) {
      log.log(`[ClaudeCodeService] buildFullSystemPrompt failed, continuing without it: ${ (err as Error)?.message ?? err }`);
    }

    const claudeArgs = [
      'claude',
      '-p', shq(prompt),
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ];
    if (appendSystemPrompt.trim()) {
      claudeArgs.push('--append-system-prompt', shq(appendSystemPrompt));
    }
    if (existingSession) {
      claudeArgs.push('--resume', shq(existingSession));
    }

    const innerCmd = `${ envAssignments.join(' ') } ${ claudeArgs.join(' ') } < /dev/null`;
    const args = ['shell', '0', '--', 'sh', '-c', innerCmd];

    return await new Promise((resolve, reject) => {
      const proc = childProcess.spawn(limactlPath, args, {
        env: { ...process.env, LIMA_HOME: limaHome, TERM: 'dumb' },
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let textCollected = '';
      let capturedSessionId: string | undefined = existingSession;
      let errored = false;
      let errorMessage = '';
      let sessionInUse = false;

      const onAbort = () => {
        try { proc.kill('SIGTERM') } catch { /* already dead */ }
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort);
      }

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }

        if (parsed.session_id) capturedSessionId = parsed.session_id;

        // Text chunks → stream to caller
        const delta = parsed?.event?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          textCollected += delta.text;
          try { callbacks.onToken?.(delta.text) } catch { /* ignore */ }
          return;
        }

        // Final result event — capture full text and record usage/cost.
        if (parsed.type === 'result') {
          if (parsed.is_error) {
            errored = true;
            if (typeof parsed.result === 'string' && parsed.result) {
              errorMessage = parsed.result;
            }
          } else {
            if (typeof parsed.result === 'string' && !textCollected) {
              textCollected = parsed.result;
              try { callbacks.onToken?.(parsed.result) } catch { /* ignore */ }
            }
            // Usage capture is best-effort — never block on failure.
            recordUsage(parsed).catch(() => { /* ignore */ });
          }
        }
      };

      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString('utf-8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf-8');
        stderrBuffer += text;
        const trimmed = text.trim();
        // Detect the session-collision signal so we can retry without it.
        if (/Session ID .* is already in use/i.test(stderrBuffer)) {
          sessionInUse = true;
        }
        if (trimmed && !trimmed.includes('no stdin data received')) {
          console.log(`[ClaudeCodeService][stderr] ${ trimmed.slice(0, 200) }`);
        }
      });

      proc.on('error', (err) => {
        options.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      proc.on('close', (code) => {
        options.signal?.removeEventListener('abort', onAbort);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);

        // Session lock collision — drop the cached id and retry once with a
        // fresh session so the user doesn't see a dead-end error.
        if (sessionInUse && !retryWithoutSession) {
          log.warn(`[ClaudeCodeService] Session "${ existingSession }" locked; retrying without --resume for conversationId=${ convId }`);
          this.sessions.delete(convId);
          this.runClaude(messages, callbacks, options, true).then(
            r => resolve(r),
            reject,
          );
          return;
        }

        if (capturedSessionId) {
          this.sessions.set(convId, capturedSessionId);
        }

        if (errored) {
          const msg = errorMessage || textCollected || `claude exited with code ${ code }`;
          log.warn(`[ClaudeCodeService] runClaude errored: ${ msg.slice(0, 200) }`);
          reject(new Error(`Claude Code: ${ msg }`));
          return;
        }

        if (!textCollected.trim()) {
          const stderrTail = stderrBuffer.trim().slice(-200);
          log.warn(`[ClaudeCodeService] runClaude exited with no text (code=${ code }) stderr=${ stderrTail }`);
          reject(new Error(`Claude Code returned no output (exit code ${ code }). ${ stderrTail || 'Check credentials and VM status.' }`));
          return;
        }

        log.log(`[ClaudeCodeService] runClaude ok: ${ textCollected.length } chars, session=${ capturedSessionId ?? '(none)' }`);
        resolve({ text: textCollected });
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Usage capture
// ─────────────────────────────────────────────────────────────

interface UsageRecord {
  ts:             string;
  duration_ms?:   number;
  input_tokens?:  number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?:     number;
  cost_usd?:      number;
  model?:         string;
}

const USAGE_SETTING_KEY = 'claudeCodeUsage';
const USAGE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const USAGE_MAX_ENTRIES = 500;

/**
 * Append a single usage sample from Claude Code's result event to
 * SullaSettingsModel.claudeCodeUsage. Trims to a rolling 24h window and
 * caps the array length so the settings row can't grow unbounded.
 */
async function recordUsage(result: any): Promise<void> {
  const u = result?.usage;
  if (!u) return;

  try {
    const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
    const raw = await SullaSettingsModel.get(USAGE_SETTING_KEY, '[]');
    let records: UsageRecord[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) records = parsed;
    } catch { /* ignore unparseable prior value */ }

    const entry: UsageRecord = {
      ts:                          new Date().toISOString(),
      duration_ms:                 typeof result.duration_ms === 'number' ? result.duration_ms : undefined,
      input_tokens:                typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
      output_tokens:               typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
      cache_creation_input_tokens: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : undefined,
      cache_read_input_tokens:     typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : undefined,
      cost_usd:                    typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
      model:                       typeof result.model === 'string' ? result.model : undefined,
    };

    records.push(entry);

    const cutoff = Date.now() - USAGE_RETENTION_MS;
    records = records.filter(r => {
      const t = Date.parse(r.ts);
      return Number.isFinite(t) && t >= cutoff;
    });

    if (records.length > USAGE_MAX_ENTRIES) {
      records = records.slice(-USAGE_MAX_ENTRIES);
    }

    await SullaSettingsModel.set(USAGE_SETTING_KEY, JSON.stringify(records));
  } catch {
    /* persistence failure — don't disturb the chat */
  }
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

let claudeCodeInstance: ClaudeCodeService | null = null;

export function getClaudeCodeService(): ClaudeCodeService {
  if (!claudeCodeInstance) {
    claudeCodeInstance = new ClaudeCodeService();
  }
  return claudeCodeInstance;
}

export function resetClaudeCodeService(): void {
  claudeCodeInstance = null;
}
