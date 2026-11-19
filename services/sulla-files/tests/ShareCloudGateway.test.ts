// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ShareCloudGateway } from '../src/Services/ShareCloudGateway.js';

describe('ShareCloudGateway content-not-found classification', () => {
  // risk: capture sharing — only a missing optional Cloud copy may offer the live-only retry.
  it('marks a 404 on the optional content upload for an explicit user retry', async() => {
    const gateway = new ShareCloudGateway({ execute: async() => ({ status: 404, body: {} }) });

    await expect(gateway.request('/shares/share-1/content', { method: 'PUT' })).rejects.toMatchObject({
      status: 502,
      code: 'SULLA_CLOUD_CONTENT_NOT_FOUND',
      message: 'Sulla Cloud returned 404',
    });
  });

  // risk: sharing correctness — a create failure must never be mislabeled as a safe no-copy retry.
  it('does not classify a 404 on share creation as a missing optional copy', async() => {
    const gateway = new ShareCloudGateway({ execute: async() => ({ status: 404, body: {} }) });

    await expect(gateway.request('/shares', { method: 'POST' })).rejects.toMatchObject({
      status: 502,
      message: 'Sulla Cloud returned 404',
    });
    await expect(gateway.request('/shares', { method: 'POST' })).rejects.not.toHaveProperty('code', 'SULLA_CLOUD_CONTENT_NOT_FOUND');
  });
});
