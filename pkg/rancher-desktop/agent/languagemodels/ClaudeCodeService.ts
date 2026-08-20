import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason } from './BaseLanguageModel';
import { buildEditPatch, buildWritePatch, type FilePatchInfo } from '../util/linePatch';
import { getMCPServerHost, type RegisteredSession } from '@pkg/main/MCPServerHost';
import { redisClient } from '../database/RedisClient';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';

const log = Logging.background;
// Dedicated perf-timing log (~/Library/Logs/rancher-desktop/perf.log). All
// latency instrumentation routes here via the Logging facility (NOT console.log,
// which never lands in a readable file) so timing is greppable in one place.
const perf = Logging.perf;

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

/**
 * Base `--disallowedTools` set applied to EVERY claude spawn (primary and
 * subconscious): the built-in AskUserQuestion (routed through the sulla-native
 * MCP tool instead) and Claude Code's built-in task/todo list, which competes
 * with Sulla Projects. See buildSpawnArgs for the full rationale.
 */
const BASE_DISALLOWED_TOOLS = 'AskUserQuestion TaskCreate TaskUpdate TaskList TaskGet TodoWrite TodoRead';

/**
 * Additional native tools disabled for SUBCONSCIOUS (observer) spawns only.
 *
 * Subconscious agents (observation/identity writers + recalls, summarizer,
 * digester) are OBSERVERS — their entire job is to read the conversation and
 * record memory through their Sulla DB tools. They must never take real action
 * on the host. Their Sulla-registry toolset is already locked down to DB tools
 * via `allowedToolNames`, but that gate does NOT govern Claude Code's OWN
 * built-in tools. Spawned with --dangerously-skip-permissions, the CLI would
 * otherwise hand an observer full Read/Write/Edit/Bash/Grep/WebFetch access —
 * so a subconscious pass could (and did) start editing files instead of just
 * observing. Denylisting the native actor tools here makes acting structurally
 * impossible, matching the observer invariant (observers get DB tools only,
 * never filesystem/shell/source-control/browser/code-editing tools).
 *
 * Names include current + legacy aliases (e.g. KillShell/KillBash) so a rename
 * on either side is harmless — an unknown disallowed name is simply ignored.
 */
const SUBCONSCIOUS_NATIVE_TOOL_DENYLIST = 'Read Write Edit MultiEdit NotebookEdit Bash BashOutput KillShell KillBash Glob Grep WebFetch WebSearch Task SlashCommand';

/** Idle timeout for a speculatively-booted process that is never claimed. */
const PREWARM_IDLE_REAP_MS = 60_000;

/** Idle timeout for a warm-pool process between turns before it's reaped. */
const WARM_IDLE_REAP_MS = 5 * 60_000;

/**
 * A `claude` process speculatively booted during the pre-turn (accumulator)
 * phase, waiting to be adopted by the next runClaude for its conversation.
 * See ClaudeCodeService.prewarm().
 */
interface PrewarmRecord {
  proc:          childProcess.ChildProcessWithoutNullStreams;
  mcpSession:    RegisteredSession | null;
  mcpConfigPath: string | null;
  model:         string;
  createdAt:     number;
  closed:        boolean;
  busy:          boolean;
  reapTimer:     ReturnType<typeof setTimeout> | null;
}

export class ClaudeCodeService extends BaseLanguageModel {
  // conversationId → Claude session_id — in-memory cache backed by Redis.
  private sessions = new Map<string, string>();

  // conversationId → a speculatively-booted process warming up during the
  // pre-turn phase, claimed by the next runClaude. See prewarm().
  private prewarmed = new Map<string, PrewarmRecord>();

  /**
   * Tracks the hash of the stable <sulla_context> payload (platform rules +
   * high-priority memories) last sent per conversation, so we only re-send it
   * when it actually changes. Without this, every turn stamps a fresh copy
   * into the permanent conversation history — N turns means N copies, each
   * re-billed on every subsequent request.
   */
  private lastStableContextHash = new Map<string, string>();

  private readonly SESSION_KEY_PREFIX = 'claude_code_session:';
  private readonly SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

  /**
   * Redis key holding the hash of the stable <sulla_context> tier last stamped
   * into ANY conversation on this install. The stable tier (platform rules +
   * top-priority memory) is install-global, and it is ALSO carried by the
   * byte-stable system prompt (soul/tooling + the observational_memory
   * section), which is sent on every session — fresh or resumed. So a
   * brand-new session already has this content via the system prompt; we use
   * this persisted hash to skip re-stamping the ~6k tier into the first
   * message of every fresh session (e.g. the heartbeat's per-cycle
   * conversations). It only needs to ride the message when its content
   * actually changes — see buildUserMessageContextPrefix.
   */
  private readonly STABLE_CTX_KEY = 'claude_code_stable_ctx_hash';

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

  /**
   * Resolve Claude credentials: integration vault first, SullaSettingsModel
   * fallback. Shared by runClaude and prewarm so both resolve identically.
   */
  private async resolveClaudeCreds(): Promise<{ oauthToken: string; apiKey: string }> {
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
    return { oauthToken, apiKey };
  }

