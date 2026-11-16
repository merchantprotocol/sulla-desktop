// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';
import * as fs from 'fs/promises';

/** The bootstrap file exists but does not hold a readable JSON object. */
export class SettingsBootstrapFileCorruptError extends Error {
  constructor(readonly detail: string) {
    super(`Settings bootstrap file ${ detail }`);
    this.name = 'SettingsBootstrapFileCorruptError';
  }
}

export interface SettingsBootstrapFileLogger {
  warn(message: string): void;
}

/**
 * The pre-database settings file (`sulla-settings-fallback.json`).
 *
 * - Reads tell "missing" (null) apart from "unreadable" (throws).
 * - Writes are serialised and atomic (temp file + rename), so a concurrent
 *   reader never sees a half-written file and two writers never drop each
 *   other's keys.
 * - A corrupt file is moved aside, never overwritten blind: the keys that can
 *   still be read from it are carried into the new file.
 */
export class SettingsBootstrapFile {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly pathOf: () => string,
    private readonly logger: SettingsBootstrapFileLogger = console,
  ) {}

  /** The parsed file; null only when it does not exist. */
  async read(): Promise<Record<string, unknown> | null> {
    let content: string;

    try {
      content = await fs.readFile(this.pathOf(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
    let data: unknown;

    try {
      data = JSON.parse(content);
    } catch {
      throw new SettingsBootstrapFileCorruptError('is not valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SettingsBootstrapFileCorruptError('does not hold a JSON object');
    }

    return data as Record<string, unknown>;
  }

  /** Move the file aside as `<file>.corrupt-<ms>` (kept for recovery); returns the new path. */
  async quarantine(): Promise<string> {
    const filePath = this.pathOf();
    const quarantined = `${ filePath }.corrupt-${ Date.now() }`;

    await fs.rename(filePath, quarantined);

    return quarantined;
  }

  /** The top-level keys that can still be read from a corrupt (e.g. truncated) file. */
  async salvage(filePath: string): Promise<Record<string, unknown>> {
    return SettingsBootstrapFile.salvageText(await fs.readFile(filePath, 'utf8'));
  }

  /** Set one property. */
  write(property: string, value: unknown): Promise<void> {
    return this.update((data) => {
      data[property] = value;
    });
  }

  /** Remove one property. */
  remove(property: string): Promise<void> {
    return this.update((data) => {
      delete data[property];
    });
  }

  /** Serialised, atomic read-modify-write. */
  update(mutate: (data: Record<string, any>) => void): Promise<void> {
    const write = this.writes.then(async() => {
      const filePath = this.pathOf();
      const data = await this.readForUpdate();

      mutate(data);
      const temporary = `${ filePath }.${ process.pid }.${ crypto.randomUUID() }.tmp`;

      await fs.writeFile(temporary, JSON.stringify(data, null, 2));
      try {
        await fs.rename(temporary, filePath);
      } catch (err) {
        await fs.unlink(temporary).catch(() => undefined);
        throw err;
      }
    });

    this.writes = write.catch(() => undefined);

    return write;
  }

  private async readForUpdate(): Promise<Record<string, any>> {
    try {
      return (await this.read()) ?? {};
    } catch (err) {
      if (!(err instanceof SettingsBootstrapFileCorruptError)) throw err;
      // Writes are atomic, so a corrupt file is not a write in progress. Keep
      // it aside and carry every key that can still be read.
      const aside = await this.quarantine();
      const salvaged = await this.salvage(aside).catch(() => ({}));

      this.logger.warn(`[SullaSettingsModel] Settings bootstrap file ${ err.detail }; moved aside to ${ aside }, kept ${ Object.keys(salvaged).length } readable key(s)`);

      return salvaged;
    }
  }

  /**
   * Best-effort parse of a damaged JSON object: every complete top-level
   * `"key": value` pair is kept; anything cut off or malformed is skipped.
   */
  static salvageText(text: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const start = text.indexOf('{');

    if (start < 0) return result;
    let index = start + 1;

    while (index < text.length) {
      const keyStart = text.indexOf('"', index);

      if (keyStart < 0) break;
      const keyEnd = SettingsBootstrapFile.stringEnd(text, keyStart);

      if (keyEnd < 0) break;
      const colon = /^\s*:\s*/.exec(text.slice(keyEnd + 1));

      if (!colon) {
        index = keyEnd + 1;
        continue;
      }
      const valueStart = keyEnd + 1 + colon[0].length;
      const valueEnd = SettingsBootstrapFile.valueEnd(text, valueStart);

      if (valueEnd < 0) break;
      try {
        const key = JSON.parse(text.slice(keyStart, keyEnd + 1)) as string;

        if (!(key in result)) result[key] = JSON.parse(text.slice(valueStart, valueEnd + 1));
      } catch {
        // Skip a pair that does not parse; keep scanning.
      }
      index = valueEnd + 1;
    }

    return result;
  }

  /** Index of the closing quote of the string starting at `start`; -1 when cut off. */
  private static stringEnd(text: string, start: number): number {
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === '\\') index++;
      else if (text[index] === '"') return index;
    }

    return -1;
  }

  /** Index of the last character of the JSON value starting at `start`; -1 when cut off. */
  private static valueEnd(text: string, start: number): number {
    const first = text[start];

    if (first === '"') return SettingsBootstrapFile.stringEnd(text, start);
    if (first === '{' || first === '[') {
      let depth = 0;

      for (let index = start; index < text.length; index++) {
        const char = text[index];

        if (char === '"') {
          index = SettingsBootstrapFile.stringEnd(text, index);
          if (index < 0) return -1;
        } else if (char === '{' || char === '[') {
          depth++;
        } else if (char === '}' || char === ']') {
          depth--;
          if (depth === 0) return index;
        }
      }

      return -1;
    }
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(start));

    return literal ? start + literal[0].length - 1 : -1;
  }
}
