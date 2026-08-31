import { describe, expect, it } from '@jest/globals';

import { ConveyorHealthWorker } from '../conveyor_health';

describe('ConveyorHealthWorker', () => {
  it('is a BaseTool with a validated-call implementation', () => {
    expect(typeof ConveyorHealthWorker).toBe('function');
    expect(typeof (ConveyorHealthWorker.prototype as any)._validatedCall).toBe('function');
  });
});
