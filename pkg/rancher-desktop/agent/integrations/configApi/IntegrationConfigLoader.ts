import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

import { resolveSullaIntegrationsDir } from '../../utils/sullaPaths';
import { ConfigApiClient } from './ConfigApiClient';
import type { EndpointConfig, IntegrationAuthConfig, LoadedIntegration } from './types';

const LOG = '[IntegrationConfigLoader]';

// File-name patterns
const AUTH_FILE_PATTERN = /\.v\d+-auth\.yaml$/;   // e.g. youtube.v3-auth.yaml
const ENDPOINT_FILE_PATTERN = /\.v\d+\.yaml$/;    // e.g. search.v3.yaml, videos.v3.yaml

/**
 * Discovers integration YAML configs from ~/sulla/integrations and
 * builds ConfigApiClient instances for each integration.
 *
 * Directory structure expected:
 *   ~/sulla/integrations/
 *     youtube/
 *       youtube.v3-auth.yaml     <- auth config
 *       search.v3.yaml           <- endpoint
 *       videos.v3.yaml           <- endpoint
 *     github/
 *       github.v4-auth.yaml
 *       repos.v4.yaml
 *       issues.v4.yaml
 */
export class IntegrationConfigLoader {
  private integrations = new Map<string, LoadedIntegration>();
  private clients = new Map<string, ConfigApiClient>();
  private integrationsDir: string;

  constructor(integrationsDir?: string) {
    this.integrationsDir = integrationsDir || resolveSullaIntegrationsDir();
  }

  /**
   * Scan the integrations directory and load all configs.
   * Call this on startup and when the user refreshes.
   */
  async loadAll(): Promise<void> {
    this.integrations.clear();
    this.clients.clear();

    if (!fs.existsSync(this.integrationsDir)) {
      console.warn(`${ LOG } Integrations directory not found: ${ this.integrationsDir }`);
      return;
    }

    const entries = fs.readdirSync(this.integrationsDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));

    for (const dir of dirs) {
      try {
        const loaded = this.loadIntegration(dir.name, path.join(this.integrationsDir, dir.name));
        if (loaded) {
          this.integrations.set(dir.name, loaded);
          this.clients.set(dir.name, new ConfigApiClient(loaded, dir.name));
          console.log(`${ LOG } Loaded integration: ${ dir.name } (${ loaded.endpoints.size } endpoints)`);
        }
      } catch (err) {
        console.error(`${ LOG } Failed to load integration "${ dir.name }":`, err);
      }
    }

    console.log(`${ LOG } Loaded ${ this.integrations.size } integration(s): ${ [...this.integrations.keys()].join(', ') }`);
  }

  /** Get a client by integration name (directory name) */
  getClient(name: string): ConfigApiClient | undefined {
    return this.clients.get(name);
  }

  /** Get all loaded client names */
  getAvailableIntegrations(): string[] {
    return [...this.clients.keys()];
  }

  /** Get the raw loaded config for an integration */
  getIntegration(name: string): LoadedIntegration | undefined {
    return this.integrations.get(name);
  }

  /** Reload a single integration by name */
  reloadIntegration(name: string): void {
    const dir = path.join(this.integrationsDir, name);
    if (!fs.existsSync(dir)) {
      this.integrations.delete(name);
      this.clients.delete(name);
      return;
    }

    const loaded = this.loadIntegration(name, dir);
    if (loaded) {
      this.integrations.set(name, loaded);
      this.clients.set(name, new ConfigApiClient(loaded, name));
    }
  }

  // ── Private ───────────────────────────────────────────────────

  private loadIntegration(name: string, dir: string): LoadedIntegration | null {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    // Find auth config file
    const authFile = files.find(f => AUTH_FILE_PATTERN.test(f));
    if (!authFile) {
      console.warn(`${ LOG } No auth config found in ${ dir } (expected *-auth.yaml)`);
      return null;
    }

    const authRaw = fs.readFileSync(path.join(dir, authFile), 'utf-8');
    const authConfig = yaml.parse(authRaw) as IntegrationAuthConfig;

    if (!authConfig?.api?.base_url) {
      console.warn(`${ LOG } Auth config in ${ dir }/${ authFile } missing api.base_url`);
      return null;
    }

    // Load endpoint files
    const endpoints = new Map<string, EndpointConfig>();
    const endpointFiles = files.filter(f => !AUTH_FILE_PATTERN.test(f));

    for (const epFile of endpointFiles) {
      try {
        const epRaw = fs.readFileSync(path.join(dir, epFile), 'utf-8');
        const epConfig = yaml.parse(epRaw) as EndpointConfig;

        if (epConfig?.endpoint?.name && epConfig?.endpoint?.path) {
          endpoints.set(epConfig.endpoint.name, epConfig);
        } else {
          console.warn(`${ LOG } Skipping ${ dir }/${ epFile }: missing endpoint.name or endpoint.path`);
        }
      } catch (err) {
        console.error(`${ LOG } Failed to parse ${ dir }/${ epFile }:`, err);
      }
    }

    return {
      name: authConfig.api.name,
      dir,
      auth: authConfig,
      endpoints,
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────

let instance: IntegrationConfigLoader | null = null;

export function getIntegrationConfigLoader(): IntegrationConfigLoader {
  if (!instance) {
    instance = new IntegrationConfigLoader();
  }
  return instance;
}
