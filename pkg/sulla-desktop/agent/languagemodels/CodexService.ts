// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as childProcess from 'child_process';
import * as crypto from 'crypto';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason, usageTokenTotal } from './BaseLanguageModel';
import {
  getProviderExecutionTransport,
  requireBrokeredContainerAuth,
  requireContainerToolConfig,
  type ProviderFileRef,
  type ProviderTransportContext,
} from './ProviderExecutionTransport';
import { buildRemotePidRecordCommand, newRemotePidFile } from './claudeLaunchCommand';
import { CliFaultError, isCliFault, isPermanentCliFailure, recoveryMessages, runWithCliFaultRecovery, terminateCliChild } from './cliFaultRecovery';
import { legacyProviderFailure } from './failures';
import { systemPromptFromMessages } from './cliSystemPromptFile';
import { AgentAwarenessPolicy } from '../services/AgentAwarenessPolicy';
import { stageImagePaths, type ImageStager } from './providerImageStaging';
import { providerSessionStore } from './providerSessionStore';
import { bindCodexMcpSession, buildCodexMcpOverrides, CODEX_MCP_TOKEN_ENV } from './codexMcpConfig';
import { currentAgentContainerRuntime } from '../services/AgentContainerRuntimeRegistry';
import { providerBridgeActivity } from '../../vault-broker/ProviderBridgeActivity';
import { LONG_TOOL_CEILING_MS, RunLivenessClock, describeHungTool, type RunToolInFlight } from '../services/RunLivenessClock';
import { CodexFailureDiagnostics } from './codexFailureDiagnostics';
import { codexSandboxArgs, CODEX_MEMORY_CONFIG_OVERRIDES, CODEX_NATIVE_SPAWN_FEATURE_PINS } from './codexSandboxPolicy';
import { CodexToolEventEmitter } from './codexToolEvents';
import { ProviderToolActivityReporter } from './ProviderToolActivityReporter';
import { CodexTurnOutcome } from './codexTurnOutcome';
import { prepareWorkerTurnPrompt } from '../tools/agents/workerMessaging';
import { normalizeCodexLimitSnapshot, recordCliLimitSnapshot, recordCliUsage } from '../usage/providerUsage';
import { resolveCodexExecutionAuth, type CodexExecutionAuth } from './codexExecutionAuth';
import { graphBrowserControllerContext } from '../utils/graphBrowserController';
import { RecallDedupe } from '../utils/recallDedupe';
import { markSteerPending, onSteer } from '../utils/steerChannel';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import { getMCPServerHost, type RegisteredSession } from '@pkg/main/MCPServerHost';
import Logging from '@pkg/utils/logging';
import { TurnHopTiming } from '../utils/turnHopTiming';
import paths from '@pkg/utils/paths';
import { firstRunTrace } from '@pkg/utils/firstRunTraceSink';

const log = Logging.background;
const failureDiagnostics = new CodexFailureDiagnostics(line => log.warn(line));
const perf = Logging.perf;

/** stderr prefix carrying the in-VM PID of the codex process (see buildSpawnArgs). */
const CODEX_PID_MARKER = 'SULLA_CODEX_PID=';

/** After SIGINT for a steer, how long codex gets to save its thread and exit before SIGTERM. */
const STEER_INTERRUPT_GRACE_MS = 10_000;
/** Jonathon's rule (2026-11-23): Codex must not sit idle longer than this. Idle = the whole agent loop, not chat. */
export const CODEX_STALL_TIMEOUT_MS = 3 * 60 * 1_000;

/** Opening line of the resume prompt that delivers a steer to an interrupted codex turn. */
const STEER_RESUME_NOTE = '[Steering message] The user sent the message below while you were working. Your turn was paused to deliver it. Take it into account and carry on with the task. Do not start over or repeat work that is already done.';

/**
 * CodexService — runs `codex exec` inside the Sulla VM and streams the
 * --json JSONL output back into Sulla's agent loop.
 *
 * The codex sibling of ClaudeCodeService: codex already owns its own agent
 * loop, tool execution, and context management inside the CLI process, so
 * from Sulla's perspective it behaves as a "one-shot completion" peer. Tool
 * work happens internally (shell, file edits, and the `sulla` CLI which is
 * on PATH in the VM). State-mutating Sulla tools are supplied through the
 * same short-lived, graph-bound MCP bridge used by Claude Code.
 *
 * Auth: by default the ChatGPT sign-in lives in Sulla's vault. Each spawn
 * gets only a provider-bridge capability (SULLA_PROVIDER_BRIDGE_TOKEN) and a
 * model_providers.sulla override pointing at the bridge, which injects and
 * refreshes the real token upstream. Legacy non-vault mode copies Sulla's
 * own auth.json into the guest $CODEX_HOME. The Mac home folder is not
 * shared into the VM, and the user's own ~/.codex is never used. With
 * ChatGPT sign-in, usage draws from the user's ChatGPT Plus/Pro plan, not
 * API billing.
 *
 * Token strategy — hybrid (first-turn seed + `exec resume` thereafter):
 *   - First turn for a conversation: serialize the full curated
 *     state.messages[] as a transcript so codex catches up to wherever
 *     Sulla is.
 *   - Subsequent turns: `codex exec resume <threadId>` with ONLY the latest
 *     user message; codex's own session state keeps prior context warm.
 *   - Resume failures (expired/missing thread): drop the cached id and
 *     retry once with a fresh session (full history).
 *
 * Process lifetime: one `codex exec` process per turn. It is spawned when
 * the turn starts and exits when the turn ends (`codex exec` reads exactly
 * one prompt, runs to `task_complete`, and exits). Nothing is booted ahead
 * of a turn and no idle process is kept between turns, to keep VM memory low.
 */
export class CodexService extends BaseLanguageModel {
  private readonly toolEventEmitter = new CodexToolEventEmitter();
  private readonly agentAwarenessPolicy: AgentAwarenessPolicy;
  override managesOwnLoop(): boolean {
    return true;
  }

  // conversationId → codex thread_id — in-memory cache backed by Redis.
  private sessions = new Map<string, string>();
  private readonly recallDedupe = new RecallDedupe();

  /**
   * Tracks the hash of the stable <sulla_context> payload last sent per
   * conversation so we only re-send it when it actually changes — same
   * dedup as ClaudeCodeService (each send becomes permanent history).
   */
  private lastStableContextHash = new Map<string, string>();

  private readonly SESSION_KEY_PREFIX = 'codex_session:';
  /**
   * Codex records the model in its thread and refuses to resume it with a different
   * one ("This session was recorded with model X but is resuming with Y"). Fallback
   * routing can run several Codex models on one conversation, so each model keeps its
   * own thread: the key is conversation + model.
   */
  private sessionKey(convId: string): string {
    const model = this.model && this.model !== 'codex' ? this.model : 'default';
    return `${ convId }@${ model }`;
  }

  private async getSession(convId: string): Promise<string | undefined> {
    const key = this.sessionKey(convId);
    const cached = this.sessions.get(key);
    if (cached) return cached;
    try {
      const stored = await providerSessionStore.get(`${ this.SESSION_KEY_PREFIX }${ key }`);
      if (stored) {
        this.sessions.set(key, stored);
        return stored;
      }
    } catch { /* Redis unavailable — start fresh session */ }
    return undefined;
  }

