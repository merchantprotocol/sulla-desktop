// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { withSilentVaultRestore } from '../silentVaultRestoreTransport';

describe('desktop broker silent restore', () => {
  it('restores and retries a locked broker request without exposing an unlock gate', async() => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(new Response(null, { status: 423 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const restore = jest.fn().mockResolvedValue(true);

    const response = await withSilentVaultRestore(fetcher, restore)('https://127.0.0.1/v1/broker/status');

    expect(response.status).toBe(200);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry when no signed-in session can be restored', async() => {
    const locked = new Response(null, { status: 423 });
    const fetcher = jest.fn().mockResolvedValue(locked);

    expect(await withSilentVaultRestore(fetcher, async() => false)('https://127.0.0.1/v1/broker/status')).toBe(locked);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
