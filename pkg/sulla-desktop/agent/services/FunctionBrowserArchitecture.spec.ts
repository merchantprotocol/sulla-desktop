// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

class TypeScriptSourceRepository {
  constructor(private readonly root: string) {}
  files(directory = this.root): string[] {
    return readdirSync(directory).flatMap(name => {
      const path=join(directory,name); if(statSync(path).isDirectory()) return this.files(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });
  }
  singletonImporters(): string[] {
    return this.files().filter(path => readFileSync(path,'utf8').includes('FunctionBrowserCompositionRoot'))
      .map(path => relative(this.root,path)).sort();
  }
}

describe('function browser composition boundary', () => {
  it('allows the process singleton only at the three framework entry points', () => { // risk: hidden global business dependency
    const projectRoot=fileURLToPath(new URL('../../../../',import.meta.url));
    const repository=new TypeScriptSourceRepository(join(projectRoot,'pkg/sulla-desktop'));
    expect(repository.singletonImporters()).toEqual([
      'agent/controllers/PlaybookController.ts',
      'agent/services/FunctionBrowserCompositionRoot.ts',
      'agent/tools/function/function_run.ts',
      'main/sullaSecretsServer.ts',
    ]);
    expect(readFileSync(join(projectRoot,'pkg/sulla-desktop/agent/services/FunctionBrowserInvocation.ts'),'utf8'))
      .not.toContain('FunctionBrowserCompositionRoot');
  });
});
