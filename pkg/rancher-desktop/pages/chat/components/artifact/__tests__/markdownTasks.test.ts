import { toggleMarkdownTask } from '../markdownTasks';

describe('toggleMarkdownTask', () => {
  test('toggles only the selected GitHub task-list checkbox', () => {
    const markdown = ['# Plan', '- [ ] first', '- [x] second', '  - [ ] nested'].join('\n');

    expect(toggleMarkdownTask(markdown, 2, true)).toBe(
      ['# Plan', '- [ ] first', '- [x] second', '  - [x] nested'].join('\n'),
    );
    expect(toggleMarkdownTask(markdown, 1, false)).toBe(
      ['# Plan', '- [ ] first', '- [ ] second', '  - [ ] nested'].join('\n'),
    );
  });
});
