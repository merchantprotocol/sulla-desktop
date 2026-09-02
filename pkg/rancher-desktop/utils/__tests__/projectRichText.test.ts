/** @jest-environment jsdom */
import { renderProjectRichText } from '../projectRichText';

describe('Projects rich-text rendering', () => {
  it('keeps the allowlisted document structure while removing executable content', () => {
    const rendered = renderProjectRichText('<h2 onclick="steal()">Review</h2>\n' +
      '<script>steal()</script>\n' +
      '<a href="javascript:steal()" data-secret="nope">unsafe</a>\n' +
      '<table><tr><th>Check</th><td>Passed</td></tr></table>');

    expect(rendered).toContain('<h2>Review</h2>');
    expect(rendered).toContain('<table>');
    expect(rendered).not.toMatch(/script|onclick|javascript:|data-secret/i);
  });

  it('renders ordinary Markdown and preserves malformed source as readable content', () => {
    expect(renderProjectRichText('**Passed**\n\n`sha`')).toContain('<strong>Passed</strong>');
    expect(renderProjectRichText('plain <broken & text')).toContain('plain');
  });
});
