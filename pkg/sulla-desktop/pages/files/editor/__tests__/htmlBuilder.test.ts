// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Invariants of the shared HTML editor core (also vendored into Sulla Cloud):
// source fidelity, element-to-source mapping, and the iframe security policy.
import '../html-builder/html-builder.js';

interface HtmlNode {
  name:       string;
  start:      number;
  openEnd:    number;
  closeStart: number;
  end:        number;
  children:   HtmlNode[];
}

interface Diagnostic { type: string }

interface CoreTestApi {
  tokenize(source: string): { roots: HtmlNode[]; all: HtmlNode[]; diagnostics: Diagnostic[] };
  patchSource(source: string, from: number, to: number, replacement: string): string;
  sandboxFor(run: boolean): string;
  previewPolicy(editing: boolean, canRunScripts?: boolean): { run: boolean; sandbox: string };
}

const builder = (globalThis as any).SullaHtmlBuilder;
const core: CoreTestApi = builder._test;

describe('HTML builder: source fidelity', () => {
  it('patches only the target byte range and leaves every other byte unchanged', () => {
    const before = '<!doctype html>\r\n<p data-x="é">old</p>\n<!--tail-->\n';
    const node = core.tokenize(before).all.find(n => n.name === 'p')!;
    const after = core.patchSource(before, node.openEnd, node.closeStart, 'new & exact');

    expect(after.slice(0, node.openEnd)).toBe(before.slice(0, node.openEnd));
    expect(after.slice(node.openEnd + 'new & exact'.length)).toBe(before.slice(node.closeStart));
  });

  it('undo restores the file byte-for-byte after an edit made in the editor', () => {
    const source = '<!doctype html>\r\n<html><body>\n  <h1 class="t">Title</h1>\n  <p>Body é</p>\n</body></html>\n';
    const changes: string[] = [];
    const host = document.createElement('div');

    document.body.append(host);
    const editor = builder.mount(host, { source, fileName: 'test.html', onChange: (v: string) => changes.push(v) });
    const textarea = host.querySelector('#ta') as HTMLTextAreaElement;

    textarea.value = source.replace('Title', 'Changed title');
    textarea.dispatchEvent(new Event('input'));
    expect(changes.at(-1)).toBe(source.replace('Title', 'Changed title'));

    (host.querySelector('#bUndo') as HTMLButtonElement).click();
    expect(changes.at(-1)).toBe(source);
    editor.destroy();
    host.remove();
  });
});

describe('HTML builder: element to source mapping', () => {
  it('maps nested same-name tags, voids, raw text, comments and quoted > attributes', () => {
    const source = '<div data-x=">"><div>A<img src="x"><script>if(a<b){x="</div>"}</script>' +
      '<!-- <div> --><style>.x:before{content:">"}</style></div><br></div>';
    const { all } = core.tokenize(source);
    const divs = all.filter(n => n.name === 'div');
    const img = all.find(n => n.name === 'img')!;
    const br = all.find(n => n.name === 'br')!;

    expect(divs).toHaveLength(2);
    expect(source.slice(divs[0].start, divs[0].end)).toBe(source);
    expect(source.slice(divs[1].start, divs[1].end)).toContain('<script>if(a<b){x="</div>"}</script>');
    expect(img.end).toBe(img.openEnd);
    expect(br.end).toBe(br.openEnd);
  });

  it('reports structural and accessibility problems from the real markup', () => {
    const types = core.tokenize('<main id="same"><img><p id="same"></main></aside>').diagnostics.map(d => d.type);

    expect(types).toEqual(expect.arrayContaining([
      'img-missing-alt', 'duplicate-id', 'mismatched-closing-tag', 'unclosed-tag', 'stray-closing-tag',
    ]));
  });
});

describe('HTML builder: iframe security policy', () => {
  it('edit and run sandboxes are mutually exclusive', () => {
    expect(core.sandboxFor(false)).toBe('allow-same-origin');
    expect(core.sandboxFor(false)).not.toContain('allow-scripts');
    expect(core.sandboxFor(true)).toBe('allow-scripts allow-forms allow-popups allow-modals');
    expect(core.sandboxFor(true)).not.toContain('allow-same-origin');
  });

  it('never grants scripts while editing, and never on hosts that cannot run them', () => {
    expect(core.previewPolicy(true, true)).toEqual({ run: false, sandbox: 'allow-same-origin' });
    expect(core.previewPolicy(true, false)).toEqual({ run: false, sandbox: 'allow-same-origin' });
    expect(core.previewPolicy(false, false)).toEqual({ run: false, sandbox: 'allow-same-origin' });
    expect(core.previewPolicy(false, true).sandbox).not.toContain('allow-same-origin');
  });

  it('renders no host actions when every optional callback is absent', () => {
    const host = document.createElement('div');

    document.body.append(host);
    const editor = builder.mount(host, {
      source:   '<!doctype html><html><head><title>Test</title></head><body><h1>Test</h1></body></html>',
      fileName: 'test.html',
    });

    expect(host.querySelector('#back')).toBeNull();
    expect(host.querySelector('#bHist')).toBeNull();
    expect(host.querySelector('#pOpen')).toBeNull();
    expect(host.querySelector('#fname')?.tagName).toBe('SPAN');
    expect(host.querySelector('[data-m="Sulla"]')).toBeNull();
    for (const menu of host.querySelectorAll<HTMLButtonElement>('[data-m]')) {
      menu.click();
      expect(host.querySelector('#drop')?.textContent).not.toMatch(
        /Rename|Version history|Share|Open in Sulla browser|Ask Sulla|New HTML file|Open…/);
    }
    editor.destroy();
    host.remove();
  });
});
