import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import Electron from 'electron';

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { ensureCodexAuthFile, codexAuthPath } from '../util/codexAuthFile';

import { resolveSullaServiceImage } from '@pkg/backend/sullaServiceImages';
import { getMCPServerHost } from '@pkg/main/MCPServerHost';
import type { ContainerRuntimeDriver, ContainerSpec } from '@pkg/runtime/containerRuntime';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

import type { BaseThreadState } from '../nodes/Graph';

const log = Logging.background;
const IDLE_MS = 30 * 60_000;
const MEMORY = process.env.SULLA_AGENT_MEMORY ?? '4g';
const CPUS = process.env.SULLA_AGENT_CPUS ?? '2';

export interface AgentContainerRun {
  jobId:        string;
  taskIndex:    number;
  provider:     string;
  model?:       string | null;
  prompt:       string;
  instructions: string;
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
    if (spec.network) args.push('--network', spec.network);
    if (spec.workingDir) args.push('--workdir', spec.workingDir);
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

async function claudeCredentials(): Promise<{ oauthToken: string; apiKey: string }> {
  let oauthToken = '';
  let apiKey = '';
  try {
    const { getIntegrationService } = await import('../services/IntegrationService');
    for (const value of await getIntegrationService().getFormValues('claude-code')) {
      if (value.property === 'oauth_token' && value.value) oauthToken = value.value;
      if (value.property === 'api_key' && value.value) apiKey = value.value;
    }
  } catch { /* settings fallback below */ }
  if (!oauthToken && !apiKey) {
    oauthToken = (await SullaSettingsModel.get('claudeOAuthToken', '')) ?? '';
    apiKey = (await SullaSettingsModel.get('claudeApiKey', '')) ?? '';
  }
  return { oauthToken, apiKey };
}

async function containerEnvironment(run: AgentContainerRun, token: string): Promise<{
  env:     Record<string, string>;
  secrets: Record<string, string>;
}> {
  const env: Record<string, string> = {
    SULLA_HOST:                   'host.lima.internal',
    SULLA_AGENT_PROVIDER:         run.provider,
    SULLA_AGENT_MODEL:            run.model ?? '',
  };
  const secrets: Record<string, string> = {
    SULLA_API_TOKEN:              token,
    SULLA_TOOL_SESSION:           token,
    SULLA_AGENT_INSTRUCTIONS_B64: Buffer.from(run.instructions).toString('base64'),
  };
  if (run.provider === 'codex') {
    if (!await ensureCodexAuthFile()) throw new Error('No Codex credentials configured');
    secrets.CODEX_AUTH_JSON_B64 = fs.readFileSync(codexAuthPath()).toString('base64');
  } else if (run.provider === 'claude-code') {
    const creds = await claudeCredentials();
    if (!creds.oauthToken && !creds.apiKey) throw new Error('No Claude Code credentials configured');
    if (creds.oauthToken) secrets.CLAUDE_CODE_OAUTH_TOKEN = creds.oauthToken;
    if (creds.apiKey) secrets.ANTHROPIC_API_KEY = creds.apiKey;
  }
  return { env, secrets };
}

async function provisionContainerSecrets(containerName: string, secrets: Record<string, string>): Promise<string> {
  const secretDir = `/dev/shm/sulla-agent-secrets/${ containerName }`;
  await limactl(['sh', '-c', 'sudo install -d -m 0700 -o 10001 -g 10001 "$1"', 'sh', secretDir]);
  for (const [key, value] of Object.entries(secrets)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid container secret name ${ key }`);
    const target = `${ secretDir }/${ key }`;
    await limactl(
      ['sh', '-c', 'umask 077; base64 -d | sudo tee "$1" >/dev/null; sudo chown 10001:10001 "$1"; sudo chmod 0400 "$1"', 'sh', target],
      Buffer.from(value).toString('base64'),
    );
  }
  return secretDir;
}

async function removeContainerSecrets(secretDir: string): Promise<void> {
  if (!secretDir.startsWith('/dev/shm/sulla-agent-secrets/')) throw new Error('Refusing to remove an unexpected secret path');
  await limactl(['sh', '-c', 'sudo find "$1" -maxdepth 1 -type f -delete; sudo rmdir "$1" 2>/dev/null || true', 'sh', secretDir]).catch(() => {});
}

export async function runAgentContainer(run: AgentContainerRun): Promise<AgentContainerResult> {
  const image = await ensureAgentImage();
  const runtime = new LimaDockerRuntimeDriver();
  const session = getMCPServerHost().registerSession(run.state, IDLE_MS + 5 * 60_000);
  const containerName = `sulla-agent-${ safeName(run.jobId) }-${ run.taskIndex }`;
  let secretDir: string | undefined;
  let containerId: string | undefined;
  try {
    const configuration = await containerEnvironment(run, session.id);
    const desktopHostIp = (await limactl(['sh', '-c', "getent hosts host.lima.internal | awk 'NR==1 {print $1}'"])).stdout.trim();
    if (!desktopHostIp) throw new Error('Could not resolve Desktop host from the Lima VM');
    secretDir = await provisionContainerSecrets(containerName, configuration.secrets);
    containerId = await runtime.create({
      name:   containerName,
      image,
      labels: {
        'com.sulla.workload':   'agent',
        'com.sulla.job-id':     run.jobId,
        'com.sulla.task-index': String(run.taskIndex),
      },
      autoRemove:  true,
      stdinOpen:   true,
      env:         configuration.env,
      binds:       [`${ secretDir }:/run/secrets/sulla-agent:rw`],
      extraHosts:  [`host.lima.internal:${ desktopHostIp }`],
      memoryLimit: MEMORY,
      cpuLimit:    CPUS,
    });

    return await new Promise((resolve, reject) => {
      const args = [
        'shell', '0', '--', 'docker', 'start', '--attach', '--interactive', containerId,
      ];
      const proc = childProcess.spawn(paths.limactl, args, {
        env:   { ...process.env, LIMA_HOME: paths.lima },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout>;
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
        session.revoke();
        if (secretDir) await removeContainerSecrets(secretDir);
        if (error) reject(error);
        else resolve({ output: output.slice(-200_000), containerName });
      };
      const onData = (chunk: Buffer) => {
        resetIdle();
        output += chunk.toString('utf8');
        if (output.length > 400_000) output = output.slice(-200_000);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.once('error', error => { finish(error).catch(reject) });
      proc.once('close', code => { finish(code === 0 ? undefined : new Error(`Agent container exited ${ code }: ${ output.slice(-4_000) }`)).catch(reject) });
      if (run.signal) {
        run.signal.addEventListener('abort', () => {
          runtime.remove(containerName).catch(() => {});
        }, { once: true });
      }
      resetIdle();
      const prompt = run.provider === 'claude-code'
        ? `${ JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: run.prompt }] } }) }\n`
        : run.prompt;
      proc.stdin.end(prompt);
    });
  } catch (error) {
    session.revoke();
    if (containerId) await runtime.remove(containerId).catch(() => {});
    if (secretDir) await removeContainerSecrets(secretDir);
    throw error;
  }
}

/** Remove agent containers left behind by a Desktop crash/restart. */
export async function reapOrphanAgentContainers(): Promise<void> {
  try {
    await limactl(['sh', '-c', 'docker ps -aq --filter label=com.sulla.workload=agent | xargs -r docker rm -f']);
  } catch (error) {
    // Agent containers are optional and must never prevent Desktop startup.
    log.warn(`[AgentContainer] startup orphan reap skipped: ${ (error as Error).message }`);
  }
}
