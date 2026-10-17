import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason, usageTokenTotal } from './BaseLanguageModel';
import { buildRemoteKillCommand, buildRemotePidRecordCommand, newRemotePidFile } from './claudeLaunchCommand';
import { CliFaultError, isPermanentCliFailure, recoveryMessages, runWithCliFaultRecovery, terminateCliChild, waitForKillHelper } from './cliFaultRecovery';
import { systemPromptFromMessages } from './cliSystemPromptFile';
import { redisClient } from '../database/RedisClient';
import { prepareWorkerTurnPrompt } from '../tools/agents/workerMessaging';
import { recordCliUsage } from '../usage/providerUsage';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import { getMCPServerHost, type RegisteredSession } from '@pkg/main/MCPServerHost';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

const log = Logging.background;
const MCP_SESSION_TTL_MS = 4 * 60 * 60_000 + 30 * 60_000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STALL_TIMEOUT_MS = 15 * 60_000;

export interface CliAgentEventResult {
  text?:      string;
  terminal?:  boolean;
  sessionId?: string;
  usage?:     Record<string, unknown>;
  activity?:  string;
  toolEvent?: {
    toolUseId:   string;
    toolName:    string;
    input?:      unknown;
    resultChars: number;
    isError?:    boolean;
  };
  toolState?: {
    toolUseId: string;
    toolName:  string;
    status:    'started' | 'completed';
  };
  error?: string;
}

export interface CliAgentRunContext {
  existingSession?: string;
  mcpSession:       RegisteredSession | null;
  mcpConfigPath?:   string;
  systemPrompt:     string;
  model?:           string;
}

export interface CliAgentSpec {
  id:                         string;
  name:                       string;
  autoModel:                  string;
  missingMessage:             string;
  contextWindow:              number;
  systemPromptInUserMessage?: boolean;
  /** True when each event reports one step rather than a cumulative turn total. */
  accumulateUsage?:           boolean;
  buildArgs(context: CliAgentRunContext): string[];
  buildEnv?(context: CliAgentRunContext): Record<string, string>;
  parseEvent(event: any): CliAgentEventResult;
  writeMcpConfig?(session: RegisteredSession): string;
  isResumeFailure?(message: string): boolean;
}

function shq(value: string): string {
  return `'${ value.replace(/'/g, "'\\''") }'`;
}

function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((block: any) => {
    if (block?.type === 'text') return String(block.text ?? '');
    if (block?.type === 'tool_result') return typeof block.content === 'string' ? block.content : contentText(block.content);
    if (block?.type === 'tool_use') return `[tool_use ${ block.name ?? 'tool' } ${ JSON.stringify(block.input ?? {}) }]`;
    if (block?.type === 'image') return '[Image attachment is present in the Sulla conversation.]';
    return '';
  }).filter(Boolean).join('\n');
}

