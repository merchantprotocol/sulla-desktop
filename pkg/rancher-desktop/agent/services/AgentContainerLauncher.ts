import * as childProcess from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';

import Electron from 'electron';

import { AgentContainerCleanupOwner } from './AgentContainerCleanup';
import { registerAgentContainerRuntime, requireAgentContainerRuntime, withAgentContainerRuntime } from './AgentContainerRuntimeRegistry';
import { getIntegrationService } from './IntegrationService';
import { RunActivity } from './RunActivity';
import { getWebSocketClientService } from './WebSocketClientService';
import {
  createProviderCliBridge,
  getLocalVaultPrincipalId,
  usesContainerVaultAuthority,
  type ProviderCliAuthMode,
  type ProviderCliBridgeLease,
} from '../../vault-broker';
import { redisClient } from '../database/RedisClient';
import {
  withProviderExecutionTransport,
  type ProviderExecutionTransport,
  type ProviderFileRef,
  type ProviderFileRequest,
  type ProviderName,
  type ProviderTransportContext,
} from '../languagemodels/ProviderExecutionTransport';
import { onSteer, steerText } from '../utils/steerChannel';
import { stripProtocolTagsStreaming } from '../utils/stripProtocolTags';
import { resolveSullaDocsDir } from '../utils/sullaPaths';

import { resolveSullaServiceImage } from '@pkg/backend/sullaServiceImages';
import { getMCPServerHost } from '@pkg/main/MCPServerHost';
import { getChatCompletionsServer } from '@pkg/main/chatCompletionsServer';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { deriveCapabilitySigningKey, issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import type { ContainerRuntimeDriver, ContainerSpec } from '@pkg/runtime/containerRuntime';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

import type { BaseThreadState } from '../nodes/Graph';

const log = Logging.background;
const IDLE_MS = 30 * 60_000;
const MEMORY = process.env.SULLA_AGENT_MEMORY ?? '4g';
const CPUS = process.env.SULLA_AGENT_CPUS ?? '2';
const LEASE_MS = 15 * 60_000;
const RENEW_MS = 5 * 60_000;
const CONTAINER_UID = typeof process.getuid === 'function' ? process.getuid() : 10_001;
const CONTAINER_GID = typeof process.getgid === 'function' ? process.getgid() : 10_001;
const cleanupOwner = new AgentContainerCleanupOwner(message => log.error(`[AgentContainer] ${ message }`));

export interface AgentContainerRun {
  jobId:          string;
  taskIndex:      number;
  provider:       string;
  model?:         string | null;
  prompt:         string;
  instructions:   string;
  /** Explicit existing worktree used only to seed this job's isolated clone. */
  workspacePath?: string;
  state:          BaseThreadState;
  signal?:        AbortSignal;
}

export interface AgentContainerResult {
  output:        string;
  containerName: string;
}

export interface AgentContainerLifecycle {
  readonly containerName: string;
  readonly workspacePath: string;
  execute<T>(action: () => T): T;
  close(): Promise<void>;
}

export type AgentContainerLifecycleRun = Omit<AgentContainerRun, 'prompt' | 'instructions'>;

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
}

function limactl(args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(paths.limactl, ['shell', '0', '--', ...args], {
      env:   { ...process.env, LIMA_HOME: paths.lima },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += String(chunk) });
    proc.stderr.on('data', chunk => { stderr += String(chunk) });
    proc.once('error', reject);
    proc.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `limactl exited ${ code }`)));
    if (input !== undefined) proc.stdin.end(input);
    else proc.stdin.end();
  });
}

/** Docker runtime adapter for Electron, whose Docker daemon lives in Lima. */
class LimaDockerRuntimeDriver implements ContainerRuntimeDriver {
  async create(spec: ContainerSpec): Promise<string> {
    const args = ['docker', 'create'];
    if (spec.autoRemove) args.push('--rm');
    if (spec.stdinOpen) args.push('--interactive');
    args.push('--name', spec.name);
    for (const [key, value] of Object.entries(spec.labels ?? {})) args.push('--label', `${ key }=${ value }`);
    for (const host of spec.extraHosts ?? []) args.push('--add-host', host);
    if (spec.memoryLimit) args.push('--memory', spec.memoryLimit);
    if (spec.cpuLimit) args.push('--cpus', spec.cpuLimit);
    if (spec.envFile) args.push('--env-file', spec.envFile);
    for (const [key, value] of Object.entries(spec.env ?? {})) args.push('--env', `${ key }=${ value }`);
    for (const bind of spec.binds ?? []) args.push('--volume', bind);
    for (const [target, options] of Object.entries(spec.tmpfs ?? {})) args.push('--tmpfs', `${ target }:${ options }`);
    if (spec.network) args.push('--network', spec.network);
    if (spec.workingDir) args.push('--workdir', spec.workingDir);
    if (spec.user) args.push('--user', spec.user);
    args.push(spec.image, ...(spec.command ?? []));
    return (await limactl(args)).stdout.trim();
  }

  async start(id: string): Promise<void> { await limactl(['docker', 'start', id]) }
  async inspect(id: string): Promise<any> { return JSON.parse((await limactl(['docker', 'inspect', id])).stdout)[0] }
  async remove(id: string, force = true): Promise<void> {
    await limactl(['docker', 'rm', ...(force ? ['--force'] : []), id]).catch(error => {
      if (!String(error).includes('No such container')) throw error;
    });
  }

  async list(label?: string): Promise<any[]> {
    const args = ['docker', 'ps', '--all', '--format', '{{json .}}'];
    if (label) args.push('--filter', `label=${ label }`);
    const output = (await limactl(args)).stdout.trim();
    return output ? output.split('\n').map(line => JSON.parse(line)) : [];
  }
}

let imageReady: Promise<string> | null = null;

