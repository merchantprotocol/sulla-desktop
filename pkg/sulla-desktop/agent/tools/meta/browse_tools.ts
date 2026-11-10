// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { toolRegistry } from '../registry';
import { IntegrationCredentialStatus, LazyIntegrationIdSource } from './IntegrationCredentialStatus';
import { ToolCatalogIndex } from './ToolCatalogIndex';
import { ToolSearchRanker } from './ToolSearchRanker';

/**
 * BrowseToolsWorker — read-only tool discovery.
 *
 * Returns ready-to-run `sulla <category>/<tool>` CLI invocations plus an
 * explicit reminder that these commands must be dispatched through a shell
 * tool — `exec` in the Sulla VM runtime, or the generic `Bash` tool on
 * surfaces (e.g. this Claude Code MCP bridge) that don't carry a
 * Sulla-branded exec — models routinely forget this and dead-end in a "how
 * do I call this" loop.
 *
 * Never blocks on credentials: query mode never looks them up, and the other
 * modes wait at most the credential status timeout.
 */

const CATEGORY_TO_INTEGRATION: Record<string, string> = {
  slack:    'slack',
  github:   'github',
  calendar: 'google-calendar',
  pg:       'postgresql',
  redis:    'redis',
  chrome:   'chrome',
};

/**
 * Preamble prepended to every non-error response.
 * MUST NOT contain the word "Example:" (meta-category test forbids it) or
 * any concrete category name used in other tests (e.g. "docker") — keep the
 * wording generic with `<category>/<tool>` placeholders only.
 */
const INVOCATION_PREAMBLE = [
  'HOW TO CALL: every entry below is a shell command. Dispatch it through',
  'your `exec` tool if you have one, or plain `Bash` if that is what your',
  'surface provides — do NOT try to call `sulla` as if it were a tool name.',
  '',
  '  exec({ command: "sulla <category>/<tool> \'<json-args>\'" })',
  '  Bash({ command: "sulla <category>/<tool> \'<json-args>\'" })',
  '',
  'CRITICAL — avoid this common failure mode:',
  '  ❌ WRONG: execute_workflow({ workflowId: "..." })  ← always fails, this is not how tools work',
  '  ✅ RIGHT: exec/Bash ({ command: "sulla <category>/<tool> \'<json-args>\'" })',
  '',
  'execute_workflow is ONLY for named Sulla routines/workflows. It is NEVER the',
  'correct dispatch method for tools listed here.',
  '',
  'The JSON payload shown on each line is ready to copy-paste into that',
  'command string. Required params appear inline with `<placeholder>` values.',
].join('\n');

export interface BrowseToolsDependencies {
  catalog?:     ToolCatalogIndex;
  credentials?: IntegrationCredentialStatus;
  ranker?:      ToolSearchRanker;
}

export class BrowseToolsWorker extends BaseTool {
  name = '';
  description = '';

  private readonly catalog: ToolCatalogIndex;
  private readonly credentials: IntegrationCredentialStatus;
  private readonly ranker: ToolSearchRanker;

  constructor(deps: BrowseToolsDependencies = {}) {
    super();
    this.catalog = deps.catalog ?? new ToolCatalogIndex(toolRegistry);
    this.credentials = deps.credentials ?? new IntegrationCredentialStatus(new LazyIntegrationIdSource());
    this.ranker = deps.ranker ?? new ToolSearchRanker();
  }

  // ────────────────────────────────────────────────────────────────
  // Main execution
  // ────────────────────────────────────────────────────────────────

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { category, query } = input;

    if (query) return this.searchTools(query as string);
    if (category) return this.describeCategory(category as string);
    return this.listCategories();
  }

  /** Query mode: ranked keyword search. No credential lookup. */
  private searchTools(query: string): ToolResponse {
    const allCategories = this.catalog.categories();
    const matches = this.ranker.rank(this.catalog.allEntries(), query);
    if (matches.length === 0) {
      return {
        successBoolean: false,
        responseString: `No tools found matching "${ query }". Available categories: ${ allCategories.join(', ') }`,
      };
    }

    const matchedLines: string[] = [];
    let currentCategory = '';
    for (const match of matches) {
      if (match.category !== currentCategory) {
        currentCategory = match.category;
        matchedLines.push('', `## ${ currentCategory }`);
      }
      matchedLines.push(match.line);
    }
    return {
      successBoolean: true,
      responseString: `${ INVOCATION_PREAMBLE }\n\nFound ${ matches.length } tools matching "${ query }":\n${ matchedLines.join('\n') }`,
    };
  }

  /** Category mode: one category in detail. */
  private async describeCategory(category: string): Promise<ToolResponse> {
    const allCategories = this.catalog.categories();
    if (!allCategories.includes(category)) {
      return {
        successBoolean: false,
        responseString: `Invalid category "${ category }". Available categories: ${ allCategories.join(', ') }`,
      };
    }

    const catDesc = toolRegistry.getCategoriesWithDescriptions().find(c => c.category === category)?.description || '';
    const integSlug = CATEGORY_TO_INTEGRATION[category];
    const connected = integSlug ? (await this.credentials.stateFor(integSlug)) === 'connected' : false;

    const lines: string[] = [];
    // The meta category must NOT emit the word "Example:" — that marks meta tools
    // as directly callable. The preamble is omitted for meta for the same reason.
    if (category !== 'meta') {
      lines.push(INVOCATION_PREAMBLE);
      lines.push('');
    }
    lines.push(`## ${ category }${ connected ? ' ✓ credentials connected' : '' }`);
    if (catDesc) lines.push(catDesc);
    lines.push('');
    for (const entry of this.catalog.entriesFor(category)) {
      lines.push(entry.line);
    }
    return { successBoolean: true, responseString: lines.join('\n').trim() };
  }

  /** Default mode: category list only. */
  private async listCategories(): Promise<ToolResponse> {
    const connectedIntegrations = await this.credentials.connectedIntegrations();
    const catDescs = toolRegistry.getCategoriesWithDescriptions();
    const lines: string[] = [];
    lines.push(INVOCATION_PREAMBLE);
    lines.push('');
    lines.push('## Available Tool Categories');
    lines.push('');
    for (const cat of this.catalog.categories()) {
      const count = this.catalog.entriesFor(cat).length;
      const catDesc = catDescs.find(c => c.category === cat)?.description || '';
      const integSlug = CATEGORY_TO_INTEGRATION[cat];
      const connected = Boolean(integSlug && connectedIntegrations?.has(integSlug));
      const badge = connected ? ' ✓ credentials connected' : '';
      lines.push(`- ${ cat } (${ count } tools)${ badge } — ${ catDesc }`);
    }
    lines.push('');
    lines.push('Call browse_tools with a category or query to see individual tools and their exec invocations.');

    return {
      successBoolean: true,
      responseString: lines.join('\n'),
    };
  }
}
