import { AsyncLocalStorage } from 'node:async_hooks';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildRemoteKillCommand } from './claudeLaunchCommand';

import paths from '@pkg/utils/paths';

import type { BaseThreadState } from '../nodes/Graph';

export type ProviderRuntime = 'lima' | 'container';
export type ProviderName = 'claude-code' | 'codex';

/**
 * Authentication is deliberately opaque at the transport boundary. Container
 * transports must broker provider authentication themselves; provider
 * services never receive a credential file or token to copy into a container.
 */
export type ProviderTransportAuth =
  | { kind: 'lima-host' }
  | { kind: 'broker'; opaqueConfigRef: string };

export interface ProviderCliOpaqueConfig {
  opaqueConfigRef: string;
  baseUrl:         string;
  environment:     Readonly<Record<string, string>>;
  codexConfigOverrides?: readonly string[];
}

export interface ProviderCliToolConfig {
  opaqueConfigRef: string;
  claudeConfigPath?: string;
  codexConfigOverrides?: readonly string[];
}

export interface ProviderTransportContext {
  runtime:        ProviderRuntime;
  provider:       ProviderName;
  conversationId: string;
  workspaceRoot?: string;
  auth:           ProviderTransportAuth;
  session?: {
    providerSessionId?:       string;
    toolSessionId?:           string;
    /** Provider-visible broker material; Desktop treats both as opaque. */
    opaqueProviderConfigRef?: string;
    opaqueToolConfigRef?:     string;
    providerConfig?:          ProviderCliOpaqueConfig;
    toolConfig?:              ProviderCliToolConfig;
  };
}

export interface ProviderCommand {
  executable: string;
  args:       string[];
  /** Capability-only additions. Container adapters must never merge Desktop process.env. */
  env?:       NodeJS.ProcessEnv;
  cwd?:       string;
}

export interface ProviderProcessLaunch {
  context:         ProviderTransportContext;
  /** Canonical provider command. A container transport executes this form. */
  providerCommand: ProviderCommand;
  /** Existing Desktop/Lima launch. Omitted entirely for container requests. */
  limaCommand?:    ProviderCommand;
  stdio?:          childProcess.StdioOptions;
}

export interface ProviderTerminationRequest {
  context:        ProviderTransportContext;
  process:        childProcess.ChildProcessWithoutNullStreams;
  signal:         'TERM' | 'KILL' | 'INT';
  remotePidFile?: string;
  remotePid?:     number;
}

export type ProviderFilePurpose = 'attachment' | 'mcp-config' | 'system-prompt';

export interface ProviderFileRequest {
  context:       ProviderTransportContext;
  purpose:       ProviderFilePurpose;
  suggestedName: string;
  data:          string | Buffer;
  mode?:         number;
}

export interface ProviderFileRef {
  /** Path as seen by the provider process, not necessarily the Desktop path. */
  path: string;
  dispose(): void;
}

export interface ProviderFileTransport {
  write(request: ProviderFileRequest): ProviderFileRef;
}

/**
 * Process/file/session seam used by the canonical Desktop provider loop.
 * Implementations may relocate CLI execution, but may not parse or reinterpret
 * provider output: ClaudeCodeService and CodexService remain the sole parsers.
 */
export interface ProviderExecutionTransport {
  readonly runtime: ProviderRuntime;
  context(input: {
    provider:           ProviderName;
    conversationId:     string;
    state?:             BaseThreadState;
    providerSessionId?: string;
    toolSessionId?:     string;
  }): ProviderTransportContext | Promise<ProviderTransportContext>;
  spawn(request: ProviderProcessLaunch): childProcess.ChildProcessWithoutNullStreams;
  terminate(request: ProviderTerminationRequest): void | Promise<void>;
  readonly files: ProviderFileTransport;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    throw new Error(`Provider file escaped its bounded workspace: ${ candidate }`);
  }
}

class LimaProviderFileTransport implements ProviderFileTransport {
  write(request: ProviderFileRequest): ProviderFileRef {
    const root = path.join(paths.sullaHome, 'workspaces', 'provider-transport');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(root, 'file-'));
    fs.chmodSync(dir, 0o700);
    const safeName = request.suggestedName.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const target = path.join(dir, safeName || 'provider-file');
    assertInside(dir, target);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, request.mode ?? 0o600);
    try {
      fs.writeFileSync(fd, request.data);
    } finally {
      fs.closeSync(fd);
    }
    let disposed = false;

    return {
      path: target,
      dispose() {
        if (disposed) return;
        disposed = true;
        try { fs.unlinkSync(target) } catch { /* already removed */ }
        try { fs.rmdirSync(dir) } catch { /* non-empty or already removed */ }
      },
    };
  }
}

class LimaProviderExecutionTransport implements ProviderExecutionTransport {
  readonly runtime = 'lima' as const;
  readonly files = new LimaProviderFileTransport();

