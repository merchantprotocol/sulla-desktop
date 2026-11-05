// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { functionBrowserCompositionRoot } from './FunctionBrowserCompositionRoot';
import type { FunctionBrowserCapabilityService } from './FunctionBrowserCapabilityService';
import { hostPort } from '@pkg/utils/instance';

export class FunctionBrowserInvocation {
  private token: string | null = null;

  constructor(private readonly invocationId: string, private readonly manifest: unknown, private readonly timeoutMs = 60_000, private readonly service: FunctionBrowserCapabilityService = functionBrowserCompositionRoot.capabilities) {}

  async environment(): Promise<Record<string, string>> {
    const minted = this.service.mintForManifest(this.invocationId, this.manifest, this.timeoutMs);
    if (!minted) return {};
    this.token = minted.token;
    return {
      SULLA_BROWSER_HOST_URL: `http://host.sulla.internal:${ hostPort(30121) }`,
      SULLA_BROWSER_TOKEN: this.token,
    };
  }

  async close(): Promise<void> {
    const token = this.token;
    this.token = null;
    if (token) await this.service.invalidate(token);
  }
}