  /** Whether speculative boot (prewarm) is enabled. Default OFF. */
  private async speculativeBootEnabled(): Promise<boolean> {
    try {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
      return (await SullaSettingsModel.get('claudeCodeSpeculativeBoot', 'false')) === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Whether the warm pool (keep the process alive across turns) is enabled.
   * Default OFF. Implies speculative boot — a warm process is just a
   * pre-warmed one that is re-parked instead of closed after each turn.
   */
  private async warmPoolEnabled(): Promise<boolean> {
    try {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
      return (await SullaSettingsModel.get('claudeCodeWarmPool', 'false')) === 'true';
    } catch {
      return false;
    }
  }

  /** Remove a specific pool record (if still current) and tear it down. */
  private disposePrewarmRecord(rec: PrewarmRecord, convId: string): void {
    if (this.prewarmed.get(convId) === rec) this.prewarmed.delete(convId);
    this.killPrewarmRecord(rec);
  }

  /**
   * Build the `limactl shell` argv that launches `claude -p` in the VM. Shared
   * by runClaude (fresh spawn) and prewarm (speculative boot) so both stay
   * identical. `streamJsonInput` adds --input-format stream-json so the process
   * can boot before the prompt is written to stdin.
   */
  private buildSpawnArgs(p: {
    oauthToken:      string;
    apiKey:          string;
    existingSession?: string;
    mcpConfigPath:   string | null;
    streamJsonInput: boolean;
    /**
     * Observer spawn: extend --disallowedTools with the native actor toolset
     * (Read/Write/Edit/Bash/…) so a subconscious pass can only observe and
     * write memory, never touch the host. See SUBCONSCIOUS_NATIVE_TOOL_DENYLIST.
     */
    subconscious?:   boolean;
  }): string[] {
    // POSIX single-quote escape. Single-quoted strings are literal in sh, so
    // no backtick/$VAR/! expansion can fire against untrusted text.
    const shq = (s: string) => `'${ s.replace(/'/g, "'\\''") }'`;

    const envAssignments: string[] = [];
    if (p.oauthToken) envAssignments.push(`CLAUDE_CODE_OAUTH_TOKEN=${ shq(p.oauthToken) }`);
    if (p.apiKey) envAssignments.push(`ANTHROPIC_API_KEY=${ shq(p.apiKey) }`);

    const claudeArgs = [
      'claude',
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      // Disable Claude's built-in AskUserQuestion — see runClaude for why it
      // routes through the sulla-native MCP tool instead.
      //
      // Also disable Claude Code's built-in task/todo list (TaskCreate /
      // TaskUpdate / TaskList / TaskGet, and legacy TodoWrite / TodoRead). It
      // is a parallel, ephemeral project-management surface that competes with
      // Sulla Projects. Agents track all work in Projects via `sulla project/*`
      // (Postgres) — there must be exactly one task system, not a second
      // in-memory to-do list. NOTE: TaskOutput / TaskStop are background-process
      // controls (not the to-do list) and stay enabled.
      //
      // Subconscious observers additionally lose the native actor tools
      // (Read/Write/Edit/Bash/…) — see SUBCONSCIOUS_NATIVE_TOOL_DENYLIST.
      '--disallowedTools', p.subconscious
        ? `${ BASE_DISALLOWED_TOOLS } ${ SUBCONSCIOUS_NATIVE_TOOL_DENYLIST }`
        : BASE_DISALLOWED_TOOLS,
    ];
    // stream-json input lets the process boot before the prompt exists (the
    // prompt is fed as a JSON user message on stdin by the caller).
    if (p.streamJsonInput) claudeArgs.push('--input-format', 'stream-json');
    if (this.model && this.model !== 'claude-code') claudeArgs.push('--model', shq(this.model));
    if (p.existingSession) claudeArgs.push('--resume', shq(p.existingSession));
    if (p.mcpConfigPath) claudeArgs.push('--mcp-config', shq(p.mcpConfigPath));

    const innerCmd = `${ envAssignments.join(' ') } exec ${ claudeArgs.join(' ') }`;
    return ['shell', '0', '--', 'sh', '-c', innerCmd];
  }

  /**
   * Speculatively boot a `claude` process for this conversation while the
   * caller does pre-turn work (recall / observations). The process reaches
   * system/init and idles on stdin; the next runClaude adopts it and just
   * writes the prompt — hiding the ~1.5-2s cold start. Fire-and-forget: every
   * failure mode falls back to a normal cold spawn. No-op unless the
   * claudeCodeSpeculativeBoot setting is on.
   */
  async prewarm(state: BaseThreadState): Promise<void> {
    try {
      if (process.platform === 'win32') return;         // no Lima on Windows
      if (!await this.speculativeBootEnabled()) return;

      const convId = typeof (state.metadata as any)?.threadId === 'string'
        ? (state.metadata as any).threadId
        : '__default__';

      const existing = this.prewarmed.get(convId);
      if (existing && !existing.closed) return;          // already warming
      if (existing) this.disposePrewarm(convId);         // stale/dead — replace

      const { oauthToken, apiKey } = await this.resolveClaudeCreds();
      if (!oauthToken && !apiKey) return;                // no creds → nothing to warm

      const existingSession = await this.getSession(convId);

      // Mint an MCP session bound to the live graph state — the SAME object the
      // turn will use (the pre-turn phase mutates it in place before any tool
      // fires), so no rebinding is needed for this single-turn adoption.
      let mcpSession: RegisteredSession | null = null;
      let mcpConfigPath: string | null = null;
      try {
        const host = getMCPServerHost();
        if (host.running) {
          mcpSession = host.registerSession(state);
          mcpConfigPath = this.writeMcpConfig(mcpSession);
        }
      } catch { /* continue without sulla-native tools */ }

      const subconscious = !!(state.metadata as any)?.isSubAgent;
      const args = this.buildSpawnArgs({ oauthToken, apiKey, existingSession, mcpConfigPath, streamJsonInput: true, subconscious });
      const proc = childProcess.spawn(paths.limactl, args, {
        env: { ...process.env, LIMA_HOME: paths.lima, TERM: 'dumb' },
      });

      const record: PrewarmRecord = {
        proc,
        mcpSession,
        mcpConfigPath,
        model:     this.model || 'claude-code',
        createdAt: Date.now(),
        closed:    false,
        busy:      false,
        reapTimer: null,
      };
      // Deliberately attach NO stdout 'data' listener: leaving stdout paused
      // lets Node buffer the early system/init line so the adopting runClaude
      // receives it intact when it switches the stream to flowing mode.
      proc.stdin.on('error', () => { /* EPIPE before adoption — non-fatal */ });
      proc.once('exit', () => { record.closed = true; });
      proc.once('error', () => { record.closed = true; });
      record.reapTimer = setTimeout(() => {
        if (this.prewarmed.get(convId) === record) this.disposePrewarm(convId);
      }, PREWARM_IDLE_REAP_MS);
      record.reapTimer.unref?.();

      this.prewarmed.set(convId, record);
      log.log(`[ClaudeCodeService] prewarm: speculative boot for convId=${ convId } session=${ existingSession ?? '(new)' }`);
    } catch (err) {
      log.log(`[ClaudeCodeService] prewarm skipped: ${ (err as Error)?.message ?? err }`);
    }
  }

  /** Claim a live pre-warmed process for this conversation, or null. */
  private claimPrewarm(convId: string, model: string): PrewarmRecord | null {
    const rec = this.prewarmed.get(convId);
    if (!rec) return null;
    this.prewarmed.delete(convId);
    if (rec.reapTimer) { clearTimeout(rec.reapTimer); rec.reapTimer = null; }
    if (rec.closed || rec.model !== model) {
      this.killPrewarmRecord(rec);                       // dead or model mismatch
      return null;
    }
    return rec;
  }

  /** Tear down and forget the pre-warmed process for a conversation. */
  private disposePrewarm(convId: string): void {
    const rec = this.prewarmed.get(convId);
    if (!rec) return;
    this.prewarmed.delete(convId);
    this.killPrewarmRecord(rec);
  }

  private killPrewarmRecord(rec: PrewarmRecord): void {
    if (rec.reapTimer) { clearTimeout(rec.reapTimer); rec.reapTimer = null; }
    try { rec.proc.kill('SIGTERM'); } catch { /* already dead */ }
    if (rec.mcpSession) { try { rec.mcpSession.revoke(); } catch { /* ignore */ } }
    if (rec.mcpConfigPath) { try { fs.unlinkSync(rec.mcpConfigPath); } catch { /* ignore */ } }
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
   * Save a base64 image block to ~/sulla/workspaces/attachments/ so the
   * Lima VM agent can read it via the Read tool. Returns the saved path.
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

      log.info(`[ClaudeCodeService] Image saved: ${ filepath }`);
      return filepath;
    } catch (err) {
      log.error('[ClaudeCodeService] Failed to save image attachment:', err);
      return null;
    }
  }

  /**
   * Extract the last user message. Walks backward to find the newest
   * user-role content, flattening string + content-block shapes. When a
   * --resume session exists, this is all we send — Claude already has
   * everything earlier in its session state.
   *
   * Image blocks are saved to disk and their paths injected into the text
   * so the Claude Code agent can read them with the Read tool.
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
   * Build a <sulla_context> prefix for the outgoing user message.
   *
   * Two tiers:
   *   - Stable context (platform rules + critical/high observational memory):
   *     sent on the first turn of a session and again ONLY when its content
   *     changes. Each send becomes permanent conversation history, so
   *     repeating it verbatim every turn multiplies token cost with zero
   *     information gain.
   *   - Recall context (subconscious middleware output for THIS turn): always
   *     included when present — it's the per-turn payload the recall agent
   *     produced specifically so the primary agent doesn't have to research.
   *
   * Injecting in the user turn rather than relying solely on
   * --append-system-prompt ensures Claude weights it properly, and fixes the
   * resumed-session gap: --resume sends only the latest user message, so
   * recall context merged into prior assistant messages was silently dropped.
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
- Environment/tooling priority:
  1. The Sulla CLI (\`sulla <category>/<tool>\`) is the first-choice surface for
     platform operations.
  2. Before inventing a custom script, integration, workflow format, browser
     workaround, GitHub flow, scheduler, or file-based substitute, check the
     Sulla CLI catalog first.
  3. Use \`sulla meta/browse_tools '{"query":"..."}'\` whenever you do not know
     the exact existing command.
  4. Sulla's bundled docs are the source of truth for this environment: tools,
     workflows, functions, sub-agents, host/VM behavior, and common operating
     procedures. Use the \`search\` tool and/or the injected \`{{sulla_docs}}\`
     path before guessing.
- Scheduling → Sulla Workflows (\`sulla workflow/import_workflow\`), never CronCreate or cron
- Git/GitHub → \`sulla github/git_push\` / \`sulla github/git_pull\`, never SSH or raw curl
- Browser → \`sulla browser/tab\` with action \`upsert\` or \`remove\` only
- Recurring tasks become workflows, not one-off commands
- Work state lives in the internal Projects system — read and update it with the \`sulla project/*\` tools (\`list_project_items\` / \`get_project_item\` / \`create_task\` / \`update_task\` / \`add_task_comment\`); never keep a separate ad-hoc task list
- You are part of a live multi-agent network — Heartbeat, Workbench, and other agents are active
</platform_context>`);

    stableParts.push(`<environment>
STOP before you build anything from scratch. Sulla Desktop already ships a large
catalog of real, working tools, and reinventing one — a custom script, a raw
curl call, an ad-hoc integration, a hand-rolled workflow — is the single most
common and most costly mistake you can make here.

Every time, in this order:
1. ASSUME THE TOOL ALREADY EXISTS. Find it with
   \`sulla meta/browse_tools '{"query":"<what you need>"}'\`, then run it as
   \`sulla <category>/<tool> '<json>'\`. Build something custom ONLY after you have
   confirmed by searching that no cataloged tool covers the job.
2. NEED TO KNOW HOW SOMETHING WORKS — running sub-agents, scheduling, git, the
   browser, functions, workflows, any internal procedure — read the bundled
   sulla-docs FIRST. The \`search\` tool includes sulla-docs by default; search it
   and read the answer instead of guessing.

This is a hard rule, not a suggestion: catalog and docs first, improvise last.
</environment>`);

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

    // Decide whether to stamp the stable tier into this message.
    //
    // The stable tier is redundant with the byte-stable system prompt (which
    // carries the same platform rules + top-priority memory and is sent on
    // EVERY session, fresh or resumed). So it only needs to ride the message
    // when its content has CHANGED since a conversation last saw it — repeating
    // it verbatim otherwise just multiplies token cost in the permanent history.
    //
    //   - Resumed session: compare against the per-conversation hash we recorded
    //     earlier this session. Unchanged → skip (existing dedup). Changed →
    //     re-send, because a resumed session never re-receives the system prompt.
    //   - Fresh session (new convId, empty per-conv hash): the system prompt has
    //     ALREADY delivered the current stable content, so seed this
    //     conversation's baseline from the install-global hash instead of
    //     force-sending. Only send if the global hash is missing/stale (first
    //     call, Redis down, or the content genuinely changed) — a safe fallback.
    const stableText = stableParts.join('\n\n');
    const stableHash = crypto.createHash('sha1').update(stableText).digest('hex');

    let lastHash = this.lastStableContextHash.get(opts.convId);
    if (lastHash === undefined && opts.isNewSession) {
      try {
        lastHash = (await redisClient.get(this.STABLE_CTX_KEY)) ?? undefined;
      } catch { /* Redis unavailable → lastHash stays undefined → we send (safe) */ }
    }
    if (lastHash !== stableHash) {
      parts.push(stableText);
    }
    this.lastStableContextHash.set(opts.convId, stableHash);
    // Keep the install-global "current stable hash" fresh so subsequent new
    // sessions can dedup against it.
    try {
      await redisClient.set(this.STABLE_CTX_KEY, stableHash, this.SESSION_TTL_SECONDS);
    } catch { /* Redis unavailable — non-fatal, we simply re-send next new session */ }

    // Observation context from observation-recall agent (targeted DB observations)
    const observationContext = (state?.metadata as any)?.observationContext;
    if (observationContext && typeof observationContext === 'string' && observationContext.trim()) {
      parts.push(`<observation_context>\n${ observationContext.trim() }\n</observation_context>`);
    }

    const userObservationContext = (state?.metadata as any)?.userObservationContext;
    if (userObservationContext && typeof userObservationContext === 'string' && userObservationContext.trim()) {
      parts.push(`<user_observations>\n${ userObservationContext.trim() }\n</user_observations>`);
    }

    const selfObservationContext = (state?.metadata as any)?.selfObservationContext;
    if (selfObservationContext && typeof selfObservationContext === 'string' && selfObservationContext.trim()) {
      parts.push(`<self_observations>\n${ selfObservationContext.trim() }\n</self_observations>`);
    }

    const businessObservationContext = (state?.metadata as any)?.businessObservationContext;
    if (businessObservationContext && typeof businessObservationContext === 'string' && businessObservationContext.trim()) {
      parts.push(`<business_observations>\n${ businessObservationContext.trim() }\n</business_observations>`);
    }

    const worldObservationContext = (state?.metadata as any)?.worldObservationContext;
    if (worldObservationContext && typeof worldObservationContext === 'string' && worldObservationContext.trim()) {
      parts.push(`<world_observations>\n${ worldObservationContext.trim() }\n</world_observations>`);
    }

    const environmentObservationContext = (state?.metadata as any)?.environmentObservationContext;
    if (environmentObservationContext && typeof environmentObservationContext === 'string' && environmentObservationContext.trim()) {
      parts.push(`<environment_observations>\n${ environmentObservationContext.trim() }\n</environment_observations>`);
    }

    const projectsObservationContext = (state?.metadata as any)?.projectsObservationContext;
    if (projectsObservationContext && typeof projectsObservationContext === 'string' && projectsObservationContext.trim()) {
      parts.push(`<projects_observations>\n${ projectsObservationContext.trim() }\n</projects_observations>`);
    }

    const skillsObservationContext = (state?.metadata as any)?.skillsObservationContext;
    if (skillsObservationContext && typeof skillsObservationContext === 'string' && skillsObservationContext.trim()) {
      parts.push(`<skills_observations>\n${ skillsObservationContext.trim() }\n</skills_observations>`);
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
    // Credentials: integration vault first, settings fallback (shared with prewarm()).
    const { oauthToken, apiKey } = await this.resolveClaudeCreds();

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

    // Prepend Sulla context to the outgoing user message. Recall context
    // travels every turn; the stable tier (platform rules + memories) is only
    // re-sent when new to the session or changed — see
    // buildUserMessageContextPrefix.
    const contextPrefix = await this.buildUserMessageContextPrefix(options.state, {
      convId,
      isNewSession: !existingSession,
    });
    const prompt = contextPrefix ? `${ contextPrefix }\n\n${ basePrompt }` : basePrompt;

    log.log(`[ClaudeCodeService] runClaude: messages=${ messages.length } promptLen=${ prompt.length } conversationId=${ convId } session=${ existingSession ?? '(new)' } hasOAuth=${ !!oauthToken } hasApiKey=${ !!apiKey }`);

    // Lima only exists on macOS/Linux; paths.limactl is a throwing getter on
    // Windows. Surface a clear, user-readable error instead of an opaque crash.
    if (process.platform === 'win32') {
      throw new Error('Claude Code execution requires the Lima VM, which is not available on Windows yet. This feature currently supports macOS and Linux only.');
    }

    const limactlPath = paths.limactl;
    const limaHome = paths.lima;

    // Speculative boot: adopt a process pre-warmed for this conversation during
    // the accumulator phase; otherwise spawn fresh below. Flag off → adopted is
    // always null and the legacy text path runs byte-for-byte as before.
    const warm = await this.warmPoolEnabled();
    const speculative = warm || await this.speculativeBootEnabled();
    const adopted = speculative ? this.claimPrewarm(convId, this.model || 'claude-code') : null;

    // Mint an MCP session bound to the calling graph state, if we have one AND
    // the in-process MCP server is listening. An adopted process already
    // carries its own (minted at prewarm against the same live state object).
    // Lifetime: revoke + delete config when the spawn promise settles.
    let mcpSession: RegisteredSession | null = null;
    let mcpConfigPath: string | null = null;
    if (adopted) {
      mcpSession = adopted.mcpSession;
      mcpConfigPath = adopted.mcpConfigPath;
      // Re-point the stable MCP token at THIS turn's live state — required when
      // the process is reused across turns; a no-op on first adoption.
      if (mcpSession && options.state) {
        try { getMCPServerHost().rebindSession(mcpSession.id, options.state as BaseThreadState); } catch { /* ignore */ }
      }
    } else if (options.state) {
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

    // The prompt is fed via stdin (see below), NOT as an argv element. A large
    // transcript embedded in the command line overflows limactl's SSH
    // multiplexing channel and the spawn dies with "mux_client_request_session:
    // write packet: Broken pipe", bricking any sufficiently long conversation.
    // Build the launch argv. `exec` replaces the inner sh with claude so there's
    // no shell layer between the SSH session and the CLI. When speculative,
    // buildSpawnArgs adds --input-format stream-json and the prompt is delivered
    // as a JSON line on stdin (see below) instead of raw text.
    // Observer runs (subconscious writers/recalls/summarizer/digester) lose the
    // native actor tools so they can only observe + write memory, never act on
    // the host. Keyed off the graph state's isSubAgent flag (set for every
    // subconscious build in buildSubconsciousState).
    const subconscious = !!(options.state?.metadata as any)?.isSubAgent;
    const args = this.buildSpawnArgs({ oauthToken, apiKey, existingSession, mcpConfigPath, streamJsonInput: speculative, subconscious });

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

    // Adopt the pre-warmed process if we claimed one; otherwise spawn fresh.
    let proc: childProcess.ChildProcessWithoutNullStreams;
    let adoptedSpawned = false;
    let poolEntry: PrewarmRecord | null = adopted;
    if (adopted) {
      proc = adopted.proc;
      adoptedSpawned = true;
      // Drop the prewarm holding listeners; this run attaches its own below.
      proc.removeAllListeners('exit');
      proc.removeAllListeners('error');
      proc.stdin.removeAllListeners('error');
    } else {
      proc = childProcess.spawn(limactlPath, args, {
        env: { ...process.env, LIMA_HOME: limaHome, TERM: 'dumb' },
      });
      // Warm mode with no prewarm available: still track this fresh process so
      // it can be parked for reuse after the turn.
      if (warm) {
        poolEntry = {
          proc,
          mcpSession,
          mcpConfigPath,
          model:     this.model || 'claude-code',
          createdAt: Date.now(),
          closed:    false,
          busy:      false,
          reapTimer: null,
        };
      }
    }
    if (poolEntry) poolEntry.busy = true;

    // Declared at method scope so the `finally` block below can read it: set
    // true when a warm turn parks its process, which tells finally to skip MCP
    // cleanup (the parked proc keeps its session for the next turn).
    let parked = false;

    try {
      return await new Promise((resolve, reject) => {

        // Feed the prompt through stdin instead of the command line. limactl's
        // SSH mux caps how large a session-request (command line) can be; a long
        // transcript blows past it. stdin is a plain data channel with no such
        // limit. Guard against EPIPE in case claude exits before we finish.
        const onStdinError = () => { /* EPIPE — claude already gone, non-fatal */ };
        proc.stdin.on('error', onStdinError);
        try {
          if (speculative) {
            // stream-json input: deliver the prompt as one user message.
            proc.stdin.write(`${ JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) }\n`);
          } else {
            proc.stdin.write(prompt);
          }
          // Warm mode keeps stdin open so the process survives for the next turn;
          // otherwise close it so claude exits when this turn completes.
          if (!warm) proc.stdin.end();
        } catch { /* stdin already closed */ }

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

      const onSpawned = () => {
        directActivity(adoptedSpawned ? 'Isolated environment ready…' : 'Booting isolated environment…');
        let tick = 0;
        heartbeatTimer = setInterval(() => {
          tick += 1;
          const elapsed = Math.round((Date.now() - heartbeatStart) / 1000);
          // Don't emit transient status messages as separate thinking bubbles
          // Tool activities and model thinking will provide feedback
        }, 3000);

        lastStreamActivityAt = Date.now();
        stallTimer = setInterval(() => {
          const silentMs = Date.now() - lastStreamActivityAt;
          if (silentMs < STALL_TIMEOUT_MS) return;
          stalled = true;
          stopStallWatchdog();
          log.warn(`[ClaudeCodeService] Stall watchdog: no stream activity for ${ Math.round(silentMs / 1000) }s — killing claude (convId=${ convId })`);
          killSpawn();
        }, STALL_CHECK_MS);
      };

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let textCollected = '';
      let capturedSessionId: string | undefined = existingSession;
      let errored = false;
      let errorMessage = '';
      let sessionInUse = false;
      let settled = false;   // guards resolve/reject across the result-vs-close paths

      // ── Perf: per-tool execution timing inside the claude CLI ──────────
      // The tool-use loop (Grep/Glob/Read/Bash/etc.) runs INSIDE the spawned
      // CLI, so the only way to measure how long each tool actually takes is
      // to time the gap between a tool_use block's input completing and its
      // matching tool_result arriving. Keyed by the tool_use id so parallel
      // tool calls are timed independently.
      const toolStarts = new Map<string, { name: string; startedAt: number }>();
      const toolTotals = new Map<string, { count: number; ms: number }>();
      let firstTokenAt = 0;
      const runStartedAt = Date.now();
      const noteToolStart = (id?: string, name?: string) => {
        if (!id || toolStarts.has(id)) return;
        toolStarts.set(id, { name: name ?? 'tool', startedAt: Date.now() });
      };
      const noteToolResult = (id?: string, resultChars = 0) => {
        if (!id) return;
        const started = toolStarts.get(id);
        if (!started) return;
        toolStarts.delete(id);
        const ms = Date.now() - started.startedAt;
        const agg = toolTotals.get(started.name) ?? { count: 0, ms: 0 };
        agg.count += 1;
        agg.ms += ms;
        toolTotals.set(started.name, agg);
        perf.log(`[ToolTiming] tool=${ started.name } ms=${ ms } resultChars=${ resultChars } convId=${ convId }`);
      };

      // Kill any lingering claude process inside the VM. Without a TTY, SSH
      // signal propagation isn't guaranteed — fire a follow-up pkill so an
      // orphaned claude doesn't keep burning tokens after the user hits stop.
      // Safe because the VM only ever runs claude via this service
      // (user-level claude lives on the host, not in the VM).
      const killRemoteClaude = (sig: 'TERM' | 'KILL') => {
        try {
          const killProc = childProcess.spawn(
            limactlPath,
            ['shell', '0', '--', 'pkill', `-${ sig }`, '-f', 'claude -p'],
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

      // Kill the spawn on both sides of the SSH boundary:
      //   1) SIGTERM the host-side limactl process — closes the SSH-style
      //      session; with `exec` in the inner shell (see above) the remote
      //      claude usually receives SIGHUP and dies.
      //   2) pkill inside the VM (see killRemoteClaude).
      //   3) Escalate to SIGKILL after a grace period — a limactl wedged in
      //      the SSH mux can ignore SIGTERM entirely, which is exactly the
      //      state that strands a hung run.
      const killSpawn = () => {
        try { proc.kill('SIGTERM') } catch { /* already dead */ }
        killRemoteClaude('TERM');
        const escalate = setTimeout(() => {
          if (proc.exitCode === null) {
            try { proc.kill('SIGKILL') } catch { /* already dead */ }
            killRemoteClaude('KILL');
          }
        }, 5_000);
        escalate.unref?.();
      };

      // ── Stall watchdog ──────────────────────────────────────────────
      // A claude process whose upstream connection dies mid-run can sit
      // silent forever (observed: 7.7h), and wedged spawns block later ones
      // from even delivering their prompt — the whole backend goes dark.
      // Watchdog scope is THIS CLI child process only, never agent-level
      // execution: recall agents and long runs are unbounded by design.
      // Liveness = any stdout/stderr byte, so extended thinking and long
      // in-CLI tool runs (10 min Bash default) reset the clock; only a
      // completely dead stream trips the kill.
      const STALL_TIMEOUT_MS = 15 * 60 * 1_000;
      const STALL_CHECK_MS = 30 * 1_000;
      let lastStreamActivityAt = Date.now();
      let stalled = false;
      let stallTimer: NodeJS.Timeout | null = null;
      const stopStallWatchdog = () => {
        if (stallTimer) {
          clearInterval(stallTimer);
          stallTimer = null;
        }
      };

      const onAbort = () => {
        stopHeartbeat();
        stopStallWatchdog();
        killSpawn();
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort);
      }

      // Start the heartbeat + stall watchdog. A fresh spawn fires 'spawn'; an
      // adopted (pre-warmed) process already spawned during prewarm, so start
      // immediately — every timer/handler onSpawned references is now declared.
      if (adoptedSpawned) onSpawned();
      else proc.once('spawn', onSpawned);

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
        case 'AskUserQuestion':
        case 'mcp__sulla-native__ask_user_question':
          // The MCP twin emits its own interactive card via the WS bus; this
          // is just the heartbeat line shown while the user is deciding.
          return 'Asking you a question…';
        default:
          return `Using ${ name }`;
        }
      };

      // Claude's native AskUserQuestion is disallowed on the CLI so it routes
      // to the sulla-native MCP tool instead. If a native call ever slips
      // through (CLI version change, flag ignored), log it loudly — the
      // question would otherwise vanish into a headless no-op.
      const noteIfNativeAsk = (name: string) => {
        if (name === 'AskUserQuestion') {
          log.warn('[ClaudeCodeService] native AskUserQuestion tool_use detected despite --disallowedTools — it will NOT round-trip. Claude should be using mcp__sulla-native__ask_user_question.');
        }
      };

      const emitActivity = (msg: string) => {
        if (!msg) return;
        try { callbacks.onActivity?.(msg) } catch { /* ignore */ }
      };

      // Extended-thinking passthrough. thinking_delta events used to be
      // silently dropped, so the longest "nothing is happening" stretches of
      // a turn (pure reasoning, no tools) showed zero signal in the thinking
      // bubble or on the mobile relay. Accumulate deltas and emit throttled
      // 💭 snippets at sentence/newline boundaries — at most one per
      // THINKING_EMIT_MS, each capped so the phone's one-line status stays
      // readable.
      const THINKING_EMIT_MS = 1200;
      const THINKING_MAX_SNIPPET = 220;
      let thinkingBuf = '';
      let lastThinkingEmitAt = 0;
      const flushThinking = (force = false) => {
        const nowMs = Date.now();
        if (!force && nowMs - lastThinkingEmitAt < THINKING_EMIT_MS) return;
        let cut = thinkingBuf.length;
        if (!force) {
          // Emit up to the last sentence/newline boundary; hold the tail for
          // the next tick so snippets read as complete thoughts.
          const boundary = thinkingBuf.search(/[.!?\n][^.!?\n]*$/);
          if (boundary < 0) return;
          cut = boundary + 1;
        }
        const snippet = thinkingBuf.slice(0, cut).replace(/\s+/g, ' ').trim();
        thinkingBuf = thinkingBuf.slice(cut);
        if (!snippet) return;
        lastThinkingEmitAt = nowMs;
        emitActivity(`💭 ${ snippet.length > THINKING_MAX_SNIPPET ? `${ snippet.slice(0, THINKING_MAX_SNIPPET - 1) }…` : snippet }`);
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
            if (!firstTokenAt) firstTokenAt = Date.now();
            textCollected += ev.delta.text;
            try { callbacks.onToken?.(ev.delta.text) } catch { /* ignore */ }
            return;
          }

          // Thinking deltas → live reasoning trace (throttled, see flushThinking)
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
            stopHeartbeat();
            thinkingBuf += ev.delta.thinking;
            flushThinking();
            return;
          }

          // Tool use block starting → emit a short activity message. Input
          // isn't filled in yet here for partial streaming, so the message
          // starts generic and content_block_stop below refines it.
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            stopHeartbeat();
            const name = ev.content_block.name ?? 'tool';
            noteIfNativeAsk(name);
            emitActivity(activityForToolUse(name, ev.content_block.input));
            return;
          }

          // Tool use complete — input is fully populated now, emit the
          // refined "Running Bash: ls" style message.
          if (ev.type === 'content_block_stop' && ev.content_block?.type === 'tool_use') {
            stopHeartbeat();
            const name = ev.content_block.name ?? 'tool';
            // Input is fully streamed → the CLI is about to RUN the tool. Start
            // the clock here so input-generation time isn't counted as tool time.
            noteToolStart(ev.content_block.id, name);
            emitActivity(activityForToolUse(name, ev.content_block.input));
            emitFilePatch(name, ev.content_block.input);
            return;
          }

          // Thinking block starting → stop the heartbeat
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
            stopHeartbeat();
            return;
          }

          // Thinking block finished → flush whatever reasoning remains so the
          // last thought isn't stranded below the boundary/throttle gates.
          if (ev.type === 'content_block_stop' && ev.content_block?.type === 'thinking') {
            flushThinking(true);
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
              noteIfNativeAsk(b.name);
              // Fallback start for CLI versions that batch the whole assistant
              // message instead of emitting streamed content_block_stop events.
              // Idempotent — won't override an earlier stream-path start.
              noteToolStart(b.id, b.name);
              emitActivity(activityForToolUse(b.name, b.input));
              emitFilePatch(b.name, b.input);
            }
          }
        }

        // Tool results arrive as a `user`-type message carrying tool_result
        // blocks (each references its tool_use_id). This is the moment the
        // tool finished running inside the CLI — stop its clock.
        if (parsed.type === 'user' && parsed.message?.content) {
          const blocks: any[] = Array.isArray(parsed.message.content) ? parsed.message.content : [];
          for (const b of blocks) {
            if (b?.type === 'tool_result') {
              let chars = 0;
              if (typeof b.content === 'string') {
                chars = b.content.length;
              } else if (Array.isArray(b.content)) {
                chars = b.content.reduce((n: number, c: any) => n + (typeof c?.text === 'string' ? c.text.length : 0), 0);
              }
              noteToolResult(b.tool_use_id, chars);
            }
          }
        }

        // Final result event — capture full text and record usage/cost.
        if (parsed.type === 'result') {
          // Perf summary: split the run into tool-execution time vs the rest
          // (model generation + CLI overhead). Directly answers "is it the
          // search/tool layer or the model that's slow?"
          const totalMs = Date.now() - runStartedAt;
          let toolMs = 0;
          let toolCount = 0;
          const breakdown: string[] = [];
          toolTotals.forEach((agg, name) => {
            toolMs += agg.ms;
            toolCount += agg.count;
            breakdown.push(`${ name }x${ agg.count }=${ agg.ms }ms`);
          });
          const ttft = firstTokenAt ? firstTokenAt - runStartedAt : -1;
          perf.log(`[RunTiming] convId=${ convId } totalMs=${ totalMs } toolMs=${ toolMs } toolCount=${ toolCount } model+overheadMs=${ totalMs - toolMs } ttftMs=${ ttft } tools=[${ breakdown.join(', ') }]`);

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
          // Warm mode: the turn completes at `result`. Settle now and keep the
          // process alive for the next turn. finishWarmTurn is defined below and
          // only invoked here (at runtime, after all handlers exist).
          if (warm) finishWarmTurn();
        }
      };

      const onStdoutData = (chunk: Buffer) => {
        lastStreamActivityAt = Date.now();
        stdoutBuffer += chunk.toString('utf-8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      };
      proc.stdout.on('data', onStdoutData);

      const onStderrData = (chunk: Buffer) => {
        lastStreamActivityAt = Date.now();
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
      };
      proc.stderr.on('data', onStderrData);

      const onProcError = (err: Error) => {
        stopHeartbeat();
        stopStallWatchdog();
        options.signal?.removeEventListener('abort', onAbort);
        if (poolEntry) this.disposePrewarmRecord(poolEntry, convId);
        if (!settled) { settled = true; reject(err); }
      };
      proc.on('error', onProcError);

      // Warm mode: settle the turn on the `result` message and RETURN the
      // process to the pool without closing it. Detaches this turn's stream
      // listeners so the next turn's don't double-process; errors / no-output
      // evict the process (a broken session must not be reused).
      const finishWarmTurn = () => {
        if (settled) return;
        settled = true;
        stopHeartbeat();
        stopStallWatchdog();
        options.signal?.removeEventListener('abort', onAbort);
        proc.stdout.removeListener('data', onStdoutData);
        proc.stderr.removeListener('data', onStderrData);
        proc.removeListener('error', onProcError);
        proc.removeListener('close', onProcClose);
        proc.stdout.pause();
        proc.stderr.pause();
        if (capturedSessionId) this.setSession(convId, capturedSessionId).catch(() => {});

        if (errored || !textCollected.trim()) {
          if (poolEntry) this.disposePrewarmRecord(poolEntry, convId);
          const msg = errorMessage || textCollected || 'claude produced no output';
          log.warn(`[ClaudeCodeService] warm turn failed, evicting proc: ${ msg.slice(0, 200) }`);
          reject(new Error(`Claude Code: ${ msg }`));
          return;
        }

        // Park the process for the next turn. Keep a lightweight exit/error
        // marker so a proc that dies while idle is flagged closed (claimPrewarm
        // then declines to hand it back). Both are cleared on the next adopt.
        if (poolEntry) {
          const entry = poolEntry;
          entry.busy = false;
          proc.once('exit', () => { entry.closed = true; });
          proc.once('error', () => { entry.closed = true; });
          if (entry.reapTimer) clearTimeout(entry.reapTimer);
          entry.reapTimer = setTimeout(() => {
            if (this.prewarmed.get(convId) === entry) this.disposePrewarm(convId);
          }, WARM_IDLE_REAP_MS);
          entry.reapTimer.unref?.();
          this.prewarmed.set(convId, entry);
          parked = true;
        }
        log.log(`[ClaudeCodeService] warm turn ok: ${ textCollected.length } chars, session=${ capturedSessionId ?? '(none)' } (proc parked)`);
        resolve({ text: textCollected });
      };

      const onProcClose = (code: number | null) => {
        stopHeartbeat();
        stopStallWatchdog();
        options.signal?.removeEventListener('abort', onAbort);
        if (poolEntry) this.disposePrewarmRecord(poolEntry, convId);   // proc gone → drop from pool
        if (settled) return;                                           // already resolved (e.g. warm result)
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        if (settled) return;                                           // a buffered `result` may have settled it
        settled = true;

        // Stall-watchdog kill — surface a clear, retryable error instead of
        // falling through to the generic no-output message.
        if (stalled) {
          const silentMin = Math.round(STALL_TIMEOUT_MS / 60_000);
          reject(new Error(`Claude Code stalled — no stream activity for ${ silentMin } minutes, so the run was terminated. Please try again.`));
          return;
        }

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
      };
      proc.on('close', onProcClose);
    });
    } finally {
      // A parked warm process keeps its MCP session for the next turn; only
      // clean up when we are not reusing it.
      if (!parked) cleanupMcp();
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
    const dir = path.join(paths.sullaConfig, 'mcp-configs');
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
