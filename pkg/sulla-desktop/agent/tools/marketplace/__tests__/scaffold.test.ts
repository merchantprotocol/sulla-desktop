import yaml from 'yaml';

import { generateSkeleton } from '../scaffold';

const context = {
  slug: 'yaml-fixture',
  name: 'A name: with a colon',
  description: 'A description: with a colon',
  runtime: 'python',
  memoryPack: true,
};

function parseFrontmatter(document: string): unknown {
  const match = document.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('Expected YAML frontmatter');
  return yaml.parse(match[1]);
}

test.each([
  ['skill', () => parseFrontmatter(generateSkeleton('skill', context)['SKILL.md'])],
  ['function', () => yaml.parse(generateSkeleton('function', context)['function.yaml'])],
  ['workflow', () => yaml.parse(generateSkeleton('workflow', context)['routine.yaml'])],
  ['agent', () => yaml.parse(generateSkeleton('agent', context)['config.yaml'])],
  ['recipe', () => yaml.parse(generateSkeleton('recipe', context)['installation.yaml'])],
  ['integration', () => yaml.parse(generateSkeleton('integration', context)['yaml-fixture.v1-auth.yaml'])],
])('scaffolds %s with parseable YAML', (_kind: string, parse: () => unknown) => {
  expect(parse()).toBeTruthy();
});