async function ensureAgentImage(): Promise<string> {
  if (imageReady) return imageReady;
  imageReady = (async() => {
    const resolved = resolveSullaServiceImage(
      'sulla-agent', process.cwd(), Electron.app.getVersion(), process.env.SULLA_AGENT_IMAGE,
    );
    try {
      await limactl(['docker', 'image', 'inspect', resolved.image]);
      return resolved.image;
    } catch { /* lazy build/pull below */ }

    if (resolved.build) {
      await limactl(['docker', 'build', '--file', path.join(resolved.build.context, resolved.build.dockerfile), '--tag', resolved.image, resolved.build.context]);
      return resolved.image;
    }

    try {
      await limactl(['docker', 'pull', resolved.image]);
      return resolved.image;
    } catch (error) {
      if (resolved.image.endsWith(':latest')) throw error;
      const latest = 'ghcr.io/merchantprotocol/sulla-agent:latest';
      await limactl(['docker', 'pull', latest]);
      return latest;
    }
  })().catch(error => {
    imageReady = null;
    throw error;
  });
  return imageReady;
}

function containerEnvironment(run: AgentContainerRun, token: string, sessionId: string, toolApiUrl: string): {
  env:     Record<string, string>;
  secrets: Record<string, string>;
} {
  const env: Record<string, string> = {
    SULLA_HOST:                   'sulla_tools',
    SULLA_TOOL_API_URL:           toolApiUrl,
    SULLA_AGENT_PROVIDER:         run.provider,
    SULLA_AGENT_MODEL:            run.model ?? '',
  };
  const secrets: Record<string, string> = {
    SULLA_API_TOKEN:              token,
    SULLA_TOOL_SESSION:           sessionId,
    SULLA_AGENT_INSTRUCTIONS_B64: Buffer.from(run.instructions).toString('base64'),
  };
  return { env, secrets };
}

async function provisionContainerSecrets(containerName: string, secrets: Record<string, string>): Promise<string> {
  const secretDir = `/dev/shm/sulla-agent-secrets/${ containerName }`;
  await limactl(['sh', '-c', 'sudo install -d -m 0700 -o "$2" -g "$3" "$1"', 'sh', secretDir, String(CONTAINER_UID), String(CONTAINER_GID)]);
  for (const [key, value] of Object.entries(secrets)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid container secret name ${ key }`);
    const target = `${ secretDir }/${ key }`;
    await limactl(
      ['sh', '-c', 'umask 077; base64 -d | sudo tee "$1" >/dev/null; sudo chown "$2:$3" "$1"; sudo chmod 0400 "$1"', 'sh', target, String(CONTAINER_UID), String(CONTAINER_GID)],
      Buffer.from(value).toString('base64'),
    );
  }
  return secretDir;
}

async function removeContainerSecrets(secretDir: string): Promise<void> {
  if (!secretDir.startsWith('/dev/shm/sulla-agent-secrets/')) throw new Error('Refusing to remove an unexpected secret path');
  await limactl(['sh', '-c', 'if [ -d "$1" ]; then sudo find "$1" -maxdepth 1 -type f -delete; sudo rmdir "$1"; fi', 'sh', secretDir]);
}

async function cleanupContainerResources(
  runtime: ContainerRuntimeDriver,
  containerId: string | undefined,
  secretDir: string | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  if (containerId) {
    await cleanupOwner.run(`container:${ containerId }`, () => runtime.remove(containerId)).catch(error => failures.push(error));
  }
  if (secretDir) {
    await cleanupOwner.run(`secrets:${ secretDir }`, () => removeContainerSecrets(secretDir)).catch(error => failures.push(error));
  }
  if (failures.length) throw new AggregateError(failures, 'Agent container cleanup remains pending');
}

async function replaceContainerSecret(secretDir: string, name: string, value: string): Promise<void> {
  if (!secretDir.startsWith('/dev/shm/sulla-agent-secrets/')) throw new Error('Refusing to update an unexpected secret path');
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid container secret name ${ name }`);
  const target = `${ secretDir }/${ name }`;
  await limactl(
    ['sh', '-c', 'umask 077; base64 -d | sudo tee "$1.next" >/dev/null; sudo chown "$2:$3" "$1.next"; sudo chmod 0400 "$1.next"; sudo mv "$1.next" "$1"', 'sh', target, String(CONTAINER_UID), String(CONTAINER_GID)],
    Buffer.from(value).toString('base64'),
  );
}

/** Seed an isolated persistent clone; never mount shared Git metadata writable. */
async function prepareCheckout(source: string | undefined, workspacePath: string): Promise<string | undefined> {
  if (!source) return undefined;
  const worktreeRoot = path.join(os.homedir(), 'Sites', 'worktrees') + path.sep;
  const resolved = fs.realpathSync(source);
  if (!resolved.startsWith(worktreeRoot) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Container workspacePath must be an existing worktree under ~/Sites/worktrees');
  }
  const top = (await limactl(['git', '-C', resolved, 'rev-parse', '--show-toplevel'])).stdout.trim();
  if (fs.realpathSync(top) !== resolved) throw new Error('container workspacePath must be a Git worktree root');
  const checkout = path.join(workspacePath, 'checkout');
  if (!fs.existsSync(path.join(checkout, '.git'))) {
    await limactl(['git', 'clone', '--local', '--no-hardlinks', resolved, checkout]);
  }
  return checkout;
}

function assertWorkspacePath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);

  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    throw new Error(`Container provider path escaped its job workspace: ${ candidate }`);
  }
  return resolved;
}

class ContainerProviderFileTransport {
  constructor(private readonly workspacePath: string) {}

  write(request: ProviderFileRequest): ProviderFileRef {
    const root = path.join(this.workspacePath, '.sulla-provider-files');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const safeName = request.suggestedName.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120) || 'provider-file';
    const target = assertWorkspacePath(root, path.join(root, `${ crypto.randomUUID() }-${ safeName }`));
    const fd = fs.openSync(
      target,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      request.mode ?? 0o600,
    );
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
      },
    };
  }
}

