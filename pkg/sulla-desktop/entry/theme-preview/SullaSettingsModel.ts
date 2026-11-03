// SPDX-License-Identifier: GPL-2.0-or-later
const values = new Map<string, unknown>();
export const SullaSettingsModel = {
  async get(key: string, fallback: unknown = null) { return values.has(key) ? values.get(key) : fallback; },
  async set(key: string, value: unknown) { values.set(key, value); },
};
