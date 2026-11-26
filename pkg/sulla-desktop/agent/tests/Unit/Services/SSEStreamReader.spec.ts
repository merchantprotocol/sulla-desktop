// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { SSEStreamReader } from '../../../languagemodels/SSEStreamReader';

describe('SSE stream reading', () => {
  it('parses complete provider events', async() => {
    // risk: changes to shared provider parsing drop or corrupt valid model output.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\ndata: {"content":"ok"}\n\n'));
        controller.close();
      },
    });
    const events = [];
    for await (const event of new SSEStreamReader().read(body)) events.push(event);

    expect(events).toEqual([{ event: 'message', data: '{"content":"ok"}' }]);
  });

  it('cancels a pending read when its caller aborts', async() => {
    // risk: caller cancellation leaves the provider reader locked and its run stuck.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true } });
    const controller = new AbortController();
    const result = new SSEStreamReader().read(body, controller.signal).next().then(() => undefined, error => error);
    controller.abort(new DOMException('Operation aborted', 'AbortError'));

    const error = await result;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });
});
