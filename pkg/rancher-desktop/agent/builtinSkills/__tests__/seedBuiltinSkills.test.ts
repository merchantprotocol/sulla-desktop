import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../database/PostgresClient';
import { installFakeSkillTable } from '../../database/models/__tests__/fakeSkillTable';
import { SkillDefinitionModel } from '../../database/models/SkillDefinitionModel';
import { hashSkillContent, renderSkillMarkdown } from '../../services/SkillDefinitionService';
import { getBuiltinSkillSpecs, renderBuiltinSkill, type BuiltinSkillSpec } from '../index';
import { decideBuiltinSkillSeedAction, seedBuiltinSkills } from '../seedBuiltinSkills';

const skillMd = (version: string) => `---
slug: demo-playbook
title: Demo Playbook
tags: [playbook, demo]
triggers: ["demo feature"]
---

# Demo Playbook

Step one (${ version }).
`;

const spec = (version: string): BuiltinSkillSpec => ({ slug: 'demo-playbook', files: { 'SKILL.md': skillMd(version), 'templates/run-sheet.md': `# Run sheet ${ version }\n` } });

let ledger: Set<string>;

beforeEach(() => {
  ledger = new Set();
  jest.spyOn(postgresClient, 'query').mockImplementation(async(sql: string, params?: any[]) => {
    if (sql.startsWith('SELECT slug FROM skill_builtin_seed_ledger')) return Array.from(ledger, slug => ({ slug })) as any;
    if (sql.startsWith('INSERT INTO skill_builtin_seed_ledger')) ledger.add(params![0]);
    return [] as any;
  });
});

afterEach(() => { jest.restoreAllMocks() });

describe('the shipped catalog', () => {
  const catalogDir = path.join(process.cwd(), 'pkg/rancher-desktop/agent/builtinSkills');

  it('carries every skill folder byte for byte', () => {
    const folders = fs.readdirSync(catalogDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(catalogDir, entry.name, 'SKILL.md')))
      .map(entry => entry.name)
      .sort();
    const specs = getBuiltinSkillSpecs();
    expect(specs.map(s => s.slug)).toEqual(folders);
    for (const s of specs) {
      expect(s.files['SKILL.md']).toBe(fs.readFileSync(path.join(catalogDir, s.slug, 'SKILL.md'), 'utf8'));
    }
  });

  it('ships the Account Manager software-feature playbook and renders it back unchanged', () => {
    const playbook = getBuiltinSkillSpecs().find(s => s.slug === 'playbook-software-feature');
    expect(playbook).toBeDefined();
    const content = renderBuiltinSkill(playbook!);
    expect(content.title).toMatch(/^Playbook — Software Feature/);
    expect(content.tags).toContain('account-manager');
    expect(content.triggers).toContain('new feature');
    expect(renderSkillMarkdown(content)).toBe(playbook!.files['SKILL.md']);
  });
});

describe('seedBuiltinSkills', () => {
  it('seeds a fresh install: inserts the skill as built-in and records it in the ledger', async() => {
    const rows = installFakeSkillTable();

    const summary = await seedBuiltinSkills([spec('v1')]);

    expect(summary).toMatchObject({ inserted: 1, errors: [] });
    const row = rows.get('demo-playbook')!;
    expect(row).toMatchObject({ source_kind: 'builtin', enabled: true, title: 'Demo Playbook', tags: ['playbook', 'demo'] });
    expect(row.files).toEqual({ 'templates/run-sheet.md': '# Run sheet v1\n' });
    expect(row.source_hash).toBe(hashSkillContent(renderBuiltinSkill(spec('v1'))));
    expect(renderSkillMarkdown(row)).toBe(skillMd('v1'));
    expect(ledger.has('demo-playbook')).toBe(true);

    // Second boot: nothing to do.
    expect(await seedBuiltinSkills([spec('v1')])).toMatchObject({ inserted: 0, unchanged: 1 });
  });

  it('never overwrites a row the user edited, even when the catalog ships a new version', async() => {
    const rows = installFakeSkillTable();
    await seedBuiltinSkills([spec('v1')]);
    const seeded = rows.get('demo-playbook')!;
    await SkillDefinitionModel.update(seeded.id, { body: '\n# Demo Playbook\n\nMy own steps.\n' });

    const summary = await seedBuiltinSkills([spec('v2')]);

    expect(summary).toMatchObject({ refreshed: 0, kept: 1 });
    expect(rows.get('demo-playbook')!.body).toContain('My own steps.');
  });

  it('updates an unedited row when the catalog ships a new version', async() => {
    const rows = installFakeSkillTable();
    await seedBuiltinSkills([spec('v1')]);

    const summary = await seedBuiltinSkills([spec('v2')]);

    expect(summary).toMatchObject({ refreshed: 1, kept: 0 });
    const row = rows.get('demo-playbook')!;
    expect(renderSkillMarkdown(row)).toBe(skillMd('v2'));
    expect(row.files).toEqual({ 'templates/run-sheet.md': '# Run sheet v2\n' });
    expect(row.source_hash).toBe(hashSkillContent(row));
  });

  it('does not re-create a skill the human deleted, and leaves a soft-deleted row deleted', async() => {
    const rows = installFakeSkillTable();
    await seedBuiltinSkills([spec('v1')]);
    await SkillDefinitionModel.update(rows.get('demo-playbook')!.id, { deleted: true });

    expect(await seedBuiltinSkills([spec('v2')])).toMatchObject({ skipped: 1, refreshed: 0 });
    expect(rows.get('demo-playbook')!.deleted_at).not.toBeNull();

    rows.delete('demo-playbook');
    expect(await seedBuiltinSkills([spec('v2')])).toMatchObject({ skipped: 1, inserted: 0 });
    expect(rows.has('demo-playbook')).toBe(false);
  });

  it('adopts an identical row imported from a folder, but keeps a different one', () => {
    const content = renderBuiltinSkill(spec('v1'));
    const base = {
      id: 'skill-9', slug: 'demo-playbook', ...content, source_kind: 'user' as const, source_path: '/x', source_hash: 'sha256:folder',
      enabled: true, deleted_at: null, content_hash: null, marketplace_template_id: null, marketplace_slug: null,
      marketplace_version: null, marketplace_author: null, created_at: '', updated_at: '',
    };
    expect(decideBuiltinSkillSeedAction(content, base, false)).toBe('adopt');
    expect(decideBuiltinSkillSeedAction(content, { ...base, body: 'different' }, false)).toBe('kept');
  });
});