  private async setSession(convId: string, sessionId: string): Promise<void> {
    const key = this.sessionKey(convId);
    this.sessions.set(key, sessionId);
    try {
      await providerSessionStore.set(`${ this.SESSION_KEY_PREFIX }${ key }`, sessionId);
    } catch { /* Durable store unavailable — session persists in memory only this run */ }
  }

  private async deleteSession(convId: string): Promise<void> {
    const key = this.sessionKey(convId);
    this.sessions.delete(key);
    this.recallDedupe.reset(convId);
    try {
      await providerSessionStore.delete(`${ this.SESSION_KEY_PREFIX }${ key }`);
    } catch { /* Durable store unavailable — non-fatal */ }
  }

  /**
   * Build the `sulla-runtime exec` argv that launches `codex exec` in the VM.
   * The prompt is never baked into this argv — `codex exec`'s positional
   * PROMPT arg is always omitted (trailing `-`) so the CLI reads its prompt
   * from stdin once runCodex writes it (see `codex exec --help`: "If not
   * provided as an argument (or if `-` is used), instructions are read from
   * stdin"). A large transcript on the command line would overflow
   * sulla-runtime's SSH multiplexing channel.
   */
  private buildSpawnArgs(p: {
    existingSession?:  string;
    mcpSession?:       RegisteredSession | null;
    readOnly?:         boolean;
    /**
     * Per-run instructions file (cliSystemPromptFile) holding the caller-built
     * Sulla prompt, passed as -c model_instructions_file on every spawn. It
     * replaces Codex's base instructions. No AGENTS.md is written or read.
     */
    instructionsPath?: string | null;
    /** VM-side pidfile the launched codex records its PID in. */
    pidFile:           string;
    /** ContainerBrokerLease / PendingMemoryBridge capability, exported before `exec codex …`. Omitted for guest-auth-file. */
    environment?:          Readonly<Record<string, string>>;
    codexConfigOverrides?: readonly string[];
  }): string[] {
    const shq = (s: string) => `'${ s.replace(/'/g, "'\\''") }'`;

    const codexArgs = ['codex', 'exec'];
    // Sulla workers need their graph-bound SULLA_TOOL_SESSION to survive
    // Codex's shell environment filtering. Keep this process-local so the
    // user's shared ~/.codex/config.toml remains unchanged; Codex still
    // applies its KEY/SECRET/TOKEN exclusions when inheriting the shell.
    codexArgs.push('-c', shq('shell_environment_policy.inherit=all'));
    if (p.existingSession) {
      codexArgs.push('resume', shq(p.existingSession));
    }
    codexArgs.push('--json');
    codexArgs.push(...codexSandboxArgs(!!p.readOnly));
    codexArgs.push('--skip-git-repo-check');
    // Structurally disallow codex's native sub-agent spawning — delegation
    // goes through `sulla agents/spawn_agent` so completions durably wake the
    // parent graph (zj21). See CODEX_NATIVE_SPAWN_FEATURE_PINS.
    for (const pin of CODEX_NATIVE_SPAWN_FEATURE_PINS) {
      codexArgs.push('-c', shq(pin));
    }
    // ContainerBrokerLease / PendingMemoryBridge route this spawn through an
    // opaque bridge instead of a raw auth.json — see codexExecutionAuth.ts.
    for (const override of p.codexConfigOverrides ?? []) {
      codexArgs.push('-c', shq(override));
    }
    if (p.mcpSession) {
      for (const override of buildCodexMcpOverrides(p.mcpSession)) {
        codexArgs.push('-c', shq(override));
      }
    }
    if (p.instructionsPath) {
      codexArgs.push('-c', shq(`model_instructions_file=${ JSON.stringify(p.instructionsPath) }`));
    }
    if (this.model && this.model !== 'codex') {
      codexArgs.push('--model', shq(this.model));
    }
    if (this.effort) codexArgs.push('-c', shq(`model_reasoning_effort=${ JSON.stringify(this.effort) }`));
    for (const override of CODEX_MEMORY_CONFIG_OVERRIDES) {
      codexArgs.push('-c', shq(override));
    }
    codexArgs.push('-'); // read the prompt from stdin

    // `exec` replaces the inner sh with codex so there's no shell layer
    // between the SSH session and the CLI — best chance of signal
    // propagation when we kill sulla-runtime on the host side.
    const mcpTokenExport = p.mcpSession
      ? ` ${ CODEX_MCP_TOKEN_ENV }=${ shq(p.mcpSession.id) } SULLA_TOOL_SESSION=${ shq(p.mcpSession.id) }`
      : '';
    const bridgeEnvExport = p.environment
      ? Object.entries(p.environment).map(([key, value]) => ` ${ key }=${ shq(value) }`).join('')
      : '';
    // The pidfile lets an abort kill exactly this run; the PID line (stderr,
    // before exec — same PID after) lets a steer interrupt it. Neither
    // touches any other codex in the VM.
    const pluginPolicySetup = `export CODEX_HOME="$HOME/.codex"${ bridgeEnvExport }${ mcpTokenExport }; ` +
      `codex features disable plugins >/dev/null && codex features disable remote_plugin >/dev/null; `;
    const innerCmd = `${ buildRemotePidRecordCommand(p.pidFile) }; ${ pluginPolicySetup }echo ${ CODEX_PID_MARKER }$$ >&2; exec ${ codexArgs.join(' ') }`;
    return ['exec', '--', 'sh', '-c', innerCmd];
  }

  /** Canonical argv used by container transports; JSONL parsing stays here. */
  private buildProviderCommand(p: {
    existingSession?:  string;
    readOnly?:         boolean;
    instructionsPath?: string | null;
    environment?:      Readonly<Record<string, string>>;
    configOverrides?:  readonly string[];
  }): { executable: string; args: string[]; env?: NodeJS.ProcessEnv } {
    const args = ['exec', '-c', 'shell_environment_policy.inherit=all'];
    if (p.existingSession) args.push('resume', p.existingSession);
    args.push('--json', ...codexSandboxArgs(!!p.readOnly), '--skip-git-repo-check');
    for (const pin of CODEX_NATIVE_SPAWN_FEATURE_PINS) args.push('-c', pin);
    for (const override of p.configOverrides ?? []) args.push('-c', override);
    if (p.instructionsPath) args.push('-c', `model_instructions_file=${ JSON.stringify(p.instructionsPath) }`);
    if (this.model && this.model !== 'codex') args.push('--model', this.model);
    if (this.effort) args.push('-c', `model_reasoning_effort=${ JSON.stringify(this.effort) }`);
    for (const override of CODEX_MEMORY_CONFIG_OVERRIDES) args.push('-c', override);
    args.push('-');

    return { executable: 'codex', args, env: p.environment ? { ...p.environment } : undefined };
  }

