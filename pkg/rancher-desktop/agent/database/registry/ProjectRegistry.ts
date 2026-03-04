import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { redisClient } from '../RedisClient';
import {
  ProjectService,
  type ProjectSummarySchema,
} from '../../services/ProjectService';
import { grepSearchFilesDetailed } from '../../../utils/grepSearch';
import { resolveSullaProjectsDir } from '../../utils/sullaPaths';

export interface ProjectRegistryInitOptions {
  filesystemProjectDirs?: string[];
}

export class ProjectRegistry {
  private readonly cacheKey = 'sulla:projects:summary';
  private readonly cacheTimestampKey = 'sulla:projects:summary:timestamp';
  private readonly cacheTTLSeconds = 3600;

  private static instance: ProjectRegistry | null = null;
  private readonly projectsBySlug = new Map<string, ProjectService>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private cachedSummaries: ProjectSummarySchema[] | null = null;
  private cachedAtSeconds = 0;
  private cacheHydrated = false;
  private lastInitOptions: ProjectRegistryInitOptions = {};

  static getInstance(): ProjectRegistry {
    return this.instance ?? (this.instance = new ProjectRegistry());
  }

  private constructor() {}

  async initialize(options: ProjectRegistryInitOptions = {}): Promise<void> {
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

  private async rebuildAndCache(options: ProjectRegistryInitOptions = {}): Promise<void> {
    const map = new Map<string, ProjectService>();

    const databaseProjects = await this.loadDatabaseProjects();
    databaseProjects.forEach(project => this.mergeBySourcePriority(map, project));

    const filesystemProjects = await this.loadFilesystemProjects(options.filesystemProjectDirs || []);
    filesystemProjects.forEach(project => this.mergeBySourcePriority(map, project));

    this.projectsBySlug.clear();
    map.forEach((project, slug) => this.projectsBySlug.set(slug, project));
    this.initialized = true;

    this.cachedSummaries = this.buildSummariesFromCurrentMap();
    this.cachedAtSeconds = Math.floor(Date.now() / 1000);
    this.cacheHydrated = true;
    await this.writeSummariesToCache(this.cachedSummaries, this.cachedAtSeconds);

    console.log(`[ProjectRegistry] initialized with ${this.projectsBySlug.size} projects`);
  }

  async refresh(options: ProjectRegistryInitOptions = {}): Promise<void> {
    this.lastInitOptions = options;

    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = this.rebuildAndCache(options)
      .catch((error) => {
        console.warn('[ProjectRegistry] Background refresh failed:', error);
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

  async getProject(slug: string): Promise<ProjectService | null> {
    await this.ensureInitialized();

    if (!this.initialized) {
      await this.initialize(this.lastInitOptions);
    }

    return this.projectsBySlug.get(String(slug || '').trim()) ?? null;
  }

  async listProjects(): Promise<ProjectSummarySchema[]> {
    await this.ensureInitialized();

    if (!this.initialized) {
      this.triggerBackgroundRefreshIfNeeded();
      return [];
    }

    return this.buildSummariesFromCurrentMap();
  }

  // ─────────────────────────────────────────────────────────────
  // ProjectStore API — used by project tools
  // ─────────────────────────────────────────────────────────────

  async searchProjects(query: string): Promise<string> {
    await this.ensureInitialized();

    // Keep search results accurate for projects created outside tool flows
    // (e.g. manually created PROJECT.md folders on disk).
    await this.refresh(this.lastInitOptions);

    const q = String(query || '').trim();
    if (!q) return 'Please provide a search query.';

    const normalized = this.normalizeSearchQuery(q);
    const specialMode = this.getSpecialProjectSearchMode(normalized);

    if (specialMode === 'all') {
      if (this.projectsBySlug.size === 0) {
        return 'There are zero (0) projects yet.';
      }

      const lines = Array.from(this.projectsBySlug.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(p => `${p.name} (slug: ${p.slug}, status: ${p.status}): ${p.description}`);

      return `All projects:\n${lines.join('\n')}`;
    }

    if (specialMode === 'active') {
      const content = await this.readActiveProjectsFile();
      if (!content) {
        return 'There are zero (0) active projects';
      }
      return content;
    }

    // Grep filesystem for matching project files
    const dirs = this.getDefaultFilesystemDirs(this.lastInitOptions.filesystemProjectDirs || []);
    const grepResult = await grepSearchFilesDetailed(q, dirs, '*.md');
    const grepHits = grepResult.matches;

    const results: string[] = [];
    const seenSlugs = new Set<string>();

    for (const hit of grepHits) {
      const slug = hit.folderName;
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      // Try to get parsed project from registry cache first
      const cached = this.projectsBySlug.get(slug);
      if (cached) {
        results.push(`${cached.name} (slug: ${cached.slug}, status: ${cached.status}): ${cached.description}`);
        continue;
      }

      // Otherwise read and parse the file on the fly
      try {
        const raw = await readFile(hit.filePath, 'utf8');
        const service = ProjectService.fromRaw('filesystem', slug, raw);
        if (service) {
          results.push(`${service.name} (slug: ${service.slug}, status: ${service.status}): ${service.description}`);
        } else {
          results.push(`${slug}: (matched file: ${hit.filePath})`);
        }
      } catch {
        results.push(`${slug}: (matched file: ${hit.filePath})`);
      }
    }

    return results.length > 0
      ? `Projects:\n${results.join('\n')}`
      : `No matching projects after searching terms: ${grepResult.attemptedTerms.map(term => `'${term}'`).join(', ') || '(none)'} (0 projects found). You can create one with create_project.`;
  }

  async loadProject(projectName: string): Promise<string> {
    await this.ensureInitialized();

    const name = String(projectName || '').trim();

    // Try exact slug match
    const bySlug = this.projectsBySlug.get(name);
    if (bySlug) return bySlug.getRawContent();

    // Try folder name match in user projects dir
    const userDir = this.getUserProjectsDir();
    const projectMd = path.join(userDir, name, 'PROJECT.md');
    if (fs.existsSync(projectMd)) {
      return fs.readFileSync(projectMd, 'utf8');
    }

    // Try fuzzy match by name
    for (const project of this.projectsBySlug.values()) {
      if (project.name.toLowerCase() === name.toLowerCase()) {
        return project.getRawContent();
      }
    }

    const available = Array.from(this.projectsBySlug.keys()).join(', ') || '(none)';
    return `Project '${name}' not found. Available: ${available}`;
  }

  async createProject(projectName: string, content?: string, customDir?: string): Promise<string> {
    await this.ensureInitialized();

    const name = String(projectName || '').trim();
    if (!name) return 'Project name is required.';

    const baseDir = customDir ? String(customDir).trim() : path.join(this.getUserProjectsDir(), name);
    const projectDir = baseDir;
    const projectFile = path.join(projectDir, 'PROJECT.md');
    const projectContent = this.normalizeCreateProjectContent(name, content);

    try {
      await mkdir(projectDir, { recursive: true });
      await writeFile(projectFile, projectContent, 'utf8');

      // Scaffold README.md if it doesn't exist
      const readmeFile = path.join(projectDir, 'README.md');
      if (!fs.existsSync(readmeFile)) {
        const service = ProjectService.fromRaw('filesystem', name, projectContent);
        const readmeContent = this.scaffoldReadme(service);
        await writeFile(readmeFile, readmeContent, 'utf8');
      }

      // Reload from the new file so the registry picks it up immediately
      const service = ProjectService.fromRaw('filesystem', name, projectContent);
      if (service) {
        this.projectsBySlug.set(service.slug, service);
        this.cachedSummaries = this.buildSummariesFromCurrentMap();
        await this.addToActiveProjects(service);
      }

      return `Project '${name}' created successfully.\nProject directory: ${projectDir}\nPRD file: ${projectFile}\nREADME: ${path.join(projectDir, 'README.md')}`;
    } catch (error: any) {
      return `Failed to create project '${name}': ${error.message}`;
    }
  }

  async updateProject(projectName: string, content: string): Promise<string> {
    await this.ensureInitialized();

    const name = String(projectName || '').trim();
    if (!name) return 'Project name is required.';

    const projectFile = this.resolveProjectFile(name);
    if (!projectFile) {
      return `Project '${name}' not found. Use create_project to create it first.`;
    }

    try {
      await writeFile(projectFile, content, 'utf8');

      const service = ProjectService.fromRaw('filesystem', name, content);
      if (service) {
        this.projectsBySlug.set(service.slug, service);
        this.cachedSummaries = this.buildSummariesFromCurrentMap();
        await this.addToActiveProjects(service);
      }

      const projectDir = path.dirname(projectFile);
      return `Project '${name}' updated successfully.\nProject directory: ${projectDir}\nPRD file: ${projectFile}`;
    } catch (error: any) {
      return `Failed to update project '${name}': ${error.message}`;
    }
  }

  async patchProject(projectName: string, section: string, content: string): Promise<string> {
    await this.ensureInitialized();

    const name = String(projectName || '').trim();
    if (!name) return 'Project name is required.';

    const existing = this.resolveProjectService(name);
    if (!existing) {
      return `Project '${name}' not found. Use create_project to create it first.`;
    }

    const canonicalSlug = existing.slug;
    const projectFile = this.resolveProjectFile(canonicalSlug);
    if (!projectFile) {
      return `Project '${name}' file not found on disk.`;
    }

    try {
      const updatedRaw = existing.patchSection(section, content);
      await writeFile(projectFile, updatedRaw, 'utf8');

      const service = ProjectService.fromRaw('filesystem', canonicalSlug, updatedRaw);
      if (service) {
        this.projectsBySlug.set(service.slug, service);
        this.cachedSummaries = this.buildSummariesFromCurrentMap();
        await this.addToActiveProjects(service);
      }

      return `Project '${name}' section '${section}' updated successfully.\nPRD file: ${projectFile}`;
    } catch (error: any) {
      return `Failed to patch project '${name}': ${error.message}`;
    }
  }

  async deleteProject(projectName: string): Promise<string> {
    await this.ensureInitialized();

    const name = String(projectName || '').trim();
    if (!name) return 'Project name is required.';

    const userDir = this.getUserProjectsDir();
    const projectDir = path.join(userDir, name);

    try {
      if (fs.existsSync(projectDir)) {
        await rm(projectDir, { recursive: true, force: true });
      }

      this.projectsBySlug.delete(name);
      this.cachedSummaries = this.buildSummariesFromCurrentMap();
      await this.removeFromActiveProjects(name);

      return `Project '${name}' deleted successfully. Removed: ${projectDir}`;
    } catch (error: any) {
      return `Failed to delete project '${name}': ${error.message}`;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  private normalizeSearchQuery(query: string): string {
    return String(query || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getSpecialProjectSearchMode(normalizedQuery: string): 'all' | 'active' | null {
    if (normalizedQuery === 'all projects' || normalizedQuery === 'all project' || normalizedQuery === 'projects') {
      return 'all';
    }

    if (normalizedQuery === 'active projects' || normalizedQuery === 'active project') {
      return 'active';
    }

    return null;
  }

  private resolveProjectService(name: string): ProjectService | null {
    const normalized = String(name || '').trim();
    if (!normalized) {
      return null;
    }

    // Exact slug match
    const bySlug = this.projectsBySlug.get(normalized);
    if (bySlug) {
      return bySlug;
    }

    // Exact title match (case-insensitive), same behavior as loadProject
    for (const project of this.projectsBySlug.values()) {
      if (project.name.toLowerCase() === normalized.toLowerCase()) {
        return project;
      }
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // ACTIVE_PROJECTS.md management
  // ─────────────────────────────────────────────────────────────

  private getActiveProjectsFilePath(): string {
    return path.join(this.getUserProjectsDir(), 'ACTIVE_PROJECTS.md');
  }

  private async readActiveProjectsFile(): Promise<string | null> {
    const filePath = this.getActiveProjectsFilePath();
    try {
      const content = await readFile(filePath, 'utf8');
      const trimmed = content.trim();
      if (!trimmed || trimmed === '# Active Projects') return null;
      return trimmed;
    } catch {
      return null;
    }
  }

  private async writeActiveProjectsFile(entries: Array<{ slug: string; name: string; description: string }>): Promise<void> {
    const filePath = this.getActiveProjectsFilePath();
    const lines = ['# Active Projects', ''];

    if (entries.length === 0) {
      lines.push('No active projects.');
    } else {
      lines.push('| Project | Folder | Description |');
      lines.push('|---------|--------|-------------|');
      for (const entry of entries) {
        lines.push(`| ${entry.name} | \`${entry.slug}\` | ${entry.description} |`);
      }
    }

    lines.push('');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, lines.join('\n'), 'utf8');
  }

  private async addToActiveProjects(project: ProjectService): Promise<void> {
    try {
      const entries = await this.parseActiveProjectEntries();
      const existingIdx = entries.findIndex(e => e.slug === project.slug);
      const entry = { slug: project.slug, name: project.name, description: project.description };

      if (existingIdx >= 0) {
        entries[existingIdx] = entry;
      } else {
        entries.push(entry);
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));
      await this.writeActiveProjectsFile(entries);
    } catch (error) {
      console.warn('[ProjectRegistry] Failed to update ACTIVE_PROJECTS.md:', error);
    }
  }

  private async removeFromActiveProjects(slug: string): Promise<void> {
    try {
      const entries = await this.parseActiveProjectEntries();
      const filtered = entries.filter(e => e.slug !== slug);
      await this.writeActiveProjectsFile(filtered);
    } catch (error) {
      console.warn('[ProjectRegistry] Failed to update ACTIVE_PROJECTS.md:', error);
    }
  }

  private async parseActiveProjectEntries(): Promise<Array<{ slug: string; name: string; description: string }>> {
    const content = await this.readActiveProjectsFile();
    if (!content) return [];

    const entries: Array<{ slug: string; name: string; description: string }> = [];
    const lines = content.split('\n');

    for (const line of lines) {
      // Parse markdown table rows: | Name | `slug` | Description |
      const match = line.match(/^\|\s*(.+?)\s*\|\s*`(.+?)`\s*\|\s*(.*?)\s*\|\s*$/);
      if (match && match[1] !== 'Project' && match[1] !== '-') {
        entries.push({
          name: match[1].trim(),
          slug: match[2].trim(),
          description: match[3].trim(),
        });
      }
    }

    return entries;
  }

  private resolveProjectFile(name: string): string | null {
    // Check existing service for workspace path
    const existing = this.projectsBySlug.get(name);
    if (existing?.workspacePath) {
      const candidate = path.join(existing.workspacePath, 'PROJECT.md');
      if (fs.existsSync(candidate)) return candidate;
    }

    // Check user projects dir
    const userDir = this.getUserProjectsDir();
    const candidate = path.join(userDir, name, 'PROJECT.md');
    if (fs.existsSync(candidate)) return candidate;

    return null;
  }

  private scaffoldReadme(service: ProjectService | null): string {
    const title = service?.name || 'Untitled Project';
    const description = service?.description || '';

    return `# ${title}

${description}

## Getting Started
...

## Project Structure
...

## Development
...
`;
  }

  private normalizeCreateProjectContent(projectName: string, content?: string): string {
    const provided = String(content || '').trim();
    if (provided) return provided;

    const title = projectName
      .split('-')
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || projectName;
    const now = new Date().toISOString();

    return `---
schemaversion: 1
slug: ${projectName}
title: "${title}"
section: Projects
status: active
created_at: "${now}"
updated_at: "${now}"
---

## Description

## Project Goal

## User Stories

## Must Haves

## Should Haves

## Nice-to-Haves

## Execution Checklist
- [ ] Define scope
- [ ] Implement
- [ ] Validate
`;
  }

  private async loadDatabaseProjects(): Promise<ProjectService[]> {
    return [];
  }

  private async loadFilesystemProjects(extraDirs: string[]): Promise<ProjectService[]> {
    const projects: ProjectService[] = [];
    const candidateDirs = this.getDefaultFilesystemDirs(extraDirs);

    for (const dir of candidateDirs) {
      const folderProjects = await this.loadFolderBasedProjects(dir);
      projects.push(...folderProjects);
    }

    return projects;
  }

  private async loadFolderBasedProjects(parentDir: string): Promise<ProjectService[]> {
    const projects: ProjectService[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(parentDir, { withFileTypes: true });
    } catch {
      return projects;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectMd = path.join(parentDir, entry.name, 'PROJECT.md');
      try {
        const raw = await readFile(projectMd, 'utf8');
        const service = ProjectService.fromRaw('filesystem', entry.name, raw);
        if (service) projects.push(service);
      } catch {
        // No PROJECT.md in this subfolder — skip
      }
    }

    return projects;
  }

  private getDefaultFilesystemDirs(extraDirs: string[]): string[] {
    const userProjectsDir = this.getUserProjectsDir();

    const fromEnv = String(process.env.SULLA_PROJECTS_DIRS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);

    const all = [...extraDirs, ...fromEnv, userProjectsDir]
      .map(dir => path.resolve(dir));

    return Array.from(new Set(all));
  }

  getUserProjectsDir(): string {
    return resolveSullaProjectsDir();
  }

  private buildSummariesFromCurrentMap(): ProjectSummarySchema[] {
    return Array.from(this.projectsBySlug.values()).map(project => project.getSummarySchema());
  }

  private mergeBySourcePriority(map: Map<string, ProjectService>, incoming: ProjectService): void {
    const slug = String(incoming.slug || '').trim();
    if (!slug) return;

    const existing = map.get(slug);
    if (!existing) {
      map.set(slug, incoming);
      return;
    }

    const existingPriority = this.getSourcePriority(existing.source);
    const incomingPriority = this.getSourcePriority(incoming.source);

    if (incomingPriority >= existingPriority) {
      map.set(slug, incoming);
    }
  }

  private getSourcePriority(source: string): number {
    switch (String(source || '').toLowerCase()) {
      case 'filesystem':
        return 2;
      case 'database':
      default:
        return 1;
    }
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

      const parsed = JSON.parse(cachedPayload) as ProjectSummarySchema[];
      if (!Array.isArray(parsed)) return;

      this.cachedSummaries = parsed;
      this.cachedAtSeconds = timestampStr ? parseInt(timestampStr, 10) || 0 : 0;
    } catch (error) {
      console.warn('[ProjectRegistry] Failed to hydrate summary cache:', error);
    }
  }

  private async writeSummariesToCache(summaries: ProjectSummarySchema[], timestamp: number): Promise<void> {
    try {
      const redisReady = await redisClient.initialize();
      if (!redisReady) return;

      await redisClient.set(this.cacheKey, JSON.stringify(summaries));
      await redisClient.set(this.cacheTimestampKey, String(timestamp));
    } catch (error) {
      console.warn('[ProjectRegistry] Failed to write summary cache:', error);
    }
  }

  private triggerBackgroundRefreshIfNeeded(): void {
    const now = Math.floor(Date.now() / 1000);
    const age = now - this.cachedAtSeconds;
    const stale = this.cachedAtSeconds === 0 || age > this.cacheTTLSeconds;

    if (!stale || this.refreshPromise) return;

    this.refresh(this.lastInitOptions).catch((error) => {
      console.warn('[ProjectRegistry] Non-blocking refresh failed:', error);
    });
  }
}

export const projectRegistry = ProjectRegistry.getInstance();
