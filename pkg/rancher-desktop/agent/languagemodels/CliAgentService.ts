import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BaseLanguageModel, type ChatMessage, type NormalizedResponse, type StreamCallbacks, FinishReason, usageTokenTotal } from './BaseLanguageModel';
import { buildRemoteKillCommand, newRemotePidFile } from './claudeLaunchCommand';
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
  error?: string;
}

export interface CliAgentRunContext {
  existingSession?: string;
  mcpSession:        RegisteredSession | null;
  mcpConfigPath?:    string;
  systemPrompt:      string;
  model?:            string;
}

export interface CliAgentSpec {
  id:             string;
  name:           string;
  autoModel:      string;
  missingMessage: string;
  contextWindow:  number;
  systemPromptInUserMessage?: boolean;
  /** True when each event reports one step rather than a cumulative turn total. */
  accumulateUsage?: boolean;
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
    return this.runCli(messages, {}, options);
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
    const result = await this.runCli(messages, callbacks, options);
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
      HOME: os.homedir(),
      PATH: '$HOME/.local/bin:/mnt/data/npm-global/bin:$PATH',
      SULLA_TOOL_SESSION: mcpSession?.id ?? '',
      ...(this.spec.buildEnv?.(context) ?? {}),
    };
    const envAssignments = Object.entries(env).filter(([, value]) => value !== '').map(([key, value]) => {
      if (key === 'PATH') return `${ key }=${ value }`;
      return `${ key }=${ shq(value) }`;
    }).join(' ');
    const pidFile = newRemotePidFile(`sulla-${ this.spec.id }`);
    const innerCommand = `echo $$ > ${ shq(pidFile) }; export ${ envAssignments }; exec ${ args }`;
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
      let lastActivity = Date.now();
      let stopped = false;
      let watchdog: ReturnType<typeof setInterval> | undefined;

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
      const remoteKill = (signal: 'TERM' | 'KILL') => {
        try {
          const killer = childProcess.spawn(paths.limactl, ['shell', '0', '--', 'sh', '-c', buildRemoteKillCommand(pidFile, signal)], {
            env: { ...process.env, LIMA_HOME: paths.lima, TERM: 'dumb' }, stdio: 'ignore', detached: true,
          });
          killer.unref();
        } catch { /* process already exited */ }
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        try { proc.kill('SIGTERM') } catch { /* already exited */ }
        remoteKill('TERM');
        const escalation = setTimeout(() => remoteKill('KILL'), 5_000);
        escalation.unref?.();
      };
      const abort = () => stop();
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort);

      watchdog = setInterval(() => {
        if (Date.now() - lastActivity > STALL_TIMEOUT_MS) {
          errorMessage = `${ this.spec.name } stalled with no stream activity for 15 minutes.`;
          stop();
        }
      }, 30_000);
      watchdog.unref?.();

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try { parsed = JSON.parse(trimmed) } catch { return }
        const event = this.spec.parseEvent(parsed);
        if (event.sessionId) sessionId = event.sessionId;
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
        lastActivity = Date.now();
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });
      proc.stderr.on('data', chunk => {
        lastActivity = Date.now();
        stderrBuffer += chunk.toString('utf8');
      });
      proc.stdin.on('error', () => { /* early CLI exit */ });
      proc.stdin.end(prompt);

      proc.on('error', err => {
        cleanup();
        reject(err);
      });
      proc.on('close', code => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        cleanup();
        if (options.signal?.aborted) {
          const error = new Error(`${ this.spec.name } run aborted`);
          error.name = 'AbortError';
          reject(error);
          return;
        }

        const combinedError = `${ errorMessage } ${ stderrBuffer.slice(-1_000) }`.trim();
        if (existingSession && !retryWithoutSession && code !== 0 && this.spec.isResumeFailure?.(combinedError)) {
          this.deleteSession(conversationId).catch(() => {});
          this.runCli(messages, callbacks, options, true).then(resolve, reject);
          return;
        }
        if (code === 127) {
          reject(new Error(this.spec.missingMessage));
          return;
        }
        if (errorMessage || (code !== 0 && !text.trim())) {
          reject(new Error(`${ this.spec.name }: ${ combinedError || `exited with code ${ code }` }`));
          return;
        }
        if (!text.trim()) {
          reject(new Error(`${ this.spec.name } returned no text. ${ stderrBuffer.trim().slice(-300) }`));
          return;
        }
        if (sessionId) this.setSession(conversationId, sessionId).catch(() => {});
        recordEngineUsage(this.spec.id, usage, this.getModel(), Date.now() - started).catch(() => {});
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
