/**
 * @jest-environment node
 *
 * Pure function under test — no DB, fs, or bridge deps, so the slug logic
 * (issue #43) is verified in isolation without mocking ProjectRegistry.
 */
import { describe, expect, it } from '@jest/globals';

import { slugify } from '../projectSlug';

describe('slugify (project slugs — issue #43)', () => {
  it('converts a spaced human name to kebab-case', () => {
    expect(slugify('Test Demo Alpha')).toBe('test-demo-alpha');
  });

  it('leaves an already-kebab name unchanged', () => {
    expect(slugify('my-cool-project')).toBe('my-cool-project');
  });

  it('collapses runs of whitespace and punctuation into single hyphens', () => {
    expect(slugify('Foo   Bar & Baz!!')).toBe('foo-bar-baz');
  });

  it('strips leading and trailing separators', () => {
    expect(slugify('  --Hello World--  ')).toBe('hello-world');
  });

  it('drops characters that are unsafe in file paths and URLs', () => {
    expect(slugify('Q1/2026 Report: v2')).toBe('q1-2026-report-v2');
  });

  it('falls back to a stable default when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('project');
    expect(slugify('')).toBe('project');
  });

  it('tolerates non-string input without throwing', () => {
    expect(slugify(undefined as unknown as string)).toBe('project');
    expect(slugify(null as unknown as string)).toBe('project');
  });
});
