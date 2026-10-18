import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';

import {
  CONTAINER_PROVIDER_FILES_PATH,
  ContainerProviderFileTransport,
} from '../ContainerProviderFileTransport';

import type { ProviderTransportContext } from '../../languagemodels/ProviderExecutionTransport';

describe('container provider file transport', () => {
  test('keeps host writes out of a symlinked workspace provider directory', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-provider-files-'));
    const workspace = path.join(fixture, 'workspace');
    const outside = path.join(fixture, 'outside');
    const storageParent = path.join(fixture, 'protected');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, '.sulla-provider-files'), 'dir');

    const transport = new ContainerProviderFileTransport(storageParent);
    const ref = transport.write({
      context:       {} as ProviderTransportContext,
      purpose:       'system-prompt',
      suggestedName: 'prompt.md',
      data:          'synthetic provider input',
    });
    const storageRoot = transport.bindMount.slice(0, transport.bindMount.indexOf(`:${ CONTAINER_PROVIDER_FILES_PATH }:ro`));

    expect(transport.bindMount).toBe(`${ storageRoot }:${ CONTAINER_PROVIDER_FILES_PATH }:ro`);
    expect(ref.path).toBe(path.posix.join(CONTAINER_PROVIDER_FILES_PATH, path.basename(ref.path)));
    const storageTarget = path.join(storageRoot, path.basename(ref.path));
    expect(fs.readFileSync(storageTarget, 'utf8')).toBe('synthetic provider input');
    expect(fs.statSync(storageRoot).mode & 0o777).toBe(0o711);
    expect(fs.statSync(storageTarget).mode & 0o077).toBe(0o044);
    expect(fs.readdirSync(outside)).toEqual([]);

    ref.dispose();
    transport.dispose();
    expect(fs.existsSync(storageRoot)).toBe(false);
    fs.rmSync(fixture, { recursive: true, force: true });
  });
});
