import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { argon2id } from 'hash-wasm';

import Electron from 'electron';
import yaml from 'yaml';

import { ExtensionErrorImpl } from './extensions';
import { fetchMarketplaceData, MarketplaceEntry } from './marketplaceData';
import type { InstallationManifest } from './recipeTypes';
import {
  Extension, ExtensionErrorCode, ExtensionMetadata,
} from './types';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import mainEvents from '@pkg/main/mainEvents';
import { spawnFile } from '@pkg/utils/childProcess';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import { sullaLog } from '@pkg/utils/sullaLog';

const console = Logging.extensions;

/**
 * RecipeExtensionImpl implements the Extension interface for recipe-based
 * extensions that are driven by a remote installation.yaml file rather than
 * a Docker image with baked-in metadata.
 *
 * Install flow:
 *   1. Fetch installation.yaml from the `installable` URL in the marketplace catalog
 *   2. Download all recipe assets (icon, compose files, etc.) from the recipe folder
 *   3. Store everything in the local extension directory (APP_DIR)
 *   4. Run setup commands from installation.yaml in order
 *   5. Mark installed
 *
 * Runtime:
 *   - start/stop/restart/status/update/logs commands are read from installation.yaml
 *   - ${APP_DIR} = extension directory, ${COMPOSE_FILE} = full path to compose file
 *   - The system is intentionally dumb — it just runs whatever commands the yaml says
 */
export class RecipeExtensionImpl implements Extension {
  constructor(
    slug: string,
    version: string,
    private readonly catalogEntry: MarketplaceEntry,
  ) {
    this.id = slug;
    this.version = version;
    // dir is set after manifest is fetched — use extensionRoot/<manifest.id>
    // For now, derive a safe name from the slug (last segment)
    const safeName = slug.replace(/[/:]/g, '-').replace(/^-+|-+$/g, '');

    this._dirFallback = path.join(paths.extensionRoot, safeName);
  }

  readonly id:      string;
  readonly version: string;

  /** Fallback dir derived from slug; replaced once manifest.id is known. */
  private _dirFallback: string;
  private _dirOverride: string | undefined;

  /** The extension directory inside extensionRoot, named after manifest.id. */
  get dir(): string {
    return this._dirOverride ?? this._dirFallback;
  }

  protected _metadata: Promise<ExtensionMetadata> | undefined;
  protected _labels:   Promise<Record<string, string>> | undefined;
  protected _manifest: InstallationManifest | undefined;

  protected readonly MANIFEST_FILE = 'installation.yaml';
  protected readonly VERSION_FILE = 'version.txt';
  protected readonly INSTALLED_LOCK = 'installed.lock';
  protected readonly RUNNING_STATE = 'running.state';

  get image(): string {
    return `${ this.id }:${ this.version }`;
  }

  // ─── Metadata ───────────────────────────────────────────────────────

  get metadata(): Promise<ExtensionMetadata> {
    this._metadata ??= (async() => {
      const icon = this.catalogEntry.logo ||
        this.catalogEntry.labels?.['com.docker.desktop.extension.icon'] ||
        this.catalogEntry.labels?.['com.docker.extension.icon'] ||
        '';

      if (!icon) {
        throw new ExtensionErrorImpl(
          ExtensionErrorCode.INVALID_METADATA,
          `Recipe extension ${ this.id } has no icon in catalog`,
        );
      }

      return { icon } as ExtensionMetadata;
    })();

    return this._metadata;
  }

  get labels(): Promise<Record<string, string>> {
    this._labels ??= Promise.resolve(this.catalogEntry.labels ?? {});

    return this._labels;
  }

  get extraUrls(): Promise<{ label: string; url: string }[]> {
    return (async() => {
      const manifest = await this.getManifest();

      return manifest.extraUrls ?? [];
    })();
  }

  // ─── Manifest ───────────────────────────────────────────────────────

  async getManifest(): Promise<InstallationManifest> {
    if (this._manifest) {
      return this._manifest;
    }

    // Try local first (already installed)
    const localPath = path.join(this.dir, this.MANIFEST_FILE);

    try {
      const raw = await fs.promises.readFile(localPath, 'utf-8');

      this._manifest = yaml.parse(raw) as InstallationManifest;

      return this._manifest;
    } catch { /* not installed locally, fetch remote */ }

    // Fetch from remote
    const installableUrl = this.catalogEntry.installable;

    if (!installableUrl) {
      throw new ExtensionErrorImpl(
        ExtensionErrorCode.INVALID_METADATA,
        `No installable URL for recipe extension ${ this.id }`,
      );
    }

    const response = await fetch(installableUrl);

    if (!response.ok) {
      throw new ExtensionErrorImpl(
        ExtensionErrorCode.FILE_NOT_FOUND,
        `Failed to fetch installation.yaml for ${ this.id }: ${ response.status }`,
      );
    }

    const text = await response.text();

    this._manifest = yaml.parse(text) as InstallationManifest;

    return this._manifest;
  }

  // ─── Install ────────────────────────────────────────────────────────

