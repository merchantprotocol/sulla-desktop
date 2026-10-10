const TASK_RE = /^(\s*[-*+]\s+\[)( |x|X)(\])/gm;

export function toggleMarkdownTask(markdown: string, index: number, checked: boolean): string {
  let current = -1;

  return markdown.replace(TASK_RE, (match, start: string, _mark: string, end: string) => {
    current += 1;
    return current === index ? `${ start }${ checked ? 'x' : ' ' }${ end }` : match;
  });
}
