/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

import { allToolManifests } from '../allManifests';
import { executionTargetFor } from '../executionTargets';
import { ToolRegistry, type ToolManifest } from '../registry';
import policy from '../tool-placement-policy.json';
import {
  integrationCallPlacement,
  integrationCallSideEffect,
  NON_READ_NAME_PATTERN,
  policySideEffect,
  requiresApproval,
  resolveToolPlacement,
  toolId,
} from '../toolPlacement';
import { renderToolPlacementCatalog } from '../toolPlacementCatalog';

// Jest runs from the repository root.
const repoRoot = process.cwd();
const ids = allToolManifests.map(m => toolId(m.category, m.name));
const byId = new Map(allToolManifests.map(m => [toolId(m.category, m.name), m]));
const placementOf = (id: string) => {
  const manifest = byId.get(id);
  if (!manifest) throw new Error(`No manifest for ${ id }`);
  return resolveToolPlacement(manifest);
};
const targetOf = (m: ToolManifest) => m.executionTarget ?? executionTargetFor(m.category, m.name);

describe('tool placement metadata', () => {
  test('tool ids are unique', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('keeps unclassified tools on Desktop, not relayable, and fails closed on unlisted writes', () => {
    expect(resolveToolPlacement({ name: 'unknown_tool', category: 'unknown', operationTypes: ['read'] })).toEqual({
      placements: ['desktop'], relayable: false, sideEffect: 'read', credential: 'none',
    });
    expect(resolveToolPlacement({ name: 'unknown_tool', category: 'unknown', operationTypes: ['execute'] }).sideEffect).toBe('irreversible');
    expect(resolveToolPlacement({ name: 'unknown_tool', category: 'unknown' }).sideEffect).toBe('irreversible');
  });

  test('manifest fields override the policy', () => {
    expect(resolveToolPlacement({
      name: 'slack_send_message', category: 'slack', operationTypes: ['execute'], placements: ['desktop'], relayable: false, sideEffect: 'write',
    })).toEqual({ placements: ['desktop'], relayable: false, sideEffect: 'write', credential: { integration: 'slack' } });
  });

  test('every non-read tool has an explicit side effect', () => {
    const unlisted = allToolManifests.filter((m) => {
      const operations = m.operationTypes ?? [];
      const derivedRead = operations.length > 0 && operations.every(operation => operation === 'read');
      return !derivedRead && !m.sideEffect && !policySideEffect(m.category, m.name);
    }).map(m => toolId(m.category, m.name));
    expect(unlisted).toEqual([]);
  });

  test('every id in the policy names a real tool, once', () => {
    const listed = [...policy.sideEffects.read, ...policy.sideEffects.write, ...policy.sideEffects.irreversible];
    expect(listed.filter(id => !byId.has(id))).toEqual([]);
    expect(listed.filter((id, i) => listed.indexOf(id) !== i)).toEqual([]);
    expect([...policy.desktopOnly, ...policy.notRelayable].filter(id => !byId.has(id))).toEqual([]);
  });

  test('no tool named for a send, post, pay, delete or public edit is read', () => {
    const reads = allToolManifests
      .filter(m => NON_READ_NAME_PATTERN.test(m.name) && resolveToolPlacement(m).sideEffect === 'read')
      .map(m => toolId(m.category, m.name));
    expect(reads).toEqual([]);
  });

  test.each([
    'files/files_link',
    'github/git_push',
    'github/github_add_pr_review',
    'github/github_close_pr',
    'github/github_comment_on_issue',
    'github/github_create_file',
    'github/github_create_issue',
    'github/github_create_pr',
    'github/github_create_release',
    'github/github_create_repo',
    'github/github_delete_repo',
    'github/github_draft_pr',
    'github/github_fork_repo',
    'github/github_request_pr_reviewers',
    'github/github_trigger_workflow_run',
    'github/github_update_file',
    'github/github_update_issue',
    'memory/pack_uninstall',
    'pg/pg_execute',
    'pg/pg_transaction',
    'redis/redis_del',
    'slack/slack_send_message',
    'slack/slack_update',
    'vault/vault_delete_credential',
  ])('%s sends, posts, publishes or deletes, so it is irreversible', (id) => {
    expect(placementOf(id).sideEffect).toBe('irreversible');
  });

  test.each([
    'browser/agent_storage',
    'browser/schedule_alarm',
    'browser/tab',
    'calendar/calendar_create',
    'calendar/calendar_update',
    'capture/camera_release',
    'capture/mic_stop',
    'capture/speaker_stop',
    'capture/teleprompter_close',
    'files/files_revoke_link',
    'github/github_merge_pr',
    'observation/add_observational_memory',
    'rules/archive_rule',
    'skills/skill_disable',
    'slack/slack_unreact',
  ])('%s is reversible, so it is write and adds no tap of its own', (id) => {
    expect(placementOf(id).sideEffect).toBe('write');
  });

  test('docker_images only lists images', () => {
    expect(placementOf('docker/docker_images').sideEffect).toBe('read');
  });

  test('memory stays on Desktop (D2: Cloud holds ciphertext only)', () => {
    const memoryCategories = policy.families.memory.categories;
    const offDesktop = allToolManifests
      .filter(m => memoryCategories.includes(m.category))
      .filter(m => JSON.stringify(resolveToolPlacement(m).placements) !== '["desktop"]' || resolveToolPlacement(m).relayable)
      .map(m => toolId(m.category, m.name));
    expect(memoryCategories).toEqual(expect.arrayContaining(['episodic', 'memory', 'observation']));
    expect(offDesktop).toEqual([]);
  });

  test('every agent-local tool is Desktop-only and not relayable', () => {
    const agentLocal = allToolManifests.filter(m => targetOf(m) === 'agent-local');
    expect(agentLocal.map(m => toolId(m.category, m.name))).toEqual(expect.arrayContaining([
      'meta/exec', 'observation/write_file', 'github/git_push', 'github/github_add_remote', 'github/github_init',
    ]));
    const wrong = agentLocal
      .filter(m => JSON.stringify(resolveToolPlacement(m).placements) !== '["desktop"]' || resolveToolPlacement(m).relayable)
      .map(m => toolId(m.category, m.name));
    expect(wrong).toEqual([]);
  });

  test.each([
    'github/heartbeat_claim_issue',
    'github/heartbeat_new_issues',
    'github/github_claim_files',
    'github/github_list_claims',
    'github/github_release_files',
  ])('%s is Desktop-only and not relayable', (id) => {
    expect(placementOf(id)).toMatchObject({ placements: ['desktop'], relayable: false });
  });

  test('vault: passwords and autofill reach the phone; API keys and secrets stay on Desktop', () => {
    const passwordTools = ['vault_autofill', 'vault_create_password', 'vault_generate_password', 'vault_list', 'vault_update_password'];
    const secretTools = [
      'vault_delete_credential', 'vault_is_enabled', 'vault_list_accounts', 'vault_list_api_keys',
      'vault_read_secrets', 'vault_request', 'vault_set_active_account', 'vault_set_credential',
    ];
    const vaultTools = allToolManifests.filter(m => m.category === 'vault').map(m => m.name).sort();
    expect(vaultTools).toEqual([...passwordTools, ...secretTools].sort());
    for (const name of passwordTools) {
      expect(placementOf(`vault/${ name }`)).toMatchObject({ placements: ['desktop', 'mobile'], relayable: false });
    }
    for (const name of secretTools) {
      expect(placementOf(`vault/${ name }`)).toMatchObject({ placements: ['desktop'], relayable: false });
    }
  });

  test.each([
    'applescript/applescript_execute',
    'browser/eval_js',
    'browser/manage_cookies',
    'capture/camera_set',
    'capture/mic_start',
    'docker/docker_exec',
    'docker/docker_run',
    'function/function_run',
    'meta/exechost',
    'pg/pg_execute',
    'settings/settings_set',
  ])('%s is never relayed to the Mac', (id) => {
    expect(placementOf(id).relayable).toBe(false);
  });

  test('integration tools carry the integration slug, not the category', () => {
    expect(placementOf('github/github_get_issue')).toEqual({
      placements: ['desktop', 'cloud', 'mobile'], relayable: true, sideEffect: 'read', credential: { integration: 'github' },
    });
    expect(placementOf('gdrive/gdrive_read').credential).toEqual({ integration: 'google_drive' });
    expect(placementOf('calendar/calendar_list').credential).toBe('none');
  });

  test('controller and workflow-manager tools follow their families', () => {
    expect(placementOf('meta/spawn_agent').placements).toEqual(['desktop', 'cloud', 'mobile']);
    expect(placementOf('meta/execute_workflow').placements).toEqual(['desktop', 'cloud', 'mobile']);
    expect(placementOf('files/files_list').placements).toEqual(['desktop', 'mobile']);
  });

  test('approval: irreversible always, write only when relayed, unknown fails closed', () => {
    expect(requiresApproval('read', { relayed: true })).toBe(false);
    expect(requiresApproval('write')).toBe(false);
    expect(requiresApproval('write', { relayed: true })).toBe(true);
    expect(requiresApproval('irreversible')).toBe(true);
    expect(requiresApproval(undefined)).toBe(true);
    expect(requiresApproval('bogus' as any)).toBe(true);
  });

  test('integration proxy calls are method-aware and fail closed', () => {
    expect(integrationCallSideEffect('get')).toBe('read');
    expect(integrationCallSideEffect('HEAD')).toBe('read');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'whatever']) {
      expect(integrationCallSideEffect(method)).toBe('irreversible');
    }
    expect(integrationCallPlacement('stripe', 'POST')).toEqual({
      placements: ['desktop', 'cloud', 'mobile'], relayable: true, sideEffect: 'irreversible', credential: { integration: 'stripe' },
    });
  });

  // The registry keys tools by bare name and keeps the first manifest
  // (capture/screenshot loses to browser/screenshot), so compare those.
  const firstPerName = allToolManifests.filter((m, i) => allToolManifests.findIndex(o => o.name === m.name) === i);

  test('every registered tool keeps the execution target executionTargetFor gives it', () => {
    const registry = new ToolRegistry();
    registry.registerManifests(allToolManifests.map(m => ({ ...m })));
    for (const m of firstPerName) {
      expect([toolId(m.category, m.name), registry.getExecutionTarget(m.name)]).toEqual([toolId(m.category, m.name), targetOf(m)]);
    }
  });

  test('the registry stores the same metadata the published JSON holds', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'resources/tool-placements.json'), 'utf8'));
    const copies = firstPerName.map(m => ({ ...m }));
    new ToolRegistry().registerManifests(copies);
    for (const copy of copies) {
      const entry = catalog.tools[toolId(copy.category, copy.name)];
      expect({ id: toolId(copy.category, copy.name), placements: copy.placements, relayable: copy.relayable, sideEffect: copy.sideEffect, credential: copy.credential })
        .toEqual({ id: toolId(copy.category, copy.name), placements: entry.placements, relayable: entry.relayable, sideEffect: entry.sideEffect, credential: entry.credential });
    }
  });

  test('resources/tool-placements.json is up to date (node scripts/gen-tool-placements.mjs)', () => {
    const current = fs.readFileSync(path.join(repoRoot, 'resources/tool-placements.json'), 'utf8');
    expect(current).toBe(renderToolPlacementCatalog(allToolManifests));
    expect(Object.keys(JSON.parse(current).tools)).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  test('placement types match @sulla/agent-core when it is present', () => {
    const unionOf = (source: string, name: string) => {
      const match = new RegExp(`export type ${ name }\\s*=([^;]+);`).exec(source);
      return match ? match[1].split('|').map(member => member.replace(/\s+/g, '')).filter(Boolean).sort() : undefined;
    };
    const ours = fs.readFileSync(path.join(repoRoot, 'pkg/sulla-desktop/agent/tools/toolPlacement.ts'), 'utf8');
    const corePath = path.join(repoRoot, 'packages/agent-core/src/types.ts');
    if (!fs.existsSync(corePath)) return;
    const core = fs.readFileSync(corePath, 'utf8');
    for (const name of ['ToolSideEffect', 'ToolPlacement', 'ToolCredential']) {
      const theirs = unionOf(core, name);
      if (theirs) expect(unionOf(ours, name)).toEqual(theirs);
    }
    expect(unionOf(core, 'ToolSideEffect')).toEqual(unionOf(ours, 'ToolSideEffect'));
  });
});
