// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), run: vi.fn(), release: vi.fn(), runtimeDuringCommand: undefined as unknown }));
vi.mock('@pkg/agent/languagemodels/credentials/ClaudeCredentialResolver', () => ({ claudeCredentialResolver: { resolve: mocks.resolve } }));
vi.mock('@pkg/agent/languagemodels/guestClaudeBridge', () => ({ releaseLease: mocks.release }));
vi.mock('@pkg/agent/tools/util/CommandRunner', () => ({ runCommand: mocks.run }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { log: vi.fn(), warn: vi.fn() } } }));

import { initializeMainClaudeModelCatalogBoundary, clearClaudeModelCatalogCache, listClaudeCodeModels } from '@pkg/agent/languagemodels/claudeModelCatalog';
import { currentAgentContainerRuntime, withAgentContainerRuntime } from '@pkg/agent/services/AgentContainerRuntimeRegistry';

const models = [{ value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Claude Fable 5.2', supportsEffort: true, supportedEffortLevels: ['high', 'max'] }];
const worker = { podId: 'catalog-worker', subject: 'test-owner', jobId: 'catalog-job', deviceId: 'test-device', workspacePath: '/workspace' };

beforeEach(() => {
  vi.clearAllMocks();
  clearClaudeModelCatalogCache();
  initializeMainClaudeModelCatalogBoundary();
  mocks.resolve.mockResolvedValue({ kind: 'oauth-capability', oauthToken: 'private-fixture-token', accountId: 'owner-account', lease: { id: 'lease' } });
  mocks.run.mockImplementation(async(_command: string, _args: string[], options: unknown) => {
    mocks.runtimeDuringCommand = currentAgentContainerRuntime();
    return { exitCode: 0, stdout: JSON.stringify(models), options };
  });
});

describe('main-owned Claude catalog boundary', () => {
  it('serves live metadata to a worker without running discovery in its container context', async() => {
    const result = await withAgentContainerRuntime(worker, () => listClaudeCodeModels());

    expect(result).toContainEqual({ id: 'claude-fable-5-2', name: 'Claude Fable 5.2', efforts: [{ id: 'high' }, { id: 'max' }] });
    expect(mocks.runtimeDuringCommand).toBeUndefined();
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.run.mock.calls[0][2].runInGuest).toBe(true);
    expect(JSON.parse(mocks.run.mock.calls[0][2].stdin).environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('private-fixture-token');
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(currentAgentContainerRuntime()).toBeUndefined();
  });

  it('coalesces concurrent worker requests into the one fixed catalog operation', async() => {
    let resolveRun!: (value: { exitCode: number; stdout: string }) => void;
    mocks.run.mockImplementation((_command: string, _args: string[], options: unknown) => {
      mocks.runtimeDuringCommand = currentAgentContainerRuntime();
      return new Promise(resolve => { resolveRun = resolve as typeof resolveRun });
    });
    const a = withAgentContainerRuntime(worker, () => listClaudeCodeModels());
    const b = withAgentContainerRuntime({ ...worker, podId: 'other-worker' }, () => listClaudeCodeModels());
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    resolveRun({ exitCode: 0, stdout: JSON.stringify(models) });
    const [first, second] = await Promise.all([a, b]);

    expect(first).toEqual(second);
    expect(mocks.runtimeDuringCommand).toBeUndefined();
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });
});
