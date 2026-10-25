import { describe, expect, test } from '@jest/globals';

import { commandExecutionTarget } from '../CommandRunner';

describe('CommandRunner container boundary', () => {
  test('a bound container cannot be overridden by the legacy guest flag', () => {
    expect(commandExecutionTarget(true, false)).toBe('container');
    expect(commandExecutionTarget(true, true)).toBe('container');
    expect(commandExecutionTarget(false, true)).toBe('vm');
  });
});
