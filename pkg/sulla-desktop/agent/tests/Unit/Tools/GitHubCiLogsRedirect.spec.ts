// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubLogStreamFetcher } from '../../../tools/github/githubLogStreamFetcher';

describe('GitHub Actions log redirect handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows a signed GitHub blob redirect without forwarding authorization', async() => {
    // risk: credential disclosure — signed log URLs must never receive GitHub auth.
    const broker = {
      executeStream: vi.fn(async() => new Response(null, {
        status: 302,
        headers: { location: 'https://logs.blob.core.windows.net/run/job?sig=secret' },
      })),
    };
    const signedFetch = vi.fn(async(_url: URL, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return new Response('##[error] assertion failed', { status: 200 });
    });
    vi.stubGlobal('fetch', signedFetch);

    const response = await new GitHubLogStreamFetcher().fetchLogStream(broker as never, {} as never, undefined);

    expect(await response.text()).toContain('assertion failed');
    expect(signedFetch).toHaveBeenCalledOnce();
  });

  it('rejects a redirect to a host outside the GitHub log allow-list', async() => {
    // risk: SSRF — a broker redirect must not turn CI log reads into arbitrary fetches.
    const broker = {
      executeStream: vi.fn(async() => new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/log.txt' },
      })),
    };
    const signedFetch = vi.fn();
    vi.stubGlobal('fetch', signedFetch);

    await expect(new GitHubLogStreamFetcher().fetchLogStream(broker as never, {} as never, undefined))
      .rejects.toThrow('not allow-listed');
    expect(signedFetch).not.toHaveBeenCalled();
  });
});
