import yaml from 'yaml';

import { ConfigApiClient } from './ConfigApiClient';
import { IntegrationDefinitionModel, type StoredFile } from '../../database/models/MarketplaceArtifactModel';

import type { EndpointConfig, IntegrationAuthConfig, LoadedIntegration } from './types';

const LOG = '[IntegrationConfigLoader]';
const AUTH_FILE_PATTERN = /\.v\d+-auth\.yaml$/;

function text(file: StoredFile | undefined): string | null {
  return typeof file === 'string' ? file : null;
}

/** Runtime integration configs are built exclusively from integration_definitions rows. */
export class IntegrationConfigLoader {
  private integrations = new Map<string, LoadedIntegration>();
  private clients = new Map<string, ConfigApiClient>();

  async loadAll(): Promise<void> {
    this.integrations.clear();
    this.clients.clear();
    for (const row of await IntegrationDefinitionModel.list()) {
      try {
        const loaded = this.loadIntegration(row.slug, row.files);
        if (!loaded) continue;
        this.integrations.set(row.slug, loaded);
        this.clients.set(row.slug, new ConfigApiClient(loaded, row.slug));
      } catch (error) {
        console.error(`${ LOG } Failed to load database integration "${ row.slug }":`, error);
      }
    }
    console.log(`${ LOG } Loaded ${ this.integrations.size } database integration(s)`);
  }

  getClient(name: string): ConfigApiClient | undefined {
    return this.clients.get(name);
  }

  getAvailableIntegrations(): string[] {
    return [...this.clients.keys()];
  }

  getIntegration(name: string): LoadedIntegration | undefined {
    return this.integrations.get(name);
  }

  reloadIntegration(_name: string): void {
    this.loadAll().catch(error => console.error(`${ LOG } Reload failed:`, error));
  }

  private loadIntegration(name: string, files: Record<string, StoredFile>): LoadedIntegration | null {
    const authName = Object.keys(files).find(file => AUTH_FILE_PATTERN.test(file) && text(files[file]) !== null);
    if (!authName) return null;
    const auth = yaml.parse(text(files[authName])!) as IntegrationAuthConfig;
    if (!auth?.api?.base_url) {
      console.warn(`${ LOG } ${ name } auth config is missing api.base_url`);
      return null;
    }
    const endpoints = new Map<string, EndpointConfig>();
    for (const [file, stored] of Object.entries(files)) {
      const raw = text(stored);
      if (!raw || file === authName || !/\.ya?ml$/i.test(file)) continue;
      try {
        const endpoint = yaml.parse(raw) as EndpointConfig;
        if (endpoint?.endpoint?.name && endpoint.endpoint.path) endpoints.set(endpoint.endpoint.name, endpoint);
      } catch (error) {
        console.warn(`${ LOG } Skipped invalid endpoint ${ name }/${ file }:`, error);
      }
    }
    return { name: auth.api.name, dir: `database:integration_definitions/${ name }`, auth, endpoints };
  }
}

let instance: IntegrationConfigLoader | null = null;
export function getIntegrationConfigLoader(): IntegrationConfigLoader {
  return instance ?? (instance = new IntegrationConfigLoader());
}
