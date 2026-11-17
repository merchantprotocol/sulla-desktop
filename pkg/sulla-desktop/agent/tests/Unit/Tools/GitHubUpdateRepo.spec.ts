// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

const { createGitHubOctokit } = vi.hoisted(() => ({ createGitHubOctokit: vi.fn() }));
vi.mock('../../../tools/github/octokit', () => ({ createGitHubOctokit }));
// Approval policy storage belongs to the application/Postgres runtime; these tests exercise the registered tool path, not policy persistence.
// The tool approval port is injected (see tools/toolDecisionPort.ts); this suite registers a port that approves nothing gated.
// Settings reads fall back to an installation file whose path only the app bootstrap sets ('Fallback path not set' in tests); answer every read with its default.
vi.mock('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: vi.fn(async(_key: string, fallback?: unknown) => fallback), set: vi.fn(async() => undefined) },
}));

import { githubToolManifests } from '../../../tools/github/manifests';
import { ToolRegistry } from '../../../tools/registry';
import { toolDecisionPort } from '../../../tools/toolDecisionPort';

toolDecisionPort.register({ requiresApproval: vi.fn().mockResolvedValue(false), request: vi.fn() });

describe('github_update_repo registered tool', () => {
  const setup = async() => {
    const update = vi.fn(async() => ({ data: { full_name: 'acme/new-name' } }));
    const replaceAllTopics = vi.fn(async() => ({ data: { names: ['alpha'] } }));
    createGitHubOctokit.mockResolvedValue({ repos: { update, replaceAllTopics } });
    const registry = new ToolRegistry();
    registry.registerManifests(githubToolManifests.filter(manifest => manifest.name === 'github_update_repo'));
    const tool = await registry.createToolForCategory('github', 'update_repo');
    return { tool, update, replaceAllTopics };
  };

  it('updates only a description through the registered tool', async() => {
    const { tool, update, replaceAllTopics } = await setup();
    const result = await tool.call({ owner: 'acme', repo: 'repo', description: 'Updated' });
    expect(result.success).toBe(true);
    expect(result.result).toContain('Changed: description');
    expect(update).toHaveBeenCalledWith({ owner: 'acme', repo: 'repo', description: 'Updated' });
    expect(replaceAllTopics).not.toHaveBeenCalled();
  });

  it('replaces topics only without issuing a repository PATCH', async() => {
    const { tool, update, replaceAllTopics } = await setup();
    const result = await tool.call({ owner: 'acme', repo: 'repo', topics: ['alpha'] });
    expect(result.success).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(replaceAllTopics).toHaveBeenCalledWith({ owner: 'acme', repo: 'repo', names: ['alpha'] });
  });

  it('reports the renamed full_name', async() => {
    const { tool, update } = await setup();
    const result = await tool.call({ owner: 'acme', repo: 'repo', name: 'new-name' });
    expect(result.success).toBe(true);
    expect(result.result).toContain('acme/new-name');
    expect(update).toHaveBeenCalledWith({ owner: 'acme', repo: 'repo', name: 'new-name' });
  });

  it('reports metadata success when replacing topics fails', async() => {
    // risk: data accuracy — callers must know a metadata mutation succeeded despite a later topics failure.
    const { tool, update, replaceAllTopics } = await setup();
    replaceAllTopics.mockRejectedValueOnce(new Error('topics unavailable'));
    const result = await tool.call({ owner: 'acme', repo: 'repo', name: 'new-name', topics: ['alpha'] });
    expect(update).toHaveBeenCalled();
    expect(replaceAllTopics).toHaveBeenCalledWith({ owner: 'acme', repo: 'new-name', names: ['alpha'] });
    expect(result.success).toBe(false);
    const detail = result.error || result.result;
    expect(detail).toContain('partially completed');
    expect(detail).toContain('repository metadata update succeeded');
    expect(detail).toContain('acme/new-name');
    expect(detail).toContain('topic replacement failed');
    expect(detail).toContain('topics unavailable');
  });

  it('rejects an empty change set and reports GitHub 403/404 errors', async() => {
    const { tool, update } = await setup();
    const empty = await tool.call({ owner: 'acme', repo: 'repo' });
    expect(empty.success).toBe(false);
    expect(empty.error || empty.result).toContain('Nothing to change');
    update.mockRejectedValueOnce({ status: 404, response: { data: { message: 'Not Found' } } });
    const missing = await tool.call({ owner: 'acme', repo: 'repo', description: 'x' });
    expect(missing.success).toBe(false);
    expect(missing.error || missing.result).toContain('404');
    expect(missing.error || missing.result).toContain('Not Found');
    update.mockRejectedValueOnce({ status: 403, response: { data: { message: 'Resource not accessible' } } });
    const forbidden = await tool.call({ owner: 'acme', repo: 'repo', description: 'x' });
    expect(forbidden.success).toBe(false);
    expect(forbidden.error || forbidden.result).toContain('403');
    expect(forbidden.error || forbidden.result).toContain('Resource not accessible');
  });
});
