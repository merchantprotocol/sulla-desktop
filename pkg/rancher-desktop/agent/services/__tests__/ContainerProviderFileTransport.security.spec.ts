import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';

import { createIsolatedCheckout, isolatedCheckoutPrefix } from '../AgentContainerCheckout';
import {
  CONTAINER_PROVIDER_FILES_PATH,
  ContainerProviderFileTransport,
} from '../ContainerProviderFileTransport';

import type { ProviderTransportContext } from '../../languagemodels/ProviderExecutionTransport';

describe('container filesystem isolation', () => {
  test('keeps host writes out of a symlinked workspace provider directory', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-provider-files-'));
    const workspace = path.join(fixture, 'workspace');
    const outside = path.join(fixture, 'outside');
    const storageParent = path.join(fixture, 'protected');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, '.sulla-provider-files'), 'dir');

    const transport = new ContainerProviderFileTransport(storageParent);
    const previousUmask = process.umask(0o077);
    const ref = (() => {
      try {
        return transport.write({
          context:       {} as ProviderTransportContext,
          purpose:       'system-prompt',
          suggestedName: 'prompt.md',
          data:          'synthetic provider input',
        });
      } finally {
        process.umask(previousUmask);
      }
    })();
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

  test('uses unique checkout directories without letting a long branch erase job identity', async() => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-container-checkout-'));
    const prefix = isolatedCheckoutPrefix('sulla-desktop', `feature/${ 'long-branch-'.repeat(20) }`, 'agent-job-123-4');
    const clone = (checkout: string): Promise<void> => {
      fs.writeFileSync(path.join(checkout, '.git'), 'independent clone');
      return Promise.resolve();
    };

    try {
      expect(prefix).toContain('-agent-agent-job-123-4-');
      const first = await createIsolatedCheckout(fixture, prefix, clone);
      const second = await createIsolatedCheckout(fixture, prefix, clone);

      expect(first).not.toBe(second);
      expect(fs.readFileSync(path.join(first, '.git'), 'utf8')).toBe('independent clone');
      expect(fs.readFileSync(path.join(second, '.git'), 'utf8')).toBe('independent clone');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('removes only its fresh checkout when cloning fails', async() => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-container-checkout-failure-'));
    const unrelated = path.join(fixture, 'unrelated');
    let failedCheckout = '';

    fs.writeFileSync(unrelated, 'preserve me');
    try {
      await expect(createIsolatedCheckout(fixture, 'repo-branch-agent-job-', (checkout) => {
        failedCheckout = checkout;
        fs.writeFileSync(path.join(checkout, 'partial'), 'partial clone');
        return Promise.reject(new Error('synthetic clone failure'));
      })).rejects.toThrow('synthetic clone failure');
      expect(fs.existsSync(failedCheckout)).toBe(false);
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('preserve me');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
