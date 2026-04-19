import * as childProcess from 'child_process';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason } from './BaseLanguageModel';
import { resolveLimactlPath, resolveLimaHome } from '../tools/util/CommandRunner';

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
   * Extract the last user message as the prompt for Claude Code.
   * Earlier messages are part of the session history managed by Claude itself.
   */
  private extractPrompt(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user') {
        const c = m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
          return c.filter((b: any) => b?.type === 'text' || typeof b === 'string')
            .map((b: any) => (typeof b === 'string' ? b : b.text))
            .join('\n');
        }
      }
    }
    return '';
  }

  /**
   * Spawn claude -p in the VM, stream text_delta chunks to the callback,
   * return the final text + session id.
   */
  private async runClaude(
    messages: ChatMessage[],
    callbacks: Partial<StreamCallbacks>,
    options: { signal?: AbortSignal; conversationId?: string },
  ): Promise<{ text: string; sessionId?: string }> {
    const prompt = this.extractPrompt(messages);
    if (!prompt.trim()) {
      return { text: '' };
    }

    const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
    const oauthToken: string = (await SullaSettingsModel.get('claudeOAuthToken', '')) ?? '';
    const apiKey: string = (await SullaSettingsModel.get('claudeApiKey', '')) ?? '';

    if (!oauthToken && !apiKey) {
      throw new Error('No Claude credentials configured. Sign in via Language Model Settings → Claude Code.');
    }

    const convId = options.conversationId ?? '__default__';
    const existingSession = this.sessions.get(convId);

    const limactlPath = resolveLimactlPath({});
    const limaHome = resolveLimaHome({});

    const envAssignments: string[] = [];
    if (oauthToken) envAssignments.push(`CLAUDE_CODE_OAUTH_TOKEN=${ JSON.stringify(oauthToken) }`);
    if (apiKey) envAssignments.push(`ANTHROPIC_API_KEY=${ JSON.stringify(apiKey) }`);

    const claudeArgs = [
      'claude',
      '-p', JSON.stringify(prompt),
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ];
    if (existingSession) {
      claudeArgs.push('--session-id', JSON.stringify(existingSession));
    }

    const innerCmd = `${ envAssignments.join(' ') } ${ claudeArgs.join(' ') } < /dev/null`;
    const args = ['shell', '0', '--', 'sh', '-c', innerCmd];

    return await new Promise((resolve, reject) => {
      const proc = childProcess.spawn(limactlPath, args, {
        env: { ...process.env, LIMA_HOME: limaHome, TERM: 'dumb' },
      });

      let stdoutBuffer = '';
      let textCollected = '';
      let capturedSessionId: string | undefined = existingSession;
      let errored = false;

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
        const text = chunk.toString('utf-8').trim();
        // Ignore the expected stdin warning
        if (text && !text.includes('no stdin data received')) {
          console.log(`[ClaudeCodeService][stderr] ${ text.slice(0, 200) }`);
        }
      });

      proc.on('error', (err) => {
        options.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      proc.on('close', (code) => {
        options.signal?.removeEventListener('abort', onAbort);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);

        if (capturedSessionId) {
          this.sessions.set(convId, capturedSessionId);
        }

        if (errored) {
          reject(new Error(textCollected || `claude exited with code ${ code }`));
          return;
        }

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
