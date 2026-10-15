/**
 * SkillDefinitionService — skills live in the skill_definitions table.
 *
 * SKILL.md folders are an import/export format only:
 *   - importSkillFolders copies folder skills into the table when their slug is
 *     new, and leaves the folders untouched. A row it imported that nobody has
 *     edited in the database follows later edits to its folder (Library edits,
 *     a `git pull` of sulla-resources, a marketplace update); a row edited in
 *     the database never does.
 *   - materializeSkill writes a row out to ~/sulla/cache/skills/<slug>/ for
 *     callers that need real files on disk (scripts, html, templates).
 *   - exportSkillToDir writes a row out as a marketplace-shaped folder.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';

import { SkillService } from './SkillService';
import {
  SkillDefinitionModel,
  type SkillContent,
  type SkillDefinition,
  type SkillFile,
  type SkillSourceKind,
} from '../database/models/SkillDefinitionModel';
import { resolveSullaHomeDir, resolveSullaSkillsDir, resolveSullaUserSkillsDir } from '../utils/sullaPaths';

export const SKILL_MANIFEST = 'SKILL.md';
/** Files larger than this are left out of the row (and logged). */
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;
export const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Never copied into a row: VCS/OS noise and the marketplace install marker. */
const SKIPPED_NAMES = new Set(['.git', '.DS_Store', 'node_modules', '.marketplace.json', '__pycache__']);

export interface ParsedSkill {
  slug:    string;
  content: SkillContent;
}

export interface SkillFolderSource {
  dir:        string;
  sourceKind: SkillSourceKind;
}

export interface SkillImportSummary {
  imported:  number;
  refreshed: number;
  skipped:   number;
  errors:    string[];
}

/**
 * Split SKILL.md into frontmatter text and body, keeping both exact so the row
 * renders back byte for byte. Returns null when there is no frontmatter.
 */
export function splitSkillMarkdown(raw: string): { frontmatterText: string; body: string } | null {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(String(raw ?? ''));
  return match ? { frontmatterText: match[1], body: match[2] } : null;
}

/** Parse SKILL.md text into row content. Null when it is not a valid skill. */
export function parseSkillMarkdown(raw: string, fallbackSlug = '', files: Record<string, SkillFile> = {}): ParsedSkill | null {
  const split = splitSkillMarkdown(raw);
  if (!split) return null;
  let frontmatter: Record<string, unknown>;
  try {
    const loaded = yaml.load(split.frontmatterText);
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return null;
    // Round-trip through JSON so dates and the like become plain JSONB values.
    frontmatter = JSON.parse(JSON.stringify(loaded));
  } catch {
    return null;
  }

  // Reuse the registry's own rules for title, description and triggers.
  const service = SkillService.fromRaw('database', fallbackSlug, String(raw));
  if (!service) return null;
  const slug = service.slug;
  if (!SKILL_SLUG_PATTERN.test(slug)) return null;

  const version = frontmatter.version ?? null;
  return {
    slug,
    content: {
      title:            service.name,
      description:      service.description,
      tags:             Array.isArray(frontmatter.tags) ? frontmatter.tags.map(tag => String(tag).trim()).filter(Boolean) : [],
      triggers:         service.triggers,
      body:             split.body,
      frontmatter,
      frontmatter_text: split.frontmatterText,
      files,
      version:          version == null ? null : String(version),
    },
  };
}

