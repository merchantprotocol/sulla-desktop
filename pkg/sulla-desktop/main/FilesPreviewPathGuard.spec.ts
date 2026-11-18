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
  // risk: file access control — ".." must not climb out of the page's folder into siblings or parents.
  it.each(['../sibling/x.css', '../../x', '%2e%2e/x', '../../../etc/passwd'])('rejects escape %s from Projects/a/method', value => {
    expect(guard.resolve('Projects/a/method', value)).toBeNull();
  });
  // risk: file access control — nested files under the page folder remain allowed.
  it('allows sub/x.png inside Projects/a/method', () => {
    expect(guard.resolve('Projects/a/method', 'sub/x.png')).toBe('Projects/a/method/sub/x.png');
  });
  // risk: file access control — root '' means collection root; ".." still cannot leave it.
  it('treats empty root as the collection root and rejects leaving it', () => {
    expect(guard.resolve('', 'docs/x.html')).toBe('docs/x.html');
    expect(guard.resolve('', '../x.html')).toBeNull();
  });
});
