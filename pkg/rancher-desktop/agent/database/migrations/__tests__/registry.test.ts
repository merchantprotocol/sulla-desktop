/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { migrationsRegistry } from '..';

describe('migrationsRegistry', () => {
  it('assigns every migration a unique numeric slot in ascending order', () => {
    const slots = migrationsRegistry.map(({ name }) => name.slice(0, 4));
    const sorted = [...slots].sort((a, b) => Number(a) - Number(b));

    expect(new Set(slots).size).toBe(slots.length);
    expect(slots).toEqual(sorted);
  });
});
