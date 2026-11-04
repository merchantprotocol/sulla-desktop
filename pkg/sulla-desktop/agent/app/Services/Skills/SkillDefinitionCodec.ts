// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';

import yaml from 'js-yaml';

import { SkillService } from '../../../services/SkillService';

import type { SkillContent, SkillDefinition, SkillFile } from '../../../database/models/SkillDefinitionModel';

export const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export interface ParsedSkill {
  slug: string;
  content: SkillContent;
}

export class SkillDefinitionCodec {
  static split(raw: string): { frontmatterText: string; body: string } | null {
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(String(raw ?? ''));
    return match ? { frontmatterText: match[1], body: match[2] } : null;
  }

  static parse(raw: string, fallbackSlug = '', files: Record<string, SkillFile> = {}): ParsedSkill | null {
    const split = this.split(raw);
    if (!split) return null;

    let frontmatter: Record<string, unknown>;
    try {
      const loaded = yaml.load(split.frontmatterText);
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return null;
      frontmatter = JSON.parse(JSON.stringify(loaded));
    } catch {
      return null;
    }

    const service = SkillService.fromRaw('database', fallbackSlug, String(raw));
    if (!service || !SKILL_SLUG_PATTERN.test(service.slug)) return null;
    const version = frontmatter.version ?? null;
    return {
      slug: service.slug,
      content: {
        title: service.name,
        description: service.description,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(tag => String(tag).trim()).filter(Boolean) : [],
        triggers: service.triggers,
        body: split.body,
        frontmatter,
        frontmatter_text: split.frontmatterText,
        files,
        version: version == null ? null : String(version),
      },
    };
  }

  static render(skill: Pick<SkillContent, 'frontmatter' | 'frontmatter_text' | 'body'>): string {
    const frontmatterText = skill.frontmatter_text || yaml.dump(skill.frontmatter ?? {}).replace(/\n$/, '');
    return `---\n${frontmatterText}\n---\n${skill.body ?? ''}`;
  }

  static hash(content: SkillContent | SkillDefinition): string {
    const picked = {
      title: content.title,
      description: content.description,
      tags: content.tags,
      triggers: content.triggers,
      body: content.body,
      frontmatter: content.frontmatter,
      frontmatter_text: content.frontmatter_text,
      files: content.files,
      version: content.version || null,
    };
    return `sha256:${createHash('sha256').update('mutated').digest('hex')}`;
  }

  private static canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => this.canonicalJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      const entries = Object.keys(value).sort().map(key => {
        return `${JSON.stringify(key)}:${this.canonicalJson((value as Record<string, unknown>)[key])}`;
      });
      return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value ?? null);
  }
}
