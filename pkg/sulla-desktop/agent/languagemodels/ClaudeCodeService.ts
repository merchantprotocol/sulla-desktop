// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason, usageTokenTotal } from './BaseLanguageModel';
import {
  getProviderExecutionTransport,
  requireBrokeredContainerAuth,
  requireContainerToolConfig,
  type ProviderFileRef,
  type ProviderTransportContext,
} from './ProviderExecutionTransport';
import {
  BackgroundCompletionDelivery,
  ClaudeBackgroundTaskTracker,
  formatBackgroundNotices,
  wakeTargetFromState,
} from './claudeBackgroundTasks';
import { buildClaudeLaunchCommand, newRemotePidFile } from './claudeLaunchCommand';
import { disallowedToolsFor } from './claudeToolPolicy';
import { CliFaultError, isPermanentCliFailure, recoveryMessages, runWithCliFaultRecovery, terminateCliChild } from './cliFaultRecovery';
import { systemPromptFromMessages } from './cliSystemPromptFile';
import { stageImagePaths, type ImageStager } from './providerImageStaging';
import { providerSessionStore } from './providerSessionStore';
import { bindLeaseToProcess, createGuestClaudeAuth, releaseLease } from './guestClaudeBridge';
import { redisClient } from '../database/RedisClient';
import type { ProviderCliBridgeLease } from '../../vault-broker';
import { prepareWorkerTurnPrompt } from '../tools/agents/workerMessaging';
import { normalizeClaudeLimitSnapshot, recordCliLimitSnapshot, recordCliUsage } from '../usage/providerUsage';
import { buildEditPatch, buildWritePatch, type FilePatchInfo } from '../util/linePatch';
import { RecallDedupe } from '../utils/recallDedupe';
import { markSteerPending, onSteer } from '../utils/steerChannel';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import { getMCPServerHost, type RegisteredSession } from '@pkg/main/MCPServerHost';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

const log = Logging.background;
// Dedicated perf-timing log (~/Library/Logs/sulla-desktop/perf.log). All
// latency instrumentation routes here via the Logging facility (NOT console.log,
// which never lands in a readable file) so timing is greppable in one place.
const perf = Logging.perf;

/**
 * ClaudeCodeService — runs `claude -p` inside the Sulla VM and streams the
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
 * Process lifetime — one `claude -p` per turn:
 *   - The process is spawned when a turn starts and exits when it ends
 *     (stdin is closed at the turn's `result`). Nothing is booted ahead of a
 *     turn and no idle process is kept between turns: each idle process
 *     held ~150 MB of VM memory. Continuity comes from --resume, not from a
 *     live process.
 *   - One exception: if the model left background work running (Bash
 *     run_in_background, Monitor), closing stdin would make the CLI stop it.
 *     That process alone stays up, stdin open, until the work finishes and
 *     the CLI has run its follow-up turn, then exits. The turn itself has
 *     already returned. See holdForBackground in runClaude.
 *
 * OAuth token refresh is the CLI's job. We only pass CLAUDE_CODE_OAUTH_TOKEN
 * (or ANTHROPIC_API_KEY) and stay out of its auth lifecycle.
 */

// Native-tool policy (disallowedToolsFor: base + observer/worker denylists)
// lives in claudeToolPolicy.ts so tests can assert it without importing this
// service's full dependency graph. Includes the zj21 sub-agent spawn lockdown:
// Task/Agent are disallowed on every spawn — delegation goes through
// `sulla agents/spawn_agent`, whose completions durably wake the parent graph.

/**
 * Ceiling on how long a process is kept alive after its turn because it still
 * owns background tasks (Bash run_in_background, Monitor). Past this the
 * process is stopped, which stops those tasks.
 */
const BACKGROUND_TASK_MAX_HOLD_MS = 4 * 60 * 60_000;

/**
 * Once a held process reports no live background tasks, how long to wait for
 * the CLI to start its follow-up turn before closing stdin anyway.
 */
const BACKGROUND_HOLD_SETTLE_MS = 60_000;

/**
 * MCP/CLI token lifetime for a `claude` process. The token is baked into the
 * process at spawn and revoked when the process exits, so it must outlive a
 * long turn plus a background hold (background tasks still call `sulla`).
 */
const PROC_MCP_SESSION_TTL_MS = BACKGROUND_TASK_MAX_HOLD_MS + 30 * 60_000;

/** Claude Code background traffic Sulla never needs (verified in 2.1.310). */
const CLAUDE_QUIET_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
} as const;

/**
 * How long a turn stays open after `result` waiting for Claude to start the
 * follow-up turn for a steer it hasn't consumed yet (observed: immediate).
 * Past this the steer is handed back to the graph instead.
 */
const STEER_FOLLOWUP_GRACE_MS = 30_000;

/**
 * conversationId → stops the process still held open for that conversation's
 * background tasks. Shared by every ClaudeCodeService instance (one per
 * model/agent override) so the next turn ends the hold whichever instance
 * runs it.
 */
const backgroundHolds = new Map<string, () => void>();

export class ClaudeCodeService extends BaseLanguageModel {
  override managesOwnLoop(): boolean {
    return true;
  }

  // conversationId → Claude session_id — in-memory cache backed by Redis.
  private sessions = new Map<string, string>();
  private readonly recallDedupe = new RecallDedupe();

  // Routes background-task completions from held CLI processes back into
  // their graph threads. See claudeBackgroundTasks.ts.
  private readonly bgDelivery = new BackgroundCompletionDelivery();

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
   * Redis key holding the hash of the stable platform/environment context last
   * stamped into any conversation on this install. Subconscious output is not
   * part of this tier; it travels only in the synthetic assistant message.
   */
  private readonly STABLE_CTX_KEY = 'claude_code_stable_ctx_hash';

  private async getSession(convId: string): Promise<string | undefined> {
    const cached = this.sessions.get(convId);
    if (cached) return cached;
    try {
      const stored = await providerSessionStore.get(`${ this.SESSION_KEY_PREFIX }${ convId }`);
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
      await providerSessionStore.set(`${ this.SESSION_KEY_PREFIX }${ convId }`, sessionId);
    } catch { /* Durable store unavailable — session persists in memory only this run */ }
  }

  private async deleteSession(convId: string): Promise<void> {
    this.sessions.delete(convId);
    this.recallDedupe.reset(convId);
    try {
      await providerSessionStore.delete(`${ this.SESSION_KEY_PREFIX }${ convId }`);
    } catch { /* Durable store unavailable — non-fatal */ }
  }

