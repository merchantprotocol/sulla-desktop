import { afterEach, describe, expect, it, jest } from '@jest/globals';

const runCommandMock: any = jest.fn();

jest.unstable_mockModule('../../util/CommandRunner', () => ({
  runCommand: runCommandMock,
}));

async function loadExecModule() {
  return import('../exec');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('exec security guardrails', () => {
  afterEach(() => {
    runCommandMock.mockReset();
  });

  it('allows benign format usages in flags and JSON headers', async() => {
    const { ExecWorker } = await loadExecModule();
    const worker = new ExecWorker() as any;

    expect(worker.getForbiddenPattern('docker ps --format json')).toBeNull();
    expect(worker.getForbiddenPattern('curl -H "Content-Type: application/json" https://example.com')).toBeNull();
    expect(worker.getForbiddenPattern('curl --data "{\"format\":\"json\"}" https://example.com')).toBeNull();
  });

  it('blocks true dangerous formatting commands', async() => {
    const { ExecWorker } = await loadExecModule();
    const worker = new ExecWorker() as any;

    expect(worker.getForbiddenPattern('mkfs.ext4 /dev/sda1')).not.toBeNull();
    expect(worker.getForbiddenPattern('format C:')).not.toBeNull();
    expect(worker.getForbiddenPattern('cmd /c format.com D:')).not.toBeNull();
  });

  it('reproduces lima instance-missing failure when exec is invoked with real-style command payload', async() => {
    const { ExecWorker, execRegistration } = await loadExecModule();

    runCommandMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout:   '',
      stderr:   'time="2026-02-19T19:59:03-08:00" level=fatal msg="instance \\\"0\\\" does not exist, run `limactl create 0` to create a new instance"\n',
    });

    const worker = configureWorker(new ExecWorker(), execRegistration);
    const command = 'psql -h localhost -p 30116 -U sulla -d sulla -c "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = \'agent_plan_todos\' AND column_name = \'description\';" 2>&1 || echo "FAILED"';
    const result = await worker.invoke({ command });

    expect(runCommandMock).toHaveBeenCalledWith(
      command,
      [],
      expect.objectContaining({ runInLimaShell: true }),
    );
    expect(result.success).toBe(false);
    expect(result.result as string).toContain('Command failed with exit code 1');
    expect(result.result as string).toContain('instance \\\"0\\\" does not exist');
  });

  it('accepts cmd alias and forwards it to runCommand', async() => {
    const { ExecWorker, execRegistration } = await loadExecModule();

    runCommandMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout:   'ok',
      stderr:   '',
    });

    const worker = configureWorker(new ExecWorker(), execRegistration);
    const result = await worker.invoke({ cmd: 'echo ok' });

    expect(runCommandMock).toHaveBeenCalledWith(
      'echo ok',
      [],
      expect.objectContaining({ runInLimaShell: true }),
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe('ok');
  });

  it('returns a clear error when neither command nor cmd is provided', async() => {
    const { ExecWorker, execRegistration } = await loadExecModule();
    const worker = configureWorker(new ExecWorker(), execRegistration);

    const result = await worker.invoke({});

    expect(result.success).toBe(false);
    expect(result.result).toContain('Missing required field: command (or cmd)');
  });
});
