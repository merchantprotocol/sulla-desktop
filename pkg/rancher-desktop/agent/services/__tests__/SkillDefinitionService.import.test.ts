/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { installFakeSkillTable } from '../../database/models/__tests__/fakeSkillTable';
import { SkillDefinitionModel } from '../../database/models/SkillDefinitionModel';
import {
  exportSkillToTempDir,
  hashSkillContent,
  importSkillFolder,
  importSkillFolders,
  materializeSkill,
  renderSkillMarkdown,
  SKILL_FILE_MAX_BYTES,
} from '../SkillDefinitionService';

const md = (slug: string, body = `# ${ slug }\n\nDo the thing.\n`) => `---\nslug: ${ slug }\ntitle: ${ slug } title\ntags: [skill]\ntriggers: ["${ slug } please"]\n---\n${ body }`;

let tmp: string;
let userDir: string;
let resourcesDir: string;

function write(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-test-'));
  userDir = path.join(tmp, 'skills');
  resourcesDir = path.join(tmp, 'resources', 'skills');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sources = () => [{ dir: userDir, sourceKind: 'user' as const }, { dir: resourcesDir, sourceKind: 'resources' as const }];

describe('importSkillFolders', () => {
  it('copies every folder skill into the table, with its files, and leaves the folders untouched', async() => {
    const rows = installFakeSkillTable();
    write(path.join(userDir, 'alpha', 'SKILL.md'), md('alpha'));
    write(path.join(userDir, 'alpha', 'templates', 'prd.md'), '# PRD\n');
    write(path.join(userDir, 'alpha', 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    write(path.join(userDir, 'alpha', 'big.bin'), Buffer.alloc(SKILL_FILE_MAX_BYTES + 1, 1));
    write(path.join(userDir, 'alpha', '.DS_Store'), 'x');
    write(path.join(resourcesDir, 'beta', 'SKILL.md'), md('beta'));
    write(path.join(userDir, 'not-a-skill', 'README.md'), 'no SKILL.md here');
    const before = fs.readFileSync(path.join(userDir, 'alpha', 'SKILL.md'), 'utf8');

    const summary = await importSkillFolders(sources());

    expect(summary).toMatchObject({ imported: 2, refreshed: 0, errors: [] });
    const alpha = rows.get('alpha')!;
    expect(alpha).toMatchObject({ source_kind: 'user', source_path: path.join(userDir, 'alpha'), title: 'alpha title', tags: ['skill'], triggers: ['alpha please'] });
    expect(renderSkillMarkdown(alpha)).toBe(md('alpha'));
    expect(alpha.files['templates/prd.md']).toBe('# PRD\n');
    expect(alpha.files['assets/logo.png']).toEqual({ encoding: 'base64', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString('base64') });
    expect(alpha.files['big.bin']).toBeUndefined();
    expect(alpha.files['.DS_Store']).toBeUndefined();
    expect(alpha.source_hash).toBe(hashSkillContent(alpha));
    expect(rows.get('beta')!.source_kind).toBe('resources');
    expect(rows.has('not-a-skill')).toBe(false);
    expect(fs.readFileSync(path.join(userDir, 'alpha', 'SKILL.md'), 'utf8')).toBe(before);
  });

  it('is import-once: a slug already in the table is never overwritten by a different folder', async() => {
    const rows = installFakeSkillTable();
    write(path.join(userDir, 'shared', 'SKILL.md'), md('shared', '# user copy\n'));
    write(path.join(resourcesDir, 'shared', 'SKILL.md'), md('shared', '# resources copy\n'));

    await importSkillFolders(sources());
    expect(rows.get('shared')!.body).toBe('# user copy\n');

    // A second boot changes nothing.
    expect(await importSkillFolders(sources())).toMatchObject({ imported: 0, refreshed: 0 });
  });

  it('follows edits to its own folder until the row is edited in the database', async() => {
    const rows = installFakeSkillTable();
    const file = path.join(userDir, 'gamma', 'SKILL.md');
    write(file, md('gamma', '# v1\n'));
    await importSkillFolders(sources());

    write(file, md('gamma', '# v2\n'));
    expect(await importSkillFolders(sources())).toMatchObject({ refreshed: 1 });
    expect(rows.get('gamma')!.body).toBe('# v2\n');

    await SkillDefinitionModel.update(rows.get('gamma')!.id, { body: '# edited in the database\n' });
    write(file, md('gamma', '# v3\n'));
    expect(await importSkillFolders(sources())).toMatchObject({ refreshed: 0 });
    expect(rows.get('gamma')!.body).toBe('# edited in the database\n');
  });

  it('never re-imports a soft-deleted slug', async() => {
    const rows = installFakeSkillTable();
    write(path.join(userDir, 'delta', 'SKILL.md'), md('delta'));
    await importSkillFolders(sources());
    await SkillDefinitionModel.update(rows.get('delta')!.id, { deleted: true });

    write(path.join(userDir, 'delta', 'SKILL.md'), md('delta', '# changed\n'));
    expect(await importSkillFolders(sources())).toMatchObject({ imported: 0, refreshed: 0 });
    expect(rows.get('delta')!.deleted_at).not.toBeNull();
  });

  it('imports a marketplace download right away and records where it came from', async() => {
    const rows = installFakeSkillTable();
    const folder = path.join(userDir, 'epsilon');
    write(path.join(folder, 'SKILL.md'), md('epsilon'));

    await importSkillFolder(folder, { sourceKind: 'marketplace', marketplace: { templateId: 'tpl-1', slug: 'epsilon', version: '1.2.0' } });

    expect(rows.get('epsilon')).toMatchObject({ source_kind: 'marketplace', marketplace_template_id: 'tpl-1', marketplace_version: '1.2.0' });
  });
});

describe('materialize and export', () => {
  it('writes a row back out as a skill folder, in a temp dir or in ~/sulla/cache/skills/<slug>/', async() => {
    installFakeSkillTable();
    write(path.join(userDir, 'zeta', 'SKILL.md'), md('zeta'));
    write(path.join(userDir, 'zeta', 'scripts', 'run.sh'), 'echo hi\n');
    await importSkillFolders(sources());

    const exported = await exportSkillToTempDir('zeta');
    expect(path.basename(exported!.dir)).toBe('zeta');
    expect(fs.readFileSync(path.join(exported!.dir, 'SKILL.md'), 'utf8')).toBe(md('zeta'));
    expect(fs.readFileSync(path.join(exported!.dir, 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n');
    exported!.cleanup();
    expect(fs.existsSync(exported!.dir)).toBe(false);

    const prevHome = process.env.SULLA_HOME_DIR;
    process.env.SULLA_HOME_DIR = tmp;
    try {
      const dir = materializeSkill((await SkillDefinitionModel.findBySlug('zeta'))!);
      expect(dir).toBe(path.join(tmp, 'cache', 'skills', 'zeta'));
      expect(fs.readFileSync(path.join(dir, 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n');
    } finally {
      if (prevHome === undefined) delete process.env.SULLA_HOME_DIR;
      else process.env.SULLA_HOME_DIR = prevHome;
    }
  });
});
