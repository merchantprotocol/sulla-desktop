// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({}));

class AgentToolsSourceScanner {
  constructor(private readonly root: string) {}
  private files(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? this.files(path) : entry.isFile() && path.endsWith('.ts') ? [path] : [];
    });
  }
  public factoryReferences(): string[] {
    return this.files(this.root).filter(path => readFileSync(path, 'utf8').includes('humanForUiIpc'));
  }
}

describe('CustodyCallerVerifier architecture', () => {
  it('keeps the UI/IPC-only human actor factory out of agent tools', () => { // risk: agent-controlled code forges human authority
    const scanner = new AgentToolsSourceScanner(join(process.cwd(), 'pkg/sulla-desktop/agent/tools'));
    expect(scanner.factoryReferences()).toEqual([]);
  });
});
