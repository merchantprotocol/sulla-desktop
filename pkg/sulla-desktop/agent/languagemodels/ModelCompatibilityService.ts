// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Public catalog metadata is not a credential, entitlement, or installed client. */
export class ModelCompatibilityService {
  constructor(private readonly clientStatus: (provider: string) => Promise<{ required: boolean; installed: boolean; version?: string }>) {}

  async assertClient(provider: string, model: { id: string; minimumClientVersion?: string }): Promise<void> {
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
