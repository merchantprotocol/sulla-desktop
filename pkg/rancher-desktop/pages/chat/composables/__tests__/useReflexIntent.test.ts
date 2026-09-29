import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: jest.fn() } }));

// eslint-disable-next-line import/first
import { isPreviewableDraft } from '../useReflexIntent';

describe('isPreviewableDraft', () => {
  it('previews short single-line requests', () => {
    expect(isPreviewableDraft('open projects')).toBe(true);
  });

  it('skips tiny, slash, mention, quoted, multi-line, and very long drafts', () => {
    expect(isPreviewableDraft('op')).toBe(false);
    expect(isPreviewableDraft('/help')).toBe(false);
    expect(isPreviewableDraft('@routine run it')).toBe(false);
    expect(isPreviewableDraft('> quoted reply')).toBe(false);
    expect(isPreviewableDraft('open projects\nand then')).toBe(false);
    expect(isPreviewableDraft('open '.repeat(80))).toBe(false);
  });
});