interface ContainerProviderTransportOptions {
  containerName: string;
  workspacePath: string;
  secretDir:     string;
  bridgeFor(provider: ProviderName): Promise<ProviderCliBridgeLease>;
  ownsBridge(ref: string): boolean;
}

class ContainerProviderExecutionTransport implements ProviderExecutionTransport {
  readonly runtime = 'container' as const;
  readonly files: ContainerProviderFileTransport;
  private readonly processPids = new WeakMap<childProcess.ChildProcessWithoutNullStreams, string>();
  private readonly toolConfigs = new Map<string, Promise<{ ref: string; claudePath: string; codexOverrides: readonly string[] }>>();

  constructor(private readonly options: ContainerProviderTransportOptions) {
    this.files = new ContainerProviderFileTransport(options.workspacePath);
  }

  async context(input: Parameters<ProviderExecutionTransport['context']>[0]): Promise<ProviderTransportContext> {
    const bridge = await this.options.bridgeFor(input.provider);
    let toolConfig: { ref: string; claudePath: string; codexOverrides: readonly string[] } | undefined;
    if (input.toolSessionId) toolConfig = await this.ensureToolConfig(input.toolSessionId);

    return {
      runtime:        'container',
      provider:       input.provider,
      conversationId: input.conversationId,
      workspaceRoot:  this.options.workspacePath,
      auth:           { kind: 'broker', opaqueConfigRef: bridge.config.opaqueConfigRef },
      session:        {
        providerSessionId:       input.providerSessionId,
        toolSessionId:           input.toolSessionId,
        opaqueProviderConfigRef: bridge.config.opaqueConfigRef,
        providerConfig:          bridge.config,
        ...(toolConfig
          ? {
            opaqueToolConfigRef: toolConfig.ref,
            toolConfig:          {
              opaqueConfigRef: toolConfig.ref,
              ...(input.provider === 'codex'
                ? {
                  codexConfigOverrides: toolConfig.codexOverrides,
                  environment:          { SULLA_MCP_SESSION_TOKEN: input.toolSessionId, SULLA_TOOL_SESSION: input.toolSessionId },
                }
                : {
                  claudeConfigPath: toolConfig.claudePath,
                  environment:      {
                    SULLA_MCP_SESSION_TOKEN: input.toolSessionId,
                    SULLA_TOOL_SESSION:      input.toolSessionId,
                  },
                }),
            },
          }
          : {}),
      },
    };
  }

  spawn(request: Parameters<ProviderExecutionTransport['spawn']>[0]): childProcess.ChildProcessWithoutNullStreams {
    if (request.context.runtime !== 'container' || request.context.workspaceRoot !== this.options.workspacePath ||
        request.context.auth.kind !== 'broker' || !this.options.ownsBridge(request.context.auth.opaqueConfigRef)) {
      throw new Error('Provider process is outside this container lifecycle');
    }
    const command = request.providerCommand;
    if (!/^[a-zA-Z0-9._/-]+$/.test(command.executable)) throw new Error('Container provider executable is invalid');
    const cwd = assertWorkspacePath(this.options.workspacePath, command.cwd ?? this.options.workspacePath);
    const pidFile = `/tmp/sulla-provider-${ crypto.randomUUID() }.pid`;
    const args = ['shell', '0', '--', 'docker', 'exec', '--interactive', '--workdir', cwd];
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(command.env ?? {})) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\0\r\n]/.test(value)) {
        throw new Error(`Container provider environment contains invalid ${ key }`);
      }
      environment[key] = value;
    }
    args.push(
      this.options.containerName,
      '/bin/sh', '-c', [
        'set -eu',
        'IFS= read -r encoded_env',
        'env_json=$(printf "%s" "$encoded_env" | base64 -d)',
        'for key in $(printf "%s" "$env_json" | jq -r "keys[]"); do value=$(printf "%s" "$env_json" | jq -r --arg key "$key" \'.[$key]\'); export "$key=$value"; done',
        'unset encoded_env env_json key value',
        'umask 077',
        'printf "%s %s\\n" "$$" "$(cut -d " " -f 22 /proc/$$/stat)" > "$1"',
        'shift',
        'exec "$@"',
      ].join('; '),
      'sulla-provider', pidFile, command.executable, ...command.args,
    );
    const proc = childProcess.spawn(paths.limactl, args, {
      env:   { ...process.env, LIMA_HOME: paths.lima, TERM: 'dumb' },
      stdio: request.stdio ?? ['pipe', 'pipe', 'pipe'],
    }) as childProcess.ChildProcessWithoutNullStreams;
    proc.stdin.on('error', () => { /* provider may exit during bootstrap */ });
    proc.stdin.write(`${ Buffer.from(JSON.stringify(environment)).toString('base64') }\n`);
    this.processPids.set(proc, pidFile);
    return proc;
  }

  async terminate(request: Parameters<ProviderExecutionTransport['terminate']>[0]): Promise<void> {
    const pidFile = this.processPids.get(request.process);
    try { request.process.kill(`SIG${ request.signal }`) } catch { /* already exited */ }
    if (!pidFile) return;
    const signal = request.signal === 'INT' ? 'TERM' : request.signal;
    const script = [
      'set -eu',
      'record=$(cat "$1" 2>/dev/null || true)',
      // eslint-disable-next-line no-template-curly-in-string
      'pid=${record%% *}',
      // eslint-disable-next-line no-template-curly-in-string
      'born=${record#* }',
      '[ -n "$pid" ] && [ "$pid" != "$record" ] || exit 0',
      '[ -r "/proc/$pid/stat" ] || exit 0',
      'current=$(cut -d " " -f 22 "/proc/$pid/stat")',
      '[ "$current" = "$born" ] || exit 0',
      'descend() { for status in /proc/[0-9]*/status; do child=$(sed -n "s/^Pid:[[:space:]]*//p" "$status" 2>/dev/null || true); parent=$(sed -n "s/^PPid:[[:space:]]*//p" "$status" 2>/dev/null || true); if [ "$parent" = "$1" ]; then descend "$child" "$2"; kill -"$2" "$child" 2>/dev/null || true; fi; done; }',
      'descend "$pid" "$2"',
      'kill -"$2" "$pid" 2>/dev/null || true',
      '[ "$2" != KILL ] || rm -f "$1"',
    ].join('; ');
    await limactl(['docker', 'exec', this.options.containerName, '/bin/sh', '-c', script, 'sulla-kill', pidFile, signal]).catch(() => {});
  }

  private ensureToolConfig(sessionId: string): Promise<{ ref: string; claudePath: string; codexOverrides: readonly string[] }> {
    const existing = this.toolConfigs.get(sessionId);
    if (existing) return existing;
    const created = (async() => {
      if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error('Container tool session id is invalid');
      const mcpUrl = getMCPServerHost().getVmReachableUrl();
      const target = `/run/secrets/sulla-agent/mcp-${ sessionId }.json`;
      const payload = JSON.stringify({
        mcpServers: {
          // Claude expands ${VAR} references in MCP headers at process start.
          // Keep the graph session capability in memory-only process env; the
          // provider-visible config contains a placeholder, never the token.
          // eslint-disable-next-line no-template-curly-in-string
          'sulla-native': { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer ${SULLA_MCP_SESSION_TOKEN}' } },
        },
      });
      await limactl(
        ['sh', '-c', 'umask 077; base64 -d | sudo tee "$1" >/dev/null; sudo chown "$2:$3" "$1"; sudo chmod 0400 "$1"', 'sh', `${ this.options.secretDir }/mcp-${ sessionId }.json`, String(CONTAINER_UID), String(CONTAINER_GID)],
        Buffer.from(payload).toString('base64'),
      );
      const ref = crypto.randomUUID();
      return {
        ref,
        claudePath:     target,
        codexOverrides: [
          `mcp_servers.sulla-native.url=${ JSON.stringify(mcpUrl) }`,
          'mcp_servers.sulla-native.bearer_token_env_var="SULLA_MCP_SESSION_TOKEN"',
          'mcp_servers.sulla-native.default_tools_approval_mode="approve"',
        ],
      };
    })();
    this.toolConfigs.set(sessionId, created);
    return created;
  }
}

