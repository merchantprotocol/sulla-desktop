import { spawn } from 'child_process';

import { currentAgentContainerRuntime } from '../../services/AgentContainerRuntimeRegistry';

import paths from '@pkg/utils/paths';

export interface CommandRunnerOptions {
  timeoutMs?:      number;
  maxOutputChars?: number;
  stdin?:          string;
  runInLimaShell?: boolean;
  limaInstance?:   string;
  /** Override the canonical `paths.lima` (rarely needed; tests/migrations only). */
  limaHome?:       string;
  /** Override the canonical `paths.limactl` (rarely needed; tests/migrations only). */
  limactlPath?:    string;
}

export function commandExecutionTarget(hasContainerRuntime: boolean, runInLimaShell = false): 'container' | 'vm' | 'host' {
  if (hasContainerRuntime) return 'container';
  return runInLimaShell ? 'vm' : 'host';
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(value)) {
    return value;
  }
  return `'${ value.split("'").join("'\"'\"'") }'`;
}

/**
 * Resolve LIMA_HOME. Prefers explicit override, then the canonical
 * `paths.lima` (SSOT — see `pkg/rancher-desktop/utils/paths.ts`).
 */
export function resolveLimaHome(options: CommandRunnerOptions = {}): string {
  return options.limaHome || process.env.LIMA_HOME || paths.lima;
}

/**
 * Resolve the limactl binary. Prefers explicit override, then the canonical
 * `paths.limactl` (SSOT — see `pkg/rancher-desktop/utils/paths.ts`).
 */
export function resolveLimactlPath(options: CommandRunnerOptions = {}): string {
  return options.limactlPath || process.env.LIMACTL_PATH || paths.limactl;
}

function executeSpawn(
  command: string,
  args: string[],
  options: CommandRunnerOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputChars = options.maxOutputChars ?? 200_000;

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      resolve({
        stdout:   '',
        stderr:   `Failed to spawn '${ command }': ${ errorMessage }`,
        exitCode: 127,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill('SIGKILL');
        finished = true;
        resolve({
          stdout:   stdout.slice(0, maxOutputChars) + '\n[timeout truncated]',
          stderr:   stderr.slice(0, maxOutputChars) + '\n[timeout]',
          exitCode: -1,
        });
      }
    }, timeoutMs);

    child.on('error', err => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({
          stdout:   '',
          stderr:   `Spawn error: ${ err.message }`,
          exitCode: 127,
        });
      }
    });
    child.stdin?.on('error', () => {});

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > maxOutputChars * 2) stdout = stdout.slice(0, maxOutputChars * 2) + '\n[truncated]';
    });

    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > maxOutputChars * 2) stderr = stderr.slice(0, maxOutputChars * 2) + '\n[truncated]';
    });

    child.on('close', code => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);

        const out = stdout.length > maxOutputChars ? stdout.slice(0, maxOutputChars) + '\n[truncated]' : stdout;
        const err = stderr.length > maxOutputChars ? stderr.slice(0, maxOutputChars) + '\n[truncated]' : stderr;

        resolve({ stdout: out, stderr: err, exitCode: code ?? 0 });
      }
    });

    if (options.stdin) {
      child.stdin?.write(options.stdin, () => {});
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandRunnerOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runtime = currentAgentContainerRuntime();

  // An agent-local runtime is the security boundary. Legacy callers still
  // say runInLimaShell because that used to mean "not the Electron host";
  // once a graph is container-bound it must never punch back into the VM.
  if (commandExecutionTarget(Boolean(runtime), options.runInLimaShell) === 'container') {
    const rawScript = args.length === 0
      ? command
      : [command, ...args.map(arg => quoteShellArg(arg))].join(' ');
    const limaHome = resolveLimaHome(options);
    const limactlPath = resolveLimactlPath(options);
    const dockerArgs = ['shell', options.limaInstance || '0', '--', 'docker', 'exec', '-i', runtime.podId, '/bin/bash', '-lc', rawScript];

    let result = await executeSpawn('env', [`LIMA_HOME=${ limaHome }`, limactlPath, ...dockerArgs], options);

    if (result.exitCode === 127) {
      result = await executeSpawn('env', [`LIMA_HOME=${ limaHome }`, 'limactl', ...dockerArgs], options);
    }

    return result;
  }

  if (commandExecutionTarget(false, options.runInLimaShell) === 'vm') {
    // Lima only exists on macOS/Linux; paths.limactl is a throwing getter on
    // Windows. Fail with a clear message instead of crashing the caller.
    if (process.platform === 'win32') {
      return {
        stdout:   '',
        stderr:   'VM command execution requires the Lima VM, which is not available on Windows. This feature currently supports macOS and Linux only.',
        exitCode: 127,
      };
    }
    const limaHome = resolveLimaHome(options);
    const limactlPath = resolveLimactlPath(options);
    const limaInstance = options.limaInstance || '0';

    const rawScript = args.length === 0
      ? command
      : [command, ...args.map(arg => quoteShellArg(arg))].join(' ');

    // Keep Lima's guest-owned HOME. User-selected host content is reachable
    // only through Files; a failed VM lookup must never become host execution.
    const limaPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const script = `export PATH=${ quoteShellArg(limaPath) }; ${ rawScript }`;

    const limactlArgs = ['shell', limaInstance, '--', 'sh', '-lc', script];
    let result = await executeSpawn('env', [`LIMA_HOME=${ limaHome }`, limactlPath, ...limactlArgs], options);

    if (result.exitCode === 127) {
      result = await executeSpawn('env', [`LIMA_HOME=${ limaHome }`, 'limactl', ...limactlArgs], options);
    }

    return result;
  }

  // Special handling for sh/bash -c full scripts
  const finalCommand = command;
  let finalArgs = [...args];

  if (command === 'sh' && args.length >= 2 && args[0] === '-c') {
    // Join remaining args as full script (preserves pipes, &&, redirects)
    const script = args.slice(1).join(' ');
    finalArgs = ['-c', script];
  } else if (command === 'bash' || command === 'zsh') {
    // Same logic for other shells
    const script = args.join(' ');
    finalArgs = ['-c', script];
  }

  return executeSpawn(finalCommand, finalArgs, options);
}
