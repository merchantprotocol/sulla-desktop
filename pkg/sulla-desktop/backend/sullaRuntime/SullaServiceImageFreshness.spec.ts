// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaServiceImageFreshness } from './SullaServiceImageFreshness';

describe('SullaServiceImageFreshness', () => {
  let images: Record<string, string>;
  let execCommand: ReturnType<typeof vi.fn>;
  let waitHealthy: ReturnType<typeof vi.fn>;
  let refresh: Map<string, string>;
  let pinned: Map<string, string>;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    images = { container: 'sha256:old', image: 'sha256:new' };
    execCommand = vi.fn(async(_options: unknown, ...command: string[]) => {
      if (command[1] === 'inspect') return `${ images.container }\n`;
      if (command[1] === 'image') return `${ images.image }\n`;

      return undefined;
    });
    waitHealthy = vi.fn(async() => undefined);
    refresh = new Map();
    pinned = new Map();
  });
  afterEach(() => vi.restoreAllMocks());

  const freshness = () => new SullaServiceImageFreshness({ execCommand } as any, refresh, pinned, waitHealthy);

  it('waits up to 600s for the service to be healthy before comparing', async() => {
    await freshness().isStale('sulla_tools', 'tools', 7);
    expect(waitHealthy).toHaveBeenCalledWith({ service: 'tools', container: 'sulla_tools' }, 600, 7);
  });

  it('is never stale when the service has no published or bundled image', async() => {
    await expect(freshness().isStale('sulla_tools', 'tools')).resolves.toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('compares a bundled service with its pinned image without pulling', async() => {
    pinned.set('sulla_files', 'sulla-files:bundled');
    await expect(freshness().isStale('sulla_files', 'sulla_files')).resolves.toBe(true);
    expect(execCommand.mock.calls.some(call => call[2] === 'pull')).toBe(false);
    images.image = images.container;
    await expect(freshness().isStale('sulla_files', 'sulla_files')).resolves.toBe(false);
  });

  it('pulls the published image and reports an older running container as stale', async() => {
    refresh.set('tools', 'ghcr.io/x/tools:latest');
    await expect(freshness().isStale('sulla_tools', 'tools')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith({ root: true }, 'docker', 'pull', 'ghcr.io/x/tools:latest');
  });

  // risk: availability — a failed pull must keep the running container, not recreate it.
  it('keeps the running container when the pull fails', async() => {
    refresh.set('tools', 'ghcr.io/x/tools:latest');
    execCommand.mockRejectedValueOnce(new Error('network down'));
    await expect(freshness().isStale('sulla_tools', 'tools')).resolves.toBe(false);
  });
});