  /**
   * Resolve how the VM's `claude` authenticates. With the container-owned
   * Vault the secret never leaves the vault, so the process gets a bridge
   * capability + base URL (and a lease the caller must bind to the process).
   * Otherwise: integration vault first, SullaSettingsModel fallback.
   */
  private async resolveClaudeCreds(
    convId: string,
    state?: BaseThreadState,
  ): Promise<{ oauthToken: string; apiKey: string; baseUrl?: string; lease?: ProviderCliBridgeLease }> {
    const bridged = await createGuestClaudeAuth({ conversationId: convId, state });
    if (bridged) return bridged;

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

  /**
   * Build the `sulla-runtime exec` argv that launches `claude -p` in the VM.
   * Input is always stream-json: the prompt is written to stdin as a JSON
   * user message, and steers can be written into the running turn.
   */
  private buildSpawnArgs(p: {
    oauthToken:        string;
    apiKey:            string;
    /** Host broker bridge base URL (container Vault mode); credentials above are then opaque capabilities. */
    baseUrl?:          string;
    existingSession?:  string;
    mcpConfigPath:     string | null;
    toolSessionId?:    string;
    /**
     * Full --disallowedTools value for this spawn's role (disallowedToolsFor):
     * observers lose the native actor toolset (Read/Write/Edit/Bash/…),
     * worker sub-agents lose detached-work tools (Monitor/ScheduleWakeup/…).
     */
    disallowedTools:   string;
    /**
     * Host path of this spawn's system prompt file (cliSystemPromptFile).
     * Passed as --append-system-prompt-file: ~/.claude/CLAUDE.md is written
     * on the host, but the CLI runs in the VM under a different $HOME and
     * never reads it — this flag is the only route Sulla's prompt has in.
     */
    systemPromptPath?: string | null;
    /** VM-side pidfile the launched claude records its PID in. */
    pidFile:           string;
  }): string[] {
    // POSIX single-quote escape. Single-quoted strings are literal in sh, so
    // no backtick/$VAR/! expansion can fire against untrusted text.
    const shq = (s: string) => `'${ s.replace(/'/g, "'\\''") }'`;

    const envAssignments: string[] = [];
    for (const [name, value] of Object.entries(CLAUDE_QUIET_ENV)) envAssignments.push(`${ name }=${ value }`);
    if (p.toolSessionId) envAssignments.push(`SULLA_TOOL_SESSION=${ shq(p.toolSessionId) }`);
    if (p.oauthToken) envAssignments.push(`CLAUDE_CODE_OAUTH_TOKEN=${ shq(p.oauthToken) }`);
    if (p.apiKey) envAssignments.push(`ANTHROPIC_API_KEY=${ shq(p.apiKey) }`);
    if (p.baseUrl) envAssignments.push(`ANTHROPIC_BASE_URL=${ shq(p.baseUrl) }`);

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
      // Files project folders. Agents track work in PROJECT.md and TASKS.md
      // in Sulla Files — there must be exactly one task system, not a second
      // in-memory to-do list. NOTE: TaskOutput / TaskStop are background-process
      // controls (not the to-do list) and stay enabled.
      //
      // Also disable native sub-agent spawning (Task, and its Agent rename).
      // Provider-native sub-agents report completion to this process only, so
      // their finished work dies with it; delegation must go through
      // `sulla agents/spawn_agent`, which durably wakes the parent graph (zj21).
      //
      // Subconscious observers additionally lose the native actor tools
      // (Read/Write/Edit/Bash/…) — see SUBCONSCIOUS_NATIVE_TOOL_DENYLIST.
      // Every acting agent (primary, workers, reviewers) gets the same set.
      '--disallowedTools', p.disallowedTools,
    ];
    // stream-json input: the prompt is fed as a JSON user message on stdin,
    // and "Send now" messages can be written into a running turn. Replay
    // echoes each stdin message back at the moment Claude consumes it — that's
    // how runClaude knows a steer has been seen.
    claudeArgs.push('--input-format', 'stream-json', '--replay-user-messages');
    if (this.model && this.model !== 'claude-code') claudeArgs.push('--model', shq(this.model));
    if (p.existingSession) claudeArgs.push('--resume', shq(p.existingSession));
    if (p.mcpConfigPath) claudeArgs.push('--mcp-config', shq(p.mcpConfigPath));
    if (p.systemPromptPath) claudeArgs.push('--append-system-prompt-file', shq(p.systemPromptPath));

    // Claude Code emits newline-delimited JSON, but its stdout is connected
    // to the sulla-runtime/SSH pipe rather than a terminal. Prefer stdbuf when the
    // VM provides it, but never make Claude startup depend on that optional
    // binary: existing installations may not have coreutils installed.
    // A resumed session must have exactly one live process: the launch first
    // stops any other claude still holding it (an orphan from an app restart,
    // or a copy owned elsewhere) so two copies never run the same chat.
    const innerCmd = buildClaudeLaunchCommand(envAssignments, claudeArgs, p.pidFile, p.existingSession);
    return ['exec', '--', 'sh', '-c', innerCmd];
  }

  /** Canonical argv used by container transports; parsing stays in this service. */
  private buildProviderCommand(p: {
    existingSession?:  string;
    mcpConfigPath:     string | null;
    disallowedTools:   string;
    systemPromptPath?: string | null;
    environment?:      Readonly<Record<string, string>>;
  }): { executable: string; args: string[]; env?: NodeJS.ProcessEnv } {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--disallowedTools', p.disallowedTools,
      '--input-format', 'stream-json', '--replay-user-messages',
    ];
    if (this.model && this.model !== 'claude-code') args.push('--model', this.model);
    if (p.existingSession) args.push('--resume', p.existingSession);
    if (p.mcpConfigPath) args.push('--mcp-config', p.mcpConfigPath);
    if (p.systemPromptPath) args.push('--append-system-prompt-file', p.systemPromptPath);

    return { executable: 'claude', args, env: { ...p.environment, ...CLAUDE_QUIET_ENV } };
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

  protected healthCheck(): Promise<boolean> {
    // Credentials presence is deferred until spawn time (see runClaude).
    return Promise.resolve(true);
  }

  constructor() {
    super({ id: 'claude-code', model: 'claude-code', baseUrl: 'local-vm' });
  }

