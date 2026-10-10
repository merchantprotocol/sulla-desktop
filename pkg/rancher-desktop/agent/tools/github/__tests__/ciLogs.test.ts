import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const listForRef = jest.fn<(...args: any[]) => Promise<any>>();
const listAnnotations = jest.fn<(...args: any[]) => Promise<any>>();
const request = jest.fn<(...args: any[]) => Promise<any>>();
const getIntegrationValue = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('@octokit/rest', () => ({
  Octokit: class {
    checks = { listForRef, listAnnotations };
    actions = { getJobForWorkflowRun: jest.fn(), listJobsForWorkflowRun: jest.fn() };
    request = request;
  },
}));
jest.unstable_mockModule('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({ getIntegrationValue }),
}));
jest.unstable_mockModule('../../base', () => ({ BaseTool: class {} }));

const { GitHubCILogsWorker, trimJobLog } = await import('../github_ci_logs');
const call = (input: any) => (new GitHubCILogsWorker() as any)._validatedCall(input);

beforeEach(() => {
  jest.clearAllMocks();
  getIntegrationValue.mockResolvedValue({ value: 'test-token' });
  listForRef.mockResolvedValue({ data: { check_runs: [{
    id: 42, name: 'unit', conclusion: 'failure', details_url: 'https://github.com/org/repo/actions/runs/7/job/99',
  }] } });
  listAnnotations.mockResolvedValue({ data: [{
    annotation_level: 'failure', path: 'src/tool.ts', start_line: 12, title: 'Test failed', message: 'expected true',
  }] });
  request.mockResolvedValue({ data: 'setup\n##[group]Run tests\nassertion\n##[error]expected true\ncleanup\n' });
});

describe('github_ci_logs', () => {
  it('combines failing check annotations with the Actions job log', async() => {
    const result = await call({ owner: 'org', repo: 'repo', ref: 'feature', maxLines: 40 });

    expect(result).toMatchObject({ successBoolean: true });
    expect(result.responseString).toContain('src/tool.ts:12');
    expect(result.responseString).toContain('job 99');
    expect(result.responseString).toContain('##[error]expected true');
    expect(request).toHaveBeenCalledWith(expect.stringContaining('/actions/jobs/{job_id}/logs'), expect.objectContaining({ job_id: 99 }));
  });

  it('trims from the failing step instead of returning an unbounded tail', () => {
    const log = Array.from({ length: 40 }, (_, index) => `setup ${ index }`).join('\n') +
      '\n##[group]Run failing step\nline one\n##[error]boom\nline two';
    const trimmed = trimJobLog(log, 20);

    expect(trimmed).toContain('Run failing step');
    expect(trimmed).toContain('boom');
    expect(trimmed.split('\n').length).toBeLessThanOrEqual(20);
  });
});
