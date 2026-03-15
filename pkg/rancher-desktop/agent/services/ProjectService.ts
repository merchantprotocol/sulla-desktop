import yaml from 'js-yaml';

export type ProjectSource = 'database' | 'filesystem';

export interface ProjectManifest {
  schemaversion?:  number;
  slug:            string;
  title:           string;
  section?:        string;
  category?:       string;
  tags?:           string[];
  owner?:          string;
  status?:         string;
  start_date?:     string;
  workspace_path?: string;
  github_url?:     string;
  [key: string]:   unknown;
}

export interface ProjectSchema {
  source:        ProjectSource;
  manifest:      ProjectManifest;
  slug:          string;
  name:          string;
  description:   string;
  status:        string;
  workspacePath: string;
  document:      string;
}

export interface ProjectSummarySchema {
  slug:        string;
  name:        string;
  status:      string;
  description: string;
}

export class ProjectService {
  readonly source:   ProjectSource;
  readonly manifest: ProjectManifest;
  readonly document: string;

  private constructor(source: ProjectSource, manifest: ProjectManifest, document: string) {
    this.source = source;
    this.manifest = manifest;
    this.document = document;
  }

  static fromRaw(source: ProjectSource, fallbackSlug: string, rawContent: string): ProjectService | null {
    const parsed = this.parseProjectDocument(rawContent);
    if (!parsed) return null;

    const manifest = parsed.manifest;
    const normalizedSlug = String(manifest.slug || fallbackSlug || '').trim();
    const normalizedTitle = String(manifest.title || normalizedSlug || '').trim();

    if (!normalizedSlug || !normalizedTitle) return null;

    return new ProjectService(source, {
      ...manifest,
      slug:  normalizedSlug,
      title: normalizedTitle,
    }, parsed.document);
  }

  static fromParts(source: ProjectSource, manifest: ProjectManifest, document: string): ProjectService | null {
    const slug = String(manifest.slug || '').trim();
    const title = String(manifest.title || '').trim();
    if (!slug || !title) return null;

    return new ProjectService(source, {
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

  get status(): string {
    return String(this.manifest.status || 'active').trim();
  }

  get workspacePath(): string {
    return String(this.manifest.workspace_path || '').trim();
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
        !/^\*\*Status\*\*/i.test(l) &&
        !/^\*\*Owner\*\*/i.test(l) &&
        !/^\*\*Start Date\*\*/i.test(l));

    return lines[0] || this.name;
  }

  getSchema(): ProjectSchema {
    return {
      source:        this.source,
      manifest:      this.manifest,
      slug:          this.slug,
      name:          this.name,
      description:   this.description,
      status:        this.status,
      workspacePath: this.workspacePath,
      document:      this.document,
    };
  }

  getSummarySchema(): ProjectSummarySchema {
    return {
      slug:        this.slug,
      name:        this.name,
      status:      this.status,
      description: this.description,
    };
  }

  getRawContent(): string {
    const frontmatter = yaml.dump(this.manifest, { lineWidth: -1 }).trim();
    return `---\n${ frontmatter }\n---\n\n${ this.document }`;
  }

  /**
   * Replace a specific markdown section (by heading) with new content.
   * Returns the full updated raw content (frontmatter + body).
   */
  patchSection(sectionHeading: string, newContent: string): string {
    const heading = String(sectionHeading || '').trim();
    if (!heading) return this.getRawContent();

    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRegex = new RegExp(
      `((?:^|\\n)(##\\s+${ escapedHeading })\\s*\\n)[\\s\\S]*?(?=\\n##\\s+|$)`,
      'i',
    );

    const match = this.document.match(sectionRegex);
    let updatedDocument: string;

    if (match) {
      updatedDocument = this.document.replace(sectionRegex, `$1${ newContent.trim() }\n`);
    } else {
      // Section doesn't exist — append it
      updatedDocument = `${ this.document.trimEnd() }\n\n## ${ heading }\n${ newContent.trim() }\n`;
    }

    const frontmatter = yaml.dump(this.manifest, { lineWidth: -1 }).trim();
    return `---\n${ frontmatter }\n---\n\n${ updatedDocument }`;
  }

  extractMarkdownSection(sectionHeading: string): string {
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

  private static parseProjectDocument(rawContent: string): { manifest: ProjectManifest; document: string } | null {
    const raw = String(rawContent || '');
    const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
    if (!fmMatch) return null;

    try {
      const parsed = yaml.load(fmMatch[1]) as ProjectManifest;
      if (!parsed || typeof parsed !== 'object') return null;

      return {
        manifest: parsed,
        document: fmMatch[2] || '',
      };
    } catch {
      return null;
    }
  }
}
