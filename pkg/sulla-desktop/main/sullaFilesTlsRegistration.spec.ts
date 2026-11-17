// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { desktopFilesTransport } from '../agent/files/desktopFilesTransport';
import { loopbackOrigin } from '@pkg/utils/instance';

import { desktopFilesFetch, FILES_HTTPS_ORIGIN } from './sullaFilesTls';

vi.mock('electron', () => ({ session: { fromPartition: () => ({}) } }));
vi.mock('@pkg/utils/logging', () => ({ default: {} }));
vi.mock('@pkg/utils/paths', () => ({ default: { appHome: '/tmp/sulla-files-registration-spec' } }));
vi.mock('./vaultTlsVerifier', () => ({ verifyVaultCertificate: vi.fn() }));

describe('Desktop main Files transport registration', () => {
  it('registers the pinned-TLS transport on import so agent-side Files calls resolve it in Desktop main', () => {
    // risk: if registration never runs, every Desktop-origin Files call fails with "transport is not available".
    const transport = desktopFilesTransport.resolve();
    expect(transport.origin).toBe(loopbackOrigin('https', 30124));
    expect(transport.origin).toBe(FILES_HTTPS_ORIGIN);
    expect(transport.fetch).toBe(desktopFilesFetch);
  });

  it('is imported by the Electron main entry before any agent code loads', () => {
    // risk: a lazy or indirect-only load leaves the transport unregistered until some other module happens to import it.
    const entry = readFileSync(new URL('../../../background.ts', import.meta.url), 'utf8');
    expect(entry).toContain("import '@pkg/main/sullaFilesTls';");
  });
});
