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

  it('toggles only the selected payload while other rows retain their state', () => {
    // risk: reviewing one payload collapses unrelated evidence.
    const controller = new TraceDisclosureController();
    controller.toggle('second');
    controller.toggle('first');
    controller.toggle('first');
    expect(controller.isOpen('first')).toBe(false);
    expect(controller.isOpen('second')).toBe(true);
    expect(controller.isOpen('new-row')).toBe(false);
  });
});
