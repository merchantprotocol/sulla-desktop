// SPDX-License-Identifier: GPL-2.0-or-later

class PreviewSettings {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string, fallback: T): Promise<T> {
    return (this.values.get(key) as T | undefined) ?? fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

export const SullaSettingsModel = new PreviewSettings();
