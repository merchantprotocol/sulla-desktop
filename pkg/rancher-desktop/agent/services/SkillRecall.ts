/**
 * Per-turn skill recall — the subconscious "which installed skills fit right
 * now" step. Keyword ranking over the skill_definitions table: no LLM call,
 * one table read, bounded size. It only suggests; the agent decides whether
 * to load a skill.
 *
 * Skill observations (<skills_observations>) say what happened when a skill
 * ran. This block says which skills are installed and fit the turn, so a skill
 * can surface even if it was never run before.
 */

import { SkillDefinitionModel, type SkillDefinition } from '../database/models/SkillDefinitionModel';
import { extractRecallTerms } from '../utils/recallTerms';

/** A skill needs at least this keyword score to be suggested at all. */
export const SKILL_FIT_MIN_SCORE = 3;
/** ...and at least this share of the best skill's score. */
export const SKILL_FIT_RELATIVE = 0.5;
export const SKILL_FIT_MAX = 4;
export const SKILL_DESCRIPTION_MAX_CHARS = 240;

function hasTerm(text: string, term: string): boolean {
  return text.toLowerCase().includes(term);
}

/** Title or slug hit 3, trigger or tag hit 2, description hit 1, per term. The body is not scored. */
export function scoreSkill(skill: Pick<SkillDefinition, 'slug' | 'title' | 'description' | 'tags' | 'triggers'>, terms: string[]): number {
  const name = `${ skill.slug } ${ skill.title }`;
  const labels = [...skill.triggers, ...skill.tags].join(' ');
  let score = 0;
  for (const term of terms) {
    if (hasTerm(name, term)) score += 3;
    else if (hasTerm(labels, term)) score += 2;
    else if (hasTerm(skill.description, term)) score += 1;
  }
  return score;
}

export function rankSkills(skills: SkillDefinition[], text: string): SkillDefinition[] {
  const terms = extractRecallTerms([text]);
  if (terms.length === 0) return [];
  const ranked = skills
    .map(skill => ({ skill, score: scoreSkill(skill, terms) }))
    .filter(entry => entry.score >= SKILL_FIT_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug));
  const top = ranked[0]?.score ?? 0;
  return ranked
    .filter(entry => entry.score >= top * SKILL_FIT_RELATIVE)
    .slice(0, SKILL_FIT_MAX)
    .map(entry => entry.skill);
}

function shortDescription(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  return flat.length > SKILL_DESCRIPTION_MAX_CHARS ? `${ flat.slice(0, SKILL_DESCRIPTION_MAX_CHARS - 1) }…` : flat;
}

/** The context block body, or '' when no installed skill fits the text. */
export async function buildSkillRecallContext(text: string): Promise<string> {
  if (!text.trim()) return '';
  const fits = rankSkills(await SkillDefinitionModel.list(), text);
  if (fits.length === 0) return '';
  return [
    'Installed skills that may fit this turn (keyword match, not an order; you decide). Load one in full with `sulla skills/skill_get \'{"slug":"<slug>"}\'` before you use it.',
    ...fits.map(skill => `- [skill:${ skill.slug }] ${ skill.title }: ${ shortDescription(skill.description) }`),
  ].join('\n');
}