  private cleanupGuestCodexPluginTemp(): void {
    const cleanup = [
      'if pgrep -x codex >/dev/null 2>&1; then exit 0; fi',
      'd="$HOME/.codex/.tmp"',
      '[ ! -d "$d" ] || find "$d" -mindepth 1 -maxdepth 1 \\(',
      "  -name 'plugins-clone-*' -o -name plugins -o -name 'git-*'",
      '\\) -exec rm -rf -- {} +',
    ].join('\n');
    const janitor = childProcess.spawn(paths.sullaRuntime, ['exec', '--', 'sh', '-c', cleanup], {
      env:      { ...process.env, TERM: 'dumb' },
      stdio:    'ignore',
      detached: true,
    });
    janitor.on('error', () => log.warn('[CodexService] Codex temp cleanup failed.'));
    janitor.unref();
  }

  override getContextWindow(): number {
    return 272_000;
  }

  override getModel(): string {
    return this.model || 'codex';
  }

  /** Reasoning effort from Preferences → AI models; '' leaves the CLI's own default. */
  private effort = '';
  override getEffort(): string { return this.effort }
  setEffort(effort: string | undefined): void { this.effort = /^[a-z]{2,10}$/.test(effort || '') ? effort! : '' }

  /** The `--model` value this CLI is launched with; '' when the CLI picks its own default. */
  private launchModel(): string {
    return this.model && this.model !== 'codex' ? this.model : '';
  }

  override getProviderName(): string {
    return 'OpenAI Codex';
  }

  protected healthCheck(): Promise<boolean> {
    // Credentials presence is deferred until spawn time (see runCodex).
    return Promise.resolve(true);
  }

  constructor(agentAwarenessPolicy = new AgentAwarenessPolicy()) {
    super({ id: 'codex', model: 'codex', baseUrl: 'local-vm' });
    this.agentAwarenessPolicy = agentAwarenessPolicy;
  }

