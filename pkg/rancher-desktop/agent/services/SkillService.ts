import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

export type SkillSource = 'database' | 'filesystem';

export interface SkillManifest {
  schemaversion?:    number;
  slug:              string;
  title:             string;
  section?:          string;
  category?:         string;
  tags?:             string[];
  order?:            number | string;
  locked?:           boolean;
  author?:           string;
  created_at?:       string;
  updated_at?:       string;
  mentions?:         string[];
  related_entities?: string[];
  [key: string]:     unknown;
}

export interface SkillResource {
  type: string;
  path: string;
}

export interface SkillSchema {
  source:      SkillSource;
  manifest:    SkillManifest;
  slug:        string;
  name:        string;
  triggers:    string[];
  description: string;
  resources:   SkillResource[];
  templates:   string[];
  scripts:     string[];
  document:    string;
}

export interface SkillSummarySchema {
  slug:        string;
  name:        string;
  triggers:    string[];
  description: string;
}

export interface SkillLoadedResource {
  type:    string;
  path:    string;
  content: string;
}

export class SkillService {
  readonly source:   SkillSource;
  readonly manifest: SkillManifest;
  readonly document: string;

  private constructor(source: SkillSource, manifest: SkillManifest, document: string) {
    this.source = source;
    this.manifest = manifest;
    this.document = document;
  }

  static fromRaw(source: SkillSource, fallbackSlug: string, rawContent: string): SkillService | null {
    const parsed = this.parseSkillDocument(rawContent);
    if (!parsed) return null;

    const manifest = parsed.manifest;
    const normalizedSlug = String(manifest.slug || fallbackSlug || '').trim();
    const normalizedTitle = String(manifest.title || normalizedSlug || '').trim();

    if (!normalizedSlug || !normalizedTitle) return null;

    return new SkillService(source, {
      ...manifest,
      slug:  normalizedSlug,
      title: normalizedTitle,
    }, parsed.document);
  }

  static fromParts(source: SkillSource, manifest: SkillManifest, document: string): SkillService | null {
    const slug = String(manifest.slug || '').trim();
    const title = String(manifest.title || '').trim();
    if (!slug || !title) return null;

    return new SkillService(source, {
      ...manifest,
      slug,
      title,
    }, String(document || ''));
  }

  get slug(): string {
    return this.manifest.slug;
  }

  get name(): string {
    return this.manifest.title;
  }

