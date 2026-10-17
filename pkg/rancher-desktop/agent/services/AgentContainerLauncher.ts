import * as childProcess from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';

import Electron from 'electron';

import { registerAgentContainerRuntime } from './AgentContainerRuntimeRegistry';
import { RunActivity } from './RunActivity';
import { getWebSocketClientService } from './WebSocketClientService';
import { getLocalVaultPrincipalId, usesContainerVaultAuthority } from '../../vault-broker';
import { redisClient } from '../database/RedisClient';
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

export interface AgentContainerRun {
  jobId:        string;
  taskIndex:    number;
  provider:     string;
  model?:       string | null;
  prompt:       string;
  instructions: string;
  /** Explicit existing worktree used only to seed this job's isolated clone. */
  workspacePath?: string;
  state:        BaseThreadState;
  signal?:      AbortSignal;
}

export interface AgentContainerResult {
  output:        string;
  containerName: string;
}

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
  await limactl(['sh', '-c', 'sudo find "$1" -maxdepth 1 -type f -delete; sudo rmdir "$1" 2>/dev/null || true', 'sh', secretDir]).catch(() => {});
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
    secretDir = await provisionContainerSecrets(containerName, configuration.secrets);
    containerId = await runtime.create({
      name:   containerName,
      image,
      labels: {
        'com.sulla.workload':   'agent',
        'com.sulla.job-id':     run.jobId,
        'com.sulla.task-index': String(run.taskIndex),
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
      podId: containerName,
      subject,
      orgId: metadata.orgId,
      agentId: metadata.agentId ?? run.state.metadata.wsChannel,
      jobId: run.jobId,
      threadId: metadata.threadId,
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
          runtime.remove(containerName).catch(() => {});
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
        if (secretDir) await removeContainerSecrets(secretDir);
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
            runtime.remove(containerName).catch(error => {
              log.warn(`[AgentContainer] abort cleanup failed for ${ containerName }: ${ (error as Error).message }`);
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
    if (containerId) await runtime.remove(containerId).catch(() => {});
    if (secretDir) await removeContainerSecrets(secretDir);
    throw error;
  }
}

/** Remove agent containers left behind by a Desktop crash/restart. */
export async function reapOrphanAgentContainers(): Promise<void> {
  try {
    const runtime = new LimaDockerRuntimeDriver();
    const containers = await runtime.list('com.sulla.workload=agent');
    for (const container of containers) {
      const details = await runtime.inspect(container.ID ?? container.Id ?? container.Names);
      const labels = details?.Config?.Labels ?? {};
      const jti = labels['com.sulla.capability-jti'];
      const exp = Number(labels['com.sulla.capability-exp'] ?? 0);
      if (jti) await redisClient.set(`sulla:capability:revoked:${ jti }`, '1', Math.max(Math.ceil(LEASE_MS / 1000), exp - Math.floor(Date.now() / 1000))).catch(() => {});
      await runtime.remove(details.Id ?? container.ID ?? container.Names);
    }
    await limactl(['sh', '-c', 'sudo find /dev/shm/sulla-agent-secrets -mindepth 2 -maxdepth 2 -type f -delete 2>/dev/null || true; sudo find /dev/shm/sulla-agent-secrets -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true']);
  } catch (error) {
    // Agent containers are optional and must never prevent Desktop startup.
    log.warn(`[AgentContainer] startup orphan reap skipped: ${ (error as Error).message }`);
  }
}
