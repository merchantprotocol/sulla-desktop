import { describe, expect, it } from '@jest/globals';

import { isTabCloseable, measureActiveTabIndicator } from '../tabStrip';

describe('AgentHeader active tab indicator', () => {
  it('follows the active tab real layout position and width', () => {
    const container = document.createElement('div');
    const first = document.createElement('a');
    const active = document.createElement('a');

    first.className = 'tab-item';
    active.className = 'tab-item';
    active.dataset.active = 'true';
    Object.defineProperty(active, 'offsetLeft', { value: 93 });
    Object.defineProperty(active, 'offsetWidth', { value: 136 });
    container.append(first, active);

    expect(measureActiveTabIndicator(container)).toEqual({ x: 93, width: 136 });

    first.dataset.active = 'true';
    delete active.dataset.active;
    Object.defineProperty(first, 'offsetLeft', { value: 0 });
    Object.defineProperty(first, 'offsetWidth', { value: 36 });

    expect(measureActiveTabIndicator(container)).toEqual({ x: 0, width: 36 });
  });

  it('never exposes close controls for pinned tabs', () => {
    expect(isTabCloseable(true)).toBe(false);
    expect(isTabCloseable(false)).toBe(true);
  });
});
