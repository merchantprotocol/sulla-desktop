/**
 * Built-in skill catalog — the skills that ship with Sulla Desktop.
 *
 * Each skill is a <slug>/ folder here (SKILL.md plus any extra files).
 * scripts/build-builtin-skills.mjs packs the folders into builtin-skills.json,
 * which is compiled into the app the same way builtin-agents.json is. It is
 * NOT read at runtime: seedBuiltinSkills copies it into skill_definitions at
 * boot, and the database stays the only source of truth for skills.
 *
 * Adding a built-in skill: add a <slug>/SKILL.md folder, run
 * `node scripts/build-builtin-skills.mjs`, commit both.
 */

import bundle from './builtin-skills.json';

import type { SkillContent, SkillFile } from '../database/models/SkillDefinitionModel';
import { parseSkillMarkdown, SKILL_MANIFEST } from '../services/SkillDefinitionService';

/** One entry of builtin-skills.json: a skill folder, file by file. */
export interface BuiltinSkillSpec {
  slug:  string;
  files: Record<string, SkillFile>;
}

export function getBuiltinSkillSpecs(): BuiltinSkillSpec[] {
  return (bundle as { skills: BuiltinSkillSpec[] }).skills;
}

/** Slugs the bundle used to ship and no longer does (see retireBuiltinSkills). */
export function getRetiredBuiltinSkillSlugs(): string[] {
  return (bundle as { retired?: string[] }).retired ?? [];
}

/** Render a bundle entry into the exact content columns the seeder writes. */
export function renderBuiltinSkill(spec: BuiltinSkillSpec): SkillContent {
  const manifest = spec.files[SKILL_MANIFEST];
  if (typeof manifest !== 'string') throw new Error(`built-in skill ${ spec.slug } has no ${ SKILL_MANIFEST }`);
  const files = Object.fromEntries(Object.entries(spec.files).filter(([rel]) => rel !== SKILL_MANIFEST));
  const parsed = parseSkillMarkdown(manifest, spec.slug, files);
  if (!parsed) throw new Error(`built-in skill ${ spec.slug } has an unreadable ${ SKILL_MANIFEST }`);
  if (parsed.slug !== spec.slug) throw new Error(`built-in skill folder ${ spec.slug } declares slug ${ parsed.slug }`);
  return parsed.content;
}
