import { afterEach, describe, expect, it, jest } from '@jest/globals';

const runCommandMock: any = jest.fn();

jest.unstable_mockModule('../../util/CommandRunner', () => ({
  runCommand: runCommandMock,
}));

async function loadModule() {
  return import('../lima_shell');
}

describe('lima_shell command construction (issue #78)', () => {
  afterEach(() => {
    runCommandMock.mockReset();
  });

  it('wraps a multi-word command in `sh -lc` so the guest shell parses it', async() => {
    runCommandMock.mockResolvedValue({ stdout: 'Linux lima-test 6.8.0', stderr: '', exitCode: 0 });

    const { LimaShellWorker } = await loadModule();
    const worker = new LimaShellWorker() as any;

    const res = await worker._validatedCall({ instance: 'test-vm', command: 'uname -a' });

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = runCommandMock.mock.calls[0];

    expect(cmd).toBe('limactl');
    // The command must be handed to the guest shell as its own argv element,
    // NOT concatenated into a single `-- "uname -a"` token (the pre-fix bug
    // that produced `uname -a: command not found`).
    expect(args).toEqual(['shell', 'test-vm', '--', 'sh', '-lc', 'uname -a']);
    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('Linux lima-test');
  });

  it('preserves pipes, arguments and redirects inside the wrapped command', async() => {
    runCommandMock.mockResolvedValue({ stdout: '3', stderr: '', exitCode: 0 });

    const { LimaShellWorker } = await loadModule();
    const worker = new LimaShellWorker() as any;

    const script = 'ls -la /tmp | grep foo | wc -l';
    await worker._validatedCall({ instance: 'test-vm', command: script });

    const [, args] = runCommandMock.mock.calls[0];

    // The full script stays a single argv element after `sh -lc`, so the guest
    // shell — not limactl's argv splitter — interprets the pipeline.
    expect(args).toEqual(['shell', 'test-vm', '--', 'sh', '-lc', script]);
  });

  it('opens an interactive shell (no `--` command) when command is omitted', async() => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const { LimaShellWorker } = await loadModule();
    const worker = new LimaShellWorker() as any;

    await worker._validatedCall({ instance: 'test-vm' });

    const [, args] = runCommandMock.mock.calls[0];

    expect(args).toEqual(['shell', 'test-vm']);
  });

  it('surfaces a non-zero exit as a failure response', async() => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });

    const { LimaShellWorker } = await loadModule();
    const worker = new LimaShellWorker() as any;

    const res = await worker._validatedCall({ instance: 'test-vm', command: 'false' });

    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toContain('boom');
  });
});
