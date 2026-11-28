// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import type { LocalAuthorityHost } from '../../../../../../services/sulla-vault/src/localAuthority/LocalAuthorityHost';
import { LocalAuthorityCollaborators } from '../../../../../../services/sulla-vault/src/localAuthority/LocalAuthorityCollaborators';
import { UpstreamHttpClient } from '../../../../../../services/sulla-vault/src/localAuthority/UpstreamHttpClient';
import { TestOnlyUpstreamHttpClient } from '../../../../../../services/sulla-vault/scripts/load/TestOnlyUpstreamHttpClient';

describe('LocalAuthorityCollaborators upstream composition', () => {
  it('keeps the default upstream client rejecting loopback destinations', async() => {
    // risk: SSRF — only a constructor-injected test client may replace default public-address validation.
    const collaborators = new LocalAuthorityCollaborators({ profileContext: { profileId: 'synthetic' } } as unknown as LocalAuthorityHost);

    await expect(collaborators.upstream.validateTarget('https://127.0.0.1:45678/'))
      .rejects.toMatchObject({ code: 'destination_denied', status: 403 });
  });

  it('uses a replacement only when the composition constructor receives a client factory', () => {
    // risk: security boundary — no environment/config switch can silently relax egress policy.
    const host = { profileContext: { profileId: 'synthetic' } } as unknown as LocalAuthorityHost;
    const replacement = new UpstreamHttpClient(host, undefined, Buffer.from('synthetic-only-ca'));
    const factory = vi.fn(() => replacement);

    const collaborators = new LocalAuthorityCollaborators(host, factory);

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(host);
    expect(collaborators.upstream).toBe(replacement);
  });

  it('pins the harness policy to only its exact synthetic origin and IPv4 loopback', async() => {
    // risk: SSRF — the isolated harness exception cannot reach any other host or local address.
    const origin = 'https://api.openai.com:45555';
    const client = new TestOnlyUpstreamHttpClient({} as LocalAuthorityHost, origin, Buffer.from('synthetic-only-ca'));
    const target = await client.validateTarget(`${ origin }/v1/responses`);

    expect(target.pinnedAddress).toBe('127.0.0.1');
    await expect(client.validateTarget('https://api.openai.com:45556/v1/responses'))
      .rejects.toMatchObject({ code: 'destination_denied', status: 403 });
    await expect(client.validateTarget('https://example.com:45555/v1/responses'))
      .rejects.toMatchObject({ code: 'destination_denied', status: 403 });
  });
});