/** The SKILL.md text a row stands for. */
export function renderSkillMarkdown(skill: Pick<SkillContent, 'frontmatter' | 'frontmatter_text' | 'body'>): string {
  const frontmatterText = skill.frontmatter_text || yaml.dump(skill.frontmatter ?? {}).replace(/\n$/, '');
  return `---\n${ frontmatterText }\n---\n${ skill.body ?? '' }`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${ value.map(canonicalJson).join(',') }]`;
  if (value && typeof value === 'object') {
    return `{${ Object.keys(value).sort().map(key => `${ JSON.stringify(key) }:${ canonicalJson((value as any)[key]) }`).join(',') }}`;
  }
  return JSON.stringify(value ?? null);
}

/** Stable hash of a skill's content (a parsed folder or a live row). */
export function hashSkillContent(content: SkillContent | SkillDefinition): string {
  const picked = {
    title:            content.title,
    description:      content.description,
    tags:             content.tags,
    triggers:         content.triggers,
    body:             content.body,
    frontmatter:      content.frontmatter,
    frontmatter_text: content.frontmatter_text,
    files:            content.files,
    version:          content.version || null,
  };
  return `sha256:${ createHash('sha256').update(canonicalJson(picked)).digest('hex') }`;
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  return buffer.toString('utf8').includes('�') && !buffer.toString('latin1').includes('�');
}

/**
 * The non-SKILL.md files of a skill folder. Skips VCS/OS noise, symlinks and
 * anything over 1 MB (logged).
 */
export function readSkillFolderFiles(dir: string): Record<string, SkillFile> {
  const files: Record<string, SkillFile> = {};
  const walk = (current: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED_NAMES.has(entry.name) || entry.name.includes('.sulla-update-')) continue;
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${ prefix }/${ entry.name }` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile() || rel === SKILL_MANIFEST) continue;
      try {
        const size = fs.statSync(abs).size;
        if (size > SKILL_FILE_MAX_BYTES) {
          console.warn(`[Skills] Skipped ${ abs } (${ size } bytes > 1 MB) — not stored in the database`);
          continue;
        }
        const buffer = fs.readFileSync(abs);
        files[rel] = looksBinary(buffer) ? { encoding: 'base64', content: buffer.toString('base64') } : buffer.toString('utf8');
      } catch (error) {
        console.warn(`[Skills] Could not read ${ abs }:`, error);
      }
    }
  };
  walk(dir, '');
  return files;
}

/** Parse one skill folder (<dir>/SKILL.md plus its other files). */
export function readSkillFolder(dir: string): ParsedSkill | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, SKILL_MANIFEST), 'utf8');
  } catch {
    return null;
  }
  return parseSkillMarkdown(raw, path.basename(dir), readSkillFolderFiles(dir));
}

/** Legacy flat .md skills: kept only when they are clearly marked as skills. */
function looksLikeFlatSkill(parsed: ParsedSkill): boolean {
  if (parsed.content.tags.map(tag => tag.toLowerCase()).includes('skill')) return true;
  const slug = parsed.slug.toLowerCase();
  return slug.startsWith('skill-') || slug.startsWith('sop-');
}

/** Every skill a folder holds: <name>/SKILL.md folders, then legacy skill-tagged .md files anywhere below. */
export function scanSkillDir(dir: string): { parsed: ParsedSkill; sourcePath: string }[] {
  const found: { parsed: ParsedSkill; sourcePath: string }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  const seen = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = path.join(dir, entry.name);
    const parsed = readSkillFolder(folder);
    if (parsed && !seen.has(parsed.slug)) {
      seen.add(parsed.slug);
      found.push({ parsed, sourcePath: folder });
    }
  }
  // Legacy: any other .md file anywhere under the dir that is marked as a
  // skill (the old registry scanned the whole tree the same way).
  const walk = (current: string) => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIPPED_NAMES.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || entry.name === SKILL_MANIFEST || !/\.(md|markdown)$/i.test(entry.name)) continue;
      try {
        const parsed = parseSkillMarkdown(fs.readFileSync(abs, 'utf8'), path.basename(entry.name, path.extname(entry.name)));
        if (parsed && !seen.has(parsed.slug) && looksLikeFlatSkill(parsed)) {
          seen.add(parsed.slug);
          found.push({ parsed, sourcePath: abs });
        }
      } catch {
        // Unreadable file: skip.
      }
    }
  };
  walk(dir);
  return found;
}

/**
 * The folders skills are imported from. ~/sulla/skills comes first: it always
 * won over ~/sulla/resources/skills when both had the same slug.
 */
