// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { TraceDisclosureController } from '@pkg/pages/chat/components/transcript/traceDisclosure';

describe('TraceDisclosureController', () => {
  it('keeps payload disclosure state isolated per transcript', () => {
    const first = new TraceDisclosureController();
    const second = new TraceDisclosureController();
    first.toggle('a');
    expect(first.isOpen('a')).toBe(true);
    expect(second.isOpen('a')).toBe(false);
    first.toggle('a');
    expect(first.isOpen('a')).toBe(false);
  });

  it('opens and closes only the selected payload', () => {
    const controller = new TraceDisclosureController();
    controller.toggle('a');
    controller.toggle('b');
    expect(controller.isOpen('a')).toBe(true);
    expect(controller.isOpen('b')).toBe(true);
    controller.toggle('a');
    expect(controller.isOpen('a')).toBe(false);
    expect(controller.isOpen('b')).toBe(true);
  });
});
