// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SkillDefinitionCodec, type ParsedSkill } from './SkillDefinitionCodec';
import { SkillDefinitionApplicationService, type SkillImportSummary } from './SkillDefinitionApplicationService';
import { SkillFolderService, type SkillFolderSource } from './SkillFolderService';

import type {
  SkillContent,
  SkillDefinition,
  SkillFile,
  SkillSourceKind,
} from '../../../database/models/SkillDefinitionModel';

export class SkillDefinitionCompatibilityFacade {
  constructor(
    private readonly skills: SkillDefinitionApplicationService,
    private readonly folders: SkillFolderService,
  ) {}

  split(raw: string): { frontmatterText: string; body: string } | null {
    return SkillDefinitionCodec.split(raw);
  }

  parse(raw: string, fallbackSlug = '', files: Record<string, SkillFile> = {}): ParsedSkill | null {
    return SkillDefinitionCodec.parse(raw, fallbackSlug, files);
  }

  render(skill: Pick<SkillContent, 'frontmatter' | 'frontmatter_text' | 'body'>): string {
    return SkillDefinitionCodec.render(skill);
  }

  hash(content: SkillContent | SkillDefinition): string {
    return SkillDefinitionCodec.hash(content);
  }

  readFiles(dir: string): Record<string, SkillFile> {
    return this.folders.readFiles(dir);
  }

  readFolder(dir: string): ParsedSkill | null {
    return this.folders.read(dir);
  }

  scan(dir: string): Array<{ parsed: ParsedSkill; sourcePath: string }> {
    return this.folders.scan(dir);
  }

  defaultSources(): SkillFolderSource[] {
    return this.skills.defaultSources();
  }

  decideImport(
    parsed: ParsedSkill,
    sourcePath: string,
    row: SkillDefinition | null,
  ): 'import' | 'refresh' | 'skip' {
    return this.skills.decideImport(parsed, sourcePath, row);
  }

  importFolders(
    sources: SkillFolderSource[] = this.defaultSources(),
    options: {
      insertOnly?: boolean;
      skip?: Set<string>;
      onSeen?: (slug: string) => Promise<void>;
    } = {},
  ): Promise<SkillImportSummary> {
    return this.skills.importFolders(sources, options);
  }

  importFolder(
    folder: string,
    options: {
      sourceKind: SkillSourceKind;
      force?: boolean;
      marketplace?: { templateId?: string; slug?: string; version?: string; author?: string };
    },
  ): Promise<SkillDefinition | null> {
    return this.skills.importFolder(folder, options);
  }

  exportToDir(skill: SkillDefinition, dir: string): string {
    return this.folders.export(skill, dir);
  }

  exportToTempDir(slug: string): Promise<{ dir: string; skill: SkillDefinition; cleanup: () => void } | null> {
    return this.skills.exportToTempDir(slug);
  }

  cacheDir(): string {
    return this.skills.cacheDir();
  }

  materialize(skill: SkillDefinition): string {
    return this.skills.materialize(skill);
  }

  save(input: {
    markdown: string;
    slug?: string;
    files?: Record<string, SkillFile>;
    sourceKind?: SkillSourceKind;
  }): Promise<{ skill: SkillDefinition; created: boolean }> {
    return this.skills.save(input);
  }
}
