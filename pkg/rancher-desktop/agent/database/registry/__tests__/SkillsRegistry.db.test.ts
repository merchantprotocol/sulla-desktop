/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { redisClient } from '../../RedisClient';
import { installFakeSkillTable } from '../../models/__tests__/fakeSkillTable';
import { SkillDefinitionModel } from '../../models/SkillDefinitionModel';
import { saveSkillFromMarkdown } from '../../../services/SkillDefinitionService';
import { skillsRegistry } from '../SkillsRegistry';

const md = (slug: string, body: string) => `---\nslug: ${ slug }\ntitle: ${ slug } title\ndescription: ${ slug } description\ntriggers: ["${ slug } please"]\n---\n${ body }`;

let tmp: string;
const envKeys = ['SULLA_HOME_DIR', 'SULLA_SKILLS_DIR', 'SULLA_SKILLS_DIRS'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Point every folder source at an empty temp home so only the table counts.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-registry-test-'));
  for (const key of envKeys) savedEnv[key] = process.env[key];
  process.env.SULLA_HOME_DIR = tmp;
  process.env.SULLA_SKILLS_DIR = path.join(tmp, 'resources', 'skills');
  delete process.env.SULLA_SKILLS_DIRS;
  jest.spyOn(redisClient, 'initialize').mockResolvedValue(false as any);
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterAll(async() => { await redisClient.close() });

describe('SkillsRegistry reads the skills table', () => {
  it('serves skills, summaries, documents and stored files from database rows', async() => {
    installFakeSkillTable();
    await saveSkillFromMarkdown({ markdown: md('db-only', '# DB only\n\nSteps.\n'), files: { 'templates/prd.md': '# PRD template\n' } });

    await skillsRegistry.initialize();

    const skill = await skillsRegistry.getSkill('db-only');
    expect(skill?.source).toBe('database');
    expect(skill?.document).toBe('# DB only\n\nSteps.\n');
    expect(await skill?.loadPlannerResources()).toEqual([{ type: 'template', path: 'templates/prd.md', content: '# PRD template\n' }]);
    expect(await skillsRegistry.getSkillSummaries()).toEqual([
      { slug: 'db-only', name: 'db-only title', triggers: ['db-only please'], description: 'db-only description' },
    ]);
    expect(await skillsRegistry.loadSkill('db-only')).toBe('# DB only\n\nSteps.\n');
    expect(SkillDefinitionModel.list).toHaveBeenCalled();
  });

  it('hides disabled and deleted rows, and sees writes after invalidate()', async() => {
    const rows = installFakeSkillTable();
    await saveSkillFromMarkdown({ markdown: md('one', '# One\n') });
    await saveSkillFromMarkdown({ markdown: md('two', '# Two\n') });
    await skillsRegistry.initialize();
    expect((await skillsRegistry.listSkills()).map(s => s.slug).sort()).toEqual(['one', 'two']);

    await SkillDefinitionModel.update(rows.get('one')!.id, { enabled: false });
    await SkillDefinitionModel.update(rows.get('two')!.id, { deleted: true });
    await saveSkillFromMarkdown({ markdown: md('three', '# Three\n') });
    await skillsRegistry.invalidate();

    expect((await skillsRegistry.listSkills()).map(s => s.slug)).toEqual(['three']);
    expect(await skillsRegistry.getSkill('one')).toBeNull();
  });

  it('imports a folder skill dropped in later on the next refresh, then serves it from the table', async() => {
    const rows = installFakeSkillTable();
    await skillsRegistry.initialize();
    expect(await skillsRegistry.getSkill('dropped')).toBeNull();

    const folder = path.join(tmp, 'skills', 'dropped');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), md('dropped', '# Dropped\n'));
    await skillsRegistry.refresh();

    expect(rows.get('dropped')?.source_kind).toBe('user');
    expect((await skillsRegistry.getSkill('dropped'))?.source).toBe('database');
  });

  it('createSkill writes to the table, not to a folder', async() => {
    const rows = installFakeSkillTable();
    await skillsRegistry.initialize();

    const result = await skillsRegistry.createSkill('made-here', '# Made here\n');

    expect(result).toContain("'made-here' created in the database");
    expect(rows.get('made-here')).toMatchObject({ source_kind: 'user', body: '# Made here\n' });
    expect(fs.existsSync(path.join(tmp, 'skills', 'made-here'))).toBe(false);
    expect((await skillsRegistry.getSkill('made-here'))?.document).toBe('# Made here\n');
  });
});