/**
 * Start one job-scoped container while the canonical Desktop graph remains
 * the control plane. Agent-local tools and CLI provider processes are scoped
 * into this lifecycle; non-CLI providers retain their canonical transport.
 */
export async function createAgentContainerLifecycle(run: AgentContainerLifecycleRun): Promise<AgentContainerLifecycle> {
  const image = await ensureAgentImage();
  const runtime = new LimaDockerRuntimeDriver();
  const containerName = `sulla-agent-${ safeName(run.jobId) }-${ run.taskIndex }`;
  const capabilityJti = crypto.randomUUID();
  const lifecycleAbort = new AbortController();
  let capabilityExpiresAt = Math.floor(Date.now() / 1000) + Math.ceil(LEASE_MS / 1000);
  let secretDir: string | undefined;
  let containerId: string | undefined;
  let unregisterRuntime: (() => void) | undefined;
  const providerBridges = new Map<ProviderName, Promise<ProviderCliBridgeLease>>();
  const providerBridgeRefs = new Set<string>();
  let toolSession: ReturnType<ReturnType<typeof getMCPServerHost>['registerSession']> | undefined;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let livenessTimer: ReturnType<typeof setInterval> | undefined;
  let checkingLiveness = false;
  let closePromise: Promise<void> | undefined;

  try {
    const installationSecret = getChatCompletionsServer().getApiToken();
    if (!installationSecret) throw new Error('Desktop tool API is not initialized');
    const metadata = run.state.metadata as { userId?: string; orgId?: string; agentId?: string; threadId?: string; deviceId?: string; allowedToolNames?: string[] };
    const deviceId = metadata.deviceId ?? await getDesktopDeviceId();
    const subject = usesContainerVaultAuthority()
      ? await getLocalVaultPrincipalId(run.state.metadata.options?.abort?.signal)
      : metadata.userId;
    if (!subject) throw new Error('Agent capability requires an authenticated user identity');
    const agentId = metadata.agentId ?? run.state.metadata.wsChannel;
    if (!agentId) throw new Error('Agent container requires an agent identity');
    const allowed = metadata.allowedToolNames ?? [];
    const scopes = allowed.length === 0 || allowed.includes('exec') ? ['*'] : allowed;
    const issueLease = () => issueCapabilityToken({
      sub:              subject,
      org_id:           metadata.orgId,
      agent_id:         agentId,
      pod_id:           containerName,
      thread_id:        metadata.threadId,
      job_id:           run.jobId,
      device_id:        deviceId,
      scopes,
      jti:              capabilityJti,
      expiresInSeconds: Math.ceil(LEASE_MS / 1000),
    }, deriveCapabilitySigningKey(installationSecret));
    const toolsServiceHealthy = await fetch('http://127.0.0.1:30123/healthz', { signal: AbortSignal.timeout(1_000) })
      .then(response => response.ok).catch(() => false);
    if (!toolsServiceHealthy) throw new Error('sulla-tools is unavailable; container agents require hostname-based tool routing');

    toolSession = getMCPServerHost().registerSession(run.state, IDLE_MS + 5 * 60_000);
    const workspacePath = path.join(os.homedir(), 'sulla', 'workspaces', 'agents', `${ safeName(run.jobId) }-${ run.taskIndex }`);
    await fs.promises.mkdir(workspacePath, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(workspacePath, 0o700);
    const checkout = await prepareCheckout(run.workspacePath, workspacePath);
    const providerWorkspace = checkout ?? workspacePath;
    secretDir = await provisionContainerSecrets(`${ containerName }-${ capabilityJti }`, {
      SULLA_API_TOKEN: issueLease(), SULLA_TOOL_SESSION: toolSession.id,
    });
    containerId = await runtime.create({
      name:   containerName,
      image,
      labels: {
        'com.sulla.workload':       'agent',
        'com.sulla.job-id':         run.jobId,
        'com.sulla.task-index':     String(run.taskIndex),
        'com.sulla.capability-jti': capabilityJti,
        'com.sulla.capability-exp': String(capabilityExpiresAt),
      },
      autoRemove: true,
      stdinOpen:  true,
      env:        {
        SULLA_AGENT_MODE:     'transport',
        SULLA_HOST:           'sulla_tools',
        SULLA_TOOL_API_URL:   'http://sulla_tools:3000',
        SULLA_AGENT_PROVIDER: run.provider,
        SULLA_AGENT_MODEL:    run.model ?? '',
      },
      binds:       [`${ secretDir }:/run/secrets/sulla-agent:rw`, `${ workspacePath }:${ workspacePath }:rw`, `${ resolveSullaDocsDir() }:/opt/sulla-docs:ro`],
      network:     'sulla_default',
      workingDir:  providerWorkspace,
      user:        `${ CONTAINER_UID }:${ CONTAINER_GID }`,
      tmpfs:       { '/home/sulla': `rw,uid=${ CONTAINER_UID },gid=${ CONTAINER_GID },mode=0700` },
      memoryLimit: MEMORY,
      cpuLimit:    CPUS,
    });
    await runtime.start(containerId);
    const mcpUrl = new URL(getMCPServerHost().getVmReachableUrl());
    await limactl([
      'docker', 'exec', containerName, 'curl', '--fail', '--silent', '--show-error', '--max-time', '3',
      `${ mcpUrl.origin }/healthz`,
    ]).catch(error => {
      throw new Error(`Container cannot reach the graph MCP host ${ mcpUrl.hostname }: ${ (error as Error).message }`);
    });
    const binding = {
      podId:         containerName,
      subject,
      orgId:         metadata.orgId,
      agentId,
      jobId:         run.jobId,
      threadId:      metadata.threadId,
      deviceId,
      workspacePath: providerWorkspace,
    };
    unregisterRuntime = registerAgentContainerRuntime(binding);
    const abortGraph = (reason: string) => {
      log.warn(`[AgentContainer] ${ containerName } failed: ${ reason }`);
      const graphAbort = run.state.metadata.options?.abort as { abort?: () => void } | undefined;
      try { graphAbort?.abort?.() } catch { /* graph is already unwinding */ }
      lifecycleAbort.abort();
    };
    const bridgeFor = (provider: ProviderName): Promise<ProviderCliBridgeLease> => {
      const existing = providerBridges.get(provider);
      if (existing) return existing;
      const created = (async() => {
        let integrationId: 'anthropic' | 'claude-code' | 'codex' | 'openai';
        let accountId: string;
        let authMode: ProviderCliAuthMode | undefined;
        if (provider === 'codex') {
          try {
            accountId = await getIntegrationService().getActiveAccountId('codex');
            integrationId = 'codex';
          } catch (error) {
            if ((error as Error).message !== 'No local vault account is configured for codex') throw error;
            accountId = await getIntegrationService().getActiveAccountId('openai');
            integrationId = 'openai';
          }
        } else {
          try {
            accountId = await getIntegrationService().getActiveAccountId('claude-code');
            integrationId = 'claude-code';
            authMode = accountId === 'oauth' ? 'oauth' : 'api-key';
          } catch (error) {
            if ((error as Error).message !== 'No local vault account is configured for claude-code') throw error;
            integrationId = 'anthropic';
            accountId = await getIntegrationService().getActiveAccountId(integrationId);
            authMode = 'api-key';
          }
        }
        const bridgeContext = () => {
          const now = Math.floor(Date.now() / 1000);
          return {
            v:                1 as const,
            iss:              'sulla-desktop',
            aud:              'sulla-tools' as const,
            sub:              subject,
            org_id:           metadata.orgId,
            agent_id:         agentId,
            pod_id:           containerName,
            thread_id:        metadata.threadId,
            job_id:           run.jobId,
            device_id:        deviceId,
            credential_scope: { integration_id: integrationId, account_id: accountId },
            scopes:           [],
            iat:              now,
            exp:              now + Math.ceil(LEASE_MS / 1000),
            jti:              capabilityJti,
            request_id:       crypto.randomUUID(),
          };
        };
        const bridge = await createProviderCliBridge({
          context:        bridgeContext(),
          provider,
          accountId,
          authMode,
          models:         run.provider === provider && run.model && run.model !== provider ? [run.model] : undefined,
          advertisedHost: mcpUrl.hostname,
          signal:         lifecycleAbort.signal,
          authorize:      async() => {
            const context = bridgeContext();
            requireAgentContainerRuntime(context);
            if (await redisClient.get(`sulla:capability:revoked:${ capabilityJti }`)) return false;
            return context;
          },
        });
        providerBridgeRefs.add(bridge.config.opaqueConfigRef);
        return bridge;
      })();
      providerBridges.set(provider, created);
      created.catch(() => providerBridges.delete(provider));
      return created;
    };
    const providerTransport = new ContainerProviderExecutionTransport({
      containerName,
      workspacePath: providerWorkspace,
      secretDir,
      bridgeFor,
      ownsBridge:    ref => providerBridgeRefs.has(ref),
    });
    renewTimer = setInterval(() => {
      capabilityExpiresAt = Math.floor(Date.now() / 1000) + Math.ceil(LEASE_MS / 1000);
      getMCPServerHost().rebindSession(toolSession.id, run.state, LEASE_MS);
      if (secretDir) {
        replaceContainerSecret(secretDir, 'SULLA_API_TOKEN', issueLease()).catch(error => {
          log.warn(`[AgentContainer] capability renewal failed for ${ containerName }: ${ (error as Error).message }`);
          abortGraph('capability renewal failed');
        });
      }
    }, RENEW_MS);
    renewTimer.unref();
    livenessTimer = setInterval(() => {
      if (checkingLiveness || closePromise) return;
      checkingLiveness = true;
      runtime.inspect(containerName).then(details => {
        if (!closePromise && details?.State?.Running !== true) abortGraph('persistent runtime exited');
      }).catch(() => {
        if (!closePromise) abortGraph('persistent runtime disappeared');
      }).finally(() => {
        checkingLiveness = false;
      });
    }, 15_000);
    livenessTimer.unref();
    run.signal?.addEventListener('abort', () => lifecycleAbort.abort(), { once: true });

    const close = () => {
      if (closePromise) return closePromise;
      // Defer the abort until after the sentinel is assigned: abort dispatch is
      // synchronous and otherwise re-enters close() before closePromise exists.
      closePromise = Promise.resolve().then(async() => {
        lifecycleAbort.abort();
        if (renewTimer) clearInterval(renewTimer);
        if (livenessTimer) clearInterval(livenessTimer);
        unregisterRuntime?.();
        unregisterRuntime = undefined;
        toolSession?.revoke();
        const bridges = await Promise.allSettled([...providerBridges.values()]);
        for (const bridge of bridges) {
          if (bridge.status !== 'fulfilled') continue;
          bridge.value.revoke();
          await bridge.value.close().catch(() => {});
        }
        providerBridgeRefs.clear();
        await redisClient.set(`sulla:capability:revoked:${ capabilityJti }`, '1', Math.max(1, capabilityExpiresAt - Math.floor(Date.now() / 1000))).catch(() => {});
        await cleanupContainerResources(runtime, containerId, secretDir);
      })();
      return closePromise;
    };

    lifecycleAbort.signal.addEventListener('abort', () => { close().catch(() => {}) }, { once: true });
    if (run.signal?.aborted) {
      await close();
      const error = new Error('Agent container lifecycle was aborted before graph execution');
      error.name = 'AbortError';
      throw error;
    }
    return {
      containerName,
      workspacePath: providerWorkspace,
      execute<T>(action: () => T): T {
        return withAgentContainerRuntime(binding, () => withProviderExecutionTransport(providerTransport, action));
      },
      close,
    };
  } catch (error) {
    lifecycleAbort.abort();
    if (renewTimer) clearInterval(renewTimer);
    if (livenessTimer) clearInterval(livenessTimer);
    unregisterRuntime?.();
    toolSession?.revoke();
    const bridges = await Promise.allSettled([...providerBridges.values()]);
    for (const bridge of bridges) {
      if (bridge.status !== 'fulfilled') continue;
      bridge.value.revoke();
      await bridge.value.close().catch(() => {});
    }
    await redisClient.set(`sulla:capability:revoked:${ capabilityJti }`, '1', Math.max(1, capabilityExpiresAt - Math.floor(Date.now() / 1000))).catch(() => {});
    await cleanupContainerResources(runtime, containerId, secretDir).catch(cleanupError => {
      throw new AggregateError([error, cleanupError], 'Agent container startup and cleanup both failed');
    });
    throw error;
  }
}

export async function runAgentContainer(run: AgentContainerRun): Promise<AgentContainerResult> {
  const image = await ensureAgentImage();
  const runtime = new LimaDockerRuntimeDriver();
  const session = getMCPServerHost().registerSession(run.state, IDLE_MS + 5 * 60_000);
  const containerName = `sulla-agent-${ safeName(run.jobId) }-${ run.taskIndex }`;
  let secretDir: string | undefined;
  const capabilityJti = crypto.randomUUID();
  let capabilityExpiresAt = Math.floor(Date.now() / 1000) + Math.ceil(LEASE_MS / 1000);
  let containerId: string | undefined;
  let unregisterRuntime: (() => void) | undefined;
  try {
    const installationSecret = getChatCompletionsServer().getApiToken();
    if (!installationSecret) throw new Error('Desktop tool API is not initialized');
    const metadata = run.state.metadata as { userId?: string; orgId?: string; agentId?: string; threadId?: string; deviceId?: string; allowedToolNames?: string[] };
    const deviceId = metadata.deviceId ?? await getDesktopDeviceId();
    const subject = usesContainerVaultAuthority()
      ? await getLocalVaultPrincipalId(run.state.metadata.options?.abort?.signal)
      : metadata.userId;
    if (!subject) throw new Error('Agent capability requires an authenticated user identity');
    const allowed = metadata.allowedToolNames ?? [];
    const scopes = allowed.length === 0 || allowed.includes('exec') ? ['*'] : allowed;
    const issueLease = () => issueCapabilityToken({
      sub:              subject,
      org_id:           metadata.orgId,
      agent_id:         metadata.agentId ?? run.state.metadata.wsChannel,
      pod_id:           containerName,
      thread_id:        metadata.threadId,
      job_id:           run.jobId,
      device_id:        deviceId,
      scopes,
      jti:              capabilityJti,
      expiresInSeconds: Math.ceil(LEASE_MS / 1000),
    }, deriveCapabilitySigningKey(installationSecret));
    const toolsServiceHealthy = await fetch('http://127.0.0.1:30123/healthz', { signal: AbortSignal.timeout(1_000) })
      .then(response => response.ok).catch(() => false);
    if (!toolsServiceHealthy) throw new Error('sulla-tools is unavailable; container agents require hostname-based tool routing');
    const configuration = containerEnvironment(
      run, issueLease(), session.id, 'http://sulla_tools:3000',
    );
    const workspacePath = path.join(os.homedir(), 'sulla', 'workspaces', 'agents', `${ safeName(run.jobId) }-${ run.taskIndex }`);
    await fs.promises.mkdir(workspacePath, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(workspacePath, 0o700);
    const checkout = await prepareCheckout(run.workspacePath, workspacePath);
    const docsPath = resolveSullaDocsDir();
    secretDir = await provisionContainerSecrets(`${ containerName }-${ capabilityJti }`, configuration.secrets);
    containerId = await runtime.create({
      name:   containerName,
      image,
      labels: {
        'com.sulla.workload':       'agent',
        'com.sulla.job-id':         run.jobId,
        'com.sulla.task-index':     String(run.taskIndex),
        'com.sulla.capability-jti': capabilityJti,
        'com.sulla.capability-exp': String(capabilityExpiresAt),
      },
      autoRemove:  true,
      stdinOpen:   true,
      env:         configuration.env,
      binds:       [`${ secretDir }:/run/secrets/sulla-agent:rw`, `${ workspacePath }:${ workspacePath }:rw`, `${ docsPath }:/opt/sulla-docs:ro`],
      network:     'sulla_default',
      workingDir:  checkout ?? workspacePath,
      user:        `${ CONTAINER_UID }:${ CONTAINER_GID }`,
      tmpfs:       { '/home/sulla': `rw,uid=${ CONTAINER_UID },gid=${ CONTAINER_GID },mode=0700` },
      memoryLimit: MEMORY,
      cpuLimit:    CPUS,
    });
    unregisterRuntime = registerAgentContainerRuntime({
      podId:         containerName,
      subject,
      orgId:         metadata.orgId,
      agentId:       metadata.agentId ?? run.state.metadata.wsChannel,
      jobId:         run.jobId,
      threadId:      metadata.threadId,
      deviceId,
      workspacePath: checkout ?? workspacePath,
    });
    const startedContainerId = containerId;

    return await new Promise((resolve, reject) => {
      const args = [
        'shell', '0', '--', 'docker', 'start', '--attach', '--interactive', startedContainerId,
      ];
      const proc = childProcess.spawn(paths.limactl, args, {
        env:   { ...process.env, LIMA_HOME: paths.lima },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let providerBuffer = '';
      let streamText = '';
      let lastStreamFlush = 0;
      let settled = false;
      let abortForceTimer: ReturnType<typeof setTimeout> | undefined;
      const pendingSteers = new Set<string>();
      let idleTimer: ReturnType<typeof setTimeout>;
      const unsubscribeSteer = onSteer(run.state, message => {
        const text = steerText(message).trim();
        if (!text || settled || proc.stdin.destroyed || proc.stdin.writableEnded) return false;
        try {
          const id = crypto.randomUUID();
          pendingSteers.add(id);
          proc.stdin.write(`${ JSON.stringify({ type: 'steer', id, message: text }) }\n`, error => {
            if (error) pendingSteers.delete(id);
          });
          return true;
        } catch {
          return false;
        }
      });
      const renewTimer = setInterval(() => {
        capabilityExpiresAt = Math.floor(Date.now() / 1000) + Math.ceil(LEASE_MS / 1000);
        getMCPServerHost().rebindSession(session.id, run.state, LEASE_MS);
        if (secretDir) {
          replaceContainerSecret(secretDir, 'SULLA_API_TOKEN', issueLease()).catch(error => {
            log.warn(`[AgentContainer] capability renewal failed for ${ containerName }: ${ (error as Error).message }`);
          });
        }
      }, RENEW_MS);
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          log.warn(`[AgentContainer] ${ containerName } idle for 30 minutes; reaping`);
          cleanupOwner.run(`container:${ startedContainerId }`, () => runtime.remove(startedContainerId)).catch(cleanupError => {
            log.error(`[AgentContainer] idle cleanup remains pending for ${ startedContainerId }: ${ (cleanupError as Error).message }`);
          });
          proc.kill('SIGTERM');
        }, IDLE_MS);
      };
      const finish = async(error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        clearInterval(renewTimer);
        if (abortForceTimer) clearTimeout(abortForceTimer);
        unsubscribeSteer();
        unregisterRuntime?.();
        unregisterRuntime = undefined;
        session.revoke();
        await redisClient.set(`sulla:capability:revoked:${ capabilityJti }`, '1', Math.max(1, capabilityExpiresAt - Math.floor(Date.now() / 1000))).catch(() => {});
        if (secretDir) {
          try {
            await cleanupOwner.run(`secrets:${ secretDir }`, () => removeContainerSecrets(secretDir!));
          } catch (cleanupError) {
            reject(new AggregateError(error ? [error, cleanupError] : [cleanupError], 'Agent container cleanup remains pending'));
            return;
          }
        }
        emitProvider('', 'streaming_complete').catch(() => {});
        emitProvider('', 'thinking_complete').catch(() => {});
        if (error) reject(error);
        else resolve({ output: output.slice(-200_000), containerName });
      };
      const emitProvider = async(content: string, kind: string) => {
        const metadata = run.state.metadata as any;
        const channel = metadata.parentWsChannel || metadata.wsChannel;
        const threadId = metadata.parentConversationId || metadata.threadId;
        if (!channel || !threadId) return;
        await getWebSocketClientService().send(channel, {
          type: 'assistant_message',
          data: { content, role: 'assistant', kind, thread_id: threadId, timestamp: Date.now() },
        }).catch(() => {});
      };
      const flushStream = (force = false) => {
        const now = Date.now();
        if (!force && now - lastStreamFlush < 50) return;
        lastStreamFlush = now;
        const content = stripProtocolTagsStreaming(streamText);
        if (content.trim()) emitProvider(content, 'streaming').catch(() => {});
      };
      const activity = (message: string) => {
        if (!message) return;
        flushStream(true);
        if (streamText.trim()) emitProvider('', 'streaming_complete').catch(() => {});
        streamText = '';
        emitProvider(message, 'thinking').catch(() => {});
      };
      const processProviderLine = (line: string) => {
        let event: any;
        try { event = JSON.parse(line) } catch { return }
        if (event.type === 'sulla.steer.ack' && typeof event.id === 'string') {
          if (pendingSteers.delete(event.id)) RunActivity.touch(run.state.metadata);
          return;
        }
        if (event.type === 'thread.started') activity('Session started — calling model');
        if ((event.type === 'item.started' || event.type === 'item.completed') && event.item) {
          const item = event.item;
          const kind = item.item_type ?? item.type;
          if (kind === 'agent_message' && event.type === 'item.completed' && typeof item.text === 'string') {
            streamText += `${ streamText.trim() ? '\n\n' : '' }${ item.text }`;
            flushStream(true);
          } else if (event.type === 'item.started') {
            if (kind === 'command_execution') activity(typeof item.command === 'string' ? `$ ${ item.command.slice(0, 120) }` : 'Running a shell command');
            else if (kind === 'file_change') activity('Editing files');
            else if (kind === 'mcp_tool_call') activity(`Using ${ item.tool ?? 'a tool' }`);
            else if (kind === 'web_search') activity(`Searching web${ item.query ? `: ${ String(item.query).slice(0, 100) }` : '' }`);
          }
        }
        const nested = event.event;
        if (nested?.type === 'content_block_delta' && nested.delta?.type === 'text_delta' && typeof nested.delta.text === 'string') {
          streamText += nested.delta.text;
          flushStream();
        }
        if (nested?.type === 'content_block_delta' && nested.delta?.type === 'thinking_delta' && typeof nested.delta.thinking === 'string') {
          activity(`💭 ${ nested.delta.thinking.replace(/\s+/g, ' ').trim().slice(0, 220) }`);
        }
        if (nested?.type === 'content_block_start' && nested.content_block?.type === 'tool_use') {
          activity(`Using ${ nested.content_block.name ?? 'a tool' }`);
        }
      };
      const onData = (chunk: Buffer, parseProvider = false) => {
        resetIdle();
        RunActivity.touch(run.state.metadata);
        const text = chunk.toString('utf8');
        output += text;
        if (output.length > 400_000) output = output.slice(-200_000);
        if (parseProvider) {
          const lines = `${ providerBuffer }${ text }`.split('\n');
          providerBuffer = lines.pop() ?? '';
          if (providerBuffer.length > 200_000) providerBuffer = providerBuffer.slice(-200_000);
          for (const line of lines) if (line.trim()) processProviderLine(line);
        }
      };
      proc.stdout.on('data', chunk => onData(chunk, true));
      proc.stderr.on('data', chunk => onData(chunk, false));
      proc.stdin.on('error', error => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE' && !settled) finish(error).catch(reject);
      });
      proc.once('error', error => { finish(error).catch(reject) });
      proc.once('close', code => { finish(code === 0 ? undefined : new Error(`Agent container exited ${ code }: ${ output.slice(-4_000) }`)).catch(reject) });
      if (run.signal) {
        run.signal.addEventListener('abort', () => {
          proc.stdin.write(`${ JSON.stringify({ type: 'cancel' }) }\n`, () => {});
          abortForceTimer = setTimeout(() => {
            cleanupOwner.run(`container:${ startedContainerId }`, () => runtime.remove(startedContainerId)).catch(error => {
              log.error(`[AgentContainer] abort cleanup remains pending for ${ startedContainerId }: ${ (error as Error).message }`);
            });
          }, 6_000);
          abortForceTimer.unref();
        }, { once: true });
      }
      resetIdle();
      proc.stdin.write(`${ JSON.stringify({ type: 'start', prompt: run.prompt }) }\n`, () => {});
    });
  } catch (error) {
    unregisterRuntime?.();
    session.revoke();
    await redisClient.set(`sulla:capability:revoked:${ capabilityJti }`, '1', Math.max(1, capabilityExpiresAt - Math.floor(Date.now() / 1000))).catch(() => {});
    await cleanupContainerResources(runtime, containerId, secretDir).catch(cleanupError => {
      throw new AggregateError([error, cleanupError], 'Agent container startup and cleanup both failed');
    });
    throw error;
  }
}

