import path from 'node:path';

import {
  SkillService,
  type SkillSchema,
  type SkillSummarySchema,
} from '../../services/SkillService';
import { SkillDefinitionModel, type SkillDefinition } from '../models/SkillDefinitionModel';
import { redisClient } from '../RedisClient';

export interface SkillRegistryInitOptions {
  /** Extra folders to import SKILL.md skills from (read-only, copied into the DB). */
  filesystemSkillDirs?: string[];
}

/** The runtime view of one skill_definitions row. */
export function skillServiceFromDefinition(row: SkillDefinition): SkillService | null {
  return SkillService.fromParts('database', { ...row.frontmatter, slug: row.slug, title: row.title }, row.body, row.files);
}

/**
 * SkillsRegistry — every runtime skill read goes through here, and every read
 * comes from the skill_definitions table. SKILL.md folders are only an import
 * source: each rebuild copies folder skills the table does not have yet (see
 * SkillDefinitionService.importSkillFolders) and then loads the table.
 */
export class SkillsRegistry {
  private readonly cacheKey = 'sulla:skills:summary';
  private readonly cacheTimestampKey = 'sulla:skills:summary:timestamp';
  private readonly cacheTTLSeconds = 3600;

  private static instance: SkillsRegistry | null = null;
  private readonly skillsBySlug = new Map<string, SkillService>();
  private initialized = false;
  private initPromise:     Promise<void> | null = null;
  private refreshPromise:  Promise<void> | null = null;
  private cachedSummaries: SkillSummarySchema[] | null = null;
  private cachedAtSeconds = 0;
  private cacheHydrated = false;
  private lastInitOptions: SkillRegistryInitOptions = {};

  static getInstance(): SkillsRegistry {
    return this.instance ?? (this.instance = new SkillsRegistry());
  }

  private constructor() {}