export function defaultSkillFolderSources(): SkillFolderSource[] {
  const fromEnv = String(process.env.SULLA_SKILLS_DIRS || '').split(',').map(value => value.trim()).filter(Boolean);
  const sources: SkillFolderSource[] = [
    { dir: resolveSullaUserSkillsDir(), sourceKind: 'user' },
    ...fromEnv.map(dir => ({ dir, sourceKind: 'user' as const })),
    { dir: resolveSullaSkillsDir(), sourceKind: 'resources' },
  ];
  const seen = new Set<string>();
  return sources.filter(({ dir }) => {
    const key = path.resolve(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Marketplace install marker of a folder, if it came from the marketplace. */
function readMarketplaceMarker(folder: string): { templateId?: string; slug?: string; version?: string } | null {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(folder, '.marketplace.json'), 'utf8'));
    return marker && typeof marker === 'object' ? marker : null;
  } catch {
    return null;
  }
}

/**
 * Pure decision for one folder skill against its row (if any).
 *   - no row                                    → import
 *   - row imported from this same path, never edited in the DB, folder changed → refresh
 *   - anything else                             → skip (the DB row wins)
 */
export function decideFolderImport(
  parsed: ParsedSkill,
  sourcePath: string,
  row: SkillDefinition | null,
): 'import' | 'refresh' | 'skip' {
  if (!row) return 'import';
  if (row.deleted_at || !row.source_hash || row.source_path !== sourcePath) return 'skip';
  if (hashSkillContent(row) !== row.source_hash) return 'skip';
  return hashSkillContent(parsed.content) === row.source_hash ? 'skip' : 'refresh';
}

/** Copy folder skills into the table. Folders are only read, never changed. */
export async function importSkillFolders(
  sources: SkillFolderSource[] = defaultSkillFolderSources(),
  options: { insertOnly?: boolean } = {},
): Promise<SkillImportSummary> {
  const summary: SkillImportSummary = { imported: 0, refreshed: 0, skipped: 0, errors: [] };
  const claimed = new Set<string>();

  for (const source of sources) {
    for (const { parsed, sourcePath } of scanSkillDir(source.dir)) {
      if (claimed.has(parsed.slug)) {
        summary.skipped++;
        continue;
      }
      claimed.add(parsed.slug);
      try {
        const row = await SkillDefinitionModel.findBySlug(parsed.slug);
        const action = row && options.insertOnly ? 'skip' : decideFolderImport(parsed, sourcePath, row);
        const hash = hashSkillContent(parsed.content);
        if (action === 'import') {
          const marker = readMarketplaceMarker(sourcePath);
          await SkillDefinitionModel.create({
            slug:                  parsed.slug,
            ...parsed.content,
            sourceKind:            marker?.templateId ? 'marketplace' : source.sourceKind,
            sourcePath,
            sourceHash:            hash,
            contentHash:           hash,
            marketplaceTemplateId: marker?.templateId ?? null,
            marketplaceSlug:       marker?.slug ?? null,
            marketplaceVersion:    marker?.version ?? null,
          });
          summary.imported++;
        } else if (action === 'refresh') {
          // Compare-and-set: a database edit that lands mid-import wins.
          const updated = await SkillDefinitionModel.update(row!.id, { ...parsed.content, sourceHash: hash, contentHash: hash }, row!.updated_at);
          if (updated) summary.refreshed++;
          else summary.skipped++;
        } else {
          summary.skipped++;
        }
      } catch (error) {
        summary.errors.push(`${ parsed.slug }: ${ error instanceof Error ? error.message : String(error) }`);
      }
    }
  }
  return summary;
}

/**
 * Import one folder right away (marketplace download/update). The folder's
 * content replaces the row when the row came from the marketplace or from this
 * same folder, or when `force` is set; a skill the human made or edited in
 * the database is otherwise kept.
 */
export async function importSkillFolder(
  folder: string,
  opts: { sourceKind: SkillSourceKind; force?: boolean; marketplace?: { templateId?: string; slug?: string; version?: string; author?: string } },
): Promise<SkillDefinition | null> {
  const parsed = readSkillFolder(folder);
  if (!parsed) return null;
  const hash = hashSkillContent(parsed.content);
  const marketplace = {
    marketplaceTemplateId: opts.marketplace?.templateId ?? null,
    marketplaceSlug:       opts.marketplace?.slug ?? null,
    marketplaceVersion:    opts.marketplace?.version ?? null,
    marketplaceAuthor:     opts.marketplace?.author ?? null,
  };
  const row = await SkillDefinitionModel.findBySlug(parsed.slug);
  if (!row) {
    return SkillDefinitionModel.create({
      slug: parsed.slug, ...parsed.content, sourceKind: opts.sourceKind, sourcePath: folder, sourceHash: hash, contentHash: hash, ...marketplace,
    });
  }
  const owned = opts.force || row.source_kind === 'marketplace' || (row.source_path === folder && hashSkillContent(row) === row.source_hash);
  if (!owned) return row;
  return SkillDefinitionModel.update(row.id, {
    ...parsed.content, sourceKind: opts.sourceKind, sourcePath: folder, sourceHash: hash, contentHash: hash, deleted: false, ...marketplace,
  });
}

function safeRelativePath(rel: string): string | null {
  const normalized = String(rel ?? '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => part === '..' || part === '')) return null;
  return normalized;
}

/** Write a row out as a skill folder: SKILL.md plus its files. */
export function exportSkillToDir(skill: SkillDefinition, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL_MANIFEST), renderSkillMarkdown(skill), 'utf8');
  for (const [rel, file] of Object.entries(skill.files ?? {})) {
    const safe = safeRelativePath(rel);
    if (!safe || safe === SKILL_MANIFEST) continue;
    const target = path.join(dir, safe);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof file === 'string') fs.writeFileSync(target, file, 'utf8');
    else if (file?.encoding === 'base64') fs.writeFileSync(target, Buffer.from(String(file.content ?? ''), 'base64'));
  }
  return dir;
}

