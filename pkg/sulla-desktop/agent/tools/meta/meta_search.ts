// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { hasContainerFileRuntime, searchContainerPaths, searchGuestPaths } from '../util/containerFileRuntime';

/** Full-text search is always executed in the agent container or Sulla guest. */
export class MetaSearchWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const { query, limit } = input;
    const includeSullaKnowledge = input.includeSullaKnowledge !== undefined
      ? input.includeSullaKnowledge !== false
      : input.includeSullaDocs !== false;
    const dirPath = input.dirPath || '~';

    if (!query) return { successBoolean: false, responseString: 'Missing required field: query' };

    try {
      const operation = hasContainerFileRuntime() ? searchContainerPaths : searchGuestPaths;
      const { roots, results } = await operation({ query, dirPath, limit, includeSullaKnowledge });
      if (!results.length) return { successBoolean: true, responseString: `No results found for "${ query }" in ${ roots.join(' and ') }` };
      const primary = results.filter(result => !result.knowledge);
      const knowledge = results.filter(result => result.knowledge);
      const render = (items:typeof results) => items.map((result, index) => [
        `${ index + 1 }. ${ result.path }`,
        result.line ? `   Line ${ result.line }` : '',
        result.preview ? `   ${ result.preview }` : '',
      ].filter(Boolean).join('\n')).join('\n\n');
      const sections = [`Found ${ results.length } result(s) for "${ query }":`];
      if (primary.length) sections.push(`\n## Results in ${ roots[0] } (${ primary.length })\n${ render(primary) }`);
      if (knowledge.length) sections.push(`\n## Results in bundled memory seed — /opt/sulla-memory-seed (${ knowledge.length })\n${ render(knowledge) }`);

      return { successBoolean: true, responseString: sections.join('\n') };
    } catch (error) {
      return { successBoolean: false, responseString: `Guest search failed: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
