/**
 * In-memory stand-in for the skill_definitions table, wired into
 * SkillDefinitionModel with jest spies. Test helper only.
 */
import { jest } from '@jest/globals';

import { SkillDefinitionModel, type SkillDefinition, type SkillDefinitionInput, type SkillDefinitionPatch } from '../SkillDefinitionModel';

let clock = Date.parse('2026-10-11T00:00:00.000Z');
const tick = () => new Date(clock += 1000).toISOString();

export function installFakeSkillTable(initial: SkillDefinition[] = []): Map<string, SkillDefinition> {
  const rows = new Map<string, SkillDefinition>(initial.map(row => [row.slug, { ...row }]));
  const byId = (id: string) => Array.from(rows.values()).find(row => row.id === id) ?? null;

  jest.spyOn(SkillDefinitionModel, 'findBySlug').mockImplementation(async slug => (rows.has(slug) ? { ...rows.get(slug)! } : null));
  jest.spyOn(SkillDefinitionModel, 'listSlugs').mockImplementation(async() => new Set(rows.keys()));
  jest.spyOn(SkillDefinitionModel, 'list').mockImplementation(async(options = {}) => Array.from(rows.values())
    .filter(row => (options.includeDeleted || !row.deleted_at) && (options.includeDisabled || row.enabled))
    .map(row => ({ ...row })));
  jest.spyOn(SkillDefinitionModel, 'create').mockImplementation(async(input: SkillDefinitionInput) => {
    if (rows.has(input.slug)) throw new Error(`duplicate key value violates unique constraint (slug ${ input.slug })`);
    const now = tick();
    const row: SkillDefinition = {
      id:                      `skill-${ rows.size + 1 }`,
      slug:                    input.slug,
      title:                   input.title,
      description:             input.description,
      tags:                    input.tags,
      triggers:                input.triggers,
      body:                    input.body,
      frontmatter:             input.frontmatter,
      frontmatter_text:        input.frontmatter_text,
      files:                   input.files,
      version:                 input.version ?? null,
      source_kind:             input.sourceKind ?? 'user',
      source_path:             input.sourcePath ?? null,
      source_hash:             input.sourceHash ?? null,
      enabled:                 input.enabled !== false,
      deleted_at:              null,
      content_hash:            input.contentHash ?? null,
      marketplace_template_id: input.marketplaceTemplateId ?? null,
      marketplace_slug:        input.marketplaceSlug ?? null,
      marketplace_version:     input.marketplaceVersion ?? null,
      marketplace_author:      input.marketplaceAuthor ?? null,
      created_at:              now,
      updated_at:              now,
    };
    rows.set(row.slug, row);
    return { ...row };
  });
  jest.spyOn(SkillDefinitionModel, 'update').mockImplementation(async(id: string, patch: SkillDefinitionPatch, expectedUpdatedAt?: string) => {
    const row = byId(id);
    if (!row || (expectedUpdatedAt && row.updated_at !== expectedUpdatedAt)) return null;
    const { sourceKind, sourcePath, sourceHash, contentHash, deleted, marketplaceTemplateId, marketplaceSlug, marketplaceVersion, marketplaceAuthor, ...content } = patch;
    Object.assign(row, content);
    if (sourceKind !== undefined) row.source_kind = sourceKind;
    if (sourcePath !== undefined) row.source_path = sourcePath;
    if (sourceHash !== undefined) row.source_hash = sourceHash;
    if (contentHash !== undefined) row.content_hash = contentHash;
    if (deleted !== undefined) row.deleted_at = deleted ? (row.deleted_at ?? tick()) : null;
    if (marketplaceTemplateId !== undefined) row.marketplace_template_id = marketplaceTemplateId;
    if (marketplaceSlug !== undefined) row.marketplace_slug = marketplaceSlug;
    if (marketplaceVersion !== undefined) row.marketplace_version = marketplaceVersion;
    if (marketplaceAuthor !== undefined) row.marketplace_author = marketplaceAuthor;
    row.updated_at = tick();
    return { ...row };
  });
  return rows;
}
