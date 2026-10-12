import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { SkillDefinition } from '../../database/models/SkillDefinitionModel';

const list = jest.fn<() => Promise<SkillDefinition[]>>();

jest.unstable_mockModule('../../database/models/SkillDefinitionModel', () => ({ SkillDefinitionModel: { list } }));

const { buildSkillRecallContext, rankSkills, scoreSkill } = await import('../SkillRecall');

function skill(slug: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id:                      `skill-${ slug }`,
    slug,
    title:                   slug,
    description:             '',
    tags:                    [],
    triggers:                [],
    body:                    '',
    frontmatter:             {},
    frontmatter_text:        '',
    files:                   {},
    version:                 null,
    source_kind:             'user',
    source_path:             null,
    source_hash:             null,
    enabled:                 true,
    deleted_at:              null,
    content_hash:            null,
    marketplace_template_id: null,
    marketplace_slug:        null,
    marketplace_version:     null,
    marketplace_author:      null,
    created_at:              '2026-10-11T00:00:00.000Z',
    updated_at:              '2026-10-11T00:00:00.000Z',
    ...overrides,
  };
}

const dashboards = skill('chat-dashboard-components', { title: 'Chat dashboard components', description: 'Render data-driven dashboard HTML in chat.', tags: ['analytics'] });
const isometric = skill('isometric', { title: 'Isometric drawings', description: 'Draw equipment concepts as isometric diagrams.', triggers: ['diagram'] });
const browser = skill('control-in-app-browser', { title: 'Control in-app browser', description: 'Drive the Sulla browser for UI QA.', body: 'dashboard dashboard dashboard' });

afterEach(() => {
  list.mockReset();
});

describe('scoreSkill', () => {
  it('weights title over labels over description and ignores the body', () => {
    expect(scoreSkill(dashboards, ['dashboard'])).toBe(3);
    expect(scoreSkill(dashboards, ['analytics'])).toBe(2);
    expect(scoreSkill(isometric, ['equipment'])).toBe(1);
    expect(scoreSkill(browser, ['dashboard'])).toBe(0);
  });
});

describe('rankSkills', () => {
  it('returns only skills that clear the minimum score', () => {
    expect(rankSkills([dashboards, isometric, browser], 'build me an analytics dashboard').map(s => s.slug)).toEqual(['chat-dashboard-components']);
  });

  it('returns nothing when the turn is not skill-shaped', () => {
    expect(rankSkills([dashboards, isometric, browser], 'how was your weekend')).toEqual([]);
  });
});

describe('buildSkillRecallContext', () => {
  it('lists fitting skills with slug, title and how to load them', async() => {
    list.mockResolvedValue([dashboards, isometric, browser]);
    const block = await buildSkillRecallContext('draw the wash plant as an isometric diagram');

    expect(block).toContain('[skill:isometric] Isometric drawings: Draw equipment concepts');
    expect(block).toContain('sulla skills/skill_get');
    expect(block).not.toContain('chat-dashboard-components');
  });

  it('is empty when nothing fits, without reading the table for blank text', async() => {
    list.mockResolvedValue([dashboards]);
    expect(await buildSkillRecallContext('how was your weekend')).toBe('');
    expect(await buildSkillRecallContext('   ')).toBe('');
    expect(list).toHaveBeenCalledTimes(1);
  });
});
