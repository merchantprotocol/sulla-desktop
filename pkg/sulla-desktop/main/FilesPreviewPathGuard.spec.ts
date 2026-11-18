// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { FilesPreviewPathGuard } from './FilesPreviewPathGuard';

describe('FilesPreviewPathGuard', () => {
  const guard = new FilesPreviewPathGuard();
  // risk: file access control — preview paths must stay inside the granted folder.
  it.each(['../secret.html', '%2e%2e/secret.html', '%2Fetc/passwd', 'C:%5csecret', 'a%5cb', 'bad%00name'])('rejects unsafe path %s', value => {
    expect(guard.resolve('site', value)).toBeNull();
  });
  // risk: file access control — legitimate nested assets remain available below the root.
  it('allows nested files inside the granted subtree', () => {
    expect(guard.resolve('site', 'assets/css/site.css')).toBe('site/assets/css/site.css');
  });
});