  async initialize(options: SkillRegistryInitOptions = {}): Promise<void> {
    this.lastInitOptions = options;

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.rebuildAndCache(options);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async rebuildAndCache(options: SkillRegistryInitOptions = {}, importFolders = true): Promise<void> {
    const map = new Map<string, SkillService>();

    // Folder skills the table does not have yet are copied in first. Non-fatal:
    // the table is the runtime source either way.
    if (importFolders) {
      try {
        const { defaultSkillFolderSources, importSkillFolders } = await import('../../services/SkillDefinitionService');
        const extra = (options.filesystemSkillDirs || []).map(dir => ({ dir: path.resolve(dir), sourceKind: 'user' as const }));
        const result = await importSkillFolders([...extra, ...defaultSkillFolderSources()]);
        if (result.imported || result.refreshed) {
          console.log(`[SkillsRegistry] Folder skills: ${ result.imported } imported, ${ result.refreshed } refreshed from unedited folders`);
        }
        if (result.errors.length) console.warn('[SkillsRegistry] Folder skill import errors:', result.errors);
      } catch (error) {
        console.warn('[SkillsRegistry] Folder skill import failed:', error);
      }
    }

    for (const row of await SkillDefinitionModel.list()) {
      const service = skillServiceFromDefinition(row);
      if (service) map.set(service.slug, service);
    }

    this.skillsBySlug.clear();
    map.forEach((skill, slug) => this.skillsBySlug.set(slug, skill));
    this.initialized = true;

    this.cachedSummaries = this.buildSummariesFromCurrentMap();
    this.cachedAtSeconds = Math.floor(Date.now() / 1000);
    this.cacheHydrated = true;
    await this.writeSummariesToCache(this.cachedSummaries, this.cachedAtSeconds);

    console.log(`[SkillsRegistry] initialized with ${ this.skillsBySlug.size } skills`);
  }

  async refresh(options: SkillRegistryInitOptions = {}): Promise<void> {
    this.lastInitOptions = options;

    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = this.rebuildAndCache(options)
      .catch((error) => {
        console.warn('[SkillsRegistry] Background refresh failed:', error);
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    await this.refreshPromise;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await this.hydrateSummariesFromCache();

    if (this.cachedSummaries && this.cachedSummaries.length > 0) {
      this.triggerBackgroundRefreshIfNeeded();
      return;
    }

    await this.initialize(this.lastInitOptions);
  }

  async getSkill(slug: string): Promise<SkillService | null> {
    await this.ensureInitialized();

    if (!this.initialized) {
      await this.initialize(this.lastInitOptions);
    }

    return this.skillsBySlug.get(String(slug || '').trim()) ?? null;
  }

  async listSkills(): Promise<SkillService[]> {
    await this.ensureInitialized();

    if (!this.initialized) {
      this.triggerBackgroundRefreshIfNeeded();
      return [];
    }

    return Array.from(this.skillsBySlug.values());
  }

  async getSkillSchemas(): Promise<SkillSchema[]> {
    const skills = await this.listSkills();
    return skills.map(skill => skill.getSchema());
  }

  async getSkillSummaries(): Promise<SkillSummarySchema[]> {
    await this.ensureInitialized();

    if (this.cachedSummaries && this.cachedSummaries.length > 0) {
      this.triggerBackgroundRefreshIfNeeded();
      return this.cachedSummaries;
    }

    const summaries = this.buildSummariesFromCurrentMap();
    this.cachedSummaries = summaries;
    this.cachedAtSeconds = Math.floor(Date.now() / 1000);
    return summaries;
  }

  async getPlanRetrievalSkillList(): Promise<{ slug: string; name: string; triggers: string[]; description: string }[]> {
    if (!this.initialized) {
      await this.initialize(this.lastInitOptions);
    }

    return this.buildSummariesFromCurrentMap();
  }

  async getPlanRetrievalSkillPrompt(): Promise<string> {
    const skills = await this.getPlanRetrievalSkillList();
    if (!skills || skills.length === 0) {
      return '_No skills found in the knowledge base yet._';
    }

    const lines: string[] = [];
    const seenSlugs = new Set<string>();

    for (const skill of skills) {
      const slug = skill.slug || 'unknown';
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      const title = skill.name || slug;
      const trigger = Array.isArray(skill.triggers) ? skill.triggers.join(', ') : '';
      if (!trigger || /^no\s+trigger\s+defined$/i.test(trigger)) continue;

      lines.push(`- **${ title }** (slug: \`${ slug }\`)\n  Trigger: ${ trigger }`);
    }

    return lines.length > 0
      ? lines.join('\n')
      : '_No skills found in the knowledge base yet._';
  }

  private buildSummariesFromCurrentMap(): SkillSummarySchema[] {
    return Array.from(this.skillsBySlug.values()).map(skill => skill.getSummarySchema());
  }

  private async hydrateSummariesFromCache(): Promise<void> {
    if (this.cacheHydrated) return;
    this.cacheHydrated = true;

    try {
      const redisReady = await redisClient.initialize();
      if (!redisReady) return;

      const cachedPayload = await redisClient.get(this.cacheKey);
      const timestampStr = await redisClient.get(this.cacheTimestampKey);

      if (!cachedPayload) return;

      const parsed = JSON.parse(cachedPayload) as SkillSummarySchema[];
      if (!Array.isArray(parsed)) return;

      this.cachedSummaries = parsed;
      this.cachedAtSeconds = timestampStr ? parseInt(timestampStr, 10) || 0 : 0;
    } catch (error) {
      console.warn('[SkillsRegistry] Failed to hydrate summary cache:', error);
    }
  }

  private async writeSummariesToCache(summaries: SkillSummarySchema[], timestamp: number): Promise<void> {
    try {
      const redisReady = await redisClient.initialize();
      if (!redisReady) return;

      await redisClient.set(this.cacheKey, JSON.stringify(summaries));
      await redisClient.set(this.cacheTimestampKey, String(timestamp));
    } catch (error) {
      console.warn('[SkillsRegistry] Failed to write summary cache:', error);
    }
  }

  private triggerBackgroundRefreshIfNeeded(): void {
    const now = Math.floor(Date.now() / 1000);
    const age = now - this.cachedAtSeconds;
    const stale = this.cachedAtSeconds === 0 || age > this.cacheTTLSeconds;

    if (!stale || this.refreshPromise) return;

    this.refresh(this.lastInitOptions).catch((error) => {
      console.warn('[SkillsRegistry] Non-blocking refresh failed:', error);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SkillStore API — used by skills tools
  // ─────────────────────────────────────────────────────────────

  async searchSkills(query: string): Promise<string> {
    const q = String(query || '').trim();
    if (!q) return 'Please provide a search query.';

    const rows = await SkillDefinitionModel.search(q);
    if (rows.length > 0) {
      return rows.map((row) => {
        const service = skillServiceFromDefinition(row);
        return `${ row.title } (${ row.slug }): ${ service?.description ?? row.description }`;
      }).join('\n');
    }
    return `No matching skills for '${ q }' (0 skills found). You can create one with skill_save.`;
  }

  async loadSkill(skillName: string): Promise<string> {
    await this.ensureInitialized();
    if (!this.initialized) await this.initialize(this.lastInitOptions);

    const name = String(skillName || '').trim();

    const bySlug = this.skillsBySlug.get(name);
    if (bySlug) return bySlug.document;

    for (const skill of this.skillsBySlug.values()) {
      if (skill.name.toLowerCase() === name.toLowerCase()) {
        return skill.document;
      }
    }

    const available = Array.from(this.skillsBySlug.keys()).join(', ') || '(none)';
    return `Skill '${ name }' not found. Available: ${ available }`;
  }

  /** Create or update a skill in the database from SKILL.md text. */
  async createSkill(skillName: string, content: string): Promise<string> {
    const name = String(skillName || '').trim();
    if (!name) return 'Skill name is required.';

    try {
      const { saveSkillFromMarkdown, splitSkillMarkdown } = await import('../../services/SkillDefinitionService');
      const markdown = splitSkillMarkdown(content) ? content : `---\nslug: ${ name }\ntitle: ${ name }\n---\n${ content }`;
      const { skill, created } = await saveSkillFromMarkdown({ markdown, slug: name });
      await this.invalidate();
      return `Skill '${ skill.slug }' ${ created ? 'created' : 'updated' } in the database. Load it with skill_get.`;
    } catch (error: any) {
      return `Failed to create skill '${ name }': ${ error.message }`;
    }
  }

  /** The database row behind a skill, including disabled/deleted rows when asked. */
  async getDefinition(slug: string): Promise<SkillDefinition | null> {
    return SkillDefinitionModel.findBySlug(String(slug || '').trim());
  }

  /**
   * Write a skill's files to ~/sulla/cache/skills/<slug>/ for callers that
   * need them on disk (scripts, html, templates) and return that path.
   */
  async materialize(slug: string): Promise<string | null> {
    const row = await SkillDefinitionModel.findBySlug(String(slug || '').trim());
    if (!row || row.deleted_at) return null;
    const { materializeSkill } = await import('../../services/SkillDefinitionService');
    return materializeSkill(row);
  }

  /** Drop every cached view (memory + Redis summary) and rebuild from the table. Call after any write. */
  async invalidate(): Promise<void> {
    this.initialized = false;
    this.cachedSummaries = null;
    this.cachedAtSeconds = 0;
    this.cacheHydrated = true;
    try {
      const redisReady = await redisClient.initialize();
      if (redisReady) {
        await redisClient.del(this.cacheKey);
        await redisClient.del(this.cacheTimestampKey);
      }
    } catch (error) {
      console.warn('[SkillsRegistry] Failed to clear summary cache:', error);
    }
    // A refresh already in flight read the table before this write.
    if (this.refreshPromise) await this.refreshPromise.catch(() => undefined);
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    // The write already landed in the table; no folder scan needed.
    await this.rebuildAndCache(this.lastInitOptions, false);
  }
}

export const skillsRegistry = SkillsRegistry.getInstance();
