// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  CliFaultError, CliHandoffFailure, CliRecoveryExhaustedError, markSullaInternalFault, runWithCliFaultRecovery,
} from '../cliFaultRecovery';
import { classifyLLMFailure } from '../providerRecovery';

const run = (makeError: () => Error) => runWithCliFaultRecovery('Claude Code', () => Promise.reject(makeError()), {
  canRetry:  () => true,
  backoffMs: 0,
});

describe('CLI recovery after a background-task handoff', () => {
  it('exhausted handoff faults are Sulla infrastructure, not the provider failing', async() => {
    const error = await run(() => markSullaInternalFault(new CliFaultError('process_exit', 'Claude Code: claude exited with code 137'))).catch(e => e);

    expect(error).toBeInstanceOf(CliHandoffFailure);
    expect(error.message).not.toMatch(/claude/i);
    expect(classifyLLMFailure(error).kind).toBe('infrastructure');
  });

  it('ordinary exhausted CLI faults keep their provider classification', async() => {
    const error = await run(() => new CliFaultError('process_exit', 'Claude Code: claude exited with code 1')).catch(e => e);

    expect(error).toBeInstanceOf(CliRecoveryExhaustedError);
    expect(classifyLLMFailure(error).kind).toBe('unavailable');
  });

  it('a handoff fault that is not retried is still classified as infrastructure', () => {
    const fault = markSullaInternalFault(new CliFaultError('spawn', 'Claude Code process error: EPIPE.', undefined, false));

    expect(classifyLLMFailure(fault).kind).toBe('infrastructure');
  });

  it('an intentional stop is never retried', async() => {
    const controller = new AbortController();
    let attempts = 0;
    const result = runWithCliFaultRecovery('Claude Code', () => {
      attempts++;
      controller.abort();
      return Promise.reject(markSullaInternalFault(new CliFaultError('process_exit', 'killed')));
    }, { signal: controller.signal, canRetry: () => true, backoffMs: 0 });

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toBe(1);
  });
});
