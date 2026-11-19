// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearClaudeModelCatalogCache, listClaudeCodeModels } from '@pkg/agent/languagemodels/claudeModelCatalog';

const f = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('@pkg/agent/tools/util/CommandRunner', () => ({ runCommand: f.runCommand }));
vi.mock('@pkg/agent/languagemodels/credentials/ClaudeCredentialResolver', () => ({ claudeCredentialResolver: { resolve: () => Promise.resolve({ kind: 'api-key', apiKey: 'fixture-key', source: 'integration-vault' }) } }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { log: vi.fn(), warn: vi.fn() } } }));

const help = { exitCode: 0, stdout: 'Usage: claude\n  --effort <level>    Effort level for the current session\n    (low, medium, high, xhigh, max)\n  --model <model>' };
const opus = (models: Awaited<ReturnType<typeof listClaudeCodeModels>>) => models.find(model => model.id === 'opus');
beforeEach(() => {
  f.runCommand.mockReset(); clearClaudeModelCatalogCache();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async() => ({ data: [{ id: 'opus', display_name: 'Opus' }] }) }));
});
describe('Claude effort discovery', () => {
  it('retries a failed help lookup before validating a configured effort', async() => {
    f.runCommand.mockResolvedValueOnce({ exitCode: 1, stdout: '' }).mockResolvedValue(help);
    expect(opus(await listClaudeCodeModels())?.efforts).toContainEqual({ id: 'medium' });
    expect(f.runCommand).toHaveBeenCalledTimes(2);
    await listClaudeCodeModels();
    expect(f.runCommand).toHaveBeenCalledTimes(2);
  });
  it('does not cache a temporary failure as an unsupported effort list', async() => {
    f.runCommand.mockRejectedValueOnce(new Error('synthetic temporary runtime failure')).mockResolvedValueOnce({ exitCode: 1, stdout: '' }).mockResolvedValue(help);
    expect(opus(await listClaudeCodeModels())?.efforts).toBeUndefined();
    expect(opus(await listClaudeCodeModels())?.efforts).toContainEqual({ id: 'medium' });
    expect(f.runCommand).toHaveBeenCalledTimes(3);
  });
  it('keeps a confirmed CLI without effort support unsupported', async() => {
    f.runCommand.mockResolvedValue({ exitCode: 0, stdout: 'Usage: claude\n  --model <model>' });
    expect(opus(await listClaudeCodeModels())?.efforts).toBeUndefined();
    await listClaudeCodeModels();
    expect(f.runCommand).toHaveBeenCalledTimes(1);
  });
  it('retries an unrecognized effort declaration without inventing supported levels', async() => {
    f.runCommand.mockResolvedValueOnce({ exitCode: 0, stdout: 'Usage: claude\n --effort <level> unknown help format' }).mockResolvedValue(help);
    expect(opus(await listClaudeCodeModels())?.efforts).toContainEqual({ id: 'medium' });
    expect(f.runCommand).toHaveBeenCalledTimes(2);
  });
});
