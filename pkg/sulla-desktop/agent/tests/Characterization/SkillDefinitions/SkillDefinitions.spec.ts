// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  decideFolderImport,
  hashSkillContent,
  parseSkillMarkdown,
  readSkillFolder,
  renderSkillMarkdown,
  scanSkillDir,
} from '../../../services/SkillDefinitionService';

import type { SkillDefinition } from '../../../database/models/SkillDefinitionModel';

const roots: string[] = [];

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-definition-characterization-'));
  roots.push(root);
  return root;
};

const write = (root: string, relativePath: string, content: string | Buffer): void => {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

const rowFrom = (
  parsed: NonNullable<ReturnType<typeof parseSkillMarkdown>>,
  sourcePath: string,
  sourceHash: string | null,
): SkillDefinition => ({
  id: 'skill-fixture',
  slug: parsed.slug,
  ...parsed.content,
  source_kind: 'user',
  source_path: sourcePath,
  source_hash: sourceHash,
  enabled: true,
  deleted_at: null,
  content_hash: sourceHash,
  marketplace_template_id: null,
  marketplace_slug: null,
  marketplace_version: null,
  marketplace_author: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('skill definition legacy characterization', () => {
  it('pins exact parse and render round trips, including CRLF frontmatter', () => {
    // risk: data integrity — editing or importing a skill must not rewrite its manifest.
    const markdown = [
      '---\r',
      'slug: fixture-skill\r',
      'title: Fixture Skill\r',
      'description: A fixture skill\r',
      'tags: [skill, " agent "]\r',
      'trigger_phrases: [run fixture]\r',
      'version: 2\r',
      '---\r',
      '# Exact body\r',
      '\r',
      'Keep this text.\r',
    ].join('\n');

    const parsed = parseSkillMarkdown(markdown);

    expect(parsed).not.toBeNull();
    expect(parsed?.slug).toBe('fixture-skill');
    expect(parsed?.content).toMatchObject({
      title: 'Fixture Skill',
      description: 'A fixture skill',
      tags: ['skill', 'agent'],
      version: '2',
      body: '# Exact body\r\n\r\nKeep this text.\r',
    });
    expect(renderSkillMarkdown(parsed!.content)).toBe(`---\n${parsed!.content.frontmatter_text}\n---\n${parsed!.content.body}`);
    expect(parseSkillMarkdown('no frontmatter')).toBeNull();
  });

  it('pins folder precedence, nested legacy discovery, duplicate suppression, and file encoding', () => {
    // risk: data integrity — the first folder skill for a slug must win over legacy duplicates.
    const root = makeRoot();
    write(root, 'alpha/SKILL.md', '---\nslug: shared\ntitle: Folder Winner\ntags: [skill]\n---\nfolder');
    write(root, 'alpha/templates/note.txt', 'hello');
    write(root, 'alpha/assets/blob.bin', Buffer.from([0, 1, 2, 255]));
    write(root, 'alpha/.marketplace.json', '{"ignored":true}');
    write(root, 'zeta.md', '---\nslug: shared\ntitle: Legacy Loser\ntags: [skill]\n---\nlegacy');
    write(root, 'nested/sop-extra.markdown', '---\nslug: sop-extra\ntitle: Extra\n---\nextra');
    write(root, 'nested/ordinary.md', '---\nslug: ordinary\ntitle: Ordinary\n---\nnot a skill');

    const found = scanSkillDir(root);
    const folder = readSkillFolder(path.join(root, 'alpha'));

    expect(found.map(item => [item.parsed.slug, path.relative(root, item.sourcePath)])).toEqual([
      ['shared', 'alpha'],
      ['sop-extra', path.join('nested', 'sop-extra.markdown')],
    ]);
    expect(folder?.content.files).toEqual({
      'assets/blob.bin': { encoding: 'base64', content: 'AAEC/w==' },
      'templates/note.txt': 'hello',
    });
  });

  it('pins folder import decisions for new, unchanged, changed, edited, moved, and deleted rows', () => {
    // risk: data integrity — folder refresh must never overwrite a database-edited skill.
    const original = parseSkillMarkdown('---\nslug: import-fixture\ntitle: Original\n---\nbody')!;
    const changed = parseSkillMarkdown('---\nslug: import-fixture\ntitle: Changed\n---\nbody')!;
    const sourcePath = '/fixtures/import-fixture';
    const sourceHash = hashSkillContent(original.content);
    const row = rowFrom(original, sourcePath, sourceHash);

    expect(decideFolderImport(original, sourcePath, null)).toBe('import');
    expect(decideFolderImport(original, sourcePath, row)).toBe('skip');
    expect(decideFolderImport(changed, sourcePath, row)).toBe('refresh');
    expect(decideFolderImport(changed, sourcePath, { ...row, title: 'Database Edit' })).toBe('skip');
    expect(decideFolderImport(changed, '/fixtures/moved', row)).toBe('skip');
    expect(decideFolderImport(changed, sourcePath, { ...row, deleted_at: '2026-01-02T00:00:00.000Z' })).toBe('skip');
  });

  it('pins canonical hashes independent of object key order and sensitive to stored file content', () => {
    // risk: data integrity — hashes decide whether imported content is safe to refresh.
    const first = parseSkillMarkdown('---\nslug: hash-fixture\ntitle: Hash Fixture\nmetadata:\n  beta: 2\n  alpha: 1\n---\nbody')!;
    const reordered = {
      ...first.content,
      frontmatter: { metadata: { alpha: 1, beta: 2 }, title: 'Hash Fixture', slug: 'hash-fixture' },
    };

    expect(hashSkillContent(first.content)).toBe('sha256:4f7efa8ad12f44cc46896180c9324b1590d738f0285bc44d850a22b83220119f');
    expect(hashSkillContent(reordered)).toBe(hashSkillContent(first.content));
    expect(hashSkillContent({ ...first.content, files: { 'note.txt': 'changed' } })).not.toBe(hashSkillContent(first.content));
  });
});
