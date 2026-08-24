import { readFileSync } from 'node:fs';

import { describe, expect, it } from '@jest/globals';
import { compileScript, parse } from '@vue/compiler-sfc';

const root = 'pkg/rancher-desktop/components';

function load(name: string) {
  const filename = `${ root }/${ name }`;
  const source = readFileSync(filename, 'utf8');
  const parsed = parse(source, { filename });
  if (parsed.errors.length) throw parsed.errors[0];
  compileScript(parsed.descriptor, { id: filename });
  return source;
}

describe('Knowledge Base and Projects UI contracts', () => {
  it('compiles the work-item panel and protects inherited links from detach', () => {
    const source = load('KnowledgeLinksPanel.vue');
    expect(source).toContain("link.scope === 'direct'");
    expect(source).toContain('from {{ link.linked_item_kind }} {{ link.linked_item_title }}');
    expect(source).toContain('listKnowledgeForItem');
    expect(source).toContain('unlinkKnowledgeItem');
  });

  it('compiles the reverse panel with ancestry, attribution, attach, and navigation', () => {
    const source = load('KnowledgeBrowserPanel.vue');
    expect(source).toContain('Related work');
    expect(source).toContain('project_title');
    expect(source).toContain('created_by');
    expect(source).toContain("$emit('open-work', item)");
    expect(source).toContain('linkKnowledgeItem');
  });
});
