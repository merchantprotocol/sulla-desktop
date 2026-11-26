// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { ModelRecoveryPolicy } from '../../../languagemodels/ModelRecoveryPolicy';
import { classifyLLMFailure } from '../../../languagemodels/providerRecovery';
import { SSEStreamIdleTimeoutError, SSEStreamReader } from '../../../languagemodels/SSEStreamReader';

describe('SSE stream idle reads', () => {
  it('turns a dead open socket into a retryable provider timeout and cancels its reader', async() => {
    // risk: a dead SSE socket leaves a model run hung forever; a retryable timeout resumes the model loop.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true } });
    const result = new SSEStreamReader(10).read(body).next().then(() => undefined, error => error);

    const error = await result;
    expect(error).toBeInstanceOf(SSEStreamIdleTimeoutError);
    expect(error).toMatchObject({ code: 'SSE_STREAM_IDLE_TIMEOUT', retrySafe: true, unsafeToFallback: false });
    const recovery = classifyLLMFailure(error);
    expect(recovery).toMatchObject({ kind: 'timeout', retryPrimary: true, fallbackAllowed: true });
    expect(new ModelRecoveryPolicy().additionalAttempts(recovery)).toBe(2);
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it('parses a complete provider event before the idle deadline', async() => {
    // risk: the network guard corrupts normal SSE events and turns valid model output into retries.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\ndata: {"content":"ok"}\n\n'));
        controller.close();
      },
    });
    const events = [];
    for await (const event of new SSEStreamReader(100).read(body)) events.push(event);

    expect(events).toEqual([{ event: 'message', data: '{"content":"ok"}' }]);
  });
});
