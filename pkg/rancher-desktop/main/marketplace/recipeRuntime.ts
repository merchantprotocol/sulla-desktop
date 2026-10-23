import path from 'node:path';

import yaml from 'yaml';

import type { StoredFile } from '@pkg/agent/database/models/MarketplaceArtifactModel';

export interface RecipeVolumeSeed {
  volumeName: string;
  sourcePath: string;
}

export interface RecipeRuntimePlan {
  compose:     string;
  volumeSeeds: RecipeVolumeSeed[];
  webPorts:    number[];
}

export type RecipeRailStatusLevel = 'ok' | 'warn' | 'bad' | 'unknown';

export interface RecipeRailDefinition {
  label:  string;
  icon:   string;
  open:   { port: number; path: string };
  status?: { port: number; path: string; every: number };
}

function railEndpoint(value: unknown, includeEvery = false): RecipeRailDefinition['open'] | RecipeRailDefinition['status'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const endpoint = value as Record<string, unknown>;
  const port = Number(endpoint.port);
  const endpointPath = endpoint.path;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof endpointPath !== 'string' || !endpointPath.startsWith('/') || endpointPath.startsWith('//')) return null;

  return includeEvery
    ? { port, path: endpointPath, every: Math.max(10, Number.isFinite(Number(endpoint.every)) ? Math.floor(Number(endpoint.every)) : 30) }
    : { port, path: endpointPath };
}

/** Parse the untrusted, optional rail app declaration from a recipe manifest. */
export function parseRecipeRail(manifest: unknown): RecipeRailDefinition | null {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const rail = (manifest as Record<string, unknown>).rail;
  if (!rail || typeof rail !== 'object' || Array.isArray(rail)) return null;
  const value = rail as Record<string, unknown>;
  const label = typeof value.label === 'string' ? value.label.trim().slice(0, 80) : '';
  const icon = typeof value.icon === 'string' ? value.icon.trim() : '';
  const open = railEndpoint(value.open);
  const status = value.status === undefined ? undefined : railEndpoint(value.status, true);
  if (!label || !/^<svg(?:\s|>)/i.test(icon) || icon.length > 20_000 || !open || (value.status !== undefined && !status)) return null;

  return { label, icon, open, ...(status ? { status: status as NonNullable<RecipeRailDefinition['status']> } : {}) };
}

function safePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'data';
}

function relativeSource(source: string): string | null {
  const normalized = source.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('~') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function sourceIsFile(source: string, files: Record<string, StoredFile>): boolean {
  return files[source] !== undefined && !Object.keys(files).some(file => file.startsWith(`${ source }/`));
}

function storedText(file: StoredFile | undefined): string | null {
  return typeof file === 'string' ? file : null;
}

/** Rewrite every host bind so runtime state no longer depends on a temp/source directory. */
export function rewriteRecipeCompose(slug: string, rawCompose: string, files: Record<string, StoredFile>): RecipeRuntimePlan {
  const document = yaml.parse(rawCompose) as Record<string, any>;
  if (!document?.services || typeof document.services !== 'object') throw new Error(`Recipe ${ slug } compose is missing services`);
  document.volumes = document.volumes && typeof document.volumes === 'object' ? document.volumes : {};
  document.configs = document.configs && typeof document.configs === 'object' ? document.configs : {};
  const volumeSeeds: RecipeVolumeSeed[] = [];
  const webPorts = new Set<number>();

  for (const [serviceName, service] of Object.entries(document.services as Record<string, any>)) {
    if (!service || typeof service !== 'object') continue;
    const nextVolumes: any[] = [];
    const nextConfigs: any[] = Array.isArray(service.configs) ? [...service.configs] : [];

    for (const [index, entry] of (Array.isArray(service.volumes) ? service.volumes : []).entries()) {
      const long = entry && typeof entry === 'object' && !Array.isArray(entry);
      const type = long ? String(entry.type ?? '') : '';
      const parts = typeof entry === 'string' ? entry.split(':') : [];
      const source = long ? String(entry.source ?? '') : String(parts[0] ?? '');
      const target = long ? String(entry.target ?? '') : String(parts[1] ?? '');
      const mode = long ? (entry.read_only ? 'ro' : '') : String(parts[2] ?? '');
      const isBind = type === 'bind' || (typeof entry === 'string' && parts.length >= 2 && (source.startsWith('.') || source.startsWith('/') || source.startsWith('~') || source.includes('/')));
      if (!isBind || !target) { nextVolumes.push(entry); continue }

      const relative = relativeSource(source);
      if (relative && sourceIsFile(relative, files)) {
        const content = storedText(files[relative]);
        if (content === null) throw new Error(`Recipe ${ slug } cannot mount binary config file ${ relative }`);
        const configKey = safePart(`${ serviceName }-${ path.basename(target) }-${ index }`);
        document.configs[configKey] = { content };
        nextConfigs.push({ source: configKey, target, ...(mode.includes('ro') ? { mode: 0o444 } : {}) });
        continue;
      }

      const volumeKey = safePart(`${ serviceName }-${ path.basename(target) || index }`);
      const volumeName = `sulla-${ safePart(slug) }-${ volumeKey }`;
      document.volumes[volumeKey] = { name: volumeName };
      nextVolumes.push(long
        ? { type: 'volume', source: volumeKey, target, ...(entry.read_only ? { read_only: true } : {}) }
        : `${ volumeKey }:${ target }${ mode ? `:${ mode }` : '' }`);
      volumeSeeds.push({ volumeName, sourcePath: relative ?? source });
    }
    service.volumes = nextVolumes;
    if (nextConfigs.length) service.configs = nextConfigs;

    for (const port of Array.isArray(service.ports) ? service.ports : []) {
      const published = typeof port === 'object' ? Number(port.published) : Number(String(port).split(':').length > 1 ? String(port).split(':').slice(-2)[0] : 0);
      if (Number.isInteger(published) && published > 0 && published <= 65535) webPorts.add(published);
    }
  }

  if (Object.keys(document.configs).length === 0) delete document.configs;
  if (Object.keys(document.volumes).length === 0) delete document.volumes;
  return { compose: yaml.stringify(document), volumeSeeds, webPorts: [...webPorts].sort((a, b) => a - b) };
}
