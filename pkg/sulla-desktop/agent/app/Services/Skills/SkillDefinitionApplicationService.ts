// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Service } from '@sulla/foundation';

import { SkillDefinitionCodec, SKILL_SLUG_PATTERN, type ParsedSkill } from './SkillDefinitionCodec';
import { SkillFolderService, type SkillFolderSource } from './SkillFolderService';

import type { SkillRepositoryContract } from '../../Repositories/SkillRepository';
import type {
  SkillContent,
  SkillDefinition,
  SkillFile,
  SkillSourceKind,
} from '../../../database/models/SkillDefinitionModel';

export interface SkillImportSummary {
  imported: number;
  refreshed: number;
  skipped: number;
  errors: string[];
}

export interface SkillPathResolver {
  home(): string;
  userSkills(): string;
  resourceSkills(): string;
}

export class SkillDefinitionApplicationService extends Service {
  constructor(
    private readonly repository: SkillRepositoryContract,
    private readonly folders: SkillFolderService,
    private readonly paths: SkillPathResolver,
    private readonly temporaryRoot: () => string = os.tmpdir,
  ) {
    super();
  }

  defaultSources(environmentValue = process.env.SULLA_SKILLS_DIRS): SkillFolderSource[] {
    const configured = String(environmentValue || '').split(',').map(value => value.trim()).filter(Boolean);
    const sources: SkillFolderSource[] = [
      { dir: this.paths.userSkills(), sourceKind: 'user' },
      ...configured.map(dir => ({ dir, sourceKind: 'user' as const })),
      { dir: this.paths.resourceSkills(), sourceKind: 'resources' },
    ];
    const seen = new Set<string>();
    return sources.filter(source => {
      const key = path.resolve(source.dir);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  decideImport(
    parsed: ParsedSkill,
    sourcePath: string,
    row: SkillDefinition | null,
  ): 'import' | 'refresh' | 'skip' {
    if (!row) return 'import';
    if (row.deleted_at || !row.source_hash || row.source_path !== sourcePath) return 'skip';
    if (SkillDefinitionCodec.hash(row) !== row.source_hash) return 'skip';
    return SkillDefinitionCodec.hash(parsed.content) === row.source_hash ? 'skip' : 'refresh';
  }

  async importFolders(_sources: SkillFolderSource[], _options: unknown): Promise<SkillImportSummary> {
    return { imported: 0, refreshed: 0, skipped: 0, errors: [] };
  }

  async importFolder(
    folder: string,
    options: {
      sourceKind: SkillSourceKind;
      force?: boolean;
      marketplace?: { templateId?: string; slug?: string; version?: string; author?: string };
    },
  ): Promise<SkillDefinition | null> {
    const parsed = this.folders.read(folder);
    if (!parsed) return null;
    const hash = SkillDefinitionCodec.hash(parsed.content);
    const marketplace = {
      marketplaceTemplateId: options.marketplace?.templateId ?? null,
      marketplaceSlug: options.marketplace?.slug ?? null,
      marketplaceVersion: options.marketplace?.version ?? null,
      marketplaceAuthor: options.marketplace?.author ?? null,
    };
    const row = await this.repository.findBySlug(parsed.slug);
    if (!row) {
      return this.repository.create({
        slug: parsed.slug,
        ...parsed.content,
        sourceKind: options.sourceKind,
        sourcePath: folder,
        sourceHash: hash,
        contentHash: hash,
        ...marketplace,
      });
    }
    const owned = options.force || row.source_kind === 'marketplace' ||
      (row.source_path === folder && SkillDefinitionCodec.hash(row) === row.source_hash);
    if (!owned) return row;
    return this.repository.update(row.id, {
      ...parsed.content,
      sourceKind: options.sourceKind,
      sourcePath: folder,
      sourceHash: hash,
      contentHash: hash,
      deleted: false,
      ...marketplace,
    });
  }

  async exportToTempDir(
    slug: string,
  ): Promise<{ dir: string; skill: SkillDefinition; cleanup: () => void } | null> {
    const skill = await this.repository.findBySlug(String(slug || '').trim());
    if (!skill || skill.deleted_at || !SKILL_SLUG_PATTERN.test(skill.slug)) return null;
    const temporary = fs.mkdtempSync(path.join(this.temporaryRoot(), 'sulla-skill-'));
    return {
      dir: this.folders.export(skill, path.join(temporary, skill.slug)),
      skill,
      cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }),
    };
  }

  cacheDir(): string {
    return path.join(this.paths.home(), 'cache', 'skills');
  }

  materialize(skill: SkillDefinition): string {
    if (!SKILL_SLUG_PATTERN.test(skill.slug)) throw new Error(`Unsafe skill slug: ${skill.slug}`);
    const root = this.cacheDir();
    const dir = path.join(root, skill.slug);
    if (path.dirname(dir) !== root) throw new Error(`Unsafe skill slug: ${skill.slug}`);
    return this.folders.replace(skill, dir);
  }

  async save(input: {
    markdown: string;
    slug?: string;
    files?: Record<string, SkillFile>;
    sourceKind?: SkillSourceKind;
  }): Promise<{ skill: SkillDefinition; created: boolean }> {
    const parsed = SkillDefinitionCodec.parse(input.markdown, input.slug ?? '');
    if (!parsed) throw new Error('SKILL.md needs a YAML frontmatter block (--- ... ---) with at least a slug or title.');
    if (input.slug && parsed.slug !== input.slug) {
      throw new Error(`Frontmatter slug "${parsed.slug}" does not match slug "${input.slug}".`);
    }
    const existing = await this.repository.findBySlug(parsed.slug);
    const content: SkillContent = { ...parsed.content, files: input.files ?? existing?.files ?? {} };
    const hash = SkillDefinitionCodec.hash(content);
    if (!existing) {
      const skill = await this.repository.create({
        slug: parsed.slug,
        ...content,
        sourceKind: input.sourceKind ?? 'user',
        contentHash: hash,
      });
      return { skill, created: true };
    }
    const skill = await this.repository.update(existing.id, { ...content, contentHash: hash, deleted: false });
    if (!skill) throw new Error(`Skill ${parsed.slug} disappeared while saving.`);
    return { skill, created: false };
  }
}
