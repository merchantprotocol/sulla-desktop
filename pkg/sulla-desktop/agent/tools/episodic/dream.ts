// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getV7Dreamer } from '../../memory/V7DreamerRuntime';
import type { DreamRunResult } from '../../memory/V7Dreamer';
import { BaseTool, ToolResponse } from '../base';

/** Stay under the workflow manager's 120 s tool proxy timeout; the dream keeps running in-process. */
const WAIT_FOR_DREAM_MS = 100_000;

/** The Dreamer routine's one step: run (or skip) a single batched dream pass. */
export class DreamRecentMemoriesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const dreamer = getV7Dreamer();
    const run = dreamer.run({ trigger: input?.force === true ? 'manual' : 'routine', force: input?.force === true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), WAIT_FOR_DREAM_MS);
    });
    try {
      const result: DreamRunResult | null = await Promise.race([run, pending]);
      if (!result) {
        return { successBoolean: true, responseString: 'Dream still running in the background; its outcome will be in the [V7Dreamer] log line.' };
      }

      return {
        successBoolean: result.outcome !== 'failed',
        responseString: JSON.stringify(result),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
