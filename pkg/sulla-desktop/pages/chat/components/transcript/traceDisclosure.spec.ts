// SPDX-License-Identifier: GPL-2.0-or-later
import { computed } from 'vue';
import { describe, expect, it } from 'vitest';
import { TraceDisclosureController } from './traceDisclosure';

describe('TraceDisclosureController', () => {
  it('updates Vue computed readers when a row is toggled', () => {
    const controller = new TraceDisclosureController();
    const open = computed(() => controller.isOpen('row'));
    expect(open.value).toBe(false);
    controller.toggle('row');
    expect(open.value).toBe(true);
    controller.toggle('row');
    expect(open.value).toBe(false);
  });

  it('closes just one payload in all-open mode and resets exceptions on bulk changes', () => {
    // risk: reviewing one payload collapses unrelated evidence.
    const controller = new TraceDisclosureController();
    controller.openAll();
    controller.toggle('first');
    expect(controller.isOpen('first')).toBe(false);
    expect(controller.isOpen('second')).toBe(true);
    expect(controller.isOpen('new-row')).toBe(true);
    controller.toggle('first');
    expect(controller.isOpen('first')).toBe(true);
    controller.toggle('first');
    controller.openAll();
    expect(controller.isOpen('first')).toBe(true);
    controller.toggleAll();
    expect(controller.isOpen('first')).toBe(false);
    expect(controller.isOpen('second')).toBe(false);
  });
});
