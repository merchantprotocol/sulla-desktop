import { describe, expect, it } from '@jest/globals';

import { reflexActionLabel } from '../reflexLabels';

describe('reflexActionLabel', () => {
  it('names built-in views', () => {
    expect(reflexActionLabel('open_tab', { mode: 'projects' })).toBe('Open Projects');
    expect(reflexActionLabel('open_tab', { mode: 'agents' })).toBe('Open Agents');
  });

  it('uses the host for URLs and handles closing tabs', () => {
    expect(reflexActionLabel('tab', { action: 'upsert', url: 'https://github.com/x' })).toBe('Open github.com');
    expect(reflexActionLabel('tab', { action: 'remove' })).toBe('Close tab');
  });

  it('falls back to a title-cased tool name plus a short string param', () => {
    expect(reflexActionLabel('teleprompter_open', {})).toBe('Teleprompter Open');
    expect(reflexActionLabel('recorder_start', { screen: 'true' })).toBe('Recorder Start: true');
  });
});