  context(input: Parameters<ProviderExecutionTransport['context']>[0]): ProviderTransportContext {
    return {
      runtime:        'lima',
      provider:       input.provider,
      conversationId: input.conversationId,
      auth:           { kind: 'lima-host' },
      session:        {
        providerSessionId: input.providerSessionId,
        toolSessionId:     input.toolSessionId,
      },
    };
  }

  spawn(request: ProviderProcessLaunch): childProcess.ChildProcessWithoutNullStreams {
    const command = request.limaCommand;
    if (!command) throw new Error('Lima provider transport requires a Lima launch command');

    return childProcess.spawn(command.executable, command.args, {
      cwd:   command.cwd,
      env:   command.env,
      stdio: request.stdio,
    }) as childProcess.ChildProcessWithoutNullStreams;
  }

  terminate(request: ProviderTerminationRequest): Promise<void> | void {
    const remoteCommand = request.remotePidFile
      ? buildRemoteKillCommand(request.remotePidFile, request.signal === 'INT' ? 'TERM' : request.signal)
      : request.remotePid
        ? `kill -${ request.signal } ${ request.remotePid }`
        : '';
    if (!remoteCommand) {
      try { request.process.kill(`SIG${ request.signal }`) } catch { /* already dead */ }
      return;
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const proc = childProcess.spawn(paths.limactl, ['shell', '0', '--', 'sh', '-c', remoteCommand], {
          env:      { ...process.env, LIMA_HOME: paths.lima, TERM: 'dumb' },
          stdio:    'ignore',
          detached: true,
        });
        proc.once('error', finish);
        proc.once('close', finish);
        proc.unref();
      } catch {
        finish();
      }
    });
  }
}

const transportScope = new AsyncLocalStorage<ProviderExecutionTransport>();
const limaTransport = new LimaProviderExecutionTransport();

/** Bind one lifecycle-owned transport to a canonical Desktop graph execution. */
export function withProviderExecutionTransport<T>(transport: ProviderExecutionTransport, action: () => T): T {
  return transportScope.run(transport, action);
}

/** VM behavior remains the default until the container lifecycle owner opts in. */
export function getProviderExecutionTransport(): ProviderExecutionTransport {
  return transportScope.getStore() ?? limaTransport;
}

export function requireBrokeredContainerAuth(context: ProviderTransportContext): ProviderCliOpaqueConfig | undefined {
  if (context.runtime !== 'container') return undefined;
  if (context.auth.kind !== 'broker' || !context.auth.opaqueConfigRef.trim()) {
    throw new Error(`Container ${ context.provider } execution requires opaque broker authentication`);
  }
  const config = context.session?.providerConfig;
  if (!config || config.opaqueConfigRef !== context.auth.opaqueConfigRef ||
      context.session?.opaqueProviderConfigRef !== config.opaqueConfigRef) {
    throw new Error(`Container ${ context.provider } execution requires a matching opaque provider config`);
  }
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error(`Container ${ context.provider } broker returned an invalid base URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Container ${ context.provider } broker returned an unsupported base URL`);
  }

  const keys = Object.keys(config.environment).sort();
  const allowed = context.provider === 'codex'
    ? ['SULLA_PROVIDER_BRIDGE_TOKEN']
    : ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index]) ||
      keys.some(key => !config.environment[key])) {
    throw new Error(`Container ${ context.provider } broker environment violates the provider allowlist`);
  }
  if (context.provider === 'claude-code' && config.environment.ANTHROPIC_BASE_URL !== config.baseUrl) {
    throw new Error('Container Claude broker base URL mismatch');
  }
  if (context.provider === 'codex' && !parsed.pathname.endsWith('/v1')) {
    throw new Error('Container Codex broker base URL must end in /v1');
  }
  if (context.provider === 'codex' &&
      (!config.codexConfigOverrides?.length || config.codexConfigOverrides.some(value => !value || /[\r\n\0]/.test(value)))) {
    throw new Error('Container Codex broker must provide bounded config overrides');
  }
  if (context.provider === 'claude-code' && config.codexConfigOverrides?.length) {
    throw new Error('Container Claude broker returned Codex-only configuration');
  }

  return config;
}

export function requireContainerToolConfig(context: ProviderTransportContext): ProviderCliToolConfig | undefined {
  if (context.runtime !== 'container') return undefined;
  const config = context.session?.toolConfig;
  if (!config || !context.session?.opaqueToolConfigRef ||
      config.opaqueConfigRef !== context.session.opaqueToolConfigRef) {
    throw new Error(`Container ${ context.provider } execution requires a matching opaque tool config`);
  }
  if (context.provider === 'claude-code') {
    if (!config.claudeConfigPath || config.codexConfigOverrides?.length) {
      throw new Error('Container Claude tool config requires a provider-visible MCP config path');
    }
  } else if (!config.codexConfigOverrides?.length || config.claudeConfigPath ||
      config.codexConfigOverrides.some(value => !value || /[\r\n\0]/.test(value))) {
    throw new Error('Container Codex tool config requires bounded MCP config overrides');
  }

  return config;
}