  async install(_allowedImages: readonly string[] | undefined): Promise<boolean> {
    if (await this.isInstalled()) {
      console.debug(`Recipe extension ${ this.id } already installed.`);

      return false;
    }

    sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] Phase 1/4: fetch manifest` });

    // ── Phase 1: Fetch the installable manifest ──
    const manifest = await this.getManifest();

    // Now that we have the manifest, set the real dir using manifest.id
    this._dirOverride = path.join(paths.extensionRoot, manifest.id);

    sullaLog({
      topic:   'extensions',
      level:   'info',
      message: `Installing recipe extension ${ this.id } (${ manifest.name })`,
      data:    { dir: this.dir, manifestId: manifest.id },
    });
    sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] Phase 1/4 complete: manifest loaded`, data: { manifestId: manifest.id, composeFile: manifest.compose?.composeFile || 'docker-compose.yml' } });

    // Clean up any leftover directory from a previous failed install
    sullaLog({ topic: 'extensions', level: 'debug', message: `[install:${ this.id }] cleaning stale directory`, data: { dir: this.dir } });
    try {
      await fs.promises.rm(this.dir, { recursive: true, maxRetries: 3 });
    } catch (ex: any) {
      if ((ex as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.debug(`Could not clean stale dir ${ this.dir }: ${ ex }`);
      }
    }

    sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] Phase 2/4: create extension dir + pull assets`, data: { dir: this.dir } });

    // ── Phase 2: Create the extension folder and pull recipe assets ──
    await fs.promises.mkdir(this.dir, { recursive: true });

    try {
      // Save the installation manifest locally
      await this.saveManifest(manifest);
      sullaLog({ topic: 'extensions', level: 'debug', message: `[install:${ this.id }] wrote installation manifest`, data: { path: path.join(this.dir, this.MANIFEST_FILE) } });

      // Pull all recipe assets (icon, manifest.yaml, etc.) from the remote recipe folder
      await this.pullRecipeAssets();
      sullaLog({ topic: 'extensions', level: 'debug', message: `[install:${ this.id }] pulled recipe assets` });

      // Save labels from catalog
      await fs.promises.writeFile(
        path.join(this.dir, 'labels.json'),
        JSON.stringify(await this.labels, undefined, 2),
      );
      sullaLog({ topic: 'extensions', level: 'debug', message: `[install:${ this.id }] wrote labels`, data: { path: path.join(this.dir, 'labels.json') } });

      sullaLog({ topic: 'extensions', level: 'info', message: `Recipe assets saved to ${ this.dir }` });

      // ── Phase 2b: Resolve {{variables}} in the compose file and write .env ──
      await this.processComposeFile();
      await this.writeEnvFile();
      sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] Phase 2/4 complete: assets + variable resolution done` });

      // ── Phase 3: Process the installable file (setup steps) ──
      sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] Phase 3/4: run setup steps`, data: { setupStepCount: manifest.setup?.length ?? 0 } });
      await this.runSetup(manifest);
      sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] Phase 3/4 complete: setup finished` });

      // ── Phase 4: Mark installed ──
      sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] Phase 4/4: mark installed` });
      await fs.promises.writeFile(
        path.join(this.dir, this.VERSION_FILE),
        this.version,
        'utf-8',
      );
      await fs.promises.writeFile(
        path.join(this.dir, this.INSTALLED_LOCK),
        JSON.stringify({ installedAt: new Date().toISOString(), version: this.version }),
        'utf-8',
      );
      sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] Phase 4/4 complete: version marker + lock written`, data: { path: path.join(this.dir, this.VERSION_FILE), version: this.version } });
    } catch (ex) {
      const err = ex as any;

      sullaLog({
        topic:   'extensions',
        level:   'error',
        message: `Failed to install recipe extension ${ this.id }, cleaning up`,
        error:   ex,
        data:    {
          message: err?.message,
          code:    err?.code,
          signal:  err?.signal,
          stdout:  err?.stdout,
          stderr:  err?.stderr,
          stack:   err?.stack,
          dir:     this.dir,
        },
      });
      await fs.promises.rm(this.dir, { recursive: true, maxRetries: 3 }).catch((e) => {
        sullaLog({ topic: 'extensions', level: 'error', message: `Failed to cleanup extension directory ${ this.dir }`, error: e });
      });
      throw ex;
    }

    mainEvents.emit('settings-write', {
      application: { extensions: { installed: { [this.id]: this.version } } },
    });

    // Clear the default session cache so updated icons are loaded fresh
    Electron.session.defaultSession.clearCache();

    sullaLog({ topic: 'extensions', level: 'info', message: `Recipe extension ${ this.id } installed successfully.` });

    // Save integration credentials declared in the manifest
    if (manifest.integrations) {
      await this.saveIntegrationCredentials(manifest.integrations);
    }

    // Start the extension after install
    try {
      sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] post-install start: invoking start()` });
      await this.start();
    } catch (ex) {
      const err = ex as any;

      sullaLog({
        topic:   'extensions',
        level:   'error',
        message: `Failed to start ${ this.id } after install`,
        error:   ex,
        data:    {
          message: err?.message,
          code:    err?.code,
          signal:  err?.signal,
          stdout:  err?.stdout,
          stderr:  err?.stderr,
          stack:   err?.stack,
        },
      });
    }

    return true;
  }

  protected async saveManifest(manifest: InstallationManifest): Promise<void> {
    await fs.promises.writeFile(
      path.join(this.dir, this.MANIFEST_FILE),
      yaml.stringify(manifest),
      'utf-8',
    );
  }

  /**
   * Pull all assets from the remote recipe folder into the local extension dir.
   * Uses the GitHub Contents API to list files, then downloads each one.
   */
  protected async pullRecipeAssets(): Promise<void> {
    const installableUrl = this.catalogEntry.installable;

    if (!installableUrl) {
      return;
    }

    // Derive the GitHub Contents API URL for the recipe folder.
    // installableUrl looks like:
    //   https://raw.githubusercontent.com/<owner>/<repo>/refs/heads/<branch>/recipes/<name>/installation.yaml
    // We need:
    //   https://api.github.com/repos/<owner>/<repo>/contents/recipes/<name>
    const rawMatch = /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/.+?\/(recipes\/[^/]+)\/[^/]+$/.exec(installableUrl);

    if (!rawMatch) {
      // Fallback: just download the icon from the base URL
      sullaLog({ topic: 'extensions', level: 'debug', message: `Could not parse recipe folder URL from ${ installableUrl }, skipping asset pull` });
      await this.downloadIconFallback();

      return;
    }

    const [, owner, repo, recipePath] = rawMatch;
    const contentsUrl = `https://api.github.com/repos/${ owner }/${ repo }/contents/${ recipePath }`;

    sullaLog({ topic: 'extensions', level: 'info', message: `Fetching recipe assets from ${ contentsUrl }` });

    try {
      const stats = { downloaded: 0, skipped: 0, failed: 0 };

      await this.pullDirectoryContents(contentsUrl, this.dir, stats);

      sullaLog({ topic: 'extensions', level: 'info', message: `Recipe asset pull summary for ${ this.id }`, data: { ...stats, source: contentsUrl } });
    } catch (ex) {
      sullaLog({ topic: 'extensions', level: 'warn', message: `Failed to pull recipe assets from ${ contentsUrl }`, error: ex });
      await this.downloadIconFallback();
    }
  }

  /**
   * Recursively fetch a GitHub Contents API directory listing and download
   * all files into `localDir`, descending into subdirectories.
   */
  protected async pullDirectoryContents(
    contentsUrl: string,
    localDir: string,
    stats: { downloaded: number; skipped: number; failed: number },
  ): Promise<void> {
    const response = await fetch(contentsUrl);

    if (!response.ok) {
      sullaLog({ topic: 'extensions', level: 'warn', message: `GitHub Contents API returned ${ response.status } for ${ contentsUrl }` });

      return;
    }

    const items: { name: string; path: string; download_url: string | null; type: string; url: string }[] = await response.json();

    for (const item of items) {
      if (item.type === 'dir') {
        // Recurse into subdirectory
        const subDir = path.join(localDir, item.name);

        await fs.promises.mkdir(subDir, { recursive: true });
        await this.pullDirectoryContents(item.url, subDir, stats);
        continue;
      }

      // Skip non-files, files without download URLs, and installation.yaml (already saved at root)
      if (item.type !== 'file' || !item.download_url || (localDir === this.dir && item.name === 'installation.yaml')) {
        stats.skipped += 1;
        continue;
      }

      sullaLog({ topic: 'extensions', level: 'debug', message: `Downloading recipe asset: ${ item.name }` });

      try {
        const fileResp = await fetch(item.download_url);

        if (fileResp.ok) {
          const data = Buffer.from(await fileResp.arrayBuffer());

          await fs.promises.writeFile(path.join(localDir, item.name), data);
          stats.downloaded += 1;
        } else {
          stats.failed += 1;
          sullaLog({ topic: 'extensions', level: 'warn', message: `Failed to download ${ item.name }: HTTP ${ fileResp.status }` });
        }
      } catch (dlErr) {
        stats.failed += 1;
        sullaLog({ topic: 'extensions', level: 'warn', message: `Failed to download ${ item.name }`, error: dlErr });
      }
    }
  }

  /**
   * Fallback icon download when the GitHub Contents API approach fails.
   */
  protected async downloadIconFallback(): Promise<void> {
    const iconSource = this.catalogEntry.logo || this._manifest?.icon;

    if (!iconSource) {
      return;
    }

    if (/^https?:\/\//.test(iconSource)) {
      try {
        const response = await fetch(iconSource);

        if (response.ok) {
          const ext = path.extname(new URL(iconSource).pathname) || '.png';

          await fs.promises.writeFile(path.join(this.dir, `icon${ ext }`), Buffer.from(await response.arrayBuffer()));
        }
      } catch { /* best effort */ }
    } else {
      const installableUrl = this.catalogEntry.installable;

      if (installableUrl) {
        const baseUrl = installableUrl.replace(/\/[^/]+$/, '/');

        try {
          const response = await fetch(`${ baseUrl }${ iconSource }`);

          if (response.ok) {
            const ext = path.extname(iconSource) || '.png';

            await fs.promises.writeFile(path.join(this.dir, `icon${ ext }`), Buffer.from(await response.arrayBuffer()));
          }
        } catch { /* best effort */ }
      }
    }
  }

  protected async runSetup(manifest: InstallationManifest): Promise<void> {
    if (!manifest.setup?.length) {
      return;
    }

    for (const [index, step] of manifest.setup.entries()) {
      const resolvedCommand = this.resolveCommand(step.command);
      const resolvedCwd = step.cwd
        ? step.cwd.replace(/\$\{APP_DIR\}/g, this.dir)
        : this.dir;
      const isOptional = step.optional !== false;

      sullaLog({ topic: 'extensions', level: 'info', message: `Running setup step ${ index + 1 }/${ manifest.setup.length }`, data: { command: resolvedCommand, cwd: resolvedCwd, optional: isOptional } });

      try {
        const { stdout, stderr } = await spawnFile('/bin/sh', ['-c', resolvedCommand], {
          stdio: 'pipe',
          cwd:   resolvedCwd,
          env:   this.spawnEnv,
        });

        if (stdout?.trim()) {
          sullaLog({ topic: 'extensions', level: 'debug', message: `[setup ${ this.id } #${ index + 1 } stdout] ${ stdout.trim() }` });
        }
        if (stderr?.trim()) {
          sullaLog({ topic: 'extensions', level: 'debug', message: `[setup ${ this.id } #${ index + 1 } stderr] ${ stderr.trim() }` });
        }
        sullaLog({ topic: 'extensions', level: 'info', message: `Setup step ${ index + 1 } succeeded` });
      } catch (err: any) {
        sullaLog({
          topic:   'extensions',
          level:   'warn',
          message: `Setup step ${ index + 1 } failed`,
          error:   err,
          data:    {
            command:  resolvedCommand,
            cwd:      resolvedCwd,
            code:     err?.code,
            signal:   err?.signal,
            stdout:   err?.stdout,
            stderr:   err?.stderr,
            optional: isOptional,
            stack:    err?.stack,
          },
        });
        if (!isOptional) {
          throw err;
        }
        sullaLog({ topic: 'extensions', level: 'info', message: `Skipping optional step failure, continuing install...` });
      }
    }
  }

  // ─── Variable Resolution ───────────────────────────────────────────

  /**
   * Apply a pipe modifier to a resolved value.
   *
   * Supported modifiers:
   *  - `urlencode`  — percent-encode for safe use in URLs/connection strings
   *  - `base64`     — base64-encode
   *  - `quote`      — wrap in single quotes with internal escaping
   *  - `json`       — JSON-stringify (produces a quoted string)
   *  - `md5`        — MD5 hex digest (always 32 chars)
   *  - `argon2`     — Argon2id password hash (e.g. `{{sullaServicePassword|argon2}}`)
   *  - `bcrypt`     — bcrypt password hash (e.g. `{{sullaServicePassword|bcrypt}}`)
   */
  protected async applyModifier(value: string, modifier: string): Promise<string> {
    switch (modifier) {
    case 'urlencode':
      return encodeURIComponent(value);
    case 'base64':
      return Buffer.from(value).toString('base64');
    case 'quote':
      return `'${ value.replace(/'/g, "'\\''") }'`;
    case 'json':
      return JSON.stringify(value);
    case 'md5':
      return crypto.createHash('md5').update(value).digest('hex');
    case 'argon2': {
      const salt = crypto.randomBytes(16);

      return await argon2id({
        password:    value,
        salt,
        parallelism: 1,
        iterations:  2,
        memorySize:  19456,
        hashLength:  32,
        outputType:  'encoded',
      });
    }
    case 'bcrypt': {
      const bcrypt = await import('bcryptjs');
      const salt = await bcrypt.genSalt(10);

      return await bcrypt.hash(value, salt);
    }
    default:
      sullaLog({ topic: 'extensions', level: 'warn', message: `Unknown variable modifier: ${ modifier }` });

      return value;
    }
  }

  /**
   * Resolve a built-in `path.*` variable to a user directory.
   *
   * Supported keys:
   *  - `home`        — user home directory
   *  - `documents`   — ~/Documents
   *  - `downloads`   — ~/Downloads
   *  - `desktop`     — ~/Desktop
   *  - `movies`      — ~/Movies
   *  - `music`       — ~/Music
   *  - `pictures`    — ~/Pictures
   *  - `data`        — extension's own data/ directory (auto-created)
   *  - `appdata`     — shared app data directory (paths.appHome/data/, cross-platform)
   *  - `appdir`      — extension directory (same as ${APP_DIR})
   */
  protected resolvePathVariable(key: string): string | null {
    const home = os.homedir();

    const builtins: Record<string, string> = {
      home,
      documents: path.join(home, 'Documents'),
      downloads: path.join(home, 'Downloads'),
      desktop:   path.join(home, 'Desktop'),
      movies:    path.join(home, 'Movies'),
      music:     path.join(home, 'Music'),
      pictures:  path.join(home, 'Pictures'),
      images:    path.join(home, 'Pictures'),
      photos:    path.join(home, 'Pictures'),
      videos:    path.join(home, 'Movies'),
      data:      path.join(this.dir, 'data'),
      appdata:   path.join(paths.appHome, 'data'),
      appdir:    this.dir,
    };

    const resolved = builtins[key];

    if (!resolved) {
      sullaLog({ topic: 'extensions', level: 'debug', message: `Unknown path variable: path.${ key }` });

      return null;
    }

    // Ensure the directory exists (best effort, don't fail if it can't be created)
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch { /* best effort */ }

    return resolved;
  }

  /**
   * Resolve `{{variable}}` placeholders in a string.
   *
   * Forms supported:
   *  - `{{propertyName}}`              → SullaSettingsModel.get(propertyName)
   *  - `{{INTEGRATION_ID.PROP}}`       → IntegrationService.getIntegrationValue(INTEGRATION_ID, PROP)
   *  - `{{propertyName|modifier}}`     → value piped through a modifier (urlencode, base64, quote, json)
   *  - `{{INTEGRATION_ID.PROP|mod}}`   → same, for integration values
   *
   * Unresolvable integration placeholders default to empty string.
   * Unresolvable settings placeholders are left as-is so the file stays debuggable.
   */
  protected async resolveVariables(content: string): Promise<string> {
    const pattern = /\{\{\s*([^}]+?)\s*\}\}/g;
    const matches = [...content.matchAll(pattern)];

    if (matches.length === 0) {
      return content;
    }

    // Build a lookup map: full expression (including modifier) → final value
    const resolved = new Map<string, string>();

    for (const match of matches) {
      const expr = match[1];

      if (resolved.has(expr)) {
        continue;
      }

      // Split off optional pipe modifier: "key|modifier"
      const pipeIndex = expr.indexOf('|');
      const rawKey = pipeIndex > 0 ? expr.substring(0, pipeIndex).trim() : expr;
      const modifier = pipeIndex > 0 ? expr.substring(pipeIndex + 1).trim() : null;

      let rawValue: string | null = null;
      const dotIndex = rawKey.indexOf('.');

      if (rawKey.startsWith('path.')) {
        // Built-in path variable: {{path.movies}}, {{path.home}}, etc.
        rawValue = this.resolvePathVariable(rawKey.substring(5));
      } else if (dotIndex > 0) {
        // Integration variable: {{INTEGRATION_ID.PROPERTY}}
        const integrationId = rawKey.substring(0, dotIndex);
        const property = rawKey.substring(dotIndex + 1);

        try {
          const svc = getIntegrationService();
          const iv = await svc.getIntegrationValue(integrationId, property);

          if (iv) {
            rawValue = iv.value;
          } else {
            sullaLog({ topic: 'extensions', level: 'debug', message: `Variable {{${ rawKey }}} not found in integrations, defaulting to empty` });
            rawValue = '';
          }
        } catch (ex) {
          sullaLog({ topic: 'extensions', level: 'debug', message: `Could not resolve integration variable {{${ rawKey }}}, defaulting to empty`, error: ex });
          rawValue = '';
        }
      } else {
        // Sulla settings variable: {{propertyName}}
        try {
          const value = await SullaSettingsModel.get(rawKey);

          if (value !== null && value !== undefined) {
            rawValue = String(value);
          } else {
            sullaLog({ topic: 'extensions', level: 'debug', message: `Variable {{${ rawKey }}} not found in settings, skipping` });
          }
        } catch (ex) {
          sullaLog({ topic: 'extensions', level: 'debug', message: `Could not resolve setting variable {{${ rawKey }}}`, error: ex });
        }
      }

      if (rawValue !== null) {
        resolved.set(expr, modifier ? await this.applyModifier(rawValue, modifier) : rawValue);
      }
    }

    // Replace all resolved placeholders
    return content.replace(pattern, (original, key) => {
      const trimmed = key.trim();

      return resolved.has(trimmed) ? resolved.get(trimmed)! : original;
    });
  }

  /** Binary file extensions that should never be processed for variable substitution. */
  private static readonly BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.icns',
    '.svg', '.tiff', '.heic', '.heif',
    '.zip', '.gz', '.tar', '.tgz', '.bz2', '.xz', '.7z',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.pdf', '.exe', '.dll', '.so', '.dylib',
    '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.avi', '.mov',
    '.wasm', '.bin',
  ]);

  /**
   * Walk the extension directory recursively and resolve {{variables}} in
   * every text file.  Binary files (images, archives, fonts, etc.) are skipped.
   */
  protected async processAllRecipeFiles(): Promise<void> {
    const walk = async(dir: string): Promise<void> => {
      let entries: fs.Dirent[];

      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        // Skip binary files
        const ext = path.extname(entry.name).toLowerCase();

        if (RecipeExtensionImpl.BINARY_EXTENSIONS.has(ext)) {
          continue;
        }

        try {
          const raw = await fs.promises.readFile(fullPath, 'utf-8');
          const processed = await this.resolveVariables(raw);

          if (processed !== raw) {
            await fs.promises.writeFile(fullPath, processed, 'utf-8');
            const relPath = path.relative(this.dir, fullPath);

            sullaLog({ topic: 'extensions', level: 'info', message: `Resolved variables in ${ relPath }` });
          }
        } catch (ex: any) {
          if ((ex as NodeJS.ErrnoException).code !== 'ENOENT') {
            const relPath = path.relative(this.dir, fullPath);

            sullaLog({ topic: 'extensions', level: 'warn', message: `Failed to process recipe file ${ relPath }`, error: ex });
          }
        }
      }
    };

    await walk(this.dir);
  }

  /**
   * @deprecated Use {@link processAllRecipeFiles} instead.
   * Kept for back-compat — now just delegates to the recursive walker.
   */
  protected async processComposeFile(): Promise<void> {
    await this.processAllRecipeFiles();
  }

  /**
   * Save integration credentials declared in the manifest to the IntegrationService.
   * Template variables in values are resolved before saving.
   */
  protected async saveIntegrationCredentials(integrations: Record<string, Record<string, string>>): Promise<void> {
    try {
      const svc = getIntegrationService();

      for (const [integrationId, properties] of Object.entries(integrations)) {
        for (const [property, rawValue] of Object.entries(properties)) {
          const resolvedValue = await this.resolveVariables(rawValue);

          await svc.setIntegrationValue({
            integration_id: integrationId,
            property,
            value:          resolvedValue,
          });
        }
        sullaLog({ topic: 'extensions', level: 'info', message: `[install:${ this.id }] saved integration credentials for ${ integrationId }` });
      }
    } catch (ex) {
      sullaLog({ topic: 'extensions', level: 'warn', message: `[install:${ this.id }] failed to save integration credentials`, error: ex });
    }
  }

  /**
   * Write a `.env` file from the manifest's `env` field with {{variables}} resolved.
   * Docker Compose automatically reads `.env` from the working directory.
   */
  protected async writeEnvFile(): Promise<void> {
    const manifest = await this.getManifest();

    if (!manifest.env || Object.keys(manifest.env).length === 0) {
      return;
    }

    const lines: string[] = [];

    for (const [envKey, envVal] of Object.entries(manifest.env)) {
      const resolvedVal = await this.resolveVariables(envVal);

      lines.push(`${ envKey }=${ resolvedVal }`);
    }

    const envPath = path.join(this.dir, '.env');

    await fs.promises.writeFile(envPath, lines.join('\n') + '\n', 'utf-8');
    sullaLog({ topic: 'extensions', level: 'info', message: `Wrote .env with ${ lines.length } entries for ${ this.id }` });
  }

  // ─── Commands ───────────────────────────────────────────────────────

  /**
   * Shell-quote a path for safe use inside `/bin/sh -c` commands.
   * Wraps in single quotes and escapes any embedded single quotes.
   */
  protected shellQuote(value: string): string {
    return `'${ value.replace(/'/g, "'\\''") }'`;
  }

  protected resolveCommand(template: string): string {
    const composeFile = this._manifest?.compose?.composeFile || 'docker-compose.yml';
    const composePath = path.join(this.dir, composeFile);

    return template
      .replace(/\$\{COMPOSE_FILE\}/g, this.shellQuote(composePath))
      .replace(/\$\{APP_DIR\}/g, this.shellQuote(this.dir));
  }

  /**
   * Build a spawn environment with PATH augmented to include directories where
   * the docker CLI is likely to live.  On macOS, Electron apps launched from
   * the Dock inherit a minimal PATH that often lacks /usr/local/bin and
   * ~/.rd/bin, causing "command not found" (exit 127) for docker commands.
   */
  protected get spawnEnv(): Record<string, string> {
    const extraDirs = [
      paths.integration,                                  // ~/.rd/bin
      path.join(paths.resources, process.platform, 'bin'), // bundled binaries
      '/usr/local/bin',                                   // common on macOS
    ];
    const existing = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const combined = [...new Set([...existing, ...extraDirs])];

    return { ...process.env as Record<string, string>, PATH: combined.join(path.delimiter) };
  }

  /**
   * Collapse repetitive command output into a compact, readable summary.
   */
  protected summarizeCommandOutput(output: string, maxLines = 30): string {
    const lines = output
      .split(/\r?\n|\r/g)
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return '';
    }

    const counts = new Map<string, number>();

    for (const line of lines) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }

    const batched = Array.from(counts.entries()).map(([line, count]) => {
      return count > 1 ? `${ line } (x${ count })` : line;
    });
    const visible = batched.slice(0, maxLines);

    if (batched.length > maxLines) {
      visible.push(`... (${ batched.length - maxLines } more lines batched)`);
    }

    return visible.join('\n');
  }

  async start(): Promise<void> {
    const manifest = await this.getManifest();
    const cmd = manifest.commands?.start;

    if (!cmd) {
      console.debug(`No start command for ${ this.id }`);

      return;
    }

    // Refresh .env before starting so settings changes take effect
    await this.writeEnvFile();

    const resolved = this.resolveCommand(cmd);

    sullaLog({ topic: 'extensions', level: 'info', message: `Starting ${ this.id }`, data: { command: resolved, cwd: this.dir } });

    try {
      const { stdout, stderr } = await spawnFile('/bin/sh', ['-c', resolved], { stdio: 'pipe', cwd: this.dir, env: this.spawnEnv });

      if (stdout) {
        const summarizedStdout = this.summarizeCommandOutput(stdout);

        if (summarizedStdout) {
          sullaLog({ topic: 'extensions', level: 'debug', message: `[${ this.id } start stdout]\n${ summarizedStdout }` });
        }
      }
      if (stderr) {
        const summarizedStderr = this.summarizeCommandOutput(stderr);

        if (summarizedStderr) {
          sullaLog({ topic: 'extensions', level: 'debug', message: `[${ this.id } start stderr]\n${ summarizedStderr }` });
        }
      }
    } catch (err: any) {
      const stderr = err?.stderr || '';
      sullaLog({ topic: 'extensions', level: 'error', message: `Failed to start ${ this.id }: ${ err.message || err }${ stderr ? `\n${ stderr }` : '' }` });
      throw err;
    }
    sullaLog({ topic: 'extensions', level: 'info', message: `Started ${ this.id } successfully` });

    // Persist running state so we can restore on app restart
    await this.saveRunningState('running');
  }

  async stop(): Promise<void> {
    const manifest = await this.getManifest();
    const cmd = manifest.commands?.stop;

    if (!cmd) {
      console.debug(`No stop command for ${ this.id }`);

      return;
    }

    const resolved = this.resolveCommand(cmd);

    sullaLog({ topic: 'extensions', level: 'info', message: `Stopping ${ this.id }`, data: { command: resolved, cwd: this.dir } });

    try {
      const { stdout, stderr } = await spawnFile('/bin/sh', ['-c', resolved], { stdio: 'pipe', cwd: this.dir, env: this.spawnEnv });

      if (stdout) {
        sullaLog({ topic: 'extensions', level: 'debug', message: `[${ this.id } stop stdout] ${ stdout.trim() }` });
      }
      if (stderr) {
        sullaLog({ topic: 'extensions', level: 'debug', message: `[${ this.id } stop stderr] ${ stderr.trim() }` });
      }
      sullaLog({ topic: 'extensions', level: 'info', message: `Stopped ${ this.id } successfully` });
    } catch (err: any) {
      const stderr = err?.stderr || '';

      sullaLog({ topic: 'extensions', level: 'warn', message: `Stop command for ${ this.id } failed (exit code ${ err?.code ?? '?' }): ${ err.message || err }${ stderr ? `\n${ stderr }` : '' }` });
    }

    // Persist stopped state so we don't auto-start on app restart.
    // This runs even if the stop command failed — the user's intent was to
    // stop, and a missing docker CLI (code 127) means the container engine
    // isn't running anyway.
    await this.saveRunningState('stopped');
  }

  async restart(): Promise<void> {
    const manifest = await this.getManifest();
    const cmd = manifest.commands?.restart;

    if (!cmd) {
      await this.stop();
      await this.start();

      return;
    }

    const resolved = this.resolveCommand(cmd);

    sullaLog({ topic: 'extensions', level: 'info', message: `Restarting ${ this.id }`, data: { command: resolved, cwd: this.dir } });
    const { stdout, stderr } = await spawnFile('/bin/sh', ['-c', resolved], { stdio: 'pipe', cwd: this.dir, env: this.spawnEnv });

    if (stdout) {
      sullaLog({ topic: 'extensions', level: 'debug', message: `[${ this.id } restart stdout] ${ stdout.trim() }` });
    }
    if (stderr) {
      sullaLog({ topic: 'extensions', level: 'debug', message: `[${ this.id } restart stderr] ${ stderr.trim() }` });
    }
    sullaLog({ topic: 'extensions', level: 'info', message: `Restarted ${ this.id } successfully` });
  }

  async status(): Promise<string> {
    const manifest = await this.getManifest();
    const cmd = manifest.commands?.status;

    if (!cmd) {
      return 'unknown';
    }

    const resolved = this.resolveCommand(cmd);

    try {
      const result = await spawnFile('/bin/sh', ['-c', resolved], { stdio: 'pipe', cwd: this.dir, env: this.spawnEnv });

      return (result as any).stdout?.toString?.() ?? 'running';
    } catch {
      return 'stopped';
    }
  }

  // ─── Uninstall ──────────────────────────────────────────────────────

  async uninstall(options?: { deleteData?: boolean }): Promise<boolean> {
    if (!(await this.isInstalled())) {
      return false;
    }

    const deleteData = options?.deleteData ?? false;

    sullaLog({ topic: 'extensions', level: 'info', message: `Uninstalling recipe extension ${ this.id }`, data: { deleteData } });

    // Stop containers if running
    try {
      await this.stop();
    } catch (ex) {
      console.error(`Ignoring error stopping ${ this.id } on uninstall: ${ ex }`);
    }

    // Remove compose images for a true uninstall
    try {
      const composeFile = this._manifest?.compose?.composeFile || 'docker-compose.yml';
      const composePath = path.join(this.dir, composeFile);
      const removeImagesCmd = `docker compose -f ${ this.shellQuote(composePath) } down --rmi all --remove-orphans`;

      const { stdout, stderr } = await spawnFile('/bin/sh', ['-c', removeImagesCmd], { stdio: 'pipe', cwd: this.dir, env: this.spawnEnv });

      if (stdout?.trim()) {
        sullaLog({ topic: 'extensions', level: 'debug', message: `[${ this.id } uninstall image cleanup stdout] ${ stdout.trim() }` });
      }
      if (stderr?.trim()) {
        sullaLog({ topic: 'extensions', level: 'debug', message: `[${ this.id } uninstall image cleanup stderr] ${ stderr.trim() }` });
      }
      sullaLog({ topic: 'extensions', level: 'info', message: `Removed compose images for ${ this.id }` });
    } catch (ex) {
      sullaLog({ topic: 'extensions', level: 'warn', message: `Failed to remove compose images for ${ this.id }`, error: ex });
    }

    // Remove docker volumes if deleteData is set
    if (deleteData) {
      try {
        const composeFile = this._manifest?.compose?.composeFile || 'docker-compose.yml';
        const composePath = path.join(this.dir, composeFile);

        await spawnFile('/bin/sh', ['-c', `docker compose -f ${ this.shellQuote(composePath) } down -v`], { stdio: 'pipe', env: this.spawnEnv });
        sullaLog({ topic: 'extensions', level: 'info', message: `Removed docker volumes for ${ this.id }` });
      } catch (ex) {
        sullaLog({ topic: 'extensions', level: 'warn', message: `Failed to remove docker volumes for ${ this.id }`, error: ex });
      }
    }

    // Remove extension directory contents, always preserving data/
    try {
      const entries = await fs.promises.readdir(this.dir);

      for (const entry of entries) {
        if (entry === 'data') {
          continue;
        }
        await fs.promises.rm(path.join(this.dir, entry), { recursive: true, maxRetries: 3 });
      }
    } catch (ex: any) {
      if ((ex as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw ex;
      }
    }

    // Clear caches
    this._metadata = undefined;
    this._labels = undefined;
    this._manifest = undefined;

    mainEvents.emit('settings-write', {
      application: { extensions: { installed: { [this.id]: undefined } } },
    });

    sullaLog({ topic: 'extensions', level: 'info', message: `Recipe extension ${ this.id } uninstalled. Compose images removed. Local data/ preserved.${ deleteData ? ' Docker volumes removed.' : ' Docker volumes kept.' }` });

    return true;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  async isInstalled(): Promise<boolean> {
    try {
      await fs.promises.access(path.join(this.dir, this.INSTALLED_LOCK), fs.constants.F_OK);

      return true;
    } catch {
      return false;
    }
  }

  async extractFile(_sourcePath: string, _destinationPath: string): Promise<void> {
    // Recipe extensions don't support extractFile — files are fetched from the recipe repo
    throw new ExtensionErrorImpl(
      ExtensionErrorCode.FILE_NOT_FOUND,
      `extractFile is not supported for recipe extensions (${ this.id })`,
    );
  }

  async shutdown(): Promise<void> {
    if (!(await this.isInstalled())) {
      return;
    }

    // On app shutdown, preserve the current running state so containers
    // return to the same state on next launch.  We do NOT stop containers
    // here — Docker will handle their lifecycle independently.
    sullaLog({ topic: 'extensions', level: 'info', message: `Shutdown: preserving state for ${ this.id } (containers left as-is)` });
  }

  // ─── Running State Persistence ──────────────────────────────────────

  /**
   * Save the desired running state ('running' | 'stopped') to disk.
   * This is read on next app launch to decide whether to auto-start.
   */
  protected async saveRunningState(state: 'running' | 'stopped'): Promise<void> {
    try {
      await fs.promises.writeFile(
        path.join(this.dir, this.RUNNING_STATE),
        state,
        'utf-8',
      );
    } catch (ex) {
      sullaLog({ topic: 'extensions', level: 'warn', message: `Failed to save running state for ${ this.id }`, error: ex });
    }
  }

  /**
   * Read the persisted running state.  Returns 'running' if no state file
   * exists (default: auto-start after first install).
   */
  async getRunningState(): Promise<'running' | 'stopped'> {
    try {
      const state = (await fs.promises.readFile(
        path.join(this.dir, this.RUNNING_STATE),
        'utf-8',
      )).trim();

      return state === 'stopped' ? 'stopped' : 'running';
    } catch {
      return 'running';
    }
  }
}

/**
 * Create a RecipeExtensionImpl from a marketplace catalog entry.
 * Returns undefined if the entry does not have an installable URL.
 */
export async function createRecipeExtension(
  slug: string,
  version: string,
): Promise<RecipeExtensionImpl | undefined> {
  const entries = await fetchMarketplaceData();
  const entry = entries.find(e => e.slug === slug);

  if (!entry?.installable) {
    return undefined;
  }

  return new RecipeExtensionImpl(slug, version, entry);
}
