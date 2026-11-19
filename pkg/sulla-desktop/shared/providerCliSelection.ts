// SPDX-License-Identifier: GPL-2.0-or-later

export const PROVIDER_CLI_IDS = ['claude-code', 'codex', 'opencode', 'cursor'] as const;
export type ProviderCliId = typeof PROVIDER_CLI_IDS[number];

/** Only container CLIs with an exact, script-free package install are pinned. */
export const VERSIONED_PROVIDER_CLI_IDS = ['claude-code', 'codex'] as const;
export type VersionedProviderCliId = typeof VERSIONED_PROVIDER_CLI_IDS[number];

export type ProviderCliSelection =
  | { mode: 'image-default' }
  | { mode: 'versioned'; version: string };
export type ProviderCliSnapshot = Record<ProviderCliId, ProviderCliSelection>;

const ROOT = '/mnt/data/sulla/provider-clis';
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const IMAGE_PATH = '/mnt/data/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function providerCliPrefix(provider: string, version: string): string {
  if (!(VERSIONED_PROVIDER_CLI_IDS as readonly string[]).includes(provider) || !VERSION.test(version)) {
    throw new Error('Unsupported provider CLI version');
  }
  return `${ ROOT }/${ provider }/${ version }`;
}

export function providerCliSnapshotForSelection(selected: Record<string, unknown>): ProviderCliSnapshot {
  return Object.fromEntries(PROVIDER_CLI_IDS.map(provider => {
    const value = selected[provider];
    if (value === undefined || value === null) return [provider, { mode: 'image-default' }];
    if (!(VERSIONED_PROVIDER_CLI_IDS as readonly string[]).includes(provider) || typeof value !== 'string' || !VERSION.test(value)) {
      throw new Error(`Saved ${ provider } CLI selection is invalid; refusing an image-default fallback.`);
    }
    return [provider, { mode: 'versioned', version: value }];
  })) as ProviderCliSnapshot;
}

export function providerCliContainerSettings(snapshot?: ProviderCliSnapshot): { binds: string[]; env: Record<string, string>; pinned: { provider: VersionedProviderCliId; version: string; prefix: string }[] } {
  if (!snapshot) return { binds: [], env: {}, pinned: [] };
  if (Object.keys(snapshot).some(provider => !(PROVIDER_CLI_IDS as readonly string[]).includes(provider)) ||
      PROVIDER_CLI_IDS.some(provider => !Object.prototype.hasOwnProperty.call(snapshot, provider))) {
    throw new Error('Saved provider CLI snapshot is incomplete; refusing to use a newer image default.');
  }
  const pinned = VERSIONED_PROVIDER_CLI_IDS.flatMap(provider => {
    const selection = snapshot[provider];
    if (!selection || selection.mode === 'image-default') return [];
    if (selection.mode !== 'versioned') throw new Error(`Invalid saved ${ provider } CLI selection`);
    return [{ provider, version: selection.version, prefix: providerCliPrefix(provider, selection.version) }];
  });
  if (!pinned.length) return { binds: [], env: {}, pinned: [] };
  return {
    binds: pinned.map(row => `${ row.prefix }:/opt/sulla-provider-clis/${ row.provider }/${ row.version }:ro`),
    env: { PATH: [...pinned.map(row => `/opt/sulla-provider-clis/${ row.provider }/${ row.version }/node_modules/.bin`), IMAGE_PATH].join(':') },
    pinned,
  };
}