/** Remove agent containers left behind by a Desktop crash/restart. */
export async function reapOrphanAgentContainers(): Promise<void> {
  const runtime = new LimaDockerRuntimeDriver();
  let containers: any[];
  try {
    containers = await runtime.list('com.sulla.workload=agent');
  } catch (error) {
    log.warn(`[AgentContainer] startup orphan inventory failed: ${ (error as Error).message }`);
    return;
  }
  for (const container of containers) {
    try {
      const details = await runtime.inspect(container.ID ?? container.Id ?? container.Names);
      const labels = details?.Config?.Labels ?? {};
      const jti = labels['com.sulla.capability-jti'];
      const exp = Number(labels['com.sulla.capability-exp'] ?? 0);
      if (jti) await redisClient.set(`sulla:capability:revoked:${ jti }`, '1', Math.max(Math.ceil(LEASE_MS / 1000), exp - Math.floor(Date.now() / 1000))).catch(() => {});
      const id = details.Id ?? container.ID ?? container.Names;
      await cleanupOwner.run(`container:${ id }`, () => runtime.remove(id));
    } catch (error) {
      log.error(`[AgentContainer] startup orphan cleanup remains pending: ${ (error as Error).message }`);
    }
  }
  try {
    await limactl(['sh', '-c', 'sudo find /dev/shm/sulla-agent-secrets -mindepth 2 -maxdepth 2 -type f -delete 2>/dev/null || true; sudo find /dev/shm/sulla-agent-secrets -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true']);
  } catch (error) {
    log.error(`[AgentContainer] startup orphan secret cleanup failed: ${ (error as Error).message }`);
  }
}
