import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason } from './BaseLanguageModel';
import { ensureCodexAuthFile, codexAuthPath } from '../util/codexAuthFile';
import { redisClient } from '../database/RedisClient';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';

const log = Logging.background;

/**
 * CodexService — runs `codex exec` inside the Lima VM and streams the
 * --json JSONL output back into Sulla's agent loop.
 *
 * The codex sibling of ClaudeCodeService: codex already owns its own agent
 * loop, tool execution, and context management inside the CLI process, so
 * from Sulla's perspective it behaves as a "one-shot completion" peer. Tool
 * work happens internally (shell, file edits, and the `sulla` CLI which is
 * on PATH in the VM — no MCP wiring needed for native tool access).
 *
 * Auth: ~/.codex/auth.json, written by CodexOAuth on sign-in and on every
 * scheduled token refresh. The home dir is mounted writable in the VM, so
 * the CLI also self-refreshes tokens in place. With ChatGPT sign-in, usage
 * draws from the user's ChatGPT Plus/Pro plan — no API billing.
 *
 * Token strategy — hybrid (first-turn seed + `exec resume` thereafter):
 *   - First turn for a conversation: serialize the full curated
 *     state.messages[] as a transcript so codex catches up to wherever
 *     Sulla is.
 *   - Subsequent turns: `codex exec resume <threadId>` with ONLY the latest
 *     user message; codex's own session state keeps prior context warm.
 *   - Resume failures (expired/missing thread): drop the cached id and
 *     retry once with a fresh session (full history).
 */
export class CodexService extends BaseLanguageModel {
  // conversationId → codex thread_id — in-memory cache backed by Redis.
  private sessions = new Map<string, string>();

  /**
   * Tracks the hash of the stable <sulla_context> payload last sent per
   * conversation so we only re-send it when it actually changes — same
   * dedup as ClaudeCodeService (each send becomes permanent history).
   */
  private lastStableContextHash = new Map<string, string>();

  private readonly SESSION_KEY_PREFIX = 'codex_session:';
  private readonly SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

  private async getSession(convId: string): Promise<string | undefined> {
    const cached = this.sessions.get(convId);
    if (cached) return cached;
    try {
      const stored = await redisClient.get(`${ this.SESSION_KEY_PREFIX }${ convId }`);
      if (stored) {
        this.sessions.set(convId, stored);
        return stored;
      }
    } catch { /* Redis unavailable — start fresh session */ }
    return undefined;
  }

  private async setSession(convId: string, sessionId: string): Promise<void> {
    this.sessions.set(convId, sessionId);
    try {
      await redisClient.set(`${ this.SESSION_KEY_PREFIX }${ convId }`, sessionId, this.SESSION_TTL_SECONDS);
    } catch { /* Redis unavailable — session persists in memory only this run */ }
  }

  private async deleteSession(convId: string): Promise<void> {
    this.sessions.delete(convId);
    try {
      await redisClient.del(`${ this.SESSION_KEY_PREFIX }${ convId }`);
    } catch { /* Redis unavailable — non-fatal */ }
  }

  override getContextWindow(): number {
    return 272_000;
  }

  override getModel(): string {
    return this.model || 'codex';
  }

  override getProviderName(): string {
    return 'OpenAI Codex';
  }

  protected async healthCheck(): Promise<boolean> {
    // Credentials presence is deferred until spawn time (see runCodex).
    return true;
  }

  constructor() {
    super({ id: 'codex', model: 'codex', baseUrl: 'local-vm' });
  }

  /** Non-streaming chat — buffers the whole response and returns it. */
  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    const { text } = await this.runCodex(messages, {}, options);
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

