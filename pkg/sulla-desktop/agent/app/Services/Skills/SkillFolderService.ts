// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import fs from 'node:fs';
import path from 'node:path';

import { SkillDefinitionCodec, type ParsedSkill } from './SkillDefinitionCodec';

import type { SkillDefinition, SkillFile, SkillSourceKind } from '../../../database/models/SkillDefinitionModel';

export const SKILL_MANIFEST = 'SKILL.md';
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;

export interface SkillFolderSource {
  dir: string;
  sourceKind: SkillSourceKind;
}

export interface SkillFileSystem {
  readdirSync(path: string, options: { withFileTypes: true }): fs.Dirent[];
  readFileSync(path: string): Buffer;
  readFileSync(path: string, encoding: 'utf8'): string;
  statSync(path: string): fs.Stats;
  mkdirSync(path: string, options: { recursive: true }): string | undefined;
  writeFileSync(path: string, data: string | Buffer, encoding?: 'utf8'): void;
  rmSync(path: string, options: { recursive: true; force: true }): void;
}

export class SkillFolderService {
  private readonly skippedNames = new Set(['.git', '.DS_Store', 'node_modules', '.marketplace.json', '__pycache__']);

  constructor(private readonly fileSystem: SkillFileSystem = fs) {}

  readFiles(dir: string): Record<string, SkillFile> {
    const files: Record<string, SkillFile> = {};
    this.walkFiles(dir, '', files);
    return files;
  }

  read(dir: string): ParsedSkill | null {
    try {
      const raw = this.fileSystem.readFileSync(path.join(dir, SKILL_MANIFEST), 'utf8');
      return SkillDefinitionCodec.parse(raw, path.basename(dir), this.readFiles(dir));
    } catch {
      return null;
    }
  }

  scan(dir: string): Array<{ parsed: ParsedSkill; sourcePath: string }> {
    const found: Array<{ parsed: ParsedSkill; sourcePath: string }> = [];
    const entries = this.entries(dir);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const folder = path.join(dir, entry.name);
      const parsed = this.read(folder);
      if (parsed && !seen.has(parsed.slug)) {
        seen.add(parsed.slug);
        found.push({ parsed, sourcePath: folder });
      }
    }
    this.walkLegacy(dir, seen, found);
    return found;
  }

  export(skill: SkillDefinition, dir: string): string {
    this.fileSystem.mkdirSync(dir, { recursive: true });
    this.fileSystem.writeFileSync(path.join(dir, SKILL_MANIFEST), SkillDefinitionCodec.render(skill), 'utf8');
    for (const [relativePath, file] of Object.entries(skill.files ?? {})) {
      const safe = this.safeRelativePath(relativePath);
      if (!safe || safe === SKILL_MANIFEST) continue;
      const target = path.join(dir, safe);
      this.fileSystem.mkdirSync(path.dirname(target), { recursive: true });
      if (typeof file === 'string') this.fileSystem.writeFileSync(target, file, 'utf8');
      else if (file?.encoding === 'base64') {
        this.fileSystem.writeFileSync(target, Buffer.from(String(file.content ?? ''), 'base64'));
      }
    }
    return dir;
  }

  replace(skill: SkillDefinition, dir: string): string {
    this.fileSystem.rmSync(dir, { recursive: true, force: true });
    return this.export(skill, dir);
  }

  private walkFiles(current: string, prefix: string, files: Record<string, SkillFile>): void {
    for (const entry of this.entries(current)) {
      if (this.skippedNames.has(entry.name) || entry.name.includes('.sulla-update-')) continue;
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        this.walkFiles(absolute, relative, files);
        continue;
      }
      if (!entry.isFile() || relative === SKILL_MANIFEST) continue;
      try {
        const size = this.fileSystem.statSync(absolute).size;
        if (size > SKILL_FILE_MAX_BYTES) {
          console.warn(`[Skills] Skipped ${absolute} (${size} bytes > 1 MB) — not stored in the database`);
          continue;
        }
        const buffer = this.fileSystem.readFileSync(absolute);
        files[relative] = this.looksBinary(buffer)
          ? { encoding: 'base64', content: buffer.toString('base64') }
          : buffer.toString('utf8');
      } catch (error) {
        console.warn(`[Skills] Could not read ${absolute}:`, error);
      }
    }
  }

  private walkLegacy(
    current: string,
    seen: Set<string>,
    found: Array<{ parsed: ParsedSkill; sourcePath: string }>,
  ): void {
    for (const entry of this.entries(current)) {
      if (entry.name.startsWith('.') || this.skippedNames.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        this.walkLegacy(absolute, seen, found);
        continue;
      }
      if (!entry.isFile() || entry.name === SKILL_MANIFEST || !/\.(md|markdown)$/i.test(entry.name)) continue;
      try {
        const fallback = path.basename(entry.name, path.extname(entry.name));
        const parsed = SkillDefinitionCodec.parse(this.fileSystem.readFileSync(absolute, 'utf8'), fallback);
        if (parsed && !seen.has(parsed.slug) && this.looksLikeFlatSkill(parsed)) {
          seen.add(parsed.slug);
          found.push({ parsed, sourcePath: absolute });
        }
      } catch {
        // Unreadable files are not skill definitions.
      }
    }
  }

  private entries(dir: string): fs.Dirent[] {
    try {
      return this.fileSystem.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  private looksBinary(buffer: Buffer): boolean {
    if (buffer.includes(0)) return true;
    return buffer.toString('utf8').includes('�') && !buffer.toString('latin1').includes('�');
  }

  private looksLikeFlatSkill(parsed: ParsedSkill): boolean {
    if (parsed.content.tags.map(tag => tag.toLowerCase()).includes('skill')) return true;
    const slug = parsed.slug.toLowerCase();
    return slug.startsWith('skill-') || slug.startsWith('sop-');
  }

  private safeRelativePath(relativePath: string): string | null {
    const normalized = String(relativePath ?? '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => part === '..' || part === '')) return null;
    return normalized;
  }
}
