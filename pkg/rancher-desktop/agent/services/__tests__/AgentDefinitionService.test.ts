import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { AgentDefinitionModel, type AgentDefinition } from '../../database/models/AgentDefinitionModel';
import { AgentDefinitionService } from '../AgentDefinitionService';

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id:                      'agent-test',
    slug:                    'test-agent',
    name:                    'Test Agent',
    description:             'Does tests',
    system_prompt:           'prompt',
    soul_content:            'soul',
    allowed_tools:           ['meta'],
    skill_refs:              ['review'],
    routine_refs:            [],
    model_priority:          [],
    version:                 '1.0.0',
    status:                  'production',
    enabled:                 true,
    source_template_slug:    null,
    content_hash:            null,
    config:                  { name: 'Test Agent', extraKey: { keep: true } },
    prompt_content:          'prompt',
    goals_content:           'goals',
    prompt_files:            { 'prompt.md': 'prompt', 'soul.md': 'soul', 'goals.md': 'goals' },
    provider:                'codex',
    model:                   'gpt-6.1-sol',
    source_kind:             'filesystem-import',
    marketplace_template_id: null,
    marketplace_slug:        null,
    marketplace_version:     null,
    marketplace_author:      null,
    created_at:              new Date(0).toISOString(),
    updated_at:              new Date(0).toISOString(),
    ...overrides,
  };
}

afterEach(() => { jest.restoreAllMocks() });

describe('AgentDefinitionService', () => {
  it('imports filesystem agents idempotently and losslessly', async() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-agent-'));
    const dir = path.join(root, 'lossless-agent');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'name: Lossless\nprovider: codex\nmodel: gpt-6.1-sol\ninjectObservations: false\nextra:\n  nested: true\ntools: [meta, github]\nskills: [review]\n');
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'primary prompt');
    fs.writeFileSync(path.join(dir, 'soul.md'), 'agent soul');
    fs.writeFileSync(path.join(dir, 'goals.md'), 'agent goals');
    const stored = new Map<string, AgentDefinition>();
    jest.spyOn(AgentDefinitionModel, 'findBySlug').mockImplementation(async slug => {
      await Promise.resolve();
      return stored.get(slug) ?? null;
    });
    jest.spyOn(AgentDefinitionModel, 'importIfMissing').mockImplementation(async input => {
      await Promise.resolve();
      const row = definition({
        slug:           input.slug,
        name:           input.name,
        config:         input.config ?? {},
        prompt_content: input.promptContent ?? '',
        soul_content:   input.soulContent ?? '',
        goals_content:  input.goalsContent ?? '',
        prompt_files:   input.promptFiles ?? {},
        allowed_tools:  input.allowedTools ?? [],
        skill_refs:     input.skillRefs ?? [],
        provider:       input.provider ?? null,
        model:          input.model ?? null,
        content_hash:   input.contentHash ?? null,
      });
      stored.set(input.slug, row);
      return row;
    });
    const service = new AgentDefinitionService();
    expect(await service.importLegacyDirectories([root])).toMatchObject({ imported: 1, skipped: 0, errors: [] });
    expect(await service.importLegacyDirectories([root])).toMatchObject({ imported: 0, refreshed: 0, skipped: 1, errors: [] });
    expect(stored.get('lossless-agent')).toMatchObject({
      config:         { injectObservations: false, extra: { nested: true } },
      prompt_content: 'primary prompt',
      soul_content:   'agent soul',
      goals_content:  'agent goals',
      allowed_tools:  ['meta', 'github'],
      skill_refs:     ['review'],
      provider:       'codex',
      model:          'gpt-6.1-sol',
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('round-trips the versioned marketplace manifest', async() => {
    const source = definition({ source_kind: 'marketplace', marketplace_template_id: 'tpl-1', marketplace_slug: 'test-agent', marketplace_author: 'Jonathon' });
    const service = new AgentDefinitionService();
    jest.spyOn(AgentDefinitionModel, 'findBySlug').mockResolvedValue(null);
    jest.spyOn(AgentDefinitionModel, 'create').mockImplementation(async input => {
      await Promise.resolve();
      return definition({
        name:                    input.name,
        config:                  input.config ?? {},
        prompt_content:          input.promptContent ?? '',
        soul_content:            input.soulContent ?? '',
        goals_content:           input.goalsContent ?? '',
        prompt_files:            input.promptFiles ?? {},
        allowed_tools:           input.allowedTools ?? [],
        skill_refs:              input.skillRefs ?? [],
        provider:                input.provider ?? null,
        model:                   input.model ?? null,
        source_kind:             input.sourceKind ?? 'local',
        marketplace_template_id: input.marketplaceTemplateId ?? null,
        marketplace_slug:        input.marketplaceSlug ?? null,
        marketplace_version:     input.marketplaceVersion ?? null,
        marketplace_author:      input.marketplaceAuthor ?? null,
      });
    });
    const manifest = service.toManifest(source);
    const imported = await service.importManifest(manifest);
    expect(manifest).toMatchObject({ apiVersion: 'sulla/v3', kind: 'Agent', manifestVersion: 1 });
    expect(service.toManifest(imported)).toEqual(manifest);
  });

  it('refreshes unedited imports when files change but never overwrites user edits', async() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-agent-'));
    const dir = path.join(root, 'builtin-agent');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'name: Builtin\n');
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'v1');
    let row = definition({ id: 'builtin', slug: 'builtin-agent', content_hash: 'old-hash' });
    jest.spyOn(AgentDefinitionModel, 'findBySlug').mockImplementation(() => Promise.resolve(row));
    jest.spyOn(AgentDefinitionModel, 'get').mockImplementation(() => Promise.resolve(row));
    const update = jest.spyOn(AgentDefinitionModel, 'update').mockImplementation((_id, patch) => {
      row = { ...row, ...(patch.promptContent !== undefined ? { prompt_content: patch.promptContent } : {}), content_hash: patch.contentHash ?? row.content_hash, source_kind: patch.sourceKind ?? row.source_kind };
      return Promise.resolve(row);
    });
    const service = new AgentDefinitionService();

    expect(await service.importLegacyDirectories([root])).toMatchObject({ refreshed: 1, skipped: 0 });
    expect(row.prompt_content).toBe('v1');
    expect(row.status).toBe('production');
    expect(await service.importLegacyDirectories([root])).toMatchObject({ refreshed: 0, skipped: 1 });

    await service.update('builtin', { promptContent: 'my edit' });
    expect(row.source_kind).toBe('local');
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'v2');
    update.mockClear();
    expect(await service.importLegacyDirectories([root])).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(update).not.toHaveBeenCalled();
    expect(row.prompt_content).toBe('my edit');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
