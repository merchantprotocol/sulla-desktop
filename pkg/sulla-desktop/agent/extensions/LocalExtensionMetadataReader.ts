// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import yaml from 'yaml';

import type { ExtensionUIContribution } from './ExtensionUIRegistry';
import { EXTENSION_HOOKS, ExtensionHookName } from './HookRegistry';

/**
 * One installed extension as the Extensions settings and rail render it.
 * Rows built from disk have no grants yet; the DB-backed list fills them in.
 */
export interface LocalExtensionPermissionRow {
  extensionId:    string;
  slug:           string;
  name:           string;
  description:    string;
  publisher:      string;
  version:        string | null;
  hooks:          ExtensionHookName[];
  grants:         Partial<Record<ExtensionHookName, boolean>>;
  ui:             readonly ExtensionUIContribution[];
  hiddenFromRail: boolean;
  integration?:   { id: string; version: string; permissions: string[]; granted: boolean };
}

export interface LocalExtensionMetadataOptions {
  /** Directories holding `<slug>/function.yaml`. The first directory that has a slug wins. */
  functionsDirs:    readonly string[];
  /** Directories holding `<slug>/integration.yaml`. The first directory that has a slug wins. */
  integrationsDirs: readonly string[];
  listUi:           (extensionId: string) => readonly ExtensionUIContribution[];
  logger?:          { warn(message: string): void };
}

type Manifest = Record<string, any>;

/**
 * Lists installed extensions from manifests on disk, so the Extensions screen can paint
 * before Postgres is ready. Never touches the database and never rejects: a missing
 * directory or a broken manifest is skipped (and logged when it is a parse error).
 */
export class LocalExtensionMetadataReader {
  constructor(private readonly options: LocalExtensionMetadataOptions) {}

  async list(): Promise<LocalExtensionPermissionRow[]> {
    const [functions, integrations] = await Promise.all([
      this.readManifests(this.options.functionsDirs, 'function.yaml'),
      this.readManifests(this.options.integrationsDirs, 'integration.yaml'),
    ]);

    const rows: LocalExtensionPermissionRow[] = [];
    for (const { slug, manifest } of functions) {
      const row = this.toFunctionRow(slug, manifest);
      if (row) rows.push(row);
    }
    for (const { slug, manifest } of integrations) {
      const row = this.toIntegrationRow(slug, manifest);
      if (row) rows.push(row);
    }

    return rows;
  }

  /** Mirrors the DB-backed listing: only functions with hooks or UI, and integrations with permissions. */
  toFunctionRow(slug: string, manifest: Manifest): LocalExtensionPermissionRow | null {
    const hooks = normalizeHooks(manifest.hooks);
    const extensionId = `function:${ slug }`;
    const ui = this.options.listUi(extensionId);
    if (!hooks.length && !ui.length) return null;

    return {
      extensionId, slug,
      name:        text(manifest.name, slug),
      description: text(manifest.description, ''),
      publisher:   publisherOf(manifest),
      version:     versionOf(manifest),
      hooks, grants: {}, ui, hiddenFromRail: false,
    };
  }

  toIntegrationRow(slug: string, manifest: Manifest): LocalExtensionPermissionRow | null {
    const permissions = Array.isArray(manifest.permissions)
      ? manifest.permissions.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    if (!permissions.length) return null;
    const version = versionOf(manifest) ?? '0.0.0';

    return {
      extensionId: `integration:${ slug }`, slug,
      name:        text(manifest.name, slug),
      description: text(manifest.description, ''),
      publisher:   publisherOf(manifest),
      version,
      hooks: [], grants: {}, ui: [], hiddenFromRail: false,
      integration: { id: text(manifest.id, slug), version, permissions, granted: false },
    };
  }

  private async readManifests(dirs: readonly string[], fileName: string): Promise<Array<{ slug: string; manifest: Manifest }>> {
    const found = new Map<string, Manifest>();
    for (const dir of dirs) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // A missing directory just means nothing is installed there.
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || found.has(entry.name)) continue;
        const manifest = await this.readManifest(path.join(dir, entry.name, fileName));
        if (manifest) found.set(entry.name, manifest);
      }
    }

    return [...found].map(([slug, manifest]) => ({ slug, manifest }));
  }

  private async readManifest(file: string): Promise<Manifest | null> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return null; // This folder has no manifest.
    }
    try {
      const parsed = yaml.parse(raw);

      return parsed && typeof parsed === 'object' ? parsed as Manifest : null;
    } catch (err) {
      this.options.logger?.warn(`[LocalExtensionMetadata] Skipping ${ file }: ${ err instanceof Error ? err.message : String(err) }`);

      return null;
    }
  }
}

function normalizeHooks(raw: unknown): ExtensionHookName[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item: any) => typeof item === 'string' ? item : item?.name)
    .filter((name: unknown): name is ExtensionHookName => typeof name === 'string' && name in EXTENSION_HOOKS);
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function versionOf(manifest: Manifest): string | null {
  return manifest.version === undefined || manifest.version === null ? null : String(manifest.version);
}

function publisherOf(manifest: Manifest): string {
  return text(manifest.developer, '') || text(manifest.author, '') || 'Unknown publisher';
}
