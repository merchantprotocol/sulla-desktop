// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Public catalog metadata is not a credential, entitlement, or installed client. */
export class ModelCompatibilityService {
  constructor(private readonly clientStatus: (provider: string) => Promise<{ required: boolean; installed: boolean; version?: string }>) {}

  async assertClient(provider: string, model: { id: string; minimumClientVersion?: string; capabilities?: { requestFormats?: string[] } }): Promise<void> {
    if (provider === 'anthropic' && model.id.startsWith('anthropic/')) throw new Error(`Model ${ model.id } is gateway-qualified; no verified native Anthropic execution identity is declared. Choose a native identity, not an inferred replacement.`);
    if (provider === 'openai' && model.capabilities?.requestFormats?.length && !model.capabilities.requestFormats.includes('chat-completions')) throw new Error(`Model ${ model.id } does not advertise the chat-completions transport used by this Desktop provider`);
    if (!model.minimumClientVersion) return;
    const status = await this.clientStatus(provider);
    if (!status.required) return;
    if (!status.installed) throw new Error(`${ provider } client is not installed`);
    const actual = status.version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    const minimum = model.minimumClientVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!actual || !minimum) throw new Error(`Cannot verify ${ provider } client compatibility for ${ model.id }`);
    for (let i = 1; i <= 3; i++) {
      if (Number(actual[i]) > Number(minimum[i])) return;
      if (Number(actual[i]) < Number(minimum[i])) throw new Error(`${ provider }/${ model.id } requires client ${ model.minimumClientVersion } or newer (installed ${ actual[0] })`);
    }
  }
}

/** Resolve the selected worker CLI, not the unrelated VM helper binary. */
export class ProviderClientStatus {
  constructor(
    private readonly readSelections: () => Promise<unknown>,
    private readonly readImageVersion: (provider: string) => Promise<string | undefined>,
    private readonly readOtherStatus: (provider: string) => Promise<{ required: boolean; installed: boolean; version?: string }>,
  ) {}

  async get(provider: string): Promise<{ required: boolean; installed: boolean; version?: string }> {
    if (provider !== 'codex' && provider !== 'claude-code') return this.readOtherStatus(provider);
    const selected = await this.readSelections();
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new Error('Saved provider CLI selections are invalid');
    const pinned = (selected as Record<string, unknown>)[provider];
    if (pinned !== undefined && pinned !== null && (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pinned))) throw new Error(`Saved ${ provider } CLI selection is invalid`);
    const version = typeof pinned === 'string' ? pinned : await this.readImageVersion(provider);
    return { required: true, installed: Boolean(version), version };
  }
}
