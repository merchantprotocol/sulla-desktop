import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason } from './BaseLanguageModel';
import { buildEditPatch, buildWritePatch, type FilePatchInfo } from '../util/linePatch';
import { resolveLimactlPath, resolveLimaHome } from '../tools/util/CommandRunner';
import { getMCPServerHost, type RegisteredSession } from '@pkg/main/MCPServerHost';
import { redisClient } from '../database/RedisClient';
import Logging from '@pkg/utils/logging';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';

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
  // conversationId → Claude session_id — in-memory cache backed by Redis.
  private sessions = new Map<string, string>();

  private readonly SESSION_KEY_PREFIX = 'claude_code_session:';
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
      state?:          BaseThreadState | any;
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
   * tool traces. System-role messages are INTENTIONALLY excluded — they
   * are the caller-built system prompt and go to --append-system-prompt
   * instead, so Claude doesn't receive them twice.
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
      if (m.role === 'system') continue; // handled via --append-system-prompt
      const text = msgToText(m).trim();
      if (!text) continue;
      lines.push(`${ labelFor(m.role) }: ${ text }`);
    }
    return lines.join('\n\n');
  }

  /**
   * Collect any system-role messages in the array and return their
   * concatenated text content. BaseNode.createNodeRunContext appends the
   * caller-built system prompt as the last message with role='system', so
   * this extracts exactly what the caller intended Claude to see.
   *
   * When the messages array has no system message (e.g. direct chatStream
   * callers like DesktopRelay bypass BaseNode), returns empty string and
   * the caller should fall back to buildFullSystemPrompt.
   */
  private extractSystemPromptFromMessages(messages: ChatMessage[]): string {
    const blockToText = (b: any): string => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      return '';
    };

    const msgToText = (m: ChatMessage): string => {
      const c: any = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(blockToText).filter(Boolean).join('\n');
      return '';
    };

    const parts: string[] = [];
    for (const m of messages) {
      if (m.role !== 'system') continue;
      const text = msgToText(m).trim();
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }

  /**
   * Build a <sulla_context> prefix to prepend to every outgoing user message.
   * Includes:
   *   - High-priority observational memory entries (critical + high)
   *   - Recall context produced by the subconscious middleware this turn
   *
   * Injecting here rather than relying solely on --append-system-prompt ensures
   * Claude treats this context as part of the user turn — which it weights more
   * heavily than appended system prompt content. It also fixes the resumed-
   * session gap: --resume sends only the latest user message, so recall context
   * merged into prior assistant messages was silently dropped.
   */
  private async buildUserMessageContextPrefix(state?: BaseThreadState): Promise<string> {
    const parts: string[] = [];

    // Platform identity — injected on every turn so Claude Code always knows
    // it's operating inside an agentic platform, not a standalone chat session.
    parts.push(`<platform_context>
You are operating inside Sulla Desktop — an autonomous agentic platform built by Jonathon Byrdziak. You are not a chatbot or a brain being asked questions. You are an agent with real tools and real execution capability.

Rules that apply on every turn:
- Execute tasks — don't describe what you would do, do it with tools
- Use the Sulla CLI (\`sulla <category>/<tool>\`) for all platform operations
- Scheduling → Sulla Workflows (\`sulla workflow/import_workflow\`), never CronCreate or cron
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
          parts.push(`<observational_memory>\n${ lines }\n</observational_memory>`);
        }
      }
    } catch { /* non-fatal */ }

    // Recall context from subconscious middleware (may be null on first turn)
    const recallContext = (state?.metadata as any)?.recallContext;
    if (recallContext && typeof recallContext === 'string' && recallContext.trim()) {
      parts.push(`<recall_context>\n${ recallContext.trim() }\n</recall_context>`);
    }

    if (parts.length === 0) return '';
    return `<sulla_context>\n${ parts.join('\n\n') }\n</sulla_context>`;
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
    options: { signal?: AbortSignal; conversationId?: string; state?: BaseThreadState },
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
    const existingSession = retryWithoutSession ? undefined : await this.getSession(convId);

    // Prompt strategy:
    //   - existingSession → send only the latest user message (Claude has the
    //     rest via --resume + prompt cache)
    //   - no session    → seed Claude with the full curated transcript
    const basePrompt = existingSession
      ? this.extractLatestUserMessage(messages)
      : this.serializeFullTranscript(messages);

    if (!basePrompt.trim()) {
      const roles = messages.map(m => m.role).join(',');
      throw new Error(`Claude Code got no extractable prompt from ${ messages.length } messages (roles=${ roles })`);
    }

    // Prepend Sulla context (high-priority observational memory + recall context)
    // to the outgoing user message. This travels with every turn regardless of
    // whether the session is resumed, so Claude can't deprioritize it.
    const contextPrefix = await this.buildUserMessageContextPrefix(options.state);
    const prompt = contextPrefix ? `${ contextPrefix }\n\n${ basePrompt }` : basePrompt;

    log.log(`[ClaudeCodeService] runClaude: messages=${ messages.length } promptLen=${ prompt.length } conversationId=${ convId } session=${ existingSession ?? '(new)' } hasOAuth=${ !!oauthToken } hasApiKey=${ !!apiKey }`);

    const limactlPath = resolveLimactlPath({});
    const limaHome = resolveLimaHome({});

    // POSIX single-quote escape. Single-quoted strings are literal in sh, so
    // no backtick/$VAR/! expansion can fire against untrusted text.
    const shq = (s: string) => `'${ s.replace(/'/g, "'\\''") }'`;

    const envAssignments: string[] = [];
    if (oauthToken) envAssignments.push(`CLAUDE_CODE_OAUTH_TOKEN=${ shq(oauthToken) }`);
    if (apiKey) envAssignments.push(`ANTHROPIC_API_KEY=${ shq(apiKey) }`);

    // Mint an MCP session bound to the calling graph state, if we have one
    // AND the in-process MCP server is listening. Claude can then call
    // native tools (execute_workflow etc.) back into this exact graph.
    // Lifetime: revoke + delete config when the spawn promise settles.
    let mcpSession: RegisteredSession | null = null;
    let mcpConfigPath: string | null = null;
    if (options.state) {
      try {
        const host = getMCPServerHost();
        if (host.running) {
          mcpSession = host.registerSession(options.state as BaseThreadState);
          mcpConfigPath = this.writeMcpConfig(mcpSession);
          log.log(`[ClaudeCodeService] MCP session minted — config=${ mcpConfigPath } url=${ mcpSession.url }`);
        }
      } catch (err) {
        log.log(`[ClaudeCodeService] MCP session setup failed, continuing without sulla-native tools: ${ (err as Error)?.message ?? err }`);
      }
    }

    // Refresh ~/.claude/CLAUDE.md with the full system prompt before spawning.
    // CLAUDE.md is the sole source of system context for Claude Code — no
    // --append-system-prompt is used.
    import('../prompts/generateClaudeCodeMemoryFile').then(({ generateClaudeCodeMemoryFile }) => {
      generateClaudeCodeMemoryFile().catch(() => {});
    }).catch(() => {});

    const claudeArgs = [
      'claude',
      '-p', shq(prompt),
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ];
    // Pass --model only when explicitly overridden (e.g. Sonnet for sub-agents).
    // Omitting the flag lets Claude Code use its own auto-selection (Opus for orchestration).
    if (this.model && this.model !== 'claude-code') {
      claudeArgs.push('--model', shq(this.model));
    }
    if (existingSession) {
      claudeArgs.push('--resume', shq(existingSession));
    }
    if (mcpConfigPath) {
      claudeArgs.push('--mcp-config', shq(mcpConfigPath));
    }

    // `exec` replaces the inner sh with claude so there's no shell layer
    // between the SSH session and the CLI — gives the best chance of signal
    // propagation when we kill limactl on the host side.
    const innerCmd = `${ envAssignments.join(' ') } exec ${ claudeArgs.join(' ') } < /dev/null`;
    const args = ['shell', '0', '--', 'sh', '-c', innerCmd];

    const cleanupMcp = () => {
      if (mcpSession) {
        try { mcpSession.revoke(); } catch { /* ignore */ }
        mcpSession = null;
      }
      if (mcpConfigPath) {
        try { fs.unlinkSync(mcpConfigPath); } catch { /* file may already be gone */ }
        mcpConfigPath = null;
      }
    };

    try {
      return await new Promise((resolve, reject) => {
        const proc = childProcess.spawn(limactlPath, args, {
          env: { ...process.env, LIMA_HOME: limaHome, TERM: 'dumb' },
        });

      // Heartbeat ticker — keeps the renderer (and routine canvas) informed
      // during the 60–120s cold-start gap between spawn and the first
      // Anthropic token. Without this the UI looks dead. Cleared on first
      // real stream event (token, tool_use, thinking) or close/error/abort.
      let heartbeatTimer: NodeJS.Timeout | null = null;
      const heartbeatStart = Date.now();
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
        let tick = 0;
        heartbeatTimer = setInterval(() => {
          tick += 1;
          const elapsed = Math.round((Date.now() - heartbeatStart) / 1000);
          const msg = tick === 1 ? 'Claude binary starting'
                    : tick === 2 ? 'Loading tools and context'
                    : tick === 3 ? 'Calling model — waiting for first response'
                    : `Still waiting on model (${ elapsed }s)`;
          directActivity(msg);
        }, 3000);
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let textCollected = '';
      let capturedSessionId: string | undefined = existingSession;
      let errored = false;
      let errorMessage = '';
      let sessionInUse = false;

      const onAbort = () => {
        stopHeartbeat();
        // 1) Kill the host-side limactl process. This closes the SSH-style
        //    session to the VM. With `exec` in the inner shell (see above),
        //    the remote claude usually receives SIGHUP and dies.
        try { proc.kill('SIGTERM') } catch { /* already dead */ }

        // 2) Belt-and-suspenders: explicitly kill any lingering claude
        //    process inside the VM. Without a TTY, SSH signal propagation
        //    isn't guaranteed — fire a follow-up pkill so an orphaned
        //    claude doesn't keep burning tokens after the user hits stop.
        //    Safe because the VM only ever runs claude via this service
        //    (user-level claude lives on the host, not in the VM).
        try {
          const killProc = childProcess.spawn(
            limactlPath,
            ['shell', '0', '--', 'pkill', '-TERM', '-f', 'claude -p'],
            {
              env:      { ...process.env, LIMA_HOME: limaHome, TERM: 'dumb' },
              stdio:    'ignore',
              detached: true,
            },
          );
          killProc.unref();
        } catch (err) {
          log.log(`[ClaudeCodeService] Remote pkill failed: ${ (err as Error)?.message ?? err }`);
        }
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort);
      }

      /**
       * Summarise a tool_use block into a short activity message like
       * "Running Bash: ls /etc" or "Reading /etc/hosts". Keep it tight so
       * the thinking bubble stays readable on mobile.
       */
      const activityForToolUse = (name: string, input: any): string => {
        const pretty = (s: string) => s.length > 80 ? `${ s.slice(0, 77) }…` : s;
        if (!input || typeof input !== 'object') return `Using ${ name }`;
        switch (name) {
        case 'Bash':
          if (typeof input.command === 'string') return `$ ${ pretty(input.command) }`;
          return 'Running a shell command';
        case 'Read':
          if (typeof input.file_path === 'string') return `Reading ${ pretty(input.file_path) }`;
          return 'Reading a file';
        case 'Edit':
        case 'Write':
          if (typeof input.file_path === 'string') return `${ name === 'Write' ? 'Writing' : 'Editing' } ${ pretty(input.file_path) }`;
          return `${ name === 'Write' ? 'Writing' : 'Editing' } a file`;
        case 'Glob':
          if (typeof input.pattern === 'string') return `Searching for ${ pretty(input.pattern) }`;
          return 'Searching files';
        case 'Grep':
          if (typeof input.pattern === 'string') return `Grepping ${ pretty(input.pattern) }`;
          return 'Grepping';
        case 'WebFetch':
        case 'WebSearch':
          if (typeof input.url === 'string') return `Fetching ${ pretty(input.url) }`;
          if (typeof input.query === 'string') return `Searching web: ${ pretty(input.query) }`;
          return `${ name } request`;
        case 'Task':
          if (typeof input.description === 'string') return `Task: ${ pretty(input.description) }`;
          return 'Spawning sub-task';
        default:
          return `Using ${ name }`;
        }
      };

      const emitActivity = (msg: string) => {
        if (!msg) return;
        try { callbacks.onActivity?.(msg) } catch { /* ignore */ }
      };

      // File patches we've already surfaced this turn. Keyed by
      // `${name}:${file_path}:${hash}` so the same edit fired via both
      // content_block_stop and the whole-message assistant event only
      // produces one PatchBlock in chat.
      const emittedPatches = new Set<string>();

      /**
       * Attempt to surface a FilePatchInfo for an Edit/Write tool_use.
       * Called at content_block_stop (best moment — full input, file not
       * yet mutated for Writes). Safe to call twice; dedup via hash.
       */
      const emitFilePatch = (name: string, input: any) => {
        if (!callbacks.onFilePatch) return;
        if (!input || typeof input !== 'object') return;
        const filePath = typeof input.file_path === 'string' ? input.file_path : '';
        if (!filePath) return;

        let info: FilePatchInfo | null = null;
        try {
          if (name === 'Edit') {
            const oldString = typeof input.old_string === 'string' ? input.old_string : '';
            const newString = typeof input.new_string === 'string' ? input.new_string : '';
            if (!oldString && !newString) return;
            info = buildEditPatch(filePath, oldString, newString);
          } else if (name === 'Write') {
            const newContent = typeof input.content === 'string' ? input.content : '';
            // Best-effort snapshot of pre-write content. Read synchronously
            // right now — Claude may or may not have hit disk yet; either
            // outcome is informational.
            let oldContent = '';
            try {
              oldContent = fs.readFileSync(filePath, 'utf-8');
            } catch {
              // File didn't exist → pure addition.
              oldContent = '';
            }
            if (oldContent === newContent) return;   // no visible change
            info = buildWritePatch(filePath, oldContent, newContent);
          } else {
            return;
          }
        } catch (err) {
          log.warn(`[ClaudeCodeService] emitFilePatch failed for ${ name } ${ filePath }: ${ (err as Error)?.message ?? err }`);
          return;
        }

        if (!info) return;
        if (info.hunks.length === 0 && info.stat.added === 0 && info.stat.removed === 0) return;

        const signature = info.hunks[0]?.lines.map(l => l.op[0] + l.text).join('|').slice(0, 200) ?? '';
        const dedupeKey = `${ name }:${ filePath }:${ info.stat.added }+${ info.stat.removed }:${ signature }`;
        if (emittedPatches.has(dedupeKey)) return;
        emittedPatches.add(dedupeKey);

        try { callbacks.onFilePatch(info) } catch { /* ignore */ }
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

        if (parsed.session_id) capturedSessionId = parsed.session_id;

        // System init — claude has booted, auth done, MCP tools loaded.
        // Update the heartbeat phase but keep ticking because the model
        // call itself can still add 20–60s.
        if (parsed.type === 'system' && parsed.subtype === 'init') {
          emitActivity('Tools connected — calling model');
          return;
        }

        // Stream-level events (wrapped in parsed.event) — text deltas,
        // tool_use block starts, thinking starts.
        const ev = parsed?.event;
        if (ev) {
          // Text chunks → stream to caller as content
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
            stopHeartbeat();
            textCollected += ev.delta.text;
            try { callbacks.onToken?.(ev.delta.text) } catch { /* ignore */ }
            return;
          }

          // Tool use block starting → emit a short activity message. Input
          // isn't filled in yet here for partial streaming, so the message
          // starts generic and content_block_stop below refines it.
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            stopHeartbeat();
            const name = ev.content_block.name ?? 'tool';
            emitActivity(`Using ${ name }…`);
            return;
          }

          // Tool use complete — input is fully populated now, emit the
          // refined "Running Bash: ls" style message.
          if (ev.type === 'content_block_stop' && ev.content_block?.type === 'tool_use') {
            stopHeartbeat();
            const name = ev.content_block.name ?? 'tool';
            emitActivity(activityForToolUse(name, ev.content_block.input));
            emitFilePatch(name, ev.content_block.input);
            return;
          }

          // Thinking block starting → indicate reasoning phase.
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
            stopHeartbeat();
            emitActivity('Thinking…');
            return;
          }
        }

        // Whole-message events (type='assistant') — pick up tool_use blocks
        // in case the streaming path didn't emit them (some CLI versions
        // batch the assistant message at content_block_stop time).
        if (parsed.type === 'assistant' && parsed.message?.content) {
          const blocks: any[] = Array.isArray(parsed.message.content) ? parsed.message.content : [];
          for (const b of blocks) {
            if (b?.type === 'tool_use' && b.name) {
              emitActivity(activityForToolUse(b.name, b.input));
              emitFilePatch(b.name, b.input);
            }
          }
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
        stopHeartbeat();
        options.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      proc.on('close', (code) => {
        stopHeartbeat();
        options.signal?.removeEventListener('abort', onAbort);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);

        // Session lock collision — drop the cached id and retry once with a
        // fresh session so the user doesn't see a dead-end error.
        if (sessionInUse && !retryWithoutSession) {
          log.warn(`[ClaudeCodeService] Session "${ existingSession }" locked; retrying without --resume for conversationId=${ convId }`);
          this.deleteSession(convId).catch(() => {});
          this.runClaude(messages, callbacks, options, true).then(
            r => resolve(r),
            reject,
          );
          return;
        }

        if (capturedSessionId) {
          this.setSession(convId, capturedSessionId).catch(() => {});
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
    } finally {
      cleanupMcp();
    }
  }

  /**
   * Write a short-lived MCP config JSON that tells Claude Code how to reach
   * the in-process MCP server. Placed under ~/.sulla/mcp-configs so it
   * appears at the same path inside the Lima VM (Lima mounts the user's
   * home directory). Perms 0600.
   *
   * The Authorization header carries the session id so tool handlers can
   * resolve back to the calling graph's BaseThreadState.
   */
  private writeMcpConfig(session: RegisteredSession): string {
    const dir = path.join(os.homedir(), '.sulla', 'mcp-configs');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${ session.id }.json`);
    const payload = {
      mcpServers: {
        'sulla-native': {
          type:    'http',
          url:     session.url,
          headers: { Authorization: session.header },
        },
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(payload), { mode: 0o600 });
    return filePath;
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

/** Create a fresh (non-singleton) ClaudeCodeService with a specific model override. */
export function createClaudeCodeService(model: string): ClaudeCodeService {
  const svc = new ClaudeCodeService();
  svc.setModel(model);
  return svc;
}

export function resetClaudeCodeService(): void {
  claudeCodeInstance = null;
}
