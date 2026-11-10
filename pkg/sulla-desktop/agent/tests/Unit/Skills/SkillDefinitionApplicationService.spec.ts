// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillDefinitionApplicationService } from '../../../app/Services/Skills/SkillDefinitionApplicationService';
import { SkillFolderService } from '../../../app/Services/Skills/SkillFolderService';

import type { SkillRepositoryContract } from '../../../app/Repositories/SkillRepository';
import type {
  SkillDefinition,
  SkillDefinitionInput,
  SkillDefinitionPatch,
} from '../../../database/models/SkillDefinitionModel';

class MemorySkillRepository implements SkillRepositoryContract {
  readonly rows = new Map<string, SkillDefinition>();
  createCalls = 0;
  updateCalls = 0;

  async findBySlug(slug: string): Promise<SkillDefinition | null> {
    return this.rows.get(slug) ?? null;
  }

  async create(input: SkillDefinitionInput): Promise<SkillDefinition> {
    this.createCalls += 1;
    const row = this.makeRow(input);
    this.rows.set(row.slug, row);
    return row;
  }

  async update(id: string, patch: SkillDefinitionPatch): Promise<SkillDefinition | null> {
    this.updateCalls += 1;
    const current = [...this.rows.values()].find(row => row.id === id);
    if (!current) return null;
    const row: SkillDefinition = {
      ...current,
      ...patch,
      source_kind: patch.sourceKind ?? current.source_kind,
      source_path: patch.sourcePath === undefined ? current.source_path : patch.sourcePath,
      source_hash: patch.sourceHash === undefined ? current.source_hash : patch.sourceHash,
      content_hash: patch.contentHash === undefined ? current.content_hash : patch.contentHash,
      deleted_at: patch.deleted === false ? null : current.deleted_at,
      marketplace_template_id: patch.marketplaceTemplateId ?? current.marketplace_template_id,
      marketplace_slug: patch.marketplaceSlug ?? current.marketplace_slug,
      marketplace_version: patch.marketplaceVersion ?? current.marketplace_version,
      marketplace_author: patch.marketplaceAuthor ?? current.marketplace_author,
    };
    this.rows.set(row.slug, row);
    return row;
  }

  private makeRow(input: SkillDefinitionInput): SkillDefinition {
    return {
      id: `skill-${input.slug}`,
      slug: input.slug,
      title: input.title,
      description: input.description,
      tags: input.tags,
      triggers: input.triggers,
      body: input.body,
      frontmatter: input.frontmatter,
      frontmatter_text: input.frontmatter_text,
      files: input.files,
      version: input.version,
      source_kind: input.sourceKind ?? 'user',
      source_path: input.sourcePath ?? null,
      source_hash: input.sourceHash ?? null,
      enabled: input.enabled !== false,
      deleted_at: null,
      content_hash: input.contentHash ?? null,
      marketplace_template_id: input.marketplaceTemplateId ?? null,
      marketplace_slug: input.marketplaceSlug ?? null,
      marketplace_version: input.marketplaceVersion ?? null,
      marketplace_author: input.marketplaceAuthor ?? null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  }
}

const roots: string[] = [];

const makeService = (): {
  service: SkillDefinitionApplicationService;
  repository: MemorySkillRepository;
  root: string;
} => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-service-unit-'));
  roots.push(root);
  const repository = new MemorySkillRepository();
  const service = new SkillDefinitionApplicationService(
    repository,
    new SkillFolderService(),
    {
      home: () => root,
      userSkills: () => path.join(root, 'user'),
      resourceSkills: () => path.join(root, 'resources'),
    },
    () => root,
  );
  return { service, repository, root };
};

const markdown = (title: string): string => `---\nslug: fixture\ntitle: ${title}\nversion: 1\n---\nbody`;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SkillDefinitionApplicationService', () => {
  it('creates then updates a skill while preserving stored files', async() => {
    // risk: data integrity — editing markdown must not discard companion files.
    const { service, repository } = makeService();
    const created = await service.save({ markdown: markdown('Original'), files: { 'script.ts': 'original' } });
    const updated = await service.save({ markdown: markdown('Updated') });

    expect(created.created).toBe(true);
    expect(updated.created).toBe(false);
    expect(updated.skill.title).toBe('Updated');
    expect(updated.skill.files).toEqual({ 'script.ts': 'original' });
    expect(repository.createCalls).toBe(1);
    expect(repository.updateCalls).toBe(1);
  });

  it('does not overwrite a human-owned row unless an explicit force import is requested', async() => {
    // risk: data integrity — marketplace imports must not silently replace human edits.
    const { service, repository, root } = makeService();
    await service.save({ markdown: markdown('Human Edit') });
    const folder = path.join(root, 'download');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), markdown('Marketplace Download'));

    const kept = await service.importFolder(folder, { sourceKind: 'marketplace' });
    const replaced = await service.importFolder(folder, { sourceKind: 'marketplace', force: true });

    expect(kept?.title).toBe('Human Edit');
    expect(replaced?.title).toBe('Marketplace Download');
    expect(repository.updateCalls).toBe(1);
  });

  it('materializes safe slugs from repository content and rejects traversal slugs', async() => {
    // risk: filesystem integrity — materialization must stay inside the cache root.
    const { service } = makeService();
    const { skill } = await service.save({ markdown: markdown('Fixture'), files: { 'nested/file.txt': 'safe' } });

    const dir = service.materialize(skill);

    expect(fs.readFileSync(path.join(dir, 'nested/file.txt'), 'utf8')).toBe('safe');
    expect(() => service.materialize({ ...skill, slug: '../escape' })).toThrow('Unsafe skill slug');
  });

  it('deduplicates configured folder sources without changing first-source precedence', () => {
    // risk: data integrity — duplicate scans must not make resources beat user skills.
    const { service, root } = makeService();
    const sources = service.defaultSources(`${path.join(root, 'user')},${path.join(root, 'extra')}`);

    expect(sources).toEqual([
      { dir: path.join(root, 'user'), sourceKind: 'user' },
      { dir: path.join(root, 'extra'), sourceKind: 'user' },
      { dir: path.join(root, 'resources'), sourceKind: 'resources' },
    ]);
  });
});
