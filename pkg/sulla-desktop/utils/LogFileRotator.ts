// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

interface LogRotationState {
  start: number;
  lastWrittenStart: Record<string, number>;
}

/** Rotates each active log into a bounded, numbered previous-run history. */
export class LogFileRotator {
  constructor(
    private readonly fileSystem: typeof fs = fs,
    private readonly maxBackups = 5,
    private readonly maxBytes = 500 * 1024,
  ) {}

  rotateDirectory(directory: string): void {
    let names: string[];
    try { names = this.fileSystem.readdirSync(directory) } catch { return }

    const state = this.readState(directory);
    const start = state.start + 1;
    const activeTopics = new Set<string>();
    const knownTopics = new Set(Object.keys(state.lastWrittenStart));

    for (const name of names) {
      const backup = name.match(/^(.*)\.\d+\.log$/);
      if (backup) knownTopics.add(path.join(directory, backup[1]));
      if (!name.endsWith('.log') || /\.\d+\.log$/.test(name)) continue;

      const activePath = path.join(directory, name);
      const topic = activePath.slice(0, -4);
      try {
        if (this.fileSystem.statSync(activePath).size === 0) continue;
      } catch {
        continue;
      }

      activeTopics.add(topic);
      knownTopics.add(topic);
      state.lastWrittenStart[topic] = start;
      this.rotateFile(activePath);
    }

    for (const topic of knownTopics) {
      if (activeTopics.has(topic)) continue;
      const lastWrittenStart = state.lastWrittenStart[topic] ?? start - 1;
      if (start - lastWrittenStart >= this.maxBackups) {
        this.deleteRotatedFiles(topic);
        delete state.lastWrittenStart[topic];
      } else {
        state.lastWrittenStart[topic] = lastWrittenStart;
      }
    }

    state.start = start;
    this.writeState(directory, state);
  }

  private rotateFile(activePath: string): void {
    const stem = activePath.slice(0, -4);
    try {
      if (this.fileSystem.statSync(activePath).size === 0) return;
    } catch { return }

    this.rotateBackups(stem);
    const firstBackup = `${ stem }.1.log`;
    try {
      this.fileSystem.renameSync(activePath, firstBackup);
      this.capFile(firstBackup);
    } catch {
      // A log file that cannot be renamed remains available for normal writes.
    }
  }

  private rotateBackups(stem: string): void {
    for (let index = this.maxBackups; index > 1; index--) {
      const source = `${ stem }.${ index - 1 }.log`;
      const destination = `${ stem }.${ index }.log`;
      try {
        if (!this.fileSystem.existsSync(source)) continue;
        if (this.fileSystem.existsSync(destination)) this.fileSystem.unlinkSync(destination);
        this.fileSystem.renameSync(source, destination);
        this.capFile(destination);
      } catch {
        // A missing or locked backup must not discard other retained history.
      }
    }
  }

  private deleteRotatedFiles(stem: string): void {
    for (let index = 1; index <= this.maxBackups; index++) {
      const backup = `${ stem }.${ index }.log`;
      try {
        if (this.fileSystem.existsSync(backup)) this.fileSystem.unlinkSync(backup);
      } catch {
        // A locked backup is safer to retain than to prevent startup.
      }
    }
  }

  private readState(directory: string): LogRotationState {
    const filePath = this.statePath(directory);
    try {
      const state = JSON.parse(this.fileSystem.readFileSync(filePath, 'utf8')) as Partial<LogRotationState>;
      const lastWrittenStart = Object.fromEntries(
        Object.entries(state.lastWrittenStart ?? {}).filter((entry): entry is [string, number] => Number.isInteger(entry[1])),
      );
      return {
        start: Number.isInteger(state.start) ? state.start! : 0,
        lastWrittenStart,
      };
    } catch {
      return { start: 0, lastWrittenStart: {} };
    }
  }

  private writeState(directory: string, state: LogRotationState): void {
    try {
      this.fileSystem.writeFileSync(this.statePath(directory), `${ JSON.stringify(state) }\n`, { mode: 0o600 });
    } catch {
      // Retention must never stop the app from opening its log streams.
    }
  }

  private statePath(directory: string): string {
    return path.join(directory, '.log-file-rotation-state.json');
  }

  private capFile(filePath: string): void {
    try {
      const size = this.fileSystem.statSync(filePath).size;
      if (size <= this.maxBytes) return;
      const buffer = Buffer.alloc(this.maxBytes);
      const fd = this.fileSystem.openSync(filePath, 'r');
      try { this.fileSystem.readSync(fd, buffer, 0, this.maxBytes, size - this.maxBytes) } finally { this.fileSystem.closeSync(fd) }
      const newline = buffer.indexOf('\n');
      this.fileSystem.writeFileSync(filePath, newline >= 0 ? buffer.subarray(newline + 1) : buffer);
    } catch {
      // Retention must never stop the app from opening its log streams.
    }
  }
}
