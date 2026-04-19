import * as childProcess from 'child_process';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason } from './BaseLanguageModel';
import { resolveLimactlPath, resolveLimaHome } from '../tools/util/CommandRunner';
import Logging from '@pkg/utils/logging';

const log = Logging.background;

/**
 * ClaudeCodeService — runs `claude -p` inside the Lima VM and streams the
 * stream-json NDJSON output back into Sulla's agent loop.
 *
 * Unlike other providers, Claude Code already has its own agent loop,
 * tool execution, and context management. We pass through the user's
 * latest message, let Claude do its thing with --dangerously-skip-permissions,
 * and capture the final text response.
 *
 * Session continuity is maintained via --session-id — we keep a per-
 * conversationId session map so multi-turn chats preserve Claude's context.
 */
export class ClaudeCodeService extends BaseLanguageModel {
  // conversationId → Claude session_id
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
    // Credentials stored in SullaSettingsModel; deferred check at spawn time.
    return true;
  }

  constructor() {
    super({ id: 'claude-code', model: 'claude-code', baseUrl: 'local-vm' });
  }

  /**
   * Non-streaming chat — buffers the whole response and returns it.
   * Used by async callers that don't need token-by-token streaming.
   */
  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    const { text, sessionId } = await this.runClaude(messages, {}, options);
    return { text, sessionId };
  }

  /**
   * Normalize the raw stdout into Sulla's NormalizedResponse format.
   */
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

  /**
   * Streaming path — spawns claude, forwards text_delta chunks to onToken,
   * and returns a NormalizedResponse when done.
   */
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
   * Extract the latest user prompt for Claude Code.
   *
   * The agent orchestrator feeds us rich, multi-turn message arrays — including
   * `tool_use` requests and `tool_result` responses wrapped inside `user` or
   * `assistant` roles. Claude Code's `-p` mode takes ONE prompt string, so we
   * need a robust extractor that:
   *
   *   1. Walks backward from the last message, collecting any plain text content.
   *   2. Flattens string-typed content blocks (Anthropic canonical shape).
   *   3. Falls back to extracting from `tool_result` / `tool_use` payloads so a
   *      conversation dominated by tool blocks still surfaces usable context.
   *   4. Never returns an empty string silently — callers must throw if that
   *      happens, because an empty `-p` argument makes the CLI return nothing
   *      in ~100ms and looks indistinguishable from a network/auth failure.
   */
  private extractPrompt(messages: ChatMessage[]): string {
    const extractFromBlock = (b: any): string => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'tool_result') {
        // tool_result content can be a string or an array of text/content blocks
        if (typeof b.content === 'string') return b.content;
        if (Array.isArray(b.content)) return b.content.map(extractFromBlock).filter(Boolean).join('\n');
      }
      return '';
    };

    const extractFromMessage = (m: ChatMessage): string => {
      const c: any = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.map(extractFromBlock).filter(Boolean).join('\n');
      }
      return '';
    };

    // Prefer the last user message — that's the "new" prompt in a turn.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user') {
        const text = extractFromMessage(m).trim();
        if (text) return text;
      }
    }

    // Fallback: any recent message with extractable text (tool_result, etc.)
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = extractFromMessage(messages[i]).trim();
      if (text) return text;
    }

    return '';
  }

  /**
   * Serialize the prior conversation (everything before the current user
   * prompt) as a plain-text transcript that can be prepended to `-p` when
   * there's no Claude session to resume. The last user message is excluded
   * because it's sent separately as the new prompt; earlier user messages,
   * assistant replies, and tool transcripts are all included so Claude can
   * see how the conversation got here.
   */
  private serializeHistory(messages: ChatMessage[]): string {
    if (messages.length <= 1) return '';

    // Reuse the same extraction logic as extractPrompt by inlining it — keeps
    // tool_use / tool_result blocks visible as the text they carry.
    const extractFromBlock = (b: any): string => {
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
        if (Array.isArray(b.content)) return `[tool_result] ${ b.content.map(extractFromBlock).filter(Boolean).join('\n') }`;
      }
      return '';
    };

    const extractFromMessage = (m: ChatMessage): string => {
      const c: any = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(extractFromBlock).filter(Boolean).join('\n');
      return '';
    };

    // Drop the final user message — that's the new prompt, sent separately.
    // If the last message is not a user turn (e.g. assistant narration), keep
    // everything before it and let extractPrompt pick the latest user above.
    let cutoff = messages.length - 1;
    while (cutoff >= 0 && messages[cutoff].role !== 'user') cutoff--;
    if (cutoff < 0) cutoff = messages.length - 1;

    const history = messages.slice(0, cutoff);
    const lines: string[] = [];
    for (const m of history) {
      const text = extractFromMessage(m).trim();
      if (!text) continue;
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : m.role;
      lines.push(`${ role }: ${ text }`);
    }

    if (lines.length === 0) return '';
    return `Previous conversation:\n${ lines.join('\n\n') }`;
  }

  /**
   * Spawn claude -p in the VM, stream text_delta chunks to the callback,
   * return the final text + session id.
   */
  private async runClaude(
    messages: ChatMessage[],
    callbacks: Partial<StreamCallbacks>,
    options: { signal?: AbortSignal; conversationId?: string },
    retryWithoutSession = false,
  ): Promise<{ text: string; sessionId?: string }> {
    const prompt = this.extractPrompt(messages);
    if (!prompt.trim()) {
      // Returning empty here used to trigger a silent Grok fallback in BaseNode.
      // Throw instead so the user sees the real problem.
      const roles = messages.map(m => m.role).join(',');
      throw new Error(`Claude Code got no extractable prompt from ${ messages.length } messages (roles=${ roles })`);
    }

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

    log.log(`[ClaudeCodeService] runClaude: promptLen=${ prompt.length } conversationId=${ convId } session=${ existingSession ?? '(new)' } hasOAuth=${ !!oauthToken } hasApiKey=${ !!apiKey }`);

    const limactlPath = resolveLimactlPath({});
    const limaHome = resolveLimaHome({});

    // POSIX single-quote escape — wraps in single quotes and escapes any
    // embedded single quotes as `'\''`. Unlike JSON.stringify (which uses
    // double quotes), single-quoted strings are literal in sh — no backtick,
    // $VAR, or ! expansion. JSON.stringify was letting prompts like
    // "look at `sulla-desktop`" fire command substitution before claude ever
    // saw the argument.
    const shq = (s: string) => `'${ s.replace(/'/g, "'\\''") }'`;

    const envAssignments: string[] = [];
    if (oauthToken) envAssignments.push(`CLAUDE_CODE_OAUTH_TOKEN=${ shq(oauthToken) }`);
    if (apiKey) envAssignments.push(`ANTHROPIC_API_KEY=${ shq(apiKey) }`);

    // When there's no existing Claude session for this conversation, Claude
    // starts fresh and has no context from prior turns. Serialize Sulla's
    // full message history so the first turn of a new session still carries
    // the conversation. With --resume, Claude already has the session state;
    // re-sending the history would be wasteful.
    const historyBlock = existingSession ? '' : this.serializeHistory(messages);
    const promptForClaude = historyBlock
      ? `${ historyBlock }\n\n--- new message ---\n${ prompt }`
      : prompt;

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
      '-p', shq(promptForClaude),
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ];
    if (appendSystemPrompt.trim()) {
      claudeArgs.push('--append-system-prompt', shq(appendSystemPrompt));
    }
    if (existingSession) {
      // --resume continues an existing conversation. We used --session-id
      // before, but that flag *creates* a session with the given UUID and
      // fails with "Session ID is already in use" on every subsequent call.
      // --resume is the correct flag for multi-turn chat — Claude loads the
      // prior conversation state and appends this prompt to it.
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

        // Final result event — capture full text (handles cases where text_delta
        // events were missed, e.g. non-streaming fallback or auth failure).
        if (parsed.type === 'result') {
          if (parsed.is_error) {
            errored = true;
            // Capture the error message so callers see the real reason
            // instead of the generic "exited with code 0".
            if (typeof parsed.result === 'string' && parsed.result) {
              errorMessage = parsed.result;
            }
          } else if (typeof parsed.result === 'string' && !textCollected) {
            textCollected = parsed.result;
            try { callbacks.onToken?.(parsed.result) } catch { /* ignore */ }
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
        // Ignore the expected stdin warning
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

        // Session lock collision — drop the cached session id and recover by
        // retrying once with a fresh session. User loses turn context but
        // avoids a dead-end error.
        if (sessionInUse && !retryWithoutSession) {
          log.warn(`[ClaudeCodeService] Session "${ existingSession }" locked; retrying with a fresh session for conversationId=${ convId }`);
          this.sessions.delete(convId);
          this.runClaude(messages, callbacks, options, true).then(resolve, reject);
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

        // Guard against silent empty success — treat no output as a failure so
        // the error surfaces instead of triggering a silent provider fallback.
        if (!textCollected.trim()) {
          const stderrTail = stderrBuffer.trim().slice(-200);
          log.warn(`[ClaudeCodeService] runClaude exited with no text (code=${ code }) stderr=${ stderrTail }`);
          reject(new Error(`Claude Code returned no output (exit code ${ code }). ${ stderrTail || 'Check credentials and VM status.' }`));
          return;
        }

        log.log(`[ClaudeCodeService] runClaude ok: ${ textCollected.length } chars, session=${ capturedSessionId ?? '(none)' }`);
        resolve({ text: textCollected, sessionId: capturedSessionId });
      });
    });
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
