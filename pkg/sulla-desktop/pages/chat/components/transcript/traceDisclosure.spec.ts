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
});