  /** Non-streaming chat — buffers the whole response and returns it. */
  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    return runWithCliFaultRecovery('Claude Code', attempt => this.runClaude(attempt === 1 ? messages : recoveryMessages(messages), {}, options), {
      signal:   options.signal,
      canRetry: () => true,
      onRetry:  (_error, attempt) => log.warn(`[ClaudeCodeService] retrying failed CLI process (attempt ${ attempt })`),
    });
  }

  protected normalizeResponse(raw: any): NormalizedResponse {
    const text: string = raw?.text ?? '';
    return {
      content:  text,
      metadata: {
        tokens_used:       usageTokenTotal(raw?.usage),
        time_spent:        0,
        prompt_tokens:     Number(raw?.usage?.input_tokens ?? 0),
        completion_tokens: Number(raw?.usage?.output_tokens ?? 0),
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
      profileId?:      string;
      usageEventId?:   string;
      state?:          BaseThreadState | any;
    } = {},
  ): Promise<NormalizedResponse | null> {
    const startTime = performance.now();

    try {
      const guardedCallbacks: StreamCallbacks = {
        ...callbacks,
        onToken: (token: string) => {
          callbacks.onToken?.(token);
        },
        onToolEvent: (event) => {
          callbacks.onToolEvent?.(event);
        },
      };
      let streamedText = '';
      guardedCallbacks.onToken = (token: string) => {
        streamedText += token;
        callbacks.onToken?.(token);
      };
      const result = await runWithCliFaultRecovery('Claude Code', attempt => this.runClaude(attempt === 1 ? messages : recoveryMessages(messages), guardedCallbacks, options), {
        signal:   options.signal,
        canRetry: () => true,
        onRetry:  (_error, attempt) => log.warn(`[ClaudeCodeService] retrying failed CLI process (attempt ${ attempt })`),
      });
      if (streamedText) result.text = streamedText;
      const response: NormalizedResponse = {
        content:  result.text,
        metadata: {
          tokens_used:       usageTokenTotal(result.usage),
          time_spent:        Math.round(performance.now() - startTime),
          prompt_tokens:     Number(result.usage?.input_tokens ?? 0),
          completion_tokens: Number(result.usage?.output_tokens ?? 0),
          model:             this.getModel(),
          finish_reason:     FinishReason.Stop,
        },
      };
      await this.recordMeterableTokens(response, options.profileId, options.usageEventId, this.usageEventId(messages, options, this.getModel()));

      return response;
    } catch (err) {
      console.warn('[ClaudeCodeService] chatStream failed:', err);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────

  /**
   * Transport a base64 image block into the provider's guest-owned staging
   * area so the Read tool can open it. Returns the provider-visible path.
   */
  private async saveImageAttachment(b: any, context?: ProviderTransportContext, refs?: ProviderFileRef[]): Promise<string | null> {
    try {
      const data: string | undefined = b?.source?.data;
      const mediaType: string = b?.source?.media_type || 'image/png';
      if (!data) return null;

      const ext = mediaType.split('/')[1]?.split('+')[0] || 'png';
      const filename = `attachment-${ Date.now() }-${ crypto.randomBytes(4).toString('hex') }.${ ext }`;
      if (context) {
        const ref = await getProviderExecutionTransport().files.write({
          context, purpose: 'attachment', suggestedName: filename, data: Buffer.from(data, 'base64'), mode: 0o600,
        });
        refs?.push(ref);
        return ref.path;
      }
      throw new Error('Attachment transport context is required');
    } catch (err) {
      log.error('[ClaudeCodeService] Failed to save image attachment:', err);
      return null;
    }
  }

  /**
   * Extract the latest turn for a resumed session. A dedicated synthetic
   * assistant context message may immediately precede the user message; it
   * must be replayed because Claude's stored session does not contain this
   * turn's newly generated subconscious context.
   *
   * Image blocks are saved to disk and their paths injected into the text
   * so the Claude Code agent can read them with the Read tool.
   */
  private extractLatestUserMessage(
    messages: ChatMessage[],
    stage?: ImageStager,
    dedupeSynthetic?: (text: string) => string,
  ): string {
    const blockToText = (b: any): string => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'image' && b?.source?.type === 'base64') {
        const savedPath = stage ? stage(b) : null;
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
        if (text) {
          // Consecutive user messages (a "Send now" steer stacked on the
          // message it followed) are all new to the session — send them all.
          const userTexts = [text];
          let contextIdx = i - 1;
          while (contextIdx >= 0 && messages[contextIdx].role === 'user') {
            const earlier = msgToText(messages[contextIdx]).trim();
            if (earlier) userTexts.unshift(earlier);
            contextIdx--;
          }
          const turn: string[] = [];
          while (contextIdx >= 0 && messages[contextIdx].role === 'assistant' && (messages[contextIdx] as any).metadata?._synthetic) {
            const assistantText = msgToText(messages[contextIdx]).trim();
            const deduped = dedupeSynthetic ? dedupeSynthetic(assistantText) : assistantText;
            if (deduped) turn.unshift(`Assistant:\n${ deduped }`);
            contextIdx--;
          }
          for (const userText of userTexts) turn.push(`User:\n${ userText }`);
          return turn.join('\n\n');
        }
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
   * are the caller-built system prompt and go to --append-system-prompt-file
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
      case 'user': return 'User';
      default: return role;
      }
    };

    const lines: string[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue; // handled via --append-system-prompt-file
      const text = msgToText(m).trim();
      if (!text) continue;
      lines.push(`${ labelFor(m.role) }: ${ text }`);
    }
    return lines.join('\n\n');
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
  4. Sulla's knowledge about this environment (tools, workflows, functions,
     sub-agents, host/VM behavior, its own source repository) arrives through
     memory recall: \`sulla.md\`, \`project-*.md\` subject pages and
     \`skills.md\`. Read them before guessing.
- Scheduling → Sulla Workflows (\`sulla workflow/import_workflow\`), never CronCreate or cron
- Git/GitHub → \`sulla github/git_push\` / \`sulla github/git_pull\`, never SSH or raw curl
- Browser → \`sulla browser/tab\` with action \`upsert\` or \`remove\` only
- Recurring tasks become workflows, not one-off commands
- Files: /mnt/sulla-files is your Human's own versioned file system, not your workspace. Save only finished work there, in the right existing folder, updated in place. Scratch goes in /mnt/worktrees/_scratch (or /tmp for throwaway files, which is on disk); the VM root and home don't survive a restart
- You are part of a live multi-agent network — Heartbeat and other agents are active
- Durable agent memory lives in Files under \`Memory/\` (provider-specific subfolders). Record durable facts there and ALSO call the observational-memory tool so recall stays current; never rely on the VM's ephemeral home directory.
- Background work (Bash run_in_background, Monitor): if it finishes after your turn ends, Sulla wakes this conversation with the completion so you can act on it. Sub-agent and workflow-worker runs are NOT woken after they return — there, wait for the result inside the same turn (bounded loop) instead of promising to report back later
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
   browser, functions, workflows, any internal procedure — read
   your recalled memory FIRST (\`skills.md\` and the subject pages). The
   \`search\` tool also searches Sulla's shipped knowledge pack by default.

This is a hard rule, not a suggestion: catalog and memory first, improvise last.
</environment>`);

    const parts: string[] = [];

    // Decide whether to stamp the stable tier into this message.
    //
    // The stable tier is redundant with the byte-stable system prompt's
    // platform rules. It only needs to ride the message
    // when its content has CHANGED since a conversation last saw it — repeating
    // it verbatim otherwise just multiplies token cost in the permanent history.
    //
    //   - Resumed session: compare against the per-conversation hash we recorded
    //     earlier this session. Unchanged → skip (existing dedup). Changed →
    //     re-send, because a resumed session never re-receives the system prompt.
    //   - Fresh session (new convId, empty per-conv hash): the system prompt has
    //     already delivered the platform rules, so seed this
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
  ): Promise<{ text: string; usage?: any }> {
    const runPhaseStart = Date.now();
    const runPhaseMarks: Record<string, number> = {};
    let lastSetupMark = runPhaseStart;
    const markPhase = (name: string) => { const now = Date.now(); runPhaseMarks[name] = now - lastSetupMark; lastSetupMark = now };
    const convId = options.conversationId ?? '__default__';
    // Signal immediately, before credential/config/file setup starts.
    try { callbacks.onActivity?.('Preparing your turn…') } catch { /* renderer unavailable */ }
    // A process still held open for this conversation's background tasks
    // ends here: the new turn's `--resume` must be the only live copy of the
    // session (the launch command would stop it anyway).
    backgroundHolds.get(convId)?.();
    const existingSession = retryWithoutSession ? undefined : await this.getSession(convId);
    markPhase('session');
    const transport = getProviderExecutionTransport();
    const initialTransportContext = await transport.context({
      provider:          'claude-code',
      conversationId:    convId,
      state:             options.state,
      providerSessionId: existingSession,
    });
    requireBrokeredContainerAuth(initialTransportContext);
    markPhase('initialContext');
    const attachmentRefs: ProviderFileRef[] = [];

    // Prompt strategy:
    //   - existingSession → send only the latest user message (Claude has the
    //     rest via --resume + prompt cache)
    //   - no session    → seed Claude with the full curated transcript
    if (!existingSession) this.recallDedupe.reset(convId);
    const extractedPrompt = existingSession
      ? await stageImagePaths(
        stage => this.extractLatestUserMessage(messages, stage, text => this.recallDedupe.dedupe(convId, existingSession, text)),
        b => this.saveImageAttachment(b, initialTransportContext, attachmentRefs),
      )
      : this.serializeFullTranscript(messages);
    if (existingSession) perf.log(`[RecallDedupe] convId=${ convId } beforeChars=${ this.extractLatestUserMessage(messages).length } afterChars=${ extractedPrompt.length }`);

    if (!extractedPrompt.trim()) {
      const roles = messages.map(m => m.role).join(',');
      throw new Error(`Claude Code got no extractable prompt from ${ messages.length } messages (roles=${ roles })`);
    }
    const basePrompt = await prepareWorkerTurnPrompt(options.state, extractedPrompt);

    // Prepend Sulla context to the outgoing user message. Recall context
    // travels every turn; the stable tier (platform rules + memories) is only
    // re-sent when new to the session or changed — see
    // buildUserMessageContextPrefix.
    const contextPrefix = await this.buildUserMessageContextPrefix(options.state, {
      convId,
      isNewSession: !existingSession,
    });
    // Background completions that could not wake the graph (thread stayed
    // busy, no wake target, or the wake failed) ride along with this turn so
    // the model still learns about them.
    const heldNotices = this.bgDelivery.takePending(convId);
    const bgPreamble = heldNotices.length ? formatBackgroundNotices(heldNotices) : '';
    const prompt = [contextPrefix, bgPreamble, basePrompt].filter(Boolean).join('\n\n');
    markPhase('prompt');

    // The Sulla runtime only exists on macOS; container transports do not depend on it.
    if (transport.runtime === 'guest' && process.platform === 'win32') {
      throw new Error('Claude Code execution requires the Sulla VM, which is not available on Windows yet. This feature currently supports macOS only.');
    }

    const runtimePath = paths.sullaRuntime;

    // Mint an MCP session bound to the calling graph state, if we have one AND
    // the in-process MCP server is listening. Lifetime: revoked + config
    // deleted when the process is done (turn end, or end of a background hold).
    let mcpSession: RegisteredSession | null = null;
    let mcpConfigPath: string | null = null;
    let mcpConfigFile: ProviderFileRef | null = null;
    if (options.state) {
      try {
        const host = getMCPServerHost();
        if (host.running) {
          mcpSession = host.registerSession(options.state, PROC_MCP_SESSION_TTL_MS);
          if (transport.runtime === 'guest') {
            mcpConfigFile = await this.writeMcpConfig(mcpSession, initialTransportContext);
            mcpConfigPath = mcpConfigFile.path;
          }
          log.log(`[ClaudeCodeService] MCP session minted — config=${ mcpConfigPath ?? '(transport-owned)' } url=${ mcpSession.url }`);
        }
      } catch (err) {
        log.log(`[ClaudeCodeService] MCP session setup failed, continuing without sulla-native tools: ${ (err as Error)?.message ?? err }`);
      }
    }

    const transportContext = mcpSession
      ? await transport.context({
        provider:          'claude-code',
        conversationId:    convId,
        state:             options.state,
        providerSessionId: existingSession,
        toolSessionId:     mcpSession.id,
      })
      : initialTransportContext;
    markPhase('toolContext');
    const providerConfig = requireBrokeredContainerAuth(transportContext);
    const { oauthToken, apiKey, baseUrl, lease: authLease } = transportContext.runtime === 'guest'
      ? await this.resolveClaudeCreds(convId, options.state)
      : { oauthToken: '', apiKey: '', baseUrl: undefined, lease: undefined };
    markPhase('auth');
    log.log(`[ClaudeCodeService] runClaude: messages=${ messages.length } promptLen=${ prompt.length } conversationId=${ convId } session=${ existingSession ?? '(new)' } hasOAuth=${ !!oauthToken } hasApiKey=${ !!apiKey }`);
    if (transportContext.runtime === 'guest' && !oauthToken && !apiKey) {
      releaseLease(authLease);
      throw new Error('No Claude credentials configured. Sign in via Integrations → Claude Code.');
    }
    const toolConfig = mcpSession && transportContext.runtime === 'container'
      ? requireContainerToolConfig(transportContext)
      : undefined;
    if (mcpSession && transportContext.runtime === 'container') {
      mcpConfigPath = toolConfig?.claudeConfigPath ?? null;
      if (!mcpConfigPath) throw new Error('Container Claude execution requires an opaque broker MCP config');
    }

    // The prompt is fed via stdin (see below), NOT as an argv element. A large
    // transcript embedded in the command line overflows sulla-runtime's SSH
    // multiplexing channel and the spawn dies with "mux_client_request_session:
    // write packet: Broken pipe", bricking any sufficiently long conversation.
    // Build the launch argv. `exec` replaces the inner sh with claude so there's
    // no shell layer between the SSH session and the CLI. The prompt is
    // delivered as a stream-json line on stdin (see below).
    // Observer runs (subconscious writers/recalls/summarizer/digester) lose the
    // native actor tools so they can only observe + write memory, never act on
    // the host. Keyed off the resolved model slot (isObserverSpawn), NOT bare
    // isSubAgent — workflow-node agents are sub-agents stamped 'primary' and
    // must keep Bash/Read to do their work. Those workers instead lose the
    // detached-work tools, since nothing they arm can reach them after return.
    const disallowedTools = disallowedToolsFor(options.state?.metadata as any);
    // The caller-built system prompt (primary chat, observer, trainer…),
    // falling back to the full Sulla prompt for callers that bypass BaseNode.
    const systemPromptFile: ProviderFileRef = await transport.files.write({
      context:       transportContext,
      purpose:       'system-prompt',
      suggestedName: `claude-system-${ crypto.randomUUID() }.md`,
      data:          systemPromptFromMessages(messages) || await this.fallbackSystemPrompt(),
    });
    const systemPromptPath = systemPromptFile.path;
    markPhase('systemPromptFile');
    const pidFile = newRemotePidFile();
    const args = this.buildSpawnArgs({ oauthToken, apiKey, baseUrl, existingSession, mcpConfigPath, toolSessionId: mcpSession?.id, disallowedTools, systemPromptPath, pidFile });
    const providerCommand = this.buildProviderCommand({
      existingSession,
      mcpConfigPath,
      disallowedTools,
      systemPromptPath,
      environment: { ...providerConfig?.environment, ...toolConfig?.environment },
    });

    const cleanupMcp = () => {
      for (const ref of attachmentRefs.splice(0)) ref.dispose();
      if (mcpSession) {
        try { mcpSession.revoke() } catch { /* ignore */ }
        mcpSession = null;
      }
      mcpConfigFile?.dispose();
      mcpConfigFile = null;
      mcpConfigPath = null;
    };

    if (options.signal?.aborted) {
      cleanupMcp();
      releaseLease(authLease);
      systemPromptFile.dispose();
      const error = new Error('Claude Code run aborted');
      error.name = 'AbortError';
      throw error;
    }

    const setupDoneAt = Date.now();
    const proc: childProcess.ChildProcessWithoutNullStreams = transport.spawn({
      context: transportContext,
      providerCommand,
      ...(transportContext.runtime === 'guest'
        ? {
          guestCommand: { executable: runtimePath, args, env: { ...process.env, TERM: 'dumb' } },
        }
        : {}),
    });
    proc.once('exit', () => systemPromptFile.dispose());
    bindLeaseToProcess(proc, authLease);

    // Background-task tracking for this process (see claudeBackgroundTasks.ts).
    // Completions that land after the turn has returned are delivered to the
    // graph thread that owns the conversation.
    const wakeTarget = wakeTargetFromState(options.state);
    const bgTracker = new ClaudeBackgroundTaskTracker((notices) => {
      log.log(`[ClaudeCodeService] ${ notices.length } background completion(s) for convId=${ convId } — delivering to graph`);
      this.bgDelivery.deliver(convId, wakeTarget, notices);
    });

    // Declared at method scope so the `finally` block below can read it: set
    // true while the process outlives its turn for background tasks, which
    // tells finally to leave MCP cleanup to the end of that hold.
    let holding = false;

    try {
      return await new Promise((resolve, reject) => {
        // Feed the prompt through stdin instead of the command line. sulla-runtime's
        // SSH mux caps how large a session-request (command line) can be; a long
        // transcript blows past it. stdin is a plain data channel with no such
        // limit. Guard against EPIPE in case claude exits before we finish.
        const onStdinError = () => { /* EPIPE — claude already gone, non-fatal */ };
        proc.stdin.on('error', onStdinError);
        // stream-json input: deliver the prompt as one user message. stdin stays
        // open until the turn completes so steers can still be written (see
        // completeTurn); closing it then lets claude exit.
        try {
          proc.stdin.write(`${ JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) }\n`);
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
          directActivity('Booting isolated environment…');
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
            if (toolStarts.size > 0) {
              const tools = [...toolStarts.values()];
              if (tools.some(tool => /ask_user_question|approval|permission/i.test(tool.name) && Date.now() - tool.startedAt < 2 * 60 * 60_000)) return;
              if (tools.every(tool => Date.now() - tool.startedAt < 30 * 60_000)) return;
              unresolvedTool = true;
            }
            if (silentMs < STALL_TIMEOUT_MS) return;
            stalled = true;
            stopStallWatchdog();
            cleanupMcp();
            log.warn(`[ClaudeCodeService] Stall watchdog: no stream activity for ${ Math.round(silentMs / 1000) }s — killing claude (convId=${ convId })`);
            killSpawn();
            scheduleForcedSettlement(() => new CliFaultError(
              'stall',
              unresolvedTool
                ? 'Claude Code stopped reporting activity while a tool was unresolved. Recovery was not attempted because replay could duplicate side effects.'
                : `Claude Code stalled — no stream activity for ${ Math.round(STALL_TIMEOUT_MS / 60_000) } minutes, so the run was terminated.`,
              undefined,
              !unresolvedTool,
              unresolvedTool,
            ));
          }, STALL_CHECK_MS);
        };

        let stdoutBuffer = '';
        let stderrBuffer = '';
        let textCollected = '';
        let capturedSessionId: string | undefined = existingSession;
        let lastUsage: any;
        let errored = false;
        let errorMessage = '';
        let sessionInUse = false;
        let sawTerminalResult = false;
        let settled = false;   // guards resolve/reject across the result-vs-close paths
        let terminationPromise: Promise<void> | null = null;
        const persistSession = async(): Promise<Error | null> => {
          if (!capturedSessionId) return null;
          try {
            await this.setSession(convId, capturedSessionId);
            return null;
          } catch (error) {
            return new CliFaultError('transport', 'Claude Code session state could not be persisted safely.', error, false);
          }
        };
        const scheduleForcedSettlement = (makeError: () => Error) => {
          const barrier = terminationPromise;
          if (!barrier) return;
          barrier.then(async() => {
            if (settled) return;
            settled = true;
            stopHeartbeat();
            stopStallWatchdog();
            closeSteering();
            options.signal?.removeEventListener('abort', onAbort);
            proc.stdout.removeAllListeners('data');
            proc.stderr.removeAllListeners('data');
            proc.removeAllListeners('error');
            proc.on('error', () => { /* late child error after forced teardown */ });
            proc.removeAllListeners('close');
            const persistenceError = await persistSession();
            cleanupMcp();
            reject(persistenceError ?? makeError());
          }, async(error) => {
            if (settled) return;
            settled = true;
            stopHeartbeat();
            stopStallWatchdog();
            closeSteering();
            options.signal?.removeEventListener('abort', onAbort);
            const persistenceError = await persistSession();
            cleanupMcp();
            reject(options.signal?.aborted ? makeError() : (persistenceError ?? error));
          }).catch(() => {});
        };
        // stream-json input only: set once the replay echo of THIS turn's prompt
        // arrives. A `result` before that belongs to a turn the CLI ran on its
        // own — e.g. on --resume it injects "background command didn't finish
        // before the previous session ended" for tasks the killed process left
        // behind and answers it ("No response requested.") BEFORE reading our
        // prompt. Settling on that result failed the turn as "claude produced
        // no output" while the CLI went on to answer the real prompt unseen.
        let promptConsumed = false;

        // ── Perf: per-tool execution timing inside the claude CLI ──────────
        // The tool-use loop (Grep/Glob/Read/Bash/etc.) runs INSIDE the spawned
        // CLI, so the only way to measure how long each tool actually takes is
        // to time the gap between a tool_use block's input completing and its
        // matching tool_result arriving. Keyed by the tool_use id so parallel
        // tool calls are timed independently.
        const toolStarts = new Map<string, { name: string; input?: unknown; startedAt: number }>();
        let unresolvedTool = false;
        const toolTotals = new Map<string, { count: number; ms: number }>();
        let firstTokenAt = 0;
        const runStartedAt = Date.now();
        let spawnedAt = 0;
        let initAt = 0;
        let firstStreamAt = 0;
        let firstContentAt = 0;
        let phaseLogged = false;
        const logRunPhase = () => {
          if (phaseLogged) return;
          phaseLogged = true;
          const d = (a: number, b: number) => a && b ? b - a : -1;
          const setupParts = Object.entries(runPhaseMarks).map(([key, ms]) => `${ key }Ms=${ ms }`).join(' ');
          perf.log(`[RunPhase] provider=claude-code convId=${ convId } setupMs=${ setupDoneAt - runPhaseStart } ${ setupParts } spawnMs=${ d(setupDoneAt, spawnedAt) } initMs=${ d(spawnedAt, initAt) } firstStreamMs=${ d(initAt || spawnedAt, firstStreamAt) } firstContentMs=${ d(firstStreamAt || initAt || spawnedAt, firstContentAt) } firstTextMs=${ d(firstContentAt || firstStreamAt || initAt || spawnedAt, firstTokenAt) } totalToTextMs=${ d(runPhaseStart, firstTokenAt) }`);
        };
        const noteToolStart = (id?: string, name?: string, input?: unknown) => {
          if (!id || toolStarts.has(id)) return;
          toolStarts.set(id, { name: name ?? 'tool', input, startedAt: Date.now() });
        };
        const noteToolResult = (id?: string, resultChars = 0, isError = false) => {
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
          try {
            callbacks.onToolEvent?.({
              toolUseId: id, toolName: started.name, input: started.input, resultChars, isError,
            });
          } catch { /* ignore */ }
        };

        // Kill THIS run's claude process inside the VM. Without a TTY, SSH
        // signal propagation isn't guaranteed — fire a follow-up kill so an
        // orphaned claude doesn't keep burning tokens after the user hits stop.
        // Targeted by pidfile, never `pkill -f 'claude -p'`: that also killed
        // every concurrent run (other agents, and the run a steering/queued
        // message had just started), which died as "returned no output".
        const killRemoteClaude = async(sig: 'TERM' | 'KILL') => {
          try {
            await transport.terminate({
              context: transportContext, process: proc, signal: sig, remotePidFile: pidFile,
            });
          } catch (err) {
            log.log(`[ClaudeCodeService] Remote kill failed: ${ (err as Error)?.message ?? err }`);
            throw err;
          }
        };

        // Kill the spawn on both sides of the SSH boundary:
        //   1) SIGTERM the host-side sulla-runtime process — closes the SSH-style
        //      session; with `exec` in the inner shell (see above) the remote
        //      claude usually receives SIGHUP and dies.
        //   2) targeted kill inside the VM (see killRemoteClaude).
        //   3) Escalate to SIGKILL after a grace period — a sulla-runtime wedged in
        //      the SSH mux can ignore SIGTERM entirely, which is exactly the
        //      state that strands a hung run.
        const killSpawn = () => {
          terminationPromise ??= terminateCliChild(proc, killRemoteClaude);
          return terminationPromise;
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
          closeSteering();
          cleanupMcp();
          killSpawn();
          scheduleForcedSettlement(() => {
            const error = new Error('Claude Code run aborted');
            error.name = 'AbortError';
            return error;
          });
        };

        // Start the heartbeat + stall watchdog once the process has spawned.
        proc.once('spawn', () => { spawnedAt = Date.now(); onSpawned() });

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

        // ── Live steering ("Send now" while the turn runs) ─────────────
        // stdin stays open for the whole stream-json turn, so a message the user
        // sends mid-run is written straight into the running CLI. Claude folds
        // it into the current turn at its next tool boundary, or — if it lands
        // while the final answer is being written — runs it as a follow-up turn
        // right after. The replay echo marks the moment Claude consumed it; a
        // `result` doesn't end this turn while any steer is still unconsumed.
        const steersInFlight: { content: string; message: ChatMessage }[] = [];
        let steeringOpen = true;
        let steerGraceTimer: NodeJS.Timeout | null = null;
        const unsubscribeSteer = onSteer(options.state, (message) => {
          if (!steeringOpen || settled || proc.stdin.writableEnded || proc.stdin.destroyed) return false;
          const content = this.extractLatestUserMessage([message]);
          if (!content.trim()) return false;
          try {
            proc.stdin.write(`${ JSON.stringify({ type: 'user', message: { role: 'user', content } }) }\n`);
          } catch {
            return false;
          }
          steersInFlight.push({ content, message });
          lastStreamActivityAt = Date.now();
          emitActivity('Steering Claude with your message…');
          log.log(`[ClaudeCodeService] steer written to running turn convId=${ convId } chars=${ content.length }`);
          return true;
        });
        // Stop taking steers. Any written but never consumed go back to the
        // graph as pending so the next turn answers them instead of dropping them.
        const closeSteering = () => {
          steeringOpen = false;
          unsubscribeSteer();
          if (steerGraceTimer) { clearTimeout(steerGraceTimer); steerGraceTimer = null }
          for (const s of steersInFlight.splice(0)) markSteerPending(s.message);
        };
        if (options.signal) {
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener('abort', onAbort);
        }

        const processLine = (line: string) => {
          if (terminationPromise) return;
          const trimmed = line.trim();
          if (!trimmed) return;
          let parsed: any;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            return;
          }

          const limitSnapshot = normalizeClaudeLimitSnapshot(parsed);
          if (limitSnapshot) recordCliLimitSnapshot('claude-code', limitSnapshot).catch(() => {});

          if (parsed.session_id) capturedSessionId = parsed.session_id;

          // Background-task bookkeeping. Once this turn has settled (the process
          // is held for background tasks), nobody owns the process's output any
          // more, so completions must be delivered.
          bgTracker.observe(parsed, settled);
          if (settled) {
            if (holding) checkBackgroundHold(parsed);
            return;
          }

          // Replay echo of a stdin message — a steer Claude just consumed.
          if (parsed.type === 'user' && parsed.isReplay) {
            const echoed = typeof parsed.message?.content === 'string' ? parsed.message.content : '';
            const idx = steersInFlight.findIndex(s => s.content === echoed);
            if (!promptConsumed && idx < 0 && !echoed.trimStart().startsWith('<task-notification>')) {
              promptConsumed = true;
              return;
            }
            if (idx >= 0) {
              steersInFlight.splice(idx, 1);
              if (steerGraceTimer && !steersInFlight.length) { clearTimeout(steerGraceTimer); steerGraceTimer = null }
              emitActivity('Claude picked up your message');
            }
            return;
          }

          // Claude Code exposes its own context compaction in stream-json as
          // a system/compact_boundary event. Sulla records the boundary but
          // deliberately leaves compaction itself to the CLI.
          if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
            try {
              callbacks.onContextCompaction?.({
                provider: 'claude-code',
                at:       Date.now(),
                source:   'stream-json:system/compact_boundary',
              });
            } catch { /* observer callback */ }
            return;
          }

          // System init — claude has booted, auth done, MCP tools loaded.
          // Update the heartbeat phase but keep ticking because the model
          // call itself can still add 20–60s.
          if (parsed.type === 'system' && parsed.subtype === 'init') {
            if (!initAt) initAt = Date.now();
            emitActivity('Tools connected — calling model');
            return;
          }

          // Stream-level events (wrapped in parsed.event) — text deltas,
          // tool_use block starts, thinking starts.
          const ev = parsed?.event;
          if (ev) {
            if (!firstStreamAt && ev.type === 'message_start') firstStreamAt = Date.now();
          // Text chunks → stream to caller as content
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
              if (!promptConsumed) return;   // a CLI-initiated turn's text, not ours
              stopHeartbeat();
              if (!firstContentAt) firstContentAt = Date.now();
              if (!firstTokenAt) { firstTokenAt = Date.now(); logRunPhase() }
              textCollected += ev.delta.text;
              try { callbacks.onToken?.(ev.delta.text) } catch { /* ignore */ }
              return;
            }

            // Thinking deltas → live reasoning trace (throttled, see flushThinking)
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
              stopHeartbeat();
              if (!firstContentAt) firstContentAt = Date.now();
              thinkingBuf += ev.delta.thinking;
              flushThinking();
              return;
            }

            // Tool use block starting → emit a short activity message. Input
            // isn't filled in yet here for partial streaming, so the message
            // starts generic and content_block_stop below refines it.
            if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
              stopHeartbeat();
              if (!firstContentAt) firstContentAt = Date.now();
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
              noteToolStart(ev.content_block.id, name, ev.content_block.input);
              emitActivity(activityForToolUse(name, ev.content_block.input));
              emitFilePatch(name, ev.content_block.input);
              return;
            }

            // Thinking block starting → stop the heartbeat
            if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
              stopHeartbeat();
              if (!firstContentAt) firstContentAt = Date.now();
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
                noteToolStart(b.id, b.name, b.input);
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
                noteToolResult(b.tool_use_id, chars, b.is_error === true);
              }
            }
          }

          // Final result event — capture full text and record usage/cost.
          if (parsed.type === 'result' && !promptConsumed && !parsed.is_error) {
            log.log(`[ClaudeCodeService] ignoring result of a CLI-initiated turn that ran before this turn's prompt (convId=${ convId })`);
            textCollected = '';
            return;
          }

          if (parsed.type === 'result') {
            if (options.signal?.aborted) return;
            sawTerminalResult = true;
            lastUsage = parsed.usage;
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
            // A steer written after Claude's last tool boundary hasn't been
            // consumed yet — Claude runs it as a follow-up turn right after this
            // result. Keep the turn open for it. The grace timer covers a CLI
            // that never picks it up: the steer then goes back to the graph.
            if (!parsed.is_error && steersInFlight.length > 0) {
              if (textCollected.trim()) {
                textCollected += '\n\n';
                try { callbacks.onToken?.('\n\n') } catch { /* ignore */ }
              }
              if (!steerGraceTimer) {
                steerGraceTimer = setTimeout(() => {
                  steerGraceTimer = null;
                  if (settled || !steersInFlight.length) return;
                  log.warn(`[ClaudeCodeService] ${ steersInFlight.length } steer(s) not picked up ${ STEER_FOLLOWUP_GRACE_MS }ms after result — returning them to the graph (convId=${ convId })`);
                  completeTurn(true);
                }, STEER_FOLLOWUP_GRACE_MS);
              }
              return;
            }
            completeTurn(!parsed.is_error);
          }
        };

        // The turn is over at `result`. If the process still owns live
        // background tasks, settle now and hold it open until they finish (see
        // holdForBackground); otherwise close stdin so claude exits and
        // onProcClose settles. Defined here, invoked only at runtime.
        const completeTurn = (ok: boolean) => {
          closeSteering();
          if (ok && bgTracker.liveTaskCount > 0 && textCollected.trim()) holdForBackground();
          else closeStdin();
        };

        const closeStdin = () => {
          try { proc.stdin.end() } catch { /* already closed */ }
        };

        const onStdoutData = (chunk: Buffer) => {
          if (settled && !holding) return;
          lastStreamActivityAt = Date.now();
          stdoutBuffer += chunk.toString('utf-8');
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() ?? '';
          for (const line of lines) processLine(line);
        };
        proc.stdout.on('data', onStdoutData);

        const onStderrData = (chunk: Buffer) => {
          if (settled) return;
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
          closeSteering();
          options.signal?.removeEventListener('abort', onAbort);
          if (holding) endHold();
          if (capturedSessionId) this.setSession(convId, capturedSessionId).catch(() => {});
          if (!settled) {
            settled = true;
            const retrySafe = toolStarts.size === 0 && !unresolvedTool;
            const safety = retrySafe ? '' : ' Recovery was not attempted because a tool was still unresolved.';
            reject(new CliFaultError('spawn', `Claude Code process error: ${ err.message }.${ safety }`, err, retrySafe, !retrySafe));
          }
        };
        proc.on('error', onProcError);

        // ── Background hold ─────────────────────────────────────────────
        // The turn is over but the CLI still owns live background tasks (Bash
        // run_in_background, Monitor). Closing stdin now would make the CLI
        // stop them, so settle the turn and keep THIS process alive with stdin
        // open: when a task finishes the CLI emits task_notification and runs
        // its own follow-up turn, which the tracker hands to the graph. Once
        // no task is left, stdin is closed and the process exits. The hold is
        // capped at BACKGROUND_TASK_MAX_HOLD_MS and ends early when the
        // conversation's next turn starts (that turn resumes the session in a
        // fresh process). The stall watchdog stops here: a silent wait on a
        // background task is not a stall.
        let holdTimer: NodeJS.Timeout | null = null;
        let holdSettleTimer: NodeJS.Timeout | null = null;
        const stopHoldSettle = () => {
          if (holdSettleTimer) { clearTimeout(holdSettleTimer); holdSettleTimer = null }
        };
        const stopHeldProcess = (reason: string) => {
          if (!holding) return;
          log.log(`[ClaudeCodeService] stopping held proc for convId=${ convId } (${ reason }; ${ bgTracker.liveTaskCount } background task(s) live)`);
          killSpawn().catch(() => {});
        };
        const onNextTurn = () => stopHeldProcess('next turn started');
        // Release everything the hold kept: timers, the registry entry, and the
        // MCP session / config / attachments the background work was using.
        const endHold = () => {
          if (!holding) return;
          holding = false;
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
          stopHoldSettle();
          if (backgroundHolds.get(convId) === onNextTurn) backgroundHolds.delete(convId);
          cleanupMcp();
        };
        const checkBackgroundHold = (parsed: any) => {
          if (bgTracker.liveTaskCount > 0 || bgTracker.inAutonomousTurn) {
            stopHoldSettle();
            return;
          }
          // The follow-up turn finished and nothing is left running.
          if (parsed?.type === 'result') {
            stopHoldSettle();
            closeStdin();
            return;
          }
          // Tasks are done but no follow-up turn has started yet.
          if (!holdSettleTimer) {
            holdSettleTimer = setTimeout(() => {
              holdSettleTimer = null;
              if (holding && bgTracker.liveTaskCount === 0 && !bgTracker.inAutonomousTurn) closeStdin();
            }, BACKGROUND_HOLD_SETTLE_MS);
            holdSettleTimer.unref?.();
          }
        };
        const holdForBackground = () => {
          if (settled) return;
          settled = true;
          holding = true;
          stopHeartbeat();
          stopStallWatchdog();
          options.signal?.removeEventListener('abort', onAbort);
          if (capturedSessionId) this.setSession(convId, capturedSessionId).catch(() => {});
          backgroundHolds.get(convId)?.();
          backgroundHolds.set(convId, onNextTurn);
          holdTimer = setTimeout(() => {
            holdTimer = null;
            log.warn(`[ClaudeCodeService] background task(s) for convId=${ convId } still live after ${ Math.round(BACKGROUND_TASK_MAX_HOLD_MS / 60_000) }min`);
            stopHeldProcess('hold limit reached');
          }, BACKGROUND_TASK_MAX_HOLD_MS);
          holdTimer.unref?.();
          log.log(`[ClaudeCodeService] runClaude ok: ${ textCollected.length } chars, session=${ capturedSessionId ?? '(none)' } (${ bgTracker.liveTaskCount } background task(s) still live — holding proc until they finish)`);
          resolve({ text: textCollected, usage: lastUsage });
        };

        const onProcClose = async(code: number | null) => {
          logRunPhase();
          const awaitingForcedSettlement = !!terminationPromise && (options.signal?.aborted || stalled);
          stopHeartbeat();
          stopStallWatchdog();
          closeSteering();
          options.signal?.removeEventListener('abort', onAbort);
          if (awaitingForcedSettlement && !settled) return;
          const persistenceError = await persistSession();
          if (persistenceError && !settled) {
            settled = true;
            reject(persistenceError);
            return;
          }
          if (!settled && stdoutBuffer.trim()) { processLine(stdoutBuffer); stdoutBuffer = '' }
          if (settled) {
            // Already resolved (held for background tasks). Deliver any
            // completion the process announced before exiting, then release.
            if (stdoutBuffer.trim()) processLine(stdoutBuffer);
            stdoutBuffer = '';
            bgTracker.flush();
            endHold();
            return;
          }
          if (stdoutBuffer.trim()) processLine(stdoutBuffer);
          if (settled) return;                                           // a buffered `result` may have settled it
          settled = true;

          // Aborted by the caller (Stop, or a new/steering message superseding
          // this run) — the kill caused the empty exit, so report an abort. A
          // "no output" error here would trigger provider fallback and show the
          // user a model failure for a run they cancelled.
          if (options.signal?.aborted) {
            const abortErr = new Error('Claude Code run aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
            return;
          }

          // Stall-watchdog kill — surface a clear, retryable error instead of
          // falling through to the generic no-output message.
          if (stalled) {
            const silentMin = Math.round(STALL_TIMEOUT_MS / 60_000);
            reject(new CliFaultError(
              'stall',
              unresolvedTool
                ? 'Claude Code stopped reporting activity while a tool was unresolved. Recovery was not attempted because replay could duplicate side effects.'
                : `Claude Code stalled — no stream activity for ${ silentMin } minutes, so the run was terminated.`,
              undefined,
              !unresolvedTool,
              unresolvedTool,
            ));
            return;
          }

          // Session lock collision — drop the cached id and retry once with a
          // fresh session so the user doesn't see a dead-end error.
          if (sessionInUse && !retryWithoutSession) {
            log.warn(`[ClaudeCodeService] Session "${ existingSession }" locked; retrying without --resume for conversationId=${ convId }`);
            this.deleteSession(convId).then(() => this.runClaude(messages, callbacks, options, true)).then(
              r => resolve(r),
              reject,
            ).catch(reject);
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

          if (code !== 0) {
            const msg = errorMessage || stderrBuffer.trim().slice(-200) || `claude exited with code ${ code }`;
            const retrySafe = toolStarts.size === 0 && !unresolvedTool && !isPermanentCliFailure(msg);
            const safety = retrySafe ? '' : ' Recovery was not attempted because a tool was still unresolved.';
            reject(new CliFaultError('process_exit', `Claude Code: ${ msg }${ safety }`, undefined, retrySafe, !retrySafe && (toolStarts.size > 0 || unresolvedTool)));
            return;
          }

          if (!sawTerminalResult) {
            const retrySafe = toolStarts.size === 0 && !unresolvedTool;
            reject(new CliFaultError('protocol', 'Claude Code exited before emitting a terminal result event.', undefined, retrySafe, !retrySafe));
            return;
          }

          if (!textCollected.trim()) {
            const stderrTail = stderrBuffer.trim().slice(-200);
            log.warn(`[ClaudeCodeService] runClaude exited with no text (code=${ code }) stderr=${ stderrTail }`);
            const retrySafe = toolStarts.size === 0 && !unresolvedTool && !isPermanentCliFailure(stderrTail);
            const safety = retrySafe ? '' : ' Recovery was not attempted because a tool was still unresolved.';
            reject(new CliFaultError('protocol', `Claude Code returned no output (exit code ${ code }). ${ stderrTail || 'Check credentials or VM status.' }${ safety }`, undefined, retrySafe, !retrySafe && (toolStarts.size > 0 || unresolvedTool)));
            return;
          }

          log.log(`[ClaudeCodeService] runClaude ok: ${ textCollected.length } chars, session=${ capturedSessionId ?? '(none)' }`);
          resolve({ text: textCollected, usage: lastUsage });
        };
        proc.on('close', onProcClose);
      });
    } finally {
      // A process held for background tasks keeps its MCP session until the
      // hold ends (endHold cleans up then).
      if (!holding) cleanupMcp();
    }
  }

  private async fallbackSystemPrompt(): Promise<string> {
    try {
      const { buildFullSystemPrompt } = await import('../prompts/buildFullSystemPrompt');
      return (await buildFullSystemPrompt({ provider: 'anthropic' })) || '';
    } catch {
      return '';
    }
  }

  /**
   * Transport a short-lived MCP config JSON into guest-owned storage so
   * Claude Code can reach the in-process MCP server without a home mount.
   *
   * The Authorization header carries the session id so tool handlers can
   * resolve back to the calling graph's BaseThreadState.
   */
  private async writeMcpConfig(session: RegisteredSession, context: ProviderTransportContext): Promise<ProviderFileRef> {
    const payload = {
      mcpServers: {
        'sulla-native': {
          type:    'http',
          url:     session.url,
          headers: { Authorization: session.header },
        },
      },
    };
    return await getProviderExecutionTransport().files.write({
      context,
      purpose:       'mcp-config',
      suggestedName: `mcp-${ session.id }.json`,
      data:          JSON.stringify(payload),
      mode:          0o600,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Usage capture
// ─────────────────────────────────────────────────────────────

/**
 * Append a single usage sample from Claude Code's result event to
 * the shared provider usage registry.
 */
async function recordUsage(result: any): Promise<void> {
  const u = result?.usage;
  if (!u) return;
  await recordCliUsage('claude-code', {
    duration_ms:                 typeof result.duration_ms === 'number' ? result.duration_ms : undefined,
    input_tokens:                typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
    output_tokens:               typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
    total_tokens:                ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
      .reduce((total, key) => total + (typeof u[key] === 'number' ? u[key] : 0), 0),
    cache_creation_input_tokens: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : undefined,
    cache_read_input_tokens:     typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : undefined,
    cost_usd:                    typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
    model:                       typeof result.model === 'string' ? result.model : undefined,
  });
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