/**
 * Export a database skill to a fresh temp folder (<tmp>/<slug>/) for tools
 * that work on folders (marketplace validate/publish/diff). Null when the
 * table has no live row for the slug. Call cleanup() when done.
 */
export async function exportSkillToTempDir(slug: string): Promise<{ dir: string; skill: SkillDefinition; cleanup: () => void } | null> {
  const skill = await SkillDefinitionModel.findBySlug(String(slug || '').trim());
  if (!skill || skill.deleted_at || !SKILL_SLUG_PATTERN.test(skill.slug)) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-skill-'));
  return {
    dir:     exportSkillToDir(skill, path.join(tmp, skill.slug)),
    skill,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

export function resolveSkillCacheDir(): string {
  return path.join(resolveSullaHomeDir(), 'cache', 'skills');
}

/**
 * Write a row to ~/sulla/cache/skills/<slug>/ and return that path. The cache
 * folder is rebuilt from the row every time; edits there are not read back.
 */
export function materializeSkill(skill: SkillDefinition): string {
  if (!SKILL_SLUG_PATTERN.test(skill.slug)) throw new Error(`Unsafe skill slug: ${ skill.slug }`);
  const root = resolveSkillCacheDir();
  const dir = path.join(root, skill.slug);
  if (path.dirname(dir) !== root) throw new Error(`Unsafe skill slug: ${ skill.slug }`);
  fs.rmSync(dir, { recursive: true, force: true });
  return exportSkillToDir(skill, dir);
}

/**
 * Create or update a skill from SKILL.md text. An update keeps the row's
 * source bookkeeping, so it now counts as edited and is never overwritten by
 * the built-in catalog or a folder import. Saving a soft-deleted slug restores it.
 */
export async function saveSkillFromMarkdown(input: {
  markdown:    string;
  slug?:       string;
  files?:      Record<string, SkillFile>;
  sourceKind?: SkillSourceKind;
}): Promise<{ skill: SkillDefinition; created: boolean }> {
  const parsed = parseSkillMarkdown(input.markdown, input.slug ?? '');
  if (!parsed) throw new Error('SKILL.md needs a YAML frontmatter block (--- ... ---) with at least a slug or title.');
  if (input.slug && parsed.slug !== input.slug) {
    throw new Error(`Frontmatter slug "${ parsed.slug }" does not match slug "${ input.slug }".`);
  }
  const existing = await SkillDefinitionModel.findBySlug(parsed.slug);
  const content: SkillContent = { ...parsed.content, files: input.files ?? existing?.files ?? {} };
  const hash = hashSkillContent(content);
  if (!existing) {
    const skill = await SkillDefinitionModel.create({ slug: parsed.slug, ...content, sourceKind: input.sourceKind ?? 'user', contentHash: hash });
    return { skill, created: true };
  }
  const skill = await SkillDefinitionModel.update(existing.id, { ...content, contentHash: hash, deleted: false });
  if (!skill) throw new Error(`Skill ${ parsed.slug } disappeared while saving.`);
  return { skill, created: false };
}
