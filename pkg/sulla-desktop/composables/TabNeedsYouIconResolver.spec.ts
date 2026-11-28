// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { TabNeedsYouIconResolver } from './TabNeedsYouIconResolver';

describe('needs-you tab icon', () => {
  it('uses the alert while the user is needed and restores the tab icon afterward', () => {
    // risk: status accuracy — stale needs-you state must not hide the tab's real identity.
    const resolver = new TabNeedsYouIconResolver();

    expect(resolver.resolve('chat', 'you', 'chat-icon-path')).toEqual({ kind: 'alert' });
    expect(resolver.resolve('chat', 'working', 'chat-icon-path')).toEqual({ kind: 'standard', path: 'chat-icon-path' });
    expect(resolver.resolve('browser', 'you', 'browser-icon-path')).toEqual({ kind: 'standard', path: 'browser-icon-path' });
    expect(resolver.resolve('browser', undefined, 'browser-icon-path')).toEqual({ kind: 'standard', path: 'browser-icon-path' });
  });
});