  /** Streaming path — forwards agent message chunks to onToken. */
  override async chatStream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options: {
      signal?:         AbortSignal;
      conversationId?: string;
      state?:          BaseThreadState | any;
    } = {},
  ): Promise<NormalizedResponse | null> {
    const startTime = performance.now();

    try {
      const { text } = await this.runCodex(messages, callbacks, options);

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
      console.warn('[CodexService] chatStream failed:', err);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────

  /**
   * Save a base64 image block to ~/sulla/workspaces/attachments/ so the
   * Lima VM agent can read it from disk. Returns the saved path.
   */
  private saveImageAttachment(b: any): string | null {
    try {
      const data: string | undefined = b?.source?.data;
      const mediaType: string = b?.source?.media_type || 'image/png';
      if (!data) return null;

      const ext = mediaType.split('/')[1]?.split('+')[0] || 'png';
      const dir = path.join(paths.sullaHome, 'workspaces', 'attachments');
      fs.mkdirSync(dir, { recursive: true });

      const filename = `attachment-${ Date.now() }.${ ext }`;
      const filepath = path.join(dir, filename);
      fs.writeFileSync(filepath, Buffer.from(data, 'base64'));

      log.info(`[CodexService] Image saved: ${ filepath }`);
      return filepath;
    } catch (err) {
      log.error('[CodexService] Failed to save image attachment:', err);
      return null;
    }
  }

  /**
   * Extract the last user message. Walks backward to find the newest
   * user-role content, flattening string + content-block shapes. When a
   * resume session exists, this is all we send — codex already has
   * everything earlier in its session state.
   */
  private extractLatestUserMessage(messages: ChatMessage[]): string {
    const blockToText = (b: any): string => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'image' && b?.source?.type === 'base64') {
        const savedPath = this.saveImageAttachment(b);
        return savedPath ? `[Image attached — read it at: ${ savedPath }]` : '';
      }
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
   * only when seeding a fresh codex session. System-role messages are
   * INTENTIONALLY excluded — the system prompt reaches codex via
   * ~/.codex/AGENTS.md (see generateCodexMemoryFile), so including them
   * here would deliver it twice.
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
      default:          return role;
      }
    };

    const lines: string[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue; // delivered via ~/.codex/AGENTS.md
      const text = msgToText(m).trim();
      if (!text) continue;
      lines.push(`${ labelFor(m.role) }: ${ text }`);
    }
    return lines.join('\n\n');
  }

  /**
   * Build a <sulla_context> prefix for the outgoing user message — same
   * two-tier strategy as ClaudeCodeService: the stable tier (platform rules
   * + high-priority memories) is sent on the first turn and again only when
   * its content changes; per-turn recall/observation context always rides
   * along when present.
   */
  private async buildUserMessageContextPrefix(
    state: BaseThreadState | undefined,
    opts: { convId: string; isNewSession: boolean },
  ): Promise<string> {
    const stableParts: string[] = [];

    stableParts.push(`<platform_context>
You are operating inside Sulla Desktop — an autonomous agentic platform built by Jonathon Byrdziak. You are not a chatbot or a brain being asked questions. You are an agent with real tools and real execution capability.

Rules that apply on every turn:
- Execute tasks — don't describe what you would do, do it with tools
- Use the Sulla CLI (\`sulla <category>/<tool>\`) for all platform operations
- Scheduling → Sulla Workflows (\`sulla workflow/import_workflow\`), never cron
- Git/GitHub → \`sulla github/git_push\` / \`sulla github/git_pull\`, never SSH or raw curl
- Browser → \`sulla browser/tab\` with action \`upsert\` or \`remove\` only
- Recurring tasks become workflows, not one-off commands
- You are part of a live multi-agent network — Heartbeat, Workbench, and other agents are active
</platform_context>`);

    // High-priority observational memory
    try {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
      const { parseJson } = await import('../services/JsonParseService');
      const raw     = await SullaSettingsModel.get('observationalMemory', '[]');
      const entries = parseJson(raw);
      if (Array.isArray(entries)) {
        const high = (entries as any[]).filter(e =>
          ['critical', 'high'].includes((e?.priority ?? '').toLowerCase()),
        );
        if (high.length > 0) {
          const lines = high.map((e: any) => `- ${ e.content ?? '' }`).join('\n');
          stableParts.push(`<observational_memory>\n${ lines }\n</observational_memory>`);
        }
      }
    } catch { /* non-fatal */ }

    const parts: string[] = [];

    // Only send the stable tier when it's new to this session or has changed
    // since it was last sent.
    const stableText = stableParts.join('\n\n');
    const stableHash = crypto.createHash('sha1').update(stableText).digest('hex');
    if (opts.isNewSession || this.lastStableContextHash.get(opts.convId) !== stableHash) {
      parts.push(stableText);
    }
    this.lastStableContextHash.set(opts.convId, stableHash);

    // Recall context from subconscious middleware (may be null on first turn)
    const recallContext = (state?.metadata as any)?.recallContext;
    if (recallContext && typeof recallContext === 'string' && recallContext.trim()) {
      parts.push(`<recall_context>\n${ recallContext.trim() }\n</recall_context>`);
    }

    // Observation context from observation-recall agent (targeted DB observations)
    const observationContext = (state?.metadata as any)?.observationContext;
    if (observationContext && typeof observationContext === 'string' && observationContext.trim()) {
      parts.push(`<observation_context>\n${ observationContext.trim() }\n</observation_context>`);
    }

    if (parts.length === 0) return '';
    return `<sulla_context>\n${ parts.join('\n\n') }\n</sulla_context>`;
  }

  /**
   * Spawn codex exec in the VM, stream agent message chunks to the
   * callback, return the final text.
   *
   * @param retryWithoutSession — internal flag for the resume-failure retry
   *   path; do not pass from callers.
   */
  private async runCodex(
    messages: ChatMessage[],
    callbacks: Partial<StreamCallbacks>,
    options: { signal?: AbortSignal; conversationId?: string; state?: BaseThreadState },
    retryWithoutSession = false,
  ): Promise<{ text: string }> {
    // Auth lives in ~/.codex/auth.json (written by CodexOAuth, self-refreshed
    // by the CLI). Rebuild it from the stored OAuth tokens if missing.
    const hasAuth = await ensureCodexAuthFile();
    if (!hasAuth) {
      throw new Error('No Codex credentials configured. Sign in with ChatGPT via Integrations → OpenAI Codex.');
    }

    const convId = options.conversationId ?? '__default__';
    const existingSession = retryWithoutSession ? undefined : await this.getSession(convId);

    // Prompt strategy:
    //   - existingSession → send only the latest user message (codex has the
    //     rest via `exec resume`)
    //   - no session    → seed codex with the full curated transcript
    const basePrompt = existingSession
      ? this.extractLatestUserMessage(messages)
      : this.serializeFullTranscript(messages);

    if (!basePrompt.trim()) {
      const roles = messages.map(m => m.role).join(',');
      throw new Error(`Codex got no extractable prompt from ${ messages.length } messages (roles=${ roles })`);
    }

    const contextPrefix = await this.buildUserMessageContextPrefix(options.state, {
      convId,
      isNewSession: !existingSession,
    });
    const prompt = contextPrefix ? `${ contextPrefix }\n\n${ basePrompt }` : basePrompt;

    log.log(`[CodexService] runCodex: messages=${ messages.length } promptLen=${ prompt.length } conversationId=${ convId } session=${ existingSession ?? '(new)' } authFile=${ codexAuthPath() }`);

    // Lima only exists on macOS/Linux; paths.limactl is a throwing getter on
    // Windows. Surface a clear, user-readable error instead of an opaque crash.
    if (process.platform === 'win32') {
      throw new Error('Codex execution requires the Lima VM, which is not available on Windows yet. This feature currently supports macOS and Linux only.');
    }

    const limactlPath = paths.limactl;
    const limaHome = paths.lima;

    // POSIX single-quote escape. Single-quoted strings are literal in sh, so
    // no backtick/$VAR/! expansion can fire against untrusted text.
    const shq = (s: string) => `'${ s.replace(/'/g, "'\\''") }'`;

    // Refresh ~/.codex/AGENTS.md with the full system prompt before spawning.
    // AGENTS.md is the sole source of system context for codex.
    import('../prompts/generateCodexMemoryFile').then(({ generateCodexMemoryFile }) => {
      generateCodexMemoryFile().catch(() => {});
    }).catch(() => {});

    // The prompt is fed via stdin (`-` positional), NOT as an argv element —
    // a large transcript on the command line overflows limactl's SSH
    // multiplexing channel (same failure mode ClaudeCodeService hit).
    //
    // --dangerously-bypass-approvals-and-sandbox: codex runs inside the Lima
    // VM, which IS the sandbox — its own landlock layer is redundant here and
    // approval prompts have no TTY to land on.
    const codexArgs = ['codex', 'exec'];
    if (existingSession) {
      codexArgs.push('resume', shq(existingSession));
    }
    codexArgs.push(
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    );
    // Pass --model only when explicitly overridden. The 'codex' sentinel means
    // "auto" — omit the flag and let the CLI use its configured default.
    if (this.model && this.model !== 'codex') {
      codexArgs.push('--model', shq(this.model));
    }
    codexArgs.push('-'); // read the prompt from stdin

    // `exec` replaces the inner sh with codex so there's no shell layer
    // between the SSH session and the CLI — best chance of signal
    // propagation when we kill limactl on the host side.
    const innerCmd = `exec ${ codexArgs.join(' ') }`;
    const args = ['shell', '0', '--', 'sh', '-c', innerCmd];

    return await new Promise((resolve, reject) => {
      const proc = childProcess.spawn(limactlPath, args, {
        env: { ...process.env, LIMA_HOME: limaHome, TERM: 'dumb' },
      });

      // Feed the prompt through stdin instead of the command line. Guard
      // against EPIPE in case codex exits before we finish.
      proc.stdin.on('error', () => { /* EPIPE — codex already gone, non-fatal */ });
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch { /* stdin already closed */ }

      // Heartbeat ticker — keeps the renderer informed during the cold-start
      // gap between spawn and the first event. Cleared on first real stream
      // event or close/error/abort.
      let heartbeatTimer: NodeJS.Timeout | null = null;
      const directActivity = (msg: string) => {
        if (!msg) return;
        try { callbacks.onActivity?.(msg) } catch { /* ignore */ }
      };
      const stopHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      proc.once('spawn', () => {
        directActivity('Booting isolated environment…');
        heartbeatTimer = setInterval(() => {
          // Transient status only — tool activities and agent messages
          // provide the real feedback once the stream starts.
        }, 3000);
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let textCollected = '';
      let sawDelta = false;
      let capturedSessionId: string | undefined = existingSession;
      let errored = false;
      let errorMessage = '';

      const onAbort = () => {
        stopHeartbeat();
        // 1) Kill the host-side limactl process (closes the SSH session; with
        //    `exec` in the inner shell the remote codex usually gets SIGHUP).
        try { proc.kill('SIGTERM') } catch { /* already dead */ }

        // 2) Belt-and-suspenders: explicitly kill any lingering codex process
        //    inside the VM so an orphan doesn't keep burning plan quota.
        try {
          const killProc = childProcess.spawn(
            limactlPath,
            ['shell', '0', '--', 'pkill', '-TERM', '-f', 'codex exec'],
            {
              env:      { ...process.env, LIMA_HOME: limaHome, TERM: 'dumb' },
              stdio:    'ignore',
              detached: true,
            },
          );
          killProc.unref();
        } catch (err) {
          log.log(`[CodexService] Remote pkill failed: ${ (err as Error)?.message ?? err }`);
        }
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort);
      }

      const emitActivity = (msg: string) => {
        if (!msg) return;
        try { callbacks.onActivity?.(msg) } catch { /* ignore */ }
      };

      const pretty = (s: string) => s.length > 80 ? `${ s.slice(0, 77) }…` : s;

      /** Append a complete agent message, skipping it when deltas already
       *  streamed its content into textCollected. */
      const appendAgentMessage = (text: string) => {
        if (!text) return;
        if (sawDelta) {
          // Deltas already delivered this content; reset for the next message.
          sawDelta = false;
          return;
        }
        const sep = textCollected.trim() ? '\n\n' : '';
        textCollected += sep + text;
        try { callbacks.onToken?.(sep + text) } catch { /* ignore */ }
      };

      /** Activity line for a thread-event item (command_execution, etc.). */
      const activityForItem = (item: any) => {
        const kind = item?.item_type ?? item?.type;
        switch (kind) {
        case 'command_execution':
          if (typeof item.command === 'string') return `$ ${ pretty(item.command) }`;
          return 'Running a shell command';
        case 'file_change': {
          const first = Array.isArray(item.changes) ? item.changes[0] : null;
          if (first?.path) return `Editing ${ pretty(String(first.path)) }`;
          return 'Editing files';
        }
        case 'web_search':
          if (typeof item.query === 'string') return `Searching web: ${ pretty(item.query) }`;
          return 'Searching the web';
        case 'mcp_tool_call':
          if (typeof item.tool === 'string') return `Using ${ item.tool }`;
          return 'Calling a tool';
        case 'reasoning':
          return ''; // thinking — no activity line needed
        default:
          return '';
        }
      };

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }

        // ── Thread-event schema (codex exec --json) ──────────────
        if (typeof parsed.type === 'string') {
          if (parsed.type === 'thread.started' && parsed.thread_id) {
            stopHeartbeat();
            capturedSessionId = parsed.thread_id;
            emitActivity('Session started — calling model');
            return;
          }
          if (parsed.type === 'item.started' || parsed.type === 'item.completed') {
            stopHeartbeat();
            const item = parsed.item ?? {};
            const kind = item.item_type ?? item.type;
            if (kind === 'agent_message' && parsed.type === 'item.completed') {
              appendAgentMessage(typeof item.text === 'string' ? item.text : '');
              return;
            }
            if (parsed.type === 'item.started') {
              const activity = activityForItem(item);
              if (activity) emitActivity(activity);
            }
            if (kind === 'error' && parsed.type === 'item.completed') {
              errored = true;
              if (typeof item.message === 'string') errorMessage = item.message;
            }
            return;
          }
          if (parsed.type === 'turn.completed') {
            recordUsage(parsed.usage, this.getModel()).catch(() => { /* ignore */ });
            return;
          }
          if (parsed.type === 'turn.failed') {
            errored = true;
            const msg = parsed.error?.message;
            if (typeof msg === 'string' && msg) errorMessage = msg;
            return;
          }
          if (parsed.type === 'error') {
            errored = true;
            if (typeof parsed.message === 'string' && parsed.message) errorMessage = parsed.message;
            return;
          }
        }

        // ── Legacy event schema ({id, msg:{type,...}}) ───────────
        const msg = parsed?.msg;
        if (!msg || typeof msg.type !== 'string') return;

        switch (msg.type) {
        case 'session_configured':
          stopHeartbeat();
          if (msg.session_id) capturedSessionId = msg.session_id;
          emitActivity('Session started — calling model');
          break;
        case 'agent_message_delta':
          stopHeartbeat();
          if (typeof msg.delta === 'string') {
            sawDelta = true;
            textCollected += msg.delta;
            try { callbacks.onToken?.(msg.delta) } catch { /* ignore */ }
          }
          break;
        case 'agent_message':
          stopHeartbeat();
          appendAgentMessage(typeof msg.message === 'string' ? msg.message : '');
          break;
        case 'exec_command_begin': {
          stopHeartbeat();
          const cmd = Array.isArray(msg.command) ? msg.command.join(' ') : String(msg.command ?? '');
          emitActivity(cmd ? `$ ${ pretty(cmd) }` : 'Running a shell command');
          break;
        }
        case 'token_count':
          recordUsage(msg.info?.total_token_usage ?? msg.info, this.getModel()).catch(() => { /* ignore */ });
          break;
        case 'task_complete':
          if (typeof msg.last_agent_message === 'string' && !textCollected.trim()) {
            appendAgentMessage(msg.last_agent_message);
          }
          break;
        case 'error':
        case 'stream_error':
          errored = true;
          if (typeof msg.message === 'string' && msg.message) errorMessage = msg.message;
          break;
        default:
          break;
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
        if (trimmed) {
          console.log(`[CodexService][stderr] ${ trimmed.slice(0, 200) }`);
        }
      });

      proc.on('error', (err) => {
        stopHeartbeat();
        options.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      proc.on('close', (code) => {
        stopHeartbeat();
        options.signal?.removeEventListener('abort', onAbort);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);

        // Resume failure (expired/missing thread) — drop the cached id and
        // retry once with a fresh session so the user doesn't see a dead end.
        const resumeFailed = existingSession && !retryWithoutSession &&
          (errored || code !== 0) &&
          /thread|session|resume|rollout|not found/i.test(`${ errorMessage } ${ stderrBuffer }`);
        if (resumeFailed) {
          log.warn(`[CodexService] Resume of "${ existingSession }" failed; retrying with a fresh session for conversationId=${ convId }`);
          this.deleteSession(convId).catch(() => {});
          this.runCodex(messages, callbacks, options, true).then(
            r => resolve(r),
            reject,
          );
          return;
        }

        if (capturedSessionId) {
          this.setSession(convId, capturedSessionId).catch(() => {});
        }

        if (code === 127) {
          reject(new Error('codex CLI is not installed in the VM yet. Restart Sulla Desktop to re-provision, or run: npm install --prefix /mnt/data/npm-global -g @openai/codex'));
          return;
        }

        if (errored || (code !== 0 && !textCollected.trim())) {
          const msg = errorMessage || stderrBuffer.trim().slice(-200) || `codex exited with code ${ code }`;
          log.warn(`[CodexService] runCodex errored: ${ msg.slice(0, 200) }`);
          reject(new Error(`Codex: ${ msg }`));
          return;
        }

        if (!textCollected.trim()) {
          const stderrTail = stderrBuffer.trim().slice(-200);
          log.warn(`[CodexService] runCodex exited with no text (code=${ code }) stderr=${ stderrTail }`);
          reject(new Error(`Codex returned no output (exit code ${ code }). ${ stderrTail || 'Check credentials and VM status.' }`));
          return;
        }

        log.log(`[CodexService] runCodex ok: ${ textCollected.length } chars, session=${ capturedSessionId ?? '(none)' }`);
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
  input_tokens?:  number;
  output_tokens?: number;
  cached_input_tokens?: number;
  model?:         string;
}

const USAGE_SETTING_KEY = 'codexUsage';
const USAGE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const USAGE_MAX_ENTRIES = 500;

/**
 * Append a single usage sample from codex's turn.completed / token_count
 * events to SullaSettingsModel.codexUsage. Trims to a rolling 24h window
 * and caps the array length so the settings row can't grow unbounded.
 */
async function recordUsage(usage: any, model: string): Promise<void> {
  if (!usage || typeof usage !== 'object') return;

  try {
    const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
    const raw = await SullaSettingsModel.get(USAGE_SETTING_KEY, '[]');
    let records: UsageRecord[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) records = parsed;
    } catch { /* ignore unparseable prior value */ }

    const entry: UsageRecord = {
      ts:                  new Date().toISOString(),
      input_tokens:        typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
      output_tokens:       typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
      cached_input_tokens: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : undefined,
      model,
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

let codexInstance: CodexService | null = null;

export function getCodexService(): CodexService {
  if (!codexInstance) {
    codexInstance = new CodexService();
  }
  return codexInstance;
}

/** Create a fresh (non-singleton) CodexService with a specific model override. */
export function createCodexService(model: string): CodexService {
  const svc = new CodexService();
  svc.setModel(model);
  return svc;
}

export function resetCodexService(): void {
  codexInstance = null;
}
