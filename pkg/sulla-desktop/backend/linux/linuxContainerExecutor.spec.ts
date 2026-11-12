// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { DockerCli, DockerCliResult, LinuxContainerExecutor } from './linuxContainerExecutor';

class FakeCli implements DockerCli {
  calls: { args: string[]; input?: string; env?: NodeJS.ProcessEnv }[] = [];
  constructor(private readonly reply: (args: string[]) => DockerCliResult = () => ({ stdout: '', stderr: '', exitCode: 0 })) {}
  async run(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.calls.push({ args, ...options });
    return this.reply(args);
  }
  spawn(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): any {
    this.calls.push({ args, ...options });
    return { fake: true };
  }
}

const NAME = 'sulla-desktop-linux-runtime';

describe('LinuxContainerExecutor', () => {
  it('only addresses its own sulla-desktop container', () => {
    // risk: acting on a user's other containers
    expect(() => new LinuxContainerExecutor(new FakeCli(), 'postgres')).toThrow(/sulla-desktop-/);
  });

  it('runs commands in the container, returns captured stdout, and keeps env values out of argv', async() => {
    // risk: secret leakage through the host process list
    const cli = new FakeCli(() => ({ stdout: 'out', stderr: '', exitCode: 0 }));
    const out = await new LinuxContainerExecutor(cli, NAME).execCommand(
      { capture: true, root: true, cwd: '/mnt/data', env: { TOKEN: 's3cret' } }, 'echo', 'hi');

    expect(out).toBe('out');
    expect(cli.calls[0].args).toEqual(['exec', '--user', '0:0', '--workdir', '/mnt/data', '--env', 'TOKEN', NAME, 'echo', 'hi']);
    expect(cli.calls[0].args.join(' ')).not.toContain('s3cret');
    expect(cli.calls[0].env).toMatchObject({ TOKEN: 's3cret' });
  });

  it('rejects with stderr and exit code when the command fails, never a false success', async() => {
    const cli = new FakeCli(() => ({ stdout: '', stderr: 'boom', exitCode: 3 }));

    await expect(new LinuxContainerExecutor(cli, NAME).execCommand('false')).rejects.toMatchObject({ code: 3, stderr: 'boom' });
  });

  it('refuses empty commands', async() => {
    await expect(new LinuxContainerExecutor(new FakeCli(), NAME).execCommand({}, ...[])).rejects.toThrow(/command is required/);
  });

  it('writes files atomically through stdin with the requested mode, not through argv', async() => {
    // risk: data accuracy / file contents leaking into process list
    const cli = new FakeCli();
    await new LinuxContainerExecutor(cli, NAME).writeFile('/etc/sulla-env', 'A=1\n', 0o600);

    expect(cli.calls[0].input).toBe('A=1\n');
    expect(cli.calls[0].args).toEqual(expect.arrayContaining(['-i', NAME, 'sh', '/etc/sulla-env', '600']));
    expect(cli.calls[0].args.join(' ')).not.toContain('A=1');
  });

  it('surfaces write/read failures and rejects relative guest paths', async() => {
    const failing = new FakeCli(() => ({ stdout: '', stderr: 'denied', exitCode: 1 }));
    const executor = new LinuxContainerExecutor(failing, NAME);

    await expect(executor.writeFile('/x', 'a')).rejects.toThrow(/denied/);
    await expect(executor.readFile('/x')).rejects.toThrow(/denied/);
    await expect(executor.readFile('relative')).rejects.toThrow(/absolute/);
    await expect(executor.writeFile('/x', 'a', '9999' as any)).rejects.toThrow(/octal/);
  });

  it('reads files and decodes with the requested encoding', async() => {
    const cli = new FakeCli(() => ({ stdout: 'hello', stderr: '', exitCode: 0 }));

    expect(await new LinuxContainerExecutor(cli, NAME).readFile('/etc/x', { encoding: 'base64' })).toBe('aGVsbG8=');
    expect(cli.calls[0].args).toEqual(['exec', NAME, 'cat', '--', '/etc/x']);
  });

  it('copies in/out with docker cp using absolute paths and normalizes the mode on copy-in', async() => {
    const cli = new FakeCli();
    const executor = new LinuxContainerExecutor(cli, NAME);

    await executor.copyFileIn('/home/u/a.txt', '/mnt/data/a.txt');
    await executor.copyFileOut('/mnt/data/a.txt', '/home/u/b.txt');
    expect(cli.calls[0].args).toEqual(['cp', '--', '/home/u/a.txt', `${ NAME }:/mnt/data/a.txt`]);
    expect(cli.calls[1].args).toEqual(expect.arrayContaining(['chmod', '644', '/mnt/data/a.txt']));
    expect(cli.calls[2].args).toEqual(['cp', '--', `${ NAME }:/mnt/data/a.txt`, '/home/u/b.txt']);
    await expect(executor.copyFileIn('rel', '/x')).rejects.toThrow(/absolute/);
    await expect(executor.copyFileOut('/x', `${ NAME }:/y`)).rejects.toThrow(/absolute/);
  });

  it('spawns interactive exec in the container', () => {
    const cli = new FakeCli();

    new LinuxContainerExecutor(cli, NAME).spawn('cat');
    expect(cli.calls[0].args).toEqual(['exec', '-i', NAME, 'cat']);
  });
});
