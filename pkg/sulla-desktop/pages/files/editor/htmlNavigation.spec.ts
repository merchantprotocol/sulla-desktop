/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { HtmlNavigation } from './htmlNavigation';

describe('HtmlNavigation',()=>{
  it('classifies browser, local and safe non-file schemes',()=>{
    const nav=new HtmlNavigation();
    expect(nav.classify('#section')).toBe('hash');
    expect(nav.classify('page.html?x=1#y')).toBe('relative');
    expect(nav.classify('https://example.com')).toBe('external');
    expect(nav.classify('mailto:a@example.com')).toBe('mailto');
    expect(nav.classify('tel:+15551234567')).toBe('tel');
  });
  it('normalizes relative traversal and drops query/hash',()=>{
    const nav=new HtmlNavigation();
    expect(nav.resolve('one/two/a.html','../other/./b.html?x=1#y')).toBe('one/other/b.html');
    expect(nav.resolve('folder/a.html','../other/./b.html?x=1#y')).toBe('other/b.html');
    expect(nav.resolve('folder/a.html','page.html?x=1#y')).toBe('folder/page.html');
  });
  it('refuses traversal above collection root',()=>{
    expect(new HtmlNavigation().resolve('a.html','../secret.html')).toBeNull();
  });
  it('returns null when backing up from the start',()=>{
    const nav=new HtmlNavigation();
    expect(nav.back()).toBeNull();
    nav.push('a.html');
    expect(nav.back()).toBeNull();
  });
  it('supports back and forward, then truncates forward history after new navigation',()=>{
    const nav=new HtmlNavigation();
    nav.push('a.html');nav.push('b.html');nav.push('c.html');
    expect(nav.back()).toBe('b.html');
    expect(nav.back()).toBe('a.html');
    expect(nav.forward()).toBe('b.html');
    nav.push('d.html');
    expect(nav.canForward).toBe(false);
    expect(nav.forward()).toBeNull();
    expect(nav.back()).toBe('b.html');
  });
});