  /** Non-streaming chat — buffers the whole response and returns it. */
  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    const runOptions = { ...options, diagnosticRunId: crypto.randomUUID() };
    return runWithCliFaultRecovery('Codex', attempt => this.runCodex(attempt === 1 ? messages : recoveryMessages(messages), {}, runOptions), {
      signal:   options.signal,
      canRetry: () => true,
      onRetry:  (error, attempt) => failureDiagnostics.retry(error, attempt, options.conversationId ?? '__default__', runOptions.diagnosticRunId),
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

  /** Streaming path — forwards agent message chunks to onToken. */
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
    const runOptions = { ...options, diagnosticRunId: crypto.randomUUID() };

    try {
      let toolStarted = false;
      const guardedCallbacks: StreamCallbacks = {
        ...callbacks,
        onToken: (token: string) => {
          callbacks.onToken?.(token);
        },
        onToolEvent: (event) => {
          toolStarted = true;
          callbacks.onToolEvent?.(event);
        },
        onToolStarted: (event) => { toolStarted = true; callbacks.onToolStarted?.(event) },
      };
      let streamedText = '';
      guardedCallbacks.onToken = (token: string) => {
        streamedText += token;
        callbacks.onToken?.(token);
      };
      const result = await runWithCliFaultRecovery('Codex', attempt => this.runCodex(attempt === 1 ? messages : recoveryMessages(messages), guardedCallbacks, runOptions), {
        signal:   options.signal,
        canRetry: () => !toolStarted,
        onRetry:  (error, attempt) => failureDiagnostics.retry(error, attempt, options.conversationId ?? '__default__', runOptions.diagnosticRunId),
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
      failureDiagnostics.failure({ error: err, fault: isCliFault(err) ? err.kind : 'process_exit', conversationId: options.conversationId ?? '__default__', runId: runOptions.diagnosticRunId });
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────

  /**
   * Transport a base64 image block into the provider's guest-owned staging
   * area. Returns the provider-visible path.
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
    } catch {
      log.error('[CodexService] Failed to save image attachment.');
      return null;
    }
  }

  /**
   * Extract the latest turn for a resumed session. A dedicated synthetic
   * assistant context message may immediately precede the user message; it
   * must be replayed because Codex's stored session does not contain this
   * turn's newly generated subconscious context.
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
   * only when seeding a fresh codex session. System-role messages are
   * INTENTIONALLY excluded — the system prompt reaches codex through the
   * per-spawn guest instruction file, so including it here would deliver it
   * twice.
   */
  private serializeFullTranscript(messages: ChatMessage[], stage?: ImageStager): string {
    const blockToText = (b: any): string => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'image' && b?.source?.type === 'base64') {
        const savedPath = stage ? stage(b) : null;
        return savedPath ? `[Image attached — read it at: ${ savedPath }]` : '';
      }
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
      if (m.role === 'system') continue; // delivered via the guest instruction file
      const text = msgToText(m).trim();
      if (!text) continue;
      lines.push(`${ labelFor(m.role) }: ${ text }`);
    }
    return lines.join('\n\n');
  }

  /**
   * Build a <sulla_context> prefix for the outgoing user message, same
   * strategy as ClaudeCodeService: the stable tier (platform rules and
   * environment) is sent on the first turn and again only when its content
   * changes. Agent role instructions are already in the system-role message
   * and must not be duplicated here. Memory and recall do not travel here;
   * they arrive as the synthetic assistant context message that precedes the
   * user message.
   *
   * Returns the stable-tier hash alongside the prefix; the caller commits it
   * to lastStableContextHash only after a successful run, so changed context
   * isn't marked "delivered" when the spawn fails.
   */
  private async buildUserMessageContextPrefix(
    state: BaseThreadState | undefined,
    opts: { convId: string; isNewSession: boolean },
  ): Promise<{ prefix: string; stableHash: string }> {
    const stableParts: string[] = [];
    const agentNetworkDirective = this.agentAwarenessPolicy.agentNetworkDirective(state?.metadata);

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
${ agentNetworkDirective }
- Durable agent memory lives in Files under \`Memory/\` (provider-specific subfolders). Record durable facts there; never rely on the VM's ephemeral home directory.
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

    const browserController = graphBrowserControllerContext(state);
    if (browserController) stableParts.push(browserController);

    const parts: string[] = [];

    // Only send the stable tier when it's new to this session or has changed
    // since it was last sent.
    const stableText = stableParts.join('\n\n');
    const stableHash = crypto.createHash('sha1').update(stableText).digest('hex');
    if (opts.isNewSession || this.lastStableContextHash.get(opts.convId) !== stableHash) {
      parts.push(stableText);
    }

    if (parts.length === 0) return { prefix: '', stableHash };
    return { prefix: `<sulla_context>\n${ parts.join('\n\n') }\n</sulla_context>`, stableHash };
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
    options: { signal?: AbortSignal; conversationId?: string; state?: BaseThreadState; diagnosticRunId?: string },
    retryWithoutSession = false,
  ): Promise<{ text: string; usage?: any }> {
    if (options.state?.metadata?.supportSessionId) {
      throw new Error('Codex native tools are unavailable in remote support chat. Select a provider with scoped support tools.');
    }
    TurnHopTiming.mark(options.state, 'onActivity.Preparing your turn');
    TurnHopTiming.emitProviderStart(options.state, 'codex', messages.length);
    const runPhaseStart = Date.now();
    const marks: Record<string, number> = {};
    let lastSetupMark = runPhaseStart;
    const mark = (name: string) => { const now = Date.now(); marks[name] = now - lastSetupMark; lastSetupMark = now };
    const convId = options.conversationId ?? '__default__';
    const diagnosticRunId = options.diagnosticRunId ?? crypto.randomUUID();
    // Signal immediately, before credential/config/file setup starts.
    try { callbacks.onActivity?.('Preparing your turn…', 'status') } catch { /* renderer unavailable */ }
    const existingSession = retryWithoutSession ? undefined : await this.getSession(convId);
    mark('session');
    const transport = getProviderExecutionTransport();
    const initialTransportContext = await transport.context({
      provider:          'codex',
      model:             this.launchModel(),
      conversationId:    convId,
      state:             options.state,
      providerSessionId: existingSession,
    });
    requireBrokeredContainerAuth(initialTransportContext);
    mark('initialContext');
    // Pick and validate exactly one execution auth before anything else is
    // set up for this spawn — nothing allocated yet needs disposal if this
    // throws, and a missing/invalid credential never surfaces as a late,
    // opaque CLI crash deep inside the run.
    let executionAuth: CodexExecutionAuth | undefined;
    if (initialTransportContext.runtime === 'guest') {
      // A fresh VM has no codex CLI; install the pinned version before the first turn.
      const { ensureGuestCli } = await import('@pkg/backend/guestClis');
      await ensureGuestCli('codex');
      executionAuth = await resolveCodexExecutionAuth({ conversationId: convId, state: options.state });
      firstRunTrace('codex', 'credentials resolved', { source: executionAuth.kind, runtime: initialTransportContext.runtime });
    } else {
      firstRunTrace('codex', 'credentials resolved', { source: 'vault-bridge', runtime: initialTransportContext.runtime });
    }
    mark('executionAuth');
    const attachmentRefs: ProviderFileRef[] = [];

    // Prompt strategy:
    //   - existingSession → send only the latest user message (codex has the
    //     rest via `exec resume`)
    //   - no session    → seed codex with the full curated transcript
    if (!existingSession) this.recallDedupe.reset(convId);
    const extractedPrompt = existingSession
      ? await stageImagePaths(
        stage => this.extractLatestUserMessage(messages, stage, text => this.recallDedupe.dedupe(convId, existingSession, text)),
        b => this.saveImageAttachment(b, initialTransportContext, attachmentRefs),
      )
      : await stageImagePaths(stage => this.serializeFullTranscript(messages, stage), b => this.saveImageAttachment(b, initialTransportContext, attachmentRefs));
    if (existingSession) perf.log(`[RecallDedupe] convId=${ convId } beforeChars=${ this.extractLatestUserMessage(messages).length } afterChars=${ extractedPrompt.length }`);

    if (!extractedPrompt.trim()) {
      executionAuth?.dispose();
      const roles = messages.map(m => m.role).join(',');
      throw new Error(`Codex got no extractable prompt from ${ messages.length } messages (roles=${ roles })`);
    }
    const basePrompt = await prepareWorkerTurnPrompt(options.state, extractedPrompt);

    const { prefix: contextPrefix, stableHash } = await this.buildUserMessageContextPrefix(options.state, {
      convId,
      isNewSession: !existingSession,
    });
    const prompt = contextPrefix ? `${ contextPrefix }\n\n${ basePrompt }` : basePrompt;
    mark('prompt');

    log.log(`[CodexService] runCodex: messages=${ messages.length } promptLen=${ prompt.length } conversationId=${ convId } session=${ existingSession ?? '(new)' } runtime=${ initialTransportContext.runtime }`);

    // The Sulla runtime only exists on macOS; paths.sullaRuntime is a throwing getter on
    // Windows. Surface a clear, user-readable error instead of an opaque crash.
    if (transport.runtime === 'guest' && process.platform === 'win32') {
      executionAuth?.dispose();
      throw new Error('Codex execution requires the Sulla VM, which is not available on Windows yet. This feature currently supports macOS only.');
    }

    const runtimePath = paths.sullaRuntime;

    // One fresh `codex exec` process per turn. Normal actor runs use --dangerously-bypass-approvals-and-sandbox:
    // codex runs inside the Sulla VM, which IS the sandbox. Verifier runs are
    // different: their graph state carries verifierReadOnly, so Codex uses its
    // read-only sandbox and cannot mutate a checkout even through native shell.
    // The
    // prompt is fed via stdin (`-` positional), NOT as an argv element — a
    // large transcript on the command line overflows sulla-runtime's SSH
    // multiplexing channel (same failure mode ClaudeCodeService hit).
    const readOnly = !!(options.state?.metadata as any)?.verifierReadOnly;

    let mcpSession: RegisteredSession | null = null;
    if (options.state) {
      try {
        const host = getMCPServerHost();
        mcpSession = bindCodexMcpSession(host, options.state, null, currentAgentContainerRuntime());
        if (mcpSession) log.log(`[CodexService] MCP session minted — url=${ mcpSession.url }`);
      } catch (err) {
        log.log(`[CodexService] MCP session setup failed, continuing without sulla-native tools: ${ (err as Error)?.message ?? err }`);
      }
    }
    if (mcpSession?.prepareCliLease) {
      try { await mcpSession.prepareCliLease(); } catch (error) { mcpSession.revoke(); throw error; }
    }
    const transportContext = mcpSession
      ? await transport.context({
        provider:          'codex',
        model:             this.launchModel(),
        conversationId:    convId,
        state:             options.state,
        providerSessionId: existingSession,
        toolSessionId:     mcpSession.id,
      })
      : initialTransportContext;
    mark('toolContext');
    const providerConfig = requireBrokeredContainerAuth(transportContext);
    const toolConfig = transportContext.runtime === 'container' && mcpSession
      ? requireContainerToolConfig(transportContext)
      : undefined;
    // Primary and child instructions share one custody path: the exact
    // caller-built system prompt is staged inside the guest for every spawn.
    // Nothing depends on a host ~/.codex/AGENTS.md or broad home mount.
    const systemInstructions = systemPromptFromMessages(messages);
    if (!systemInstructions.trim()) {
      executionAuth?.dispose();
      throw new Error('Codex system instructions are unavailable for this run');
    }
    const instructionsFile = await transport.files.write({
      context:       transportContext,
      purpose:       'system-prompt',
      suggestedName: `codex-instructions-${ crypto.randomUUID() }.md`,
      data:          systemInstructions,
    }).catch(err => { executionAuth?.dispose(); throw err });
    const instructionsPath = instructionsFile.path;
    mark('instructionsFile');
    const setupDoneAt = Date.now();
    const pidFile = newRemotePidFile('sulla-codex');
    const args = this.buildSpawnArgs({
      existingSession,
      mcpSession: transportContext.runtime === 'guest' ? mcpSession : null,
      readOnly,
      instructionsPath,
      pidFile,
      environment:          executionAuth?.environment,
      codexConfigOverrides: executionAuth?.codexConfigOverrides,
    });
    const providerCommand = this.buildProviderCommand({
      existingSession,
      readOnly,
      instructionsPath,
      environment:     { ...providerConfig?.environment, ...toolConfig?.environment },
      configOverrides: [...(providerConfig?.codexConfigOverrides ?? []), ...(toolConfig?.codexConfigOverrides ?? [])],
    });

    return await new Promise((resolve, reject) => {
      let mcpCleaned = false;
      const cleanupMcp = () => {
        if (mcpCleaned) return;
        mcpCleaned = true;
        for (const ref of attachmentRefs.splice(0)) ref.dispose();
        try { mcpSession?.revoke() } catch { /* already revoked */ }
        executionAuth?.dispose();
      };
      if (options.signal?.aborted) {
        cleanupMcp();
        instructionsFile.dispose();
        const error = new Error('Codex run aborted');
        error.name = 'AbortError';
        reject(error);
        return;
      }
      let spawnedAt = 0;
      let initAt = 0;
      let firstStreamAt = 0;
      let firstContentAt = 0;
      let firstTextAt = 0;
      let phaseLogged = false;
      const logRunPhase = () => {
        if (phaseLogged) return;
        phaseLogged = true;
        const d = (a: number, b: number) => a && b ? b - a : -1;
        const setupParts = Object.entries(marks).map(([key, ms]) => `${ key }Ms=${ ms }`).join(' ');
        perf.log(`[RunPhase] provider=codex convId=${ convId } setupMs=${ setupDoneAt - runPhaseStart } ${ setupParts } spawnMs=${ d(setupDoneAt, spawnedAt) } initMs=${ d(spawnedAt, initAt) } firstStreamMs=${ d(initAt || spawnedAt, firstStreamAt) } firstContentMs=${ d(firstStreamAt || initAt || spawnedAt, firstContentAt) } firstTextMs=${ d(firstContentAt || firstStreamAt || initAt || spawnedAt, firstTextAt) } totalToTextMs=${ d(runPhaseStart, firstTextAt) }`);
      };
      const proc: childProcess.ChildProcessWithoutNullStreams = transport.spawn({
        context: transportContext,
        providerCommand,
        ...(transportContext.runtime === 'guest'
          ? {
            guestCommand: { executable: runtimePath, args, env: { ...process.env, TERM: 'dumb' } },
          }
          : {}),
      });
      proc.once('exit', () => instructionsFile.dispose());
      if (transportContext.runtime === 'guest') {
        proc.once('close', () => this.cleanupGuestCodexPluginTemp());
      }

      // Feed the prompt through stdin instead of the command line. Guard
      // against EPIPE in case codex exits before we finish.
      proc.stdin.on('error', () => { /* EPIPE — codex already gone, non-fatal */ });
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch { /* stdin already closed */ }

      const activityReporter = new ProviderToolActivityReporter(callbacks.onActivity);
      const emitActivity = (msg: string, reportingActivity?: 'status' | 'tool') => activityReporter.report(msg, reportingActivity);

      proc.once('spawn', () => {
        spawnedAt = Date.now();
        emitActivity('Booting isolated environment…', 'status');
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let textCollected = '';
      let sawDelta = false;
      let capturedSessionId: string | undefined = existingSession;
      let codexPid: number | undefined;
      const outcome = new CodexTurnOutcome();
      let errorMessage = '';
      let latestRateLimitReason: string | undefined;
      let unsubscribeProviderBridgeRetryStatus = () => {};
      let lastUsage: any = null;
      let sawTerminalResult = false;
      // Whole-loop liveness: stdout/stderr, every JSONL event, tool start and
      // result, and provider stream chunks relayed by the bridge (reasoning
      // tokens arrive there long before `codex exec --json` prints the item).
      // Container runs record bridge activity under the runtime pod; VM runs on a
      // bridge lease (vault authority, first-run pending bridge) under the lease's pod.
      const providerBridgePodId = currentAgentContainerRuntime()?.podId ?? executionAuth?.podId;
      const liveness = new RunLivenessClock(CODEX_STALL_TIMEOUT_MS, LONG_TOOL_CEILING_MS, () => Date.now(),
        () => providerBridgeActivity.lastModelOutputAt(providerBridgePodId));
      let hungTool: RunToolInFlight | undefined;
      let lastBridgeOutputReportedAt = providerBridgeActivity.lastModelOutputAt(providerBridgePodId);
      let sawToolExecution = false;
      let unresolvedTool = false;
      let settled = false;
      // Surface provider retry state to the job, but never refresh the watchdog clock here.
      unsubscribeProviderBridgeRetryStatus = providerBridgeActivity.subscribeRetryStatus(providerBridgePodId, event => {
        if (settled) return;
        if (event.status === 429) {
          latestRateLimitReason = event.reason?.trim() || latestRateLimitReason || 'reason unavailable';
          emitActivity('Codex is rate-limited, retrying', 'status');
        } else {
          emitActivity('Codex is busy, retrying', 'status');
        }
      });
      let terminationPromise: Promise<void> | null = null;
      const persistSession = async(): Promise<Error | null> => {
        if (!capturedSessionId) return null;
        try {
          await this.setSession(convId, capturedSessionId);
          return null;
        } catch (error) {
          return new CliFaultError('transport', 'Codex session state could not be persisted safely.', error, false, true);
        }
      };
      const scheduleForcedSettlement = (makeError: () => Error) => {
        const barrier = terminationPromise;
        if (!barrier) return;
        barrier.then(async() => {
          if (settled) return;
          settled = true;
          stopStallWatchdog();
          closeSteering(true);
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
          stopStallWatchdog();
          closeSteering(true);
          options.signal?.removeEventListener('abort', onAbort);
          const persistenceError = await persistSession();
          cleanupMcp();
          reject(options.signal?.aborted ? makeError() : (persistenceError ?? error));
        }).catch(() => {});
      };

      // Kill the spawn on both sides of the SSH boundary — mirrors
      // ClaudeCodeService.killSpawn. Used by both explicit abort and the
      // stall watchdog below.
      let killStarted = false;
      const killSpawn = () => {
        if (killStarted) return terminationPromise!;
        killStarted = true;
        const remoteKill = async(signal: 'TERM' | 'KILL') => {
          await transport.terminate({
            context: transportContext, process: proc, signal, remotePidFile: pidFile,
          });
        };
        terminationPromise = terminateCliChild(proc, remoteKill);
        return terminationPromise;
      };

      // ── Stall watchdog ──────────────────────────────────────────────
      // Jonathon's rules: Codex must not sit silent for more than three
      // minutes (2026-11-23), and silence means the WHOLE loop is idle
      // (2026-11-24): no stream byte, no JSONL event, no provider stream chunk
      // and no tool call still running. Provider retry status (429/503) never
      // counts. A tool running past LONG_TOOL_CEILING_MS is reported as a hung
      // tool, not a dead agent.
      const STALL_CHECK_MS = 30 * 1_000;
      let stalled = false;
      let stallTimer: NodeJS.Timeout | null = null;
      const stopStallWatchdog = () => {
        if (stallTimer) {
          clearInterval(stallTimer);
          stallTimer = null;
        }
        unsubscribeProviderBridgeRetryStatus();
        unsubscribeProviderBridgeRetryStatus = () => {};
      };
      const stallErrorMessage = () => hungTool
        ? `Codex ${ describeHungTool(hungTool) }, with no other activity. Recovery was not attempted because replay could duplicate side effects.`
        : latestRateLimitReason
          ? `Codex stalled: no output for 3 minutes (rate-limited by OpenAI: ${ latestRateLimitReason })`
          : 'Codex stalled: no output for 3 minutes';
      const startStallWatchdog = () => {
        liveness.start();
        stallTimer = setInterval(() => {
          // Relayed model output (reasoning) is invisible on stdout; pass it up to the job clock.
          const bridgeOutputAt = providerBridgeActivity.lastModelOutputAt(providerBridgePodId);
          if (bridgeOutputAt > lastBridgeOutputReportedAt) {
            lastBridgeOutputReportedAt = bridgeOutputAt;
            try { callbacks.onLiveness?.() } catch { /* liveness reporting is best-effort */ }
          }
          const verdict = liveness.verdict();
          if (verdict.kind === 'alive') return;
          const silentMs = verdict.silentMs;
          if (verdict.kind === 'tool_hung') {
            unresolvedTool = true;
            hungTool = verdict.tool;
          }
          stalled = true;
          stopStallWatchdog();
          cleanupMcp();
          log.warn(`[CodexService] Stall watchdog: no stream activity for ${ Math.round(silentMs / 1000) }s — killing codex (convId=${ convId })`);
          killSpawn();
          scheduleForcedSettlement(() => new CliFaultError(
            'stall',
            stallErrorMessage(),
            undefined,
            false,
            unresolvedTool,
          ));
        }, STALL_CHECK_MS);
      };
      proc.once('spawn', startStallWatchdog);

      // ── Live steering ("Send now" while the turn runs) ─────────────
      // `codex exec` reads exactly one prompt, so a steer can't be written
      // into the running turn. Instead: SIGINT this codex (it records the
      // interrupted turn in its thread and exits), then `exec resume` the
      // same thread with the steer — codex carries on from where it was,
      // now with the user's new direction. Needs the thread id and the
      // in-VM PID; a steer that arrives before both waits for them.
      const steers: ChatMessage[] = [];
      let steeringOpen = true;
      let interruptSent = false;
      let interruptEscalation: NodeJS.Timeout | null = null;
      const signalCodex = (sig: 'INT' | 'TERM') => {
        if (!codexPid) return;
        try {
          Promise.resolve(transport.terminate({
            context: transportContext, process: proc, signal: sig, remotePid: codexPid,
          })).catch(error => log.log(`[CodexService] steer signal failed: ${ (error as Error)?.message ?? error }`));
        } catch (err) {
          log.log(`[CodexService] steer signal failed: ${ (err as Error)?.message ?? err }`);
        }
      };
      const maybeInterruptForSteer = () => {
        if (interruptSent || !steers.length || !capturedSessionId || !codexPid) return;
        interruptSent = true;
        log.log(`[CodexService] steering: interrupting codex pid=${ codexPid } thread=${ capturedSessionId } to deliver ${ steers.length } message(s) (convId=${ convId })`);
        emitActivity('Steering Codex with your message…', 'status');
        signalCodex('INT');
        interruptEscalation = setTimeout(() => {
          if (proc.exitCode === null) {
            signalCodex('TERM');
            try { proc.kill('SIGTERM') } catch { /* already dead */ }
          }
        }, STEER_INTERRUPT_GRACE_MS);
        interruptEscalation.unref?.();
      };
      const unsubscribeSteer = onSteer(options.state, (message) => {
        if (!steeringOpen) return false;
        steers.push(message);
        maybeInterruptForSteer();
        return true;
      });
      // Stop taking steers. With `handBack`, any we took go back to the graph
      // as pending so the next turn answers them instead of dropping them.
      const closeSteering = (handBack: boolean) => {
        steeringOpen = false;
        unsubscribeSteer();
        if (interruptEscalation) { clearTimeout(interruptEscalation); interruptEscalation = null }
        if (handBack) for (const m of steers.splice(0)) markSteerPending(m);
      };

      const onAbort = () => {
        stopStallWatchdog();
        closeSteering(true);
        cleanupMcp();
        killSpawn();
        scheduleForcedSettlement(() => {
          const error = new Error('Codex run aborted');
          error.name = 'AbortError';
          return error;
        });
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort);
      }

      /** Append a complete agent message, skipping it when deltas already
       *  streamed its content into textCollected. */
      const appendAgentMessage = (text: string) => {
        if (!text) return;
        if (!firstTextAt) { firstTextAt = Date.now(); logRunPhase() }
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
          if (typeof item.command === 'string') return `$ ${ item.command }`;
          return 'Running a shell command';
        case 'file_change': {
          const first = Array.isArray(item.changes) ? item.changes[0] : null;
          if (first?.path) return `Editing ${ String(first.path) }`;
          return 'Editing files';
        }
        case 'web_search':
          if (typeof item.query === 'string') return `Searching web: ${ item.query }`;
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
        if (terminationPromise) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }

        const limitSnapshot = normalizeCodexLimitSnapshot(parsed);
        if (limitSnapshot) recordCliLimitSnapshot('codex', limitSnapshot).catch(() => {});

        // ── Thread-event schema (codex exec --json) ──────────────
        if (typeof parsed.type === 'string') {
          if (!firstStreamAt) firstStreamAt = Date.now();
          if (parsed.type === 'thread.started' && parsed.thread_id) {
            if (!initAt) initAt = Date.now();
            capturedSessionId = parsed.thread_id;
            emitActivity('Session started — calling model', 'status');
            maybeInterruptForSteer();
            return;
          }
          if (parsed.type === 'item.started' || parsed.type === 'item.completed') {
            const item = parsed.item ?? {};
            if (!firstContentAt && parsed.type === 'item.started') firstContentAt = Date.now();
            const kind = item.item_type ?? item.type;
            const itemId = typeof item.id === 'string' ? item.id : typeof item.call_id === 'string' ? item.call_id : '';
            const isTool = ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(kind);
            if (isTool && itemId) {
              if (parsed.type === 'item.started') {
                const call = this.toolEventEmitter.started(item);
                callbacks.onToolStarted?.(call ?? { toolUseId: itemId, toolName: String(item.tool ?? item.name ?? kind) });
                liveness.toolStarted(itemId, String(item.tool ?? item.name ?? kind));
              } else if (parsed.type === 'item.completed') liveness.toolFinished(itemId);
            }
            if (isTool && parsed.type === 'item.started') sawToolExecution = true;
            if (kind === 'agent_message' && parsed.type === 'item.completed') {
              appendAgentMessage(typeof item.text === 'string' ? item.text : '');
              return;
            }
            if (parsed.type === 'item.started') {
              const activity = activityForItem(item);
              if (activity) emitActivity(activity, 'tool');
            }
            this.toolEventEmitter.emit(parsed.type, item, callbacks.onToolEvent);
            if (kind === 'error' && parsed.type === 'item.completed') {
              if (outcome.recordErrorEvent(item.message) === 'notice') {
                log.info('[CodexService] Codex emitted a non-fatal notice.');
              } else if (typeof item.message === 'string') {
                errorMessage = item.message;
              }
            }
            return;
          }
          if (parsed.type === 'turn.completed') {
            sawTerminalResult = true;
            outcome.recordCompletion();
            // Recorded once on close — codex can emit several usage events
            // per run (one per model call) and each carries cumulative totals.
            lastUsage = parsed.usage;
            return;
          }
          if (parsed.type === 'turn.failed') {
            outcome.recordTurnFailed();
            const msg = parsed.error?.message;
            if (typeof msg === 'string' && msg) errorMessage = msg;
            return;
          }
          if (parsed.type === 'error') {
            if (outcome.recordErrorEvent(parsed.message) === 'notice') {
              log.info('[CodexService] Codex emitted a non-fatal notice.');
            } else if (typeof parsed.message === 'string' && parsed.message) {
              errorMessage = parsed.message;
            }
            return;
          }
        }

        // ── Legacy event schema ({id, msg:{type,...}}) ───────────
        const msg = parsed?.msg;
        if (!msg || typeof msg.type !== 'string') return;

        switch (msg.type) {
        case 'session_configured':
          if (msg.session_id) capturedSessionId = msg.session_id;
          emitActivity('Session started — calling model', 'status');
          maybeInterruptForSteer();
          break;
        case 'agent_message_delta':
          if (typeof msg.delta === 'string') {
            if (!firstContentAt) firstContentAt = Date.now();
            if (!firstTextAt) { firstTextAt = Date.now(); logRunPhase() }
            sawDelta = true;
            textCollected += msg.delta;
            try { callbacks.onToken?.(msg.delta) } catch { /* ignore */ }
          }
          break;
        case 'agent_message':
          appendAgentMessage(typeof msg.message === 'string' ? msg.message : '');
          break;
        case 'exec_command_begin': {
          const cmd = Array.isArray(msg.command) ? msg.command.join(' ') : String(msg.command ?? '');
          emitActivity(cmd ? `$ ${ cmd }` : 'Running a shell command', 'tool');
          break;
        }
        case 'token_count':
          // Cumulative running total — keep the latest, record once on close.
          lastUsage = msg.info?.total_token_usage ?? msg.info;
          break;
        case 'task_complete':
          sawTerminalResult = true;
          outcome.recordCompletion();
          if (typeof msg.last_agent_message === 'string' && !textCollected.trim()) {
            appendAgentMessage(msg.last_agent_message);
          }
          break;
        case 'error':
          if (outcome.recordErrorEvent(msg.message) === 'notice') {
            log.info('[CodexService] Codex emitted a non-fatal notice.');
          } else if (typeof msg.message === 'string' && msg.message) {
            errorMessage = msg.message;
          }
          break;
        case 'stream_error':
          // Retryable — codex retries the model stream internally and the
          // turn can still succeed. Keep the message for context in case the
          // process later exits non-zero, but don't mark the run failed.
          if (typeof msg.message === 'string' && msg.message) errorMessage = msg.message;
          break;
        default:
          break;
        }
      };

      proc.stdout.on('data', (chunk) => {
        if (settled) return;
        liveness.touch();
        try { callbacks.onLiveness?.() } catch { /* liveness reporting is best-effort */ }
        stdoutBuffer += chunk.toString('utf-8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      proc.stderr.on('data', (chunk) => {
        if (settled) return;
        liveness.touch();
        let text = chunk.toString('utf-8');
        if (!codexPid && text.includes(CODEX_PID_MARKER)) {
          const m = new RegExp(`${ CODEX_PID_MARKER }(\\d+)\\s*`).exec(text);
          if (m) {
            codexPid = Number(m[1]);
            text = text.replace(m[0], '');
            maybeInterruptForSteer();
          }
        }
        stderrBuffer += text;
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        stopStallWatchdog();
        closeSteering(true);
        options.signal?.removeEventListener('abort', onAbort);
        cleanupMcp();
        failureDiagnostics.failure({ error: err, fault: 'spawn', conversationId: convId, runId: diagnosticRunId });
        if (capturedSessionId) this.setSession(convId, capturedSessionId).catch(() => {});
        const retrySafe = liveness.toolsInFlight === 0 && !unresolvedTool;
        const safety = retrySafe ? '' : ' Recovery was not attempted because a tool was still unresolved.';
        reject(new CliFaultError('spawn', `Codex process error: ${ err.message }.${ safety }`, err, retrySafe, !retrySafe));
      });

      proc.on('close', async(code, signal) => {
        logRunPhase();
        if (settled) return;
        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer);
          stdoutBuffer = '';
        }
        const awaitingForcedSettlement = !!terminationPromise && (options.signal?.aborted || stalled);
        stopStallWatchdog();
        options.signal?.removeEventListener('abort', onAbort);
        cleanupMcp();
        if (awaitingForcedSettlement) {
          closeSteering(true);
          return;
        }
        const persistenceError = await persistSession();
        if (persistenceError) {
          settled = true;
          closeSteering(true);
          reject(persistenceError);
          return;
        }
        settled = true;

        // Interrupted to deliver a steer — resume the same thread with it and
        // return this turn's text plus the steered continuation as one reply.
        const steered = steers.splice(0);
        closeSteering(false);
        if (steered.length && interruptSent && capturedSessionId && !options.signal?.aborted) {
          this.setSession(convId, capturedSessionId).catch(() => {});
          this.lastStableContextHash.set(convId, stableHash);
          if (lastUsage) recordUsage(lastUsage, this.getModel()).catch(() => { /* ignore */ });
          const lead = textCollected.trim() ? `${ textCollected }\n\n` : '';
          if (lead) {
            try { callbacks.onToken?.('\n\n') } catch { /* ignore */ }
          }
          log.log(`[CodexService] steering: resuming thread ${ capturedSessionId } with ${ steered.length } steer message(s) (convId=${ convId })`);
          // Carry this run's system messages: runCodex stages them as the
          // instructions file, and a resume without them throws before the
          // steer is delivered (which killed steered sub-agents).
          const systemMessages = messages.filter(m => m.role === 'system');
          const steerTurn: ChatMessage[] = [...systemMessages, { role: 'user', content: STEER_RESUME_NOTE } as ChatMessage, ...steered];
          this.runCodex(steerTurn, callbacks, options).then(
            r => resolve({ text: `${ lead }${ r.text }`, usage: r.usage }),
            reject,
          );
          return;
        }
        // Steers taken but never delivered (the run ended first) go back to
        // the graph, which runs another turn for them.
        for (const m of steered) markSteerPending(m);

        // Aborted by the caller (Stop, or a new/steering message superseding
        // this run) — report an abort, not a provider failure that would
        // trigger fallback and a user-facing error for a cancelled run.
        if (options.signal?.aborted) {
          const abortErr = new Error('Codex run aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
          return;
        }

        // Stall-watchdog kill — surface the exact rule violation instead of
        // falling through to the generic no-output message.
        if (stalled) {
          const stallError = new CliFaultError(
            'stall',
            stallErrorMessage(),
            undefined,
            false,
            unresolvedTool,
          );
          failureDiagnostics.failure({ error: stallError, fault: 'stall', conversationId: convId, runId: diagnosticRunId, exitCode: code, signal });
          reject(stallError);
          return;
        }

        // Binary missing — checked BEFORE the resume heuristic: sh's
        // "codex: not found" must not be mistaken for a dead thread (and the
        // session must survive so the conversation resumes once codex is
        // re-provisioned).
        if (code === 127) {
          failureDiagnostics.failure({ error: new Error('Codex spawn failed because CLI is not installed'), fault: 'process_exit', conversationId: convId, runId: diagnosticRunId, exitCode: code, signal });
          import('./providerRecovery').then(({ InfrastructureFailure }) => reject(new InfrastructureFailure('codex CLI is not installed in the VM yet. Restart Sulla Desktop to re-provision, or run: npm install --prefix /mnt/data/npm-global -g @openai/codex')));
          return;
        }

        // Resume failure (expired/missing thread, or an older codex without
        // the `exec resume` subcommand) — drop the cached id and retry once
        // with a fresh session so the user doesn't see a dead end. The match
        // deliberately omits generic words like 'session'/'not found':
        // sulla-runtime's SSH-mux noise ("mux_client_request_session ... Broken
        // pipe") lands in stderr and must not wipe a valid thread.
        const resumeFailed = existingSession && !retryWithoutSession && !sawToolExecution &&
          (outcome.fatal || code !== 0) &&
          /(?:failed|unable) to (?:load|resume|find).*(?:thread|rollout|conversation)|(?:thread|rollout|conversation).*(?:not found|does not exist|invalid|expired)|recorded with model .* resuming with/i.test(`${ errorMessage } ${ stderrBuffer.slice(-500) }`);
        if (resumeFailed) {
          const typedFailure = legacyProviderFailure('codex', errorMessage || stderrBuffer.trim().slice(-200) || 'Codex resume failed', { exitCode: code });
          if (signal) Object.assign(typedFailure, { signal });
          failureDiagnostics.retry(new CliFaultError('process_exit', 'Codex resume failed', typedFailure), 2, convId, diagnosticRunId);
          this.deleteSession(convId).then(() => this.runCodex(messages, callbacks, options, true)).then(
            r => resolve(r),
            reject,
          ).catch(reject);
          return;
        }

        if (capturedSessionId) {
          this.setSession(convId, capturedSessionId).catch(() => {});
        }

        if (outcome.fatal) {
          const msg = errorMessage || stderrBuffer.trim().slice(-200) || `codex exited with code ${ code }`;
          const typedFailure = legacyProviderFailure('codex', msg, { exitCode: code });
          if (signal) Object.assign(typedFailure, { signal });
          failureDiagnostics.failure({ error: typedFailure, fault: 'process_exit', conversationId: convId, runId: diagnosticRunId, exitCode: code, signal });
          reject(isPermanentCliFailure(typedFailure) && !(liveness.toolsInFlight > 0 || unresolvedTool)
            ? typedFailure
            : new CliFaultError('process_exit', `Codex: ${ msg }`, typedFailure, !(liveness.toolsInFlight > 0 || unresolvedTool), Boolean(liveness.toolsInFlight > 0 || unresolvedTool)));
          return;
        }

        if (code !== 0) {
          const msg = errorMessage || stderrBuffer.trim().slice(-200) || `codex exited with code ${ code }`;
          const typedFailure = legacyProviderFailure('codex', msg, { exitCode: code });
          if (signal) Object.assign(typedFailure, { signal });
          failureDiagnostics.failure({ error: typedFailure, fault: 'process_exit', conversationId: convId, runId: diagnosticRunId, exitCode: code, signal });
          const retrySafe = liveness.toolsInFlight === 0 && !unresolvedTool && !isPermanentCliFailure(typedFailure);
          const safety = retrySafe ? '' : ' Recovery was not attempted because a tool was still unresolved.';
          reject(!retrySafe && !(liveness.toolsInFlight > 0 || unresolvedTool)
            ? typedFailure
            : new CliFaultError('process_exit', `Codex: ${ msg }${ safety }`, typedFailure, retrySafe, !retrySafe && (liveness.toolsInFlight > 0 || unresolvedTool)));
          return;
        }

        if (!sawTerminalResult) {
          const retrySafe = liveness.toolsInFlight === 0 && !unresolvedTool;
          const protocolError = new CliFaultError('protocol', 'Codex exited before emitting a terminal completion event.', undefined, retrySafe, !retrySafe);
          failureDiagnostics.failure({ error: protocolError, fault: 'protocol', conversationId: convId, runId: diagnosticRunId, exitCode: code, signal });
          reject(protocolError);
          return;
        }

        if (!textCollected.trim()) {
          const stderrTail = stderrBuffer.trim().slice(-200);
          const typedFailure = legacyProviderFailure('codex', stderrTail || 'Codex returned no output', { exitCode: code });
          if (signal) Object.assign(typedFailure, { signal });
          failureDiagnostics.failure({ error: typedFailure, fault: 'protocol', conversationId: convId, runId: diagnosticRunId, exitCode: code, signal });
          const retrySafe = liveness.toolsInFlight === 0 && !unresolvedTool && !isPermanentCliFailure(typedFailure);
          const safety = retrySafe ? '' : ' Recovery was not attempted because a tool was still unresolved.';
          reject(!retrySafe && !(liveness.toolsInFlight > 0 || unresolvedTool)
            ? typedFailure
            : new CliFaultError('protocol', `Codex returned no output (exit code ${ code }). ${ stderrTail || 'Check credentials or VM status.' }${ safety }`, typedFailure, retrySafe, !retrySafe && (liveness.toolsInFlight > 0 || unresolvedTool)));
          return;
        }

        // Success: commit the stable-context hash (the context was actually
        // delivered) and record this run's final usage snapshot.
        this.lastStableContextHash.set(convId, stableHash);
        if (lastUsage) {
          recordUsage(lastUsage, this.getModel()).catch(() => { /* ignore */ });
        }

        log.log(`[CodexService] runCodex ok: ${ textCollected.length } chars, session=${ capturedSessionId ?? '(none)' }`);
        resolve({ text: textCollected, usage: lastUsage });
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Usage capture
// ─────────────────────────────────────────────────────────────

/**
 * Append a single usage sample from codex's turn.completed / token_count
 * events to the shared provider usage registry.
 */
async function recordUsage(usage: any, model: string): Promise<void> {
  if (!usage || typeof usage !== 'object') return;
  await recordCliUsage('codex', {
    input_tokens:        typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
    output_tokens:       typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
    cached_input_tokens: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : undefined,
    model,
  });
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
export function createCodexService(model: string, effort?: string): CodexService {
  const svc = new CodexService();
  svc.setModel(model);
  svc.setEffort(effort);
  return svc;
}

export function resetCodexService(): void {
  codexInstance = null;
}
