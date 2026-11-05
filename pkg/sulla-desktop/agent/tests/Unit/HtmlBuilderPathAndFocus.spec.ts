// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync('pkg/sulla-desktop/pages/files/editor/html-builder/html-builder.js', 'utf8');
const context: { SullaHtmlBuilder?: { _test: Record<string, any> } } = {};
runInNewContext(source, context);
const internals = context.SullaHtmlBuilder!._test;

class FakeClassList {
  private values = new Set<string>();
  toggle(name: string, force?: boolean) { const next = force === undefined ? !this.values.has(name) : force; next ? this.values.add(name) : this.values.delete(name); return next; }
  contains(name: string) { return this.values.has(name); }
}
class FakeControl {
  classList = new FakeClassList();
  attributes = new Map<string, string>();
  title = '';
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}

describe('HTML viewer path and focus business logic', () => {
  it('resolves a Files-relative path and preserves the filename fallback', () => {
    const Presenter = internals.FilePathPresenter;
    expect(new Presenter({ filePath: '/mnt/sulla-files/Projects/site/index.html', fileName: 'fallback.html' }).resolve()).toBe('Projects/site/index.html');
    expect(new Presenter({ fileName: 'fallback.html' }).resolve()).toBe('fallback.html');
    expect(new Presenter().resolve()).toBe('untitled.html');
  });

  it('keeps focus state and all toolbar controls synchronized', () => {
    const Controller = internals.FocusModeController;
    const root = { classList: new FakeClassList() };
    const first = new FakeControl();
    const second = new FakeControl();
    const controller = new Controller({ root, controls: [first, second], toast: () => {}, redraw: () => {}, schedule: callback => callback() });
    controller.toggle();
    expect(root.classList.contains('focus')).toBe(true);
    expect(first.classList.contains('on')).toBe(true);
    expect(second.attributes.get('aria-pressed')).toBe('true');
    controller.toggle();
    expect(root.classList.contains('focus')).toBe(false);
    expect(first.title).toBe('Hide editing tools');
    expect(second.attributes.get('aria-pressed')).toBe('false');
  });

  it('selects a failure toast when copy fails and copies the full path on success', async () => {
    const Action = internals.PathCopyAction;
    const failureToasts: string[] = [];
    const failure = new Action({ clipboard: new internals.ClipboardService({ navigatorRef: null, documentRef: null }), toast: (message: string) => failureToasts.push(message) });
    expect(await failure.copy('Projects/site/index.html')).toBe(false);
    expect(failureToasts).toEqual(["Couldn't copy the path"]);

    let copiedPath = '';
    const successToasts: string[] = [];
    const success = new Action({ clipboard: new internals.ClipboardService({ navigatorRef: { clipboard: { writeText: async (value: string) => { copiedPath = value; } } }, documentRef: null }), toast: (message: string) => successToasts.push(message) });
    expect(await success.copy('Projects/site/index.html')).toBe(true);
    expect(copiedPath).toBe('Projects/site/index.html');
    expect(successToasts).toEqual(['Path copied']);
  });

});
