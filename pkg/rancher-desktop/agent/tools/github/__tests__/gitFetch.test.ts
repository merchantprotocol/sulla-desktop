import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runCommand = jest.fn<(...args: any[]) => Promise<any>>();
const getIntegrationValue = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../util/CommandRunner', () => ({ runCommand }));
jest.unstable_mockModule('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({ getIntegrationValue }),
}));
jest.unstable_mockModule('../../base', () => ({ BaseTool: class {} }));

const { GitFetchWorker } = await import('../git_fetch');
const call = (input: any) => (new GitFetchWorker() as any)._validatedCall(input);

beforeEach(() => {
  jest.clearAllMocks();
  getIntegrationValue.mockResolvedValue({ value: 'test-token' });
  runCommand
    .mockResolvedValueOnce({ exitCode: 0, stdout: '/repo\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'git@github.com:org/repo.git\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin/main bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', stderr: '' });
});

describe('git_fetch', () => {
  it('uses vault-backed ephemeral credentials and reports updated refs', async() => {
    const result = await call({ absolutePath: '/repo', branch: 'main', prune: true });
    const fetchCommand = runCommand.mock.calls[3][0];

    expect(result).toMatchObject({ successBoolean: true });
    expect(result.responseString).toContain('aaaaaaaaaaaa -> bbbbbbbbbbbb');
    expect(fetchCommand).toContain('GIT_TERMINAL_PROMPT=0');
    expect(fetchCommand).toContain('refs/remotes/origin/main');
    expect(fetchCommand).toContain('--prune');
    expect(result.responseString).not.toContain('test-token');
  });
});
