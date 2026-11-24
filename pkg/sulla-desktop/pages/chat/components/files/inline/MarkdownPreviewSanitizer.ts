// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { renderMarkdown } from '../../../messages/markdown';

/** Reuses chat's marked + DOMPurify policy and removes resource-bearing markup before display. */
export class MarkdownPreviewSanitizer {
  constructor(private readonly renderer: (markdown: string) => string = renderMarkdown) {}

  render(markdown: string): string {
    const template = document.createElement('template');
    template.innerHTML = this.renderer(markdown);
    template.content.querySelectorAll('img, audio, video, source, track, iframe, object, embed').forEach(element => element.remove());
    return template.innerHTML;
  }
}
