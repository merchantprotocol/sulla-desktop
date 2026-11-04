// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class MemoryToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  add_observational_memory(args, result) {
    const content = text.string(args.content);
    const output = text.extractOutput(result);
    return {
      label:   'Memory',
      summary: content ? `Remembering: "${ text.truncate(content, 60) }"` : 'Remembering observation',
      output:  output || undefined,
    };
  },
  remove_observational_memory(args, result) {
    const id = text.string(args.id);
    const output = text.extractOutput(result);
    // The result contains the content of what was forgotten
    const content = output?.match(/Forgetting:\s*"(.+?)"/)?.[1];
    return {
      label:   'Memory',
      summary: content ? `Forgetting: "${ text.truncate(content, 60) }"` : `Forgetting observation ${ id }`,
      output:  output || undefined,
    };
  },
    });
  }
}
