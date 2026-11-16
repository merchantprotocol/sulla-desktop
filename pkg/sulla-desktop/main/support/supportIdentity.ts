// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import paths from '@pkg/utils/paths';

export interface SupportIdentityFileSystem {
  readFileSync(file: string, encoding: 'utf8'): string;
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  writeFileSync(file: string, data: string, options: { mode: number }): void;
}

/** Reads, and creates when missing, the device id the support channel uses. Paths resolve lazily on each call. */
export class SupportDeviceIdentity {
  constructor(
    private readonly enrolledFile: () => string = () => path.join(paths.sullaConfig, 'device-id'),
    private readonly fallbackFile: () => string = () => path.join(app.getPath('userData'), 'support-device-id'),
    private readonly files: SupportIdentityFileSystem = fs,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** The Cloud-enrolled device id, or null when this install is not enrolled. */
  readEnrolled(): string | null {
    try {
      const id = this.files.readFileSync(this.enrolledFile(), 'utf8').trim();

      return id || null;
    } catch {
      return null;
    }
  }

  /** The enrolled id, else the support fallback id, else null. */
  read(): string | null {
    for (const file of [this.enrolledFile(), this.fallbackFile()]) {
      try {
        const id = this.files.readFileSync(file, 'utf8').trim();

        if (id) return id;
      } catch {}
    }

    return null;
  }

  /** The existing id, or a new random fallback id written with owner-only permissions. */
  getOrCreate(): string {
    const existing = this.read();

    if (existing) return existing;
    const id = this.newId();
    const fallback = this.fallbackFile();

    this.files.mkdirSync(path.dirname(fallback), { recursive: true });
    this.files.writeFileSync(fallback, id, { mode: 0o600 });

    return id;
  }
}

/** Shared instance for the main process; it holds no state, only path resolvers. */
export const supportDeviceIdentity = new SupportDeviceIdentity();
