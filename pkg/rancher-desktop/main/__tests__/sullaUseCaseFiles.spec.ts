import { activePublishedVersion } from '../sullaUseCaseFiles';

describe('Files-backed use cases', () => {
  it('activates only the published version, never the current draft', () => {
    expect(activePublishedVersion({
      id: 'file-1', path: 'Use Cases/skills/example/SKILL.md',
      published_version_id: 'published-v1',
      current_version_id: 'private-draft-v2',
    } as any)).toBe('published-v1');
    expect(activePublishedVersion({ id: 'file-2', path: 'Use Cases/skills/draft/SKILL.md' } as any)).toBeNull();
  });
});
