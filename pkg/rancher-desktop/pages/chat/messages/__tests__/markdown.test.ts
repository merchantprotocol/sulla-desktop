import { renderMarkdown } from '../markdown';

describe('renderMarkdown', () => {
  it('routes ordinary Markdown links through the main-window tab handler', () => {
    const html = renderMarkdown('[Sulla](https://sulladesktop.com/docs)');
    const container = document.createElement('div');

    container.innerHTML = html;
    const anchor = container.querySelector('a');

    expect(anchor?.getAttribute('href')).toBe('https://sulladesktop.com/docs');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('makes local file links clickable without changing their target', () => {
    const html = renderMarkdown('[ChatPage](/workspace/sulla/ChatPage.vue:12)');
    const container = document.createElement('div');

    container.innerHTML = html;
    const anchor = container.querySelector('a');

    expect(anchor?.getAttribute('href')).toBe('/workspace/sulla/ChatPage.vue:12');
    expect(anchor?.getAttribute('target')).toBe('_blank');
  });

  it('still strips unsafe link protocols', () => {
    const html = renderMarkdown('[unsafe](javascript:alert(1))');
    const container = document.createElement('div');

    container.innerHTML = html;

    expect(container.querySelector('a')?.hasAttribute('href')).toBe(false);
  });
});
