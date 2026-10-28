// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { resolveMemorySeedDir } from '../utils/sullaPaths';

interface MemoryDoc {
  file:  string;
  front: Record<string, any>;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}\b/, 'API token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/(?:password|api[_-]?key|secret|token)\s*[:=]\s*["']?[^\s"'<>]{8,}/i, 'embedded credential'],
];

function markdownDocs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort().map(name => path.join(dir, name));
}

function textFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const data = fs.readFileSync(absolute);
        if (!data.includes(0) && !data.toString('utf8').includes('�')) files.push(absolute);
      }
    }
  };
  walk(dir);
  return files;
}

function readDoc(file: string, issues: string[]): MemoryDoc | null {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    issues.push(`${ path.relative(path.dirname(path.dirname(file)), file) }: missing YAML frontmatter`);
    return null;
  }
  try {
    const front = parseYaml(match[1]);
    if (!front || typeof front !== 'object' || Array.isArray(front)) throw new Error('frontmatter must be an object');
    return { file, front };
  } catch (error) {
    issues.push(`${ path.basename(file) }: invalid YAML frontmatter (${ (error as Error).message })`);
    return null;
  }
}

function knownCoreSubjects(): Set<string> {
  const subjects = new Set<string>(['global']);
  const dir = path.join(resolveMemorySeedDir(), 'subjects');
  for (const file of markdownDocs(dir)) {
    const match = fs.readFileSync(file, 'utf8').match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) continue;
    try {
      const slug = String(parseYaml(match[1])?.slug ?? '');
      if (slug) subjects.add(slug);
    } catch { /* The core seeder reports malformed shipped documents. */ }
  }
  return subjects;
}

/** Validate the portable on-disk contract shared by marketplace and memory/pack_validate. */
export function validateMemoryPackFormat(packDir: string, packSlug: string): string[] {
  const issues: string[] = [];
  const root = path.join(packDir, 'memory');
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) issues.push('memory/manifest.json is required');
  else {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Number.isInteger(manifest?.version) || manifest.version < 1) issues.push('memory/manifest.json: version must be a positive integer');
    } catch (error) {
      issues.push(`memory/manifest.json: invalid JSON (${ (error as Error).message })`);
    }
  }

  const subjectFiles = markdownDocs(path.join(root, 'subjects'));
  const skillFiles = markdownDocs(path.join(root, 'skills'));
  if (subjectFiles.length === 0) issues.push('memory/subjects must contain at least one .md subject');
  if (skillFiles.length === 0) issues.push('memory/skills must contain at least one .md skill');

  const subjects = subjectFiles.map(file => readDoc(file, issues)).filter((doc): doc is MemoryDoc => Boolean(doc));
  const skills = skillFiles.map(file => readDoc(file, issues)).filter((doc): doc is MemoryDoc => Boolean(doc));
  const knownSubjects = knownCoreSubjects();
  for (const doc of subjects) {
    const slug = String(doc.front.slug ?? '');
    const filename = path.basename(doc.file, '.md');
    if (!SLUG.test(slug)) issues.push(`memory/subjects/${ filename }.md: slug must be kebab-case`);
    if (slug !== filename) issues.push(`memory/subjects/${ filename }.md: slug "${ slug }" must match filename`);
    knownSubjects.add(slug);
    for (const field of ['kind', 'name', 'parent']) if (!doc.front[field]) issues.push(`memory/subjects/${ filename }.md: ${ field } is required`);
  }
  for (const doc of subjects) {
    const parent = String(doc.front.parent ?? '');
    if (parent && !knownSubjects.has(parent)) issues.push(`memory/subjects/${ path.basename(doc.file) }: parent "${ parent }" does not exist`);
  }
  for (const doc of skills) {
    const slug = String(doc.front.slug ?? '');
    const filename = path.basename(doc.file, '.md');
    if (!SLUG.test(slug)) issues.push(`memory/skills/${ filename }.md: slug must be kebab-case`);
    if (slug !== filename) issues.push(`memory/skills/${ filename }.md: slug "${ slug }" must match filename`);
    for (const field of ['label', 'trigger_when']) if (!doc.front[field]) issues.push(`memory/skills/${ filename }.md: ${ field } is required`);
    const scope = doc.front.scope;
    if (!Array.isArray(scope) || scope.length === 0) issues.push(`memory/skills/${ filename }.md: scope must be a non-empty array`);
    else for (const subject of scope.map(String)) if (!knownSubjects.has(subject)) issues.push(`memory/skills/${ filename }.md: scope "${ subject }" does not exist`);
  }

  const allFiles = textFiles(packDir);
  for (const file of allFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(packDir, file).split(path.sep).join('/');
    if (/(?:^|[\s"'`])(?:\/(?:Users|home)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/m.test(source)) issues.push(`${ relative }: contains a personal absolute home path`);
    for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(source)) issues.push(`${ relative }: contains a possible ${ label }`);
  }

  if (!SLUG.test(packSlug)) issues.push(`pack slug "${ packSlug }" must be kebab-case`);
  return Array.from(new Set(issues));
}