function fullTranscript(messages: ChatMessage[]): string {
  return messages
    .filter(message => message.role !== 'system')
    .map(message => {
      const text = contentText(message.content).trim();
      if (!text) return '';
      const label = message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : 'Tool';
      return `${ label }:\n${ text }`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function latestTurn(messages: ChatMessage[]): string {
  const turns: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') {
      if (turns.length) break;
      continue;
    }
    const text = contentText(message.content).trim();
    if (text) turns.unshift(`User:\n${ text }`);
  }
  return turns.join('\n\n') || fullTranscript(messages);
}

function numeric(source: any, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

async function recordEngineUsage(providerId: string, usage: any, model: string, durationMs: number): Promise<void> {
  if (!usage || typeof usage !== 'object') return;
  await recordCliUsage(providerId, {
    duration_ms:                 numeric(usage, 'duration_ms') ?? durationMs,
    input_tokens:                numeric(usage, 'input_tokens', 'input'),
    output_tokens:               numeric(usage, 'output_tokens', 'output'),
    cached_input_tokens:         numeric(usage, 'cached_input_tokens', 'cached'),
    cache_creation_input_tokens: numeric(usage, 'cache_creation_input_tokens', 'cache_write'),
    cache_read_input_tokens:     numeric(usage, 'cache_read_input_tokens', 'cache_read'),
    cost_usd:                    numeric(usage, 'cost_usd', 'cost'),
    model,
  });
}

/**
 * Shared process/session lifecycle for JSON-streaming coding CLIs.
 * Provider subclasses only describe argv/env and normalize one JSONL event.
 */
export class CliAgentService extends BaseLanguageModel {
  private readonly sessions = new Map<string, string>();

  constructor(protected readonly spec: CliAgentSpec) {
    super({ id: spec.id, model: spec.autoModel, baseUrl: 'local-vm' });
  }

  override getProviderName(): string {
    return this.spec.name;
  }

  override getModel(): string {
    return this.model || this.spec.autoModel;
  }

  override getContextWindow(): number {
    return this.spec.contextWindow;
  }

  protected async healthCheck(): Promise<boolean> {
    return true;
  }

  protected async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    return runWithCliFaultRecovery(this.spec.name, attempt => this.runCli(attempt === 1 ? messages : recoveryMessages(messages), {}, options), {
      signal:   options.signal,
      canRetry: () => true,
      onRetry:  (_error, attempt) => log.warn(`[${ this.spec.name }] retrying failed CLI process (attempt ${ attempt })`),
    });
  }

  protected normalizeResponse(raw: any): NormalizedResponse {
    return this.toResponse(raw, 0);
  }

  override async chatStream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options: { signal?: AbortSignal; conversationId?: string; profileId?: string; usageEventId?: string; state?: BaseThreadState | any } = {},
  ): Promise<NormalizedResponse | null> {
    const started = performance.now();
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
    const result = await runWithCliFaultRecovery(this.spec.name, attempt => this.runCli(attempt === 1 ? messages : recoveryMessages(messages), guardedCallbacks, options), {
      signal:   options.signal,
      canRetry: () => true,
      onRetry:  (_error, attempt) => log.warn(`[${ this.spec.name }] retrying failed CLI process (attempt ${ attempt })`),
    });
    if (streamedText) result.text = streamedText;
    const response = this.toResponse(result, Math.round(performance.now() - started));
    await this.recordMeterableTokens(response, options.profileId, options.usageEventId, this.usageEventId(messages, options, this.getModel()));
    return response;
  }

  private toResponse(raw: any, durationMs: number): NormalizedResponse {
    const usage = raw?.usage ?? {};
    const normalizedUsage = {
      input_tokens:        numeric(usage, 'input_tokens', 'input') ?? 0,
      output_tokens:       numeric(usage, 'output_tokens', 'output') ?? 0,
      cached_input_tokens: numeric(usage, 'cached_input_tokens', 'cached') ?? 0,
    };
    return {
      content:  raw?.text ?? '',
      metadata: {
        tokens_used:       usageTokenTotal(normalizedUsage),
        time_spent:        durationMs,
        prompt_tokens:     normalizedUsage.input_tokens,
        completion_tokens: normalizedUsage.output_tokens,
        model:             this.getModel(),
        finish_reason:     FinishReason.Stop,
      },
    };
  }

  private async getSession(conversationId: string): Promise<string | undefined> {
    const cached = this.sessions.get(conversationId);
    if (cached) return cached;
    try {
      const stored = await redisClient.get(`${ this.spec.id }_session:${ conversationId }`);
      if (stored) this.sessions.set(conversationId, stored);
      return stored || undefined;
    } catch { return undefined }
  }

  private async setSession(conversationId: string, sessionId: string): Promise<void> {
    this.sessions.set(conversationId, sessionId);
    try { await redisClient.set(`${ this.spec.id }_session:${ conversationId }`, sessionId, SESSION_TTL_SECONDS) } catch { /* memory-only fallback */ }
  }

  private async deleteSession(conversationId: string): Promise<void> {
    this.sessions.delete(conversationId);
    try { await redisClient.del(`${ this.spec.id }_session:${ conversationId }`) } catch { /* non-fatal */ }
  }

  private registerMcpSession(state?: BaseThreadState): RegisteredSession | null {
    if (!state) return null;
    try {
      const host = getMCPServerHost();
      return host.running ? host.registerSession(state, MCP_SESSION_TTL_MS) : null;
    } catch (err) {
      log.warn(`[${ this.spec.name }] MCP session unavailable: ${ (err as Error)?.message ?? err }`);
      return null;
    }
  }

  private async runCli(
    messages: ChatMessage[],
    callbacks: Partial<StreamCallbacks>,
    options: { signal?: AbortSignal; conversationId?: string; state?: BaseThreadState },
    retryWithoutSession = false,
  ): Promise<{ text: string; usage?: any }> {
    if (process.platform === 'win32') {
      throw new Error(`${ this.spec.name } requires the Lima VM, which is not available on Windows yet.`);
    }

    const conversationId = options.conversationId ?? '__default__';
    const existingSession = retryWithoutSession ? undefined : await this.getSession(conversationId);
    const rawPrompt = existingSession ? latestTurn(messages) : fullTranscript(messages);
    if (!rawPrompt.trim()) throw new Error(`${ this.spec.name } received no extractable prompt.`);

    const systemPrompt = systemPromptFromMessages(messages);
    const workerPrompt = await prepareWorkerTurnPrompt(options.state, rawPrompt);
    if (options.signal?.aborted) {
      const error = new Error(`${ this.spec.name } run aborted`);
      error.name = 'AbortError';
      throw error;
    }
    const prompt = this.spec.systemPromptInUserMessage && systemPrompt
      ? `<system_instructions>\n${ systemPrompt }\n</system_instructions>\n\n${ workerPrompt }`
      : workerPrompt;
    const mcpSession = this.registerMcpSession(options.state);
    const context: CliAgentRunContext = {
      existingSession,
      mcpSession,
      systemPrompt,
      model: this.model && this.model !== this.spec.autoModel ? this.model : undefined,
    };
    let mcpConfigPath: string | null = null;
    if (mcpSession && this.spec.writeMcpConfig) {
      mcpConfigPath = this.spec.writeMcpConfig(mcpSession);
      context.mcpConfigPath = mcpConfigPath;
    }

    const args = this.spec.buildArgs(context).map(shq).join(' ');
    const env = {
      HOME:               os.homedir(),
      PATH:               '$HOME/.local/bin:/mnt/data/npm-global/bin:$PATH',
      SULLA_TOOL_SESSION: mcpSession?.id ?? '',
      ...(this.spec.buildEnv?.(context) ?? {}),
    };
    const envAssignments = Object.entries(env).filter(([, value]) => value !== '').map(([key, value]) => {
      if (key === 'PATH') return `${ key }=${ value }`;
      return `${ key }=${ shq(value) }`;
    }).join(' ');
    const pidFile = newRemotePidFile(`sulla-${ this.spec.id }`);
    const innerCommand = `${ buildRemotePidRecordCommand(pidFile) }; export ${ envAssignments }; exec ${ args }`;
    const proc = childProcess.spawn(paths.limactl, ['shell', '0', '--', 'sh', '-c', innerCommand], {
      env: { ...process.env, LIMA_HOME: paths.lima, TERM: 'dumb' },
    });

    return await new Promise((resolve, reject) => {
      const started = Date.now();
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let text = '';
      let sessionId = existingSession;
      let usage: any = null;
      let errorMessage = '';
      let sawTerminalResult = false;
      let lastActivity = Date.now();
      let stopped = false;
      let settled = false;
      const activeToolEvents = new Map<string, { startedAt: number }>();
      let sawToolExecution = false;
      let unresolvedTool = false;
      // Initialized after setup; keep this mutable so cleanup also works if AbortSignal fires before the timer starts.
      // eslint-disable-next-line prefer-const
      let watchdog: ReturnType<typeof setInterval> | undefined;
      let terminationPromise: Promise<void> | undefined;

      const cleanup = () => {
        try { mcpSession?.revoke() } catch { /* already revoked */ }
        if (mcpConfigPath) {
          try {
            const stat = fs.statSync(mcpConfigPath);
            if (stat.isDirectory()) fs.rmSync(mcpConfigPath, { recursive: true });
            else fs.unlinkSync(mcpConfigPath);
          } catch { /* already gone */ }
        }
        options.signal?.removeEventListener('abort', abort);
        if (watchdog) clearInterval(watchdog);
      };
      const remoteKill = async(signal: 'TERM' | 'KILL') => {
        const killer = childProcess.spawn(paths.limactl, ['shell', '0', '--', 'sh', '-c', buildRemoteKillCommand(pidFile, signal)], {
          env: { ...process.env, LIMA_HOME: paths.lima, TERM: 'dumb' }, stdio: 'ignore', detached: true,
        });
        killer.unref();
        await waitForKillHelper(killer);
      };
      const stop = () => {
        if (terminationPromise) return terminationPromise;
        stopped = true;
        try { mcpSession?.revoke() } catch { /* already revoked */ }
        terminationPromise = terminateCliChild(proc, remoteKill);
        return terminationPromise;
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => {
        const rejectAbort = () => {
          const error = new Error(`${ this.spec.name } run aborted`);
          error.name = 'AbortError';
          rejectOnce(error);
        };
        stop().then(rejectAbort, rejectAbort);
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort);

      if (stopped) return;

      watchdog = setInterval(() => {
        const silentMs = Date.now() - lastActivity;
        if (silentMs < STALL_TIMEOUT_MS) return;
        if (activeToolEvents.size > 0) {
          const tools = [...activeToolEvents.values()];
          if (tools.every(tool => Date.now() - tool.startedAt < 30 * 60_000)) return;
          unresolvedTool = true;
          errorMessage = `${ this.spec.name } stopped reporting activity while a tool was unresolved.`;
          stop().then(() => {
            proc.removeAllListeners('error');
            proc.on('error', () => { /* late child error after forced teardown */ });
            if (sessionId) this.setSession(conversationId, sessionId).catch(() => {});
            rejectOnce(new CliFaultError('stall', `${ errorMessage } Recovery was not attempted because replay could duplicate side effects.`, undefined, false, true));
          }, error => rejectOnce(error instanceof Error ? error : new CliFaultError('transport', String(error), error, false)));
          return;
        }
        if (silentMs > STALL_TIMEOUT_MS) {
          errorMessage = `${ this.spec.name } stalled with no stream activity for 15 minutes.`;
          stop().then(() => {
            proc.removeAllListeners('error');
            proc.on('error', () => { /* late child error after forced teardown */ });
            if (sessionId) this.setSession(conversationId, sessionId).catch(() => {});
            rejectOnce(new CliFaultError('stall', errorMessage));
          }, error => rejectOnce(error instanceof Error ? error : new CliFaultError('transport', String(error), error, false)));
        }
      }, 30_000);
      watchdog.unref?.();

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try { parsed = JSON.parse(trimmed) } catch { return }
        const event = this.spec.parseEvent(parsed);
        if (event.toolState?.toolUseId) {
          if (event.toolState.status === 'completed') activeToolEvents.delete(event.toolState.toolUseId);
          else {
            sawToolExecution = true;
            activeToolEvents.set(event.toolState.toolUseId, { startedAt: Date.now() });
          }
        }
        if (event.sessionId) sessionId = event.sessionId;
        if (event.terminal) sawTerminalResult = true;
        if (event.usage) {
          if (this.spec.accumulateUsage) {
            usage ??= {};
            for (const [key, value] of Object.entries(event.usage)) {
              if (typeof value === 'number' && Number.isFinite(value)) {
                usage[key] = (typeof usage[key] === 'number' ? usage[key] : 0) + value;
              } else if (value !== undefined) {
                usage[key] = value;
              }
            }
          } else {
            usage = event.usage;
          }
        }
        if (event.error) errorMessage = event.error;
        if (event.activity) {
          try { callbacks.onActivity?.(event.activity) } catch { /* UI callback */ }
        }
        if (event.toolEvent) {
          try { callbacks.onToolEvent?.(event.toolEvent) } catch { /* UI callback */ }
        }
        if (event.text) {
          text += event.text;
          try { callbacks.onToken?.(event.text) } catch { /* UI callback */ }
        }
      };

      proc.stdout.on('data', chunk => {
        if (settled) return;
        lastActivity = Date.now();
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });
      proc.stderr.on('data', chunk => {
        if (settled) return;
        lastActivity = Date.now();
        stderrBuffer += chunk.toString('utf8');
      });
      proc.stdin.on('error', () => { /* early CLI exit */ });
      proc.stdin.end(prompt);

      proc.on('error', async(err) => {
        if (sessionId) {
          try { await this.setSession(conversationId, sessionId) } catch (error) {
            rejectOnce(new CliFaultError('transport', `${ this.spec.name } session state could not be persisted safely.`, error, false, true));
            return;
          }
        }
        const retrySafe = activeToolEvents.size === 0 && !unresolvedTool;
        const safety = retrySafe ? '' : ' Recovery was not attempted because a tool or approval was still unresolved.';
        rejectOnce(new CliFaultError('spawn', `${ this.spec.name } process error: ${ err.message }.${ safety }`, err, retrySafe, !retrySafe));
      });
      proc.on('close', async(code) => {
        if (settled) return;
        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer);
          stdoutBuffer = '';
        }
        if (terminationPromise && (options.signal?.aborted || errorMessage)) {
          options.signal?.removeEventListener('abort', abort);
          if (watchdog) clearInterval(watchdog);
          try { mcpSession?.revoke() } catch { /* already revoked */ }
          if (mcpConfigPath) {
            try {
              const stat = fs.statSync(mcpConfigPath);
              if (stat.isDirectory()) fs.rmSync(mcpConfigPath, { recursive: true });
              else fs.unlinkSync(mcpConfigPath);
            } catch { /* already gone */ }
          }
          proc.removeAllListeners('error');
          proc.on('error', () => { /* late child error after termination */ });
          if (sessionId) {
            try { await this.setSession(conversationId, sessionId) } catch (error) {
              rejectOnce(new CliFaultError('transport', `${ this.spec.name } session state could not be persisted safely.`, error, false, true));
            }
          }
          return;
        }
        settled = true;
        cleanup();
        if (options.signal?.aborted) {
          const error = new Error(`${ this.spec.name } run aborted`);
          error.name = 'AbortError';
          reject(error);
          return;
        }

        const combinedError = `${ errorMessage } ${ stderrBuffer.slice(-1_000) }`.trim();
        if (sessionId) {
          try { await this.setSession(conversationId, sessionId) } catch (error) {
            reject(new CliFaultError('transport', `${ this.spec.name } session state could not be persisted safely.`, error, false, true));
            return;
          }
        }
        if (existingSession && !retryWithoutSession && !sawToolExecution && code !== 0 && this.spec.isResumeFailure?.(combinedError)) {
          this.deleteSession(conversationId).then(() => this.runCli(messages, callbacks, options, true)).then(resolve, reject);
          return;
        }
        if (code === 127) {
          reject(new Error(this.spec.missingMessage));
          return;
        }
        if (errorMessage || code !== 0) {
          const message = `${ this.spec.name }: ${ combinedError || `exited with code ${ code }` }`;
          if (/unauthorized|invalid api key|credential|quota|usage balance|weekly limit|session limit|rate limit|too many requests/i.test(combinedError)) {
            reject(new Error(message));
          } else {
            const retrySafe = activeToolEvents.size === 0 && !unresolvedTool && !isPermanentCliFailure(combinedError);
            const safety = retrySafe ? '' : ' Recovery was not attempted because a tool or approval was still unresolved.';
            reject(new CliFaultError(errorMessage.includes('stalled') ? 'stall' : 'process_exit', `${ message }${ safety }`, undefined, retrySafe, !retrySafe && (activeToolEvents.size > 0 || unresolvedTool)));
          }
          return;
        }
        if (!sawTerminalResult) {
          const retrySafe = activeToolEvents.size === 0 && !unresolvedTool;
          reject(new CliFaultError('protocol', `${ this.spec.name } exited before emitting a terminal result event.`, undefined, retrySafe, !retrySafe));
          return;
        }
        if (!text.trim()) {
          const retrySafe = activeToolEvents.size === 0 && !unresolvedTool && !isPermanentCliFailure(stderrBuffer);
          const safety = retrySafe ? '' : ' Recovery was not attempted because a tool was still unresolved.';
          reject(new CliFaultError('protocol', `${ this.spec.name } returned no text. ${ stderrBuffer.trim().slice(-300) }${ safety }`, undefined, retrySafe, !retrySafe && (activeToolEvents.size > 0 || unresolvedTool)));
          return;
        }
        recordEngineUsage(this.spec.id, usage, this.getModel(), Date.now() - started).catch(() => {});
        settled = true;
        resolve({ text, usage });
      });
    });
  }
}

/** A short-lived Cursor plugin is its supported per-process MCP config surface. */
export function writeCursorMcpPlugin(session: RegisteredSession): string {
  const dir = path.join(paths.sullaConfig, 'mcp-configs', `cursor-${ session.id }`);
  const manifestDir = path.join(dir, '.cursor-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify({
    name:        'sulla-native',
    version:     '1.0.0',
    description: 'Sulla Desktop graph-bound tools',
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      'sulla-native': {
        url:     session.url,
        headers: { Authorization: session.header },
      },
    },
  }), { mode: 0o600 });
  return dir;
}
