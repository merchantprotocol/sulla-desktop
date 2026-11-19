// SPDX-License-Identifier: GPL-2.0-or-later
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), run: vi.fn(), release: vi.fn() }));
vi.mock('../../../languagemodels/credentials/ClaudeCredentialResolver', () => ({ claudeCredentialResolver: { resolve: mocks.resolve } }));
vi.mock('@pkg/backend/providerCliUpdates', () => ({ approvedCliVersions: async() => [] }));
vi.mock('../../../languagemodels/guestClaudeBridge', () => ({ releaseLease: mocks.release }));
vi.mock('../../../tools/util/CommandRunner', () => ({ runCommand: mocks.run }));
import { fetchClaudeCliModels, parseClaudeCliModels } from '../../../languagemodels/claudeCliModelDiscovery';

const cliModels = [
  { value: 'default', resolvedModel: 'claude-opus-new', displayName: 'Default' },
  { value: 'opus', resolvedModel: 'claude-opus-new', displayName: 'Opus New', supportsEffort: true, supportedEffortLevels: ['high', 'max'] },
  { value: 'fable', resolvedModel: 'claude-fable-new', displayName: 'Fable New', supportsEffort: true, supportedEffortLevels: ['high'] },
  { value: 'new-family', resolvedModel: 'claude-new-family', displayName: 'New Family' },
];
beforeEach(() => { vi.clearAllMocks(); });
describe('Claude CLI live discovery', () => {
  it('uses the CLI response including unknown future families and per-model efforts', () => {
    expect(parseClaudeCliModels(cliModels)).toEqual([
      { id: 'claude-opus-new', name: 'Opus New', efforts: [{ id: 'high' }, { id: 'max' }] },
      { id: 'opus', name: 'Opus New (CLI alias)', efforts: [{ id: 'high' }, { id: 'max' }] },
      { id: 'claude-fable-new', name: 'Fable New', efforts: [{ id: 'high' }] },
      { id: 'fable', name: 'Fable New (CLI alias)', efforts: [{ id: 'high' }] },
      { id: 'claude-new-family', name: 'New Family' },
      { id: 'new-family', name: 'New Family (CLI alias)' },
    ]);
  });
  it('rejects malformed entries and removes duplicates without inventing models', () => {
    expect(parseClaudeCliModels([null, { value: 'bad id' }, {}, ...cliModels, cliModels[1]])).toHaveLength(6);
    expect(parseClaudeCliModels({ models: cliModels })).toEqual([]);
  });
  it('uses the selected account lease and stdin credentials, then releases it', async() => {
    const lease = {};
    mocks.resolve.mockResolvedValue({ kind: 'oauth-capability', oauthToken: 'private-test-token', baseUrl: 'http://broker.test', accountId: 'owner-account', lease });
    mocks.run.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(cliModels) });
    expect(await fetchClaudeCliModels('owner-account')).toHaveLength(6);
    const [command, , options] = mocks.run.mock.calls[0];
    expect(command).not.toContain('private-test-token');
    expect(JSON.parse(options.stdin).environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('private-test-token');
    expect(command).toContain('initialize');
    expect(command).toContain('--no-session-persistence');
    expect(options.runInGuest).toBe(true);
    expect(mocks.release).toHaveBeenCalledWith(lease);
  });
  it('does not use a CLI capability if the selected account changed between metadata and execution resolution', async() => {
    const lease = {};
    mocks.resolve.mockResolvedValue({ kind: 'oauth-capability', oauthToken: 'private-test-token', accountId: 'other-account', lease });
    expect(await fetchClaudeCliModels('owner-account')).toBeNull();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(lease);
  });
  it('runs the control handshake to completion without sending a user prompt', async() => {
    const dir = mkdtempSync(join(tmpdir(), 'sulla-cli-catalog-'));
    try {
      writeFileSync(join(dir, 'claude'), `#!/usr/bin/env node
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).once('line',line=>{
 const x=JSON.parse(line);
 if(x.type!=='control_request'||x.request.subtype!=='initialize')process.exit(2);
 process.stdout.write(JSON.stringify({type:'control_response',response:{request_id:x.request_id,subtype:'success',response:{models:${ JSON.stringify(cliModels) }}}})+'\\n');
});`, { mode: 0o755 });
      mocks.resolve.mockResolvedValue({ kind: 'oauth-capability', oauthToken: 'private-fixture-token' });
      mocks.run.mockImplementation(async(command, _args, options) => {
        const result = spawnSync('sh', ['-c', command], { input: options.stdin, encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: `${ dir }:${ process.env.PATH }` } });
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
      });
      expect(await fetchClaudeCliModels()).toHaveLength(6);
    } finally { rmSync(dir, { recursive: true, force: true }) }
  });
  it('returns failure instead of a fixed list and releases the lease after a timeout', async() => {
    const lease = {};
    mocks.resolve.mockResolvedValue({ kind: 'oauth-capability', oauthToken: 'private-test-token', lease });
    mocks.run.mockResolvedValue({ exitCode: -1, stdout: 'partial' });
    expect(await fetchClaudeCliModels()).toBeNull();
    expect(mocks.release).toHaveBeenCalledWith(lease);
  });
});
