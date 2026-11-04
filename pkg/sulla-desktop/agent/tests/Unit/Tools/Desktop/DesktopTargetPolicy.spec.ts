// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { DesktopWorker } from '../../../../tools/desktop/desktop';

class DesktopSnapshotPolicyHarness {
  async snapshot(app: string): Promise<{ successBoolean: boolean; responseString: string }> {
    const worker = new DesktopWorker();
    worker.name = 'snapshot';
    return await (worker as any)._validatedCall({ app });
  }
}

describe('desktop snapshot target policy', () => {
  const harness = new DesktopSnapshotPolicyHarness();
  const refusal = 'Desktop control refused: this app or window is privacy-protected.';

  for (const app of ['1Password', 'Keychain Access', 'http://localhost:4777/vault']) {
    it(`refuses desktop/snapshot for ${ app }`, async() => {
      // risk: secrets — credential stores and the sealed wallet service must never reach desktop automation.
      const result = await harness.snapshot(app);
      expect(result).toEqual({ successBoolean: false, responseString: refusal });
    });
  }
});
