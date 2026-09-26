import { describe, expect, it } from '@jest/globals';

import { resolveToolArgument } from '../WorkflowPlaybook';
describe('native workflow tool arguments', () => {
  it('interpolates nested strings without losing JSON types or mutating inputs', () => {
    const input = { tool: 'tab', args: { url: '{{trigger}}', active: false, retries: 3, optional: null, list: ['{{trigger}}', true, 0] } };
    expect(resolveToolArgument(input, 'about:blank', {}, [])).toEqual({ tool: 'tab', args: { url: 'about:blank', active: false, retries: 3, optional: null, list: ['about:blank', true, 0] } });
    expect(input.args.url).toBe('{{trigger}}');
  });
  it.each([null, false, true, 0, 3, undefined])('preserves scalar %p', value => {
    expect(resolveToolArgument(value, '', {}, [])).toBe(value);
  });
  it('keeps unresolved strings intact', () => {
    expect(resolveToolArgument('prefix {{missing}}', '', {}, [])).toBe('prefix {{missing}}');
  });
});