  get resources(): SkillResource[] {
    const fromYamlBlock = this.extractResourcesYamlBlock(this.document);
    if (fromYamlBlock.length > 0) return fromYamlBlock;

    const resources: SkillResource[] = [];
    const lines = this.document.split(/\r?\n/);

    for (const line of lines) {
      const m = /^\s*[-*]\s*(Template|Script|Doc|Config)\s*:\s*`?([^`\n]+)`?\s*$/i.exec(line);
      if (!m) continue;

      const typeLabel = m[1].toLowerCase();
      const path = m[2].trim();

      resources.push({
        type: typeLabel === 'doc' ? 'doc' : typeLabel,
        path,
      });
    }

    return resources;
  }

  get templates(): string[] {
    return this.resources.filter(r => r.type === 'template').map(r => r.path);
  }

  get scripts(): string[] {
    return this.resources.filter(r => r.type === 'script').map(r => r.path);
  }

  get triggers(): string[] {
    const out = new Set<string>();
    const doc = this.document;

    const explicit = (/\*\*Triggers?\*\*\s*:\s*(.+)/i.exec(doc)) || (/(?:^|\n)\s*Triggers?\s*:\s*(.+)/i.exec(doc));
    if (explicit?.[1]) {
      this.splitTriggerCandidates(explicit[1]).forEach(t => out.add(t));
    }

    const triggerSection = this.extractMarkdownSection('Triggers') || this.extractMarkdownSection('Trigger');
    if (triggerSection) {
      triggerSection
        .split(/\r?\n/)
        .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
        .filter(Boolean)
        .forEach(line => this.splitTriggerCandidates(line).forEach(t => out.add(t)));
    }

    const triggerFrontmatter = String(this.manifest.trigger || '').trim();
    if (triggerFrontmatter) {
      this.splitTriggerCandidates(triggerFrontmatter).forEach(t => out.add(t));
    }

    const triggerFrontmatterList = Array.isArray((this.manifest as any).triggers)
      ? (this.manifest as any).triggers
      : [];
    triggerFrontmatterList
      .map((value: unknown) => String(value || '').trim())
      .filter(Boolean)
      .forEach((value: string) => this.splitTriggerCandidates(value).forEach(t => out.add(t)));

    return Array.from(out);
  }

  get description(): string {
    const manifestDescription = String((this.manifest as any).description || '').trim();
    if (manifestDescription) return manifestDescription;

    const descriptionSection = this.extractMarkdownSection('Description');
    if (descriptionSection) {
      const firstParagraph = descriptionSection
        .split(/\n\s*\n/)
        .map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
        .find(Boolean);
      if (firstParagraph) return firstParagraph;
    }

    const goalMatch = /\*\*Goal\*\*\s*:\s*(.+)/i.exec(this.document);
    if (goalMatch?.[1]) return goalMatch[1].trim();

    const lines = this.document.split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !l.startsWith('#') &&
        !/^\*\*Triggers?\*\*/i.test(l) &&
        !/^\*\*Goal\*\*/i.test(l) &&
        !/^\*\*Status\*\*/i.test(l));

    return lines[0] || this.name;
  }

  get plannerSection(): string {
    return this.extractMarkdownSection('Planner');
  }

  getSchema(): SkillSchema {
    return {
      source:      this.source,
      manifest:    this.manifest,
      slug:        this.slug,
      name:        this.name,
      triggers:    this.triggers,
      description: this.description,
      resources:   this.resources,
      templates:   this.templates,
      scripts:     this.scripts,
      document:    this.document,
    };
  }

  getSummarySchema(): SkillSummarySchema {
    return {
      slug:        this.slug,
      name:        this.name,
      triggers:    this.triggers,
      description: this.description,
    };
  }

  getManifestAssistantMessage(): string {
    const resourceLines = this.resources.length > 0
      ? this.resources.map((resource) => `- ${ resource.type }: ${ resource.path }`).join('\n')
      : '- none';

    return [
      `${ this.name }`,
      `slug: ${ this.slug }`,
      `trigger: ${ this.triggers.join(' | ') || 'none' }`,
      `description: ${ this.description }`,
      'resources:',
      resourceLines,
    ].join('\n');
  }

  async loadPlannerResources(): Promise<SkillLoadedResource[]> {
    const loadableResources = this.resources.filter((resource) => {
      const type = String(resource.type || '').toLowerCase();
      return type !== 'script' && type !== 'tool' && type !== 'tools';
    });

    const loaded: SkillLoadedResource[] = [];
    for (const resource of loadableResources) {
      const candidates = this.resolveResourcePaths(resource.path);
      for (const absolutePath of candidates) {
        try {
          const content = await this.readResourceContentForAssistant(absolutePath);
          loaded.push({
            type: resource.type,
            path: resource.path,
            content,
          });
          break;
        } catch {
          continue;
        }
      }
    }

    const discoveredResources = await this.loadDiscoveredTemplateAndResourceFiles();
    const dedupeKey = (resource: SkillLoadedResource): string => {
      const type = String(resource.type || '').toLowerCase();
      const resourcePath = String(resource.path || '').trim();
      return `${ type }:${ resourcePath }`;
    };

    const seen = new Set<string>(loaded.map(dedupeKey));
    for (const resource of discoveredResources) {
      const key = dedupeKey(resource);
      if (seen.has(key)) continue;
      seen.add(key);
      loaded.push(resource);
    }

    return loaded;
  }

  async loadPrimaryPrdTemplate(): Promise<string> {
    const templateResources = this.resources.filter((resource) => String(resource.type || '').toLowerCase() === 'template');
    if (templateResources.length === 0) return '';

    const prdResource = templateResources.find((resource) => /(^|\/)prd\.[^/]+$/i.test(String(resource.path || '').trim())) ||
      templateResources[0];
    if (!prdResource) return '';

    const candidates = this.resolveResourcePaths(prdResource.path);
    for (const absolutePath of candidates) {
      try {
        const content = await this.readResourceContentForAssistant(absolutePath);
        return String(content || '').trim();
      } catch {
        continue;
      }
    }

    return '';
  }

  private static parseSkillDocument(rawContent: string): { manifest: SkillManifest; document: string } | null {
    const raw = String(rawContent || '');
    const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
    if (!fmMatch) return null;

    try {
      const parsed = yaml.load(fmMatch[1]) as SkillManifest;
      if (!parsed || typeof parsed !== 'object') return null;

      return {
        manifest: parsed,
        document: fmMatch[2] || '',
      };
    } catch {
      return null;
    }
  }

  private extractResourcesYamlBlock(document: string): SkillResource[] {
    const match = /```yaml\s*\n([\s\S]*?)\n```/i.exec(document);
    if (!match?.[1]) return [];

    try {
      const parsed = yaml.load(match[1]) as { resources?: { type?: string; path?: string }[] };
      const resources = Array.isArray(parsed?.resources) ? parsed.resources : [];

      return resources
        .map(item => ({
          type: String(item?.type || '').trim().toLowerCase(),
          path: String(item?.path || '').trim(),
        }))
        .filter(item => item.type.length > 0 && item.path.length > 0);
    } catch {
      return [];
    }
  }

  private splitTriggerCandidates(input: string): string[] {
    const raw = String(input || '').trim();
    if (!raw) return [];

    const fromQuotes = Array.from(raw.matchAll(/"([^"]+)"/g))
      .map(match => String(match[1] || '').trim())
      .filter(Boolean);

    const fromDelimiters = raw
      .split(/[,;]|\s+\|\s+/)
      .map(s => s.trim())
      .map(s => s.replace(/^human\s+says\s+/i, '').trim())
      .map(s => s.replace(/^['"]+|['"]+$/g, '').trim())
      .filter(Boolean);

    return Array.from(new Set([...fromQuotes, ...fromDelimiters]));
  }

  private extractMarkdownSection(sectionHeading: string): string {
    const heading = String(sectionHeading || '').trim();
    if (!heading) return '';

    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRegex = new RegExp(
      `(?:^|\\n)##\\s+${ escapedHeading }\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`,
      'i',
    );
    const match = this.document.match(sectionRegex);
    return match?.[1]?.trim() || '';
  }

  private async loadDiscoveredTemplateAndResourceFiles(): Promise<SkillLoadedResource[]> {
    const discovered: SkillLoadedResource[] = [];
    const visitedDirs = new Set<string>();

    const basePaths = this.deriveSkillBasePaths();
    for (const basePath of basePaths) {
      for (const folderName of ['templates', 'resources']) {
        const relativeDir = this.joinResourcePath(basePath, folderName);
        const directoryCandidates = this.resolveResourcePaths(relativeDir);

        for (const absoluteDir of directoryCandidates) {
          const normalizedDir = path.resolve(absoluteDir);
          if (visitedDirs.has(normalizedDir)) continue;
          visitedDirs.add(normalizedDir);

          const files = await this.collectFilesRecursively(normalizedDir);
          for (const filePath of files) {
            try {
              const content = await this.readResourceContentForAssistant(filePath);
              const relativeWithinDir = path.relative(normalizedDir, filePath).split(path.sep).join('/');
              const resourcePath = this.joinResourcePath(relativeDir, relativeWithinDir);

              discovered.push({
                type: folderName === 'templates' ? 'template' : 'resource',
                path: resourcePath,
                content,
              });
            } catch {
              continue;
            }
          }
        }
      }
    }

    return discovered;
  }

  private deriveSkillBasePaths(): string[] {
    const out = new Set<string>();

    for (const resource of this.resources) {
      const resourcePath = String(resource.path || '').trim();
      if (!resourcePath) continue;

      const normalized = resourcePath.replace(/\\/g, '/');
      const templatesIdx = normalized.lastIndexOf('/templates/');
      const resourcesIdx = normalized.lastIndexOf('/resources/');

      if (templatesIdx > -1) {
        out.add(normalized.slice(0, templatesIdx));
      }
      if (resourcesIdx > -1) {
        out.add(normalized.slice(0, resourcesIdx));
      }
    }

    return Array.from(out).filter(Boolean);
  }

  private joinResourcePath(...parts: string[]): string {
    return parts
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('/')
      .replace(/\/+/g, '/');
  }

  private async collectFilesRecursively(dirPath: string): Promise<string[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        const absolutePath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const nested = await this.collectFilesRecursively(absolutePath);
          files.push(...nested);
          continue;
        }

        if (!entry.isFile()) continue;
        files.push(absolutePath);
      }

      return files;
    } catch {
      return [];
    }
  }

  private async readResourceContentForAssistant(absolutePath: string): Promise<string> {
    const rawContent = await readFile(absolutePath, 'utf8');
    const expectedExportName = this.getExpectedExportNameFromPath(absolutePath);
    const extracted = this.extractExportedConstValue(rawContent, expectedExportName);
    return extracted ?? rawContent;
  }

  private getExpectedExportNameFromPath(filePath: string): string {
    const base = path.basename(String(filePath || '').trim(), path.extname(String(filePath || '').trim()));
    return base.replace(/[^a-zA-Z0-9_$]/g, '_');
  }

  private extractExportedConstValue(source: string, expectedExportName: string): string | null {
    const raw = String(source || '');
    const expected = String(expectedExportName || '').trim();
    if (!raw.trim()) return null;

    const byExpectedName = expected
      ? this.extractConstAssignmentLiteral(raw, expected)
      : null;
    if (byExpectedName) return byExpectedName;

    const firstConstMatch = /export\s+const\s+[a-zA-Z_$][\w$]*\s*=\s*(`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')\s*;?/m.exec(raw);
    if (!firstConstMatch?.[1]) return null;

    return this.unwrapLiteral(firstConstMatch[1]);
  }

  private extractConstAssignmentLiteral(source: string, constName: string): string | null {
    const escapedConstName = constName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `export\\s+const\\s+${ escapedConstName }\\s*=\\s*(` +
        '(?:[^`\\\\]|\\\\[\\s\\S])*`|' +
        '"(?:[^"\\\\]|\\\\[\\s\\S])*"|' +
        "'(?:[^'\\\\]|\\\\[\\s\\S])*'" +
        ')\\s*;?',
      'm',
    );

    const match = source.match(regex);
    if (!match?.[1]) return null;
    return this.unwrapLiteral(match[1]);
  }

  private unwrapLiteral(literal: string): string {
    const value = String(literal || '');
    if (value.length < 2) return value;

    if (value.startsWith('`') && value.endsWith('`')) {
      return value.slice(1, -1).replace(/\\`/g, '`');
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      try {
        return JSON.parse(value.startsWith("'") ? `"${ value.slice(1, -1).replace(/\\/g, '\\\\').replace(/"/g, '\\"') }"` : value);
      } catch {
        return value.slice(1, -1);
      }
    }

    return value;
  }

  private resolveResourcePaths(resourcePath: string): string[] {
    const target = String(resourcePath || '').trim();
    if (!target) return [];

    if (path.isAbsolute(target)) {
      return [target];
    }

    const cwd = process.cwd();
    const candidates = [
      path.resolve(cwd, target),
      path.resolve(cwd, 'agent', target),
      path.resolve(cwd, 'pkg/rancher-desktop/agent', target),
    ];

    return candidates;
  }
}
