// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { TraceDisclosureController } from '@pkg/pages/chat/components/transcript/traceDisclosure';

describe('TraceDisclosureController', () => {
  it('opens and closes every payload without sharing state across controllers', () => {
    const first = new TraceDisclosureController();
    const second = new TraceDisclosureController();
    first.openAll();
    expect(first.isOpen('a')).toBe(true);
    expect(second.isOpen('a')).toBe(false);
    first.closeAll();
    expect(first.isOpen('a')).toBe(false);
  });

  it('keeps the other rows open when closing one payload in all-open mode', () => {
    const controller = new TraceDisclosureController();
    controller.toggle('a');
    expect(controller.isOpen('a')).toBe(true);
    controller.toggle('a');
    expect(controller.isOpen('a')).toBe(false);
    controller.openAll();
    controller.toggle('a');
    expect(controller.isOpen('a')).toBe(false);
    expect(controller.isOpen('b')).toBe(true);
    expect(controller.isAllOpen).toBe(true);
  });
});
