import { BaseTool, ToolResponse } from '../base';
import { toolRegistry } from '../registry';

/**
 * BrowseToolsWorker — read-only tool discovery.
 *
 * Returns ready-to-run `sulla <category>/<tool>` CLI invocations plus an
 * explicit reminder that these commands must be dispatched through the
 * `exec` tool (models routinely forget this and dead-end in a "how do I
 * call this" loop).
 */

/** Tools excluded from the listing — internal plumbing the agent already has */
const EXCLUDED_TOOLS = new Set([
  'file_search',
  'read_file',
  'write_file',
  'browse_tools',
]);

const CATEGORY_TO_INTEGRATION: Record<string, string> = {
  slack:    'slack',
  github:   'github',
  calendar: 'google-calendar',
  n8n:      'n8n',
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
  'your `exec` tool — do NOT try to call `sulla` as if it were a tool name.',
  '',
  '  exec({ command: "sulla <category>/<tool> \'<json-args>\'" })',
  '',
  'CRITICAL — avoid this common failure mode:',
  '  ❌ WRONG: execute_workflow({ workflowId: "..." })  ← always fails, this is not how tools work',
  '  ✅ RIGHT: exec({ command: "sulla <category>/<tool> \'<json-args>\'" })',
  '',
  'execute_workflow is ONLY for named Sulla routines/workflows. It is NEVER the',
  'correct dispatch method for tools listed here.',
  '',
  'The JSON payload shown on each line is ready to copy-paste into that',
  'command string. Required params appear inline with `<placeholder>` values.',
].join('\n');

export class BrowseToolsWorker extends BaseTool {
  name = '';
  description = '';

  // ────────────────────────────────────────────────────────────────
  // Formatting helpers
  // ────────────────────────────────────────────────────────────────

  private toCliName(toolName: string, category: string): string {
    const endpoint = toolName.startsWith(`${ category }_`)
      ? toolName.slice(category.length + 1)
      : toolName;
    return `${ category }/${ endpoint }`;
  }

  /** Build a JSON payload showing only required fields with `<paramname>` placeholders. */
  private buildArgsJson(schemaDef: Record<string, any> | undefined): string {
    if (!schemaDef) return '{}';
    const required = Object.entries(schemaDef).filter(([, spec]) => !spec.optional);
    if (required.length === 0) return '{}';
    const parts = required.map(([key]) => `"${ key }":"<${ key }>"`);
    return `{${ parts.join(',') }}`;
  }

  private formatParams(schemaDef: Record<string, any>): string {
    const parts: string[] = [];
    for (const [key, spec] of Object.entries(schemaDef)) {
      const req = spec.optional ? 'optional' : 'required';
      const type = spec.type === 'enum'
        ? `enum: ${ (spec.enum || []).join('|') }`
        : spec.type;
      parts.push(`${ key } (${ req }, ${ type })`);
    }
    return parts.join(', ');
  }

  private formatToolLine(toolName: string, category: string): string {
    const description = toolRegistry.getToolDescription(toolName);
    const schemaDef = toolRegistry.getSchemaDef(toolName);
    const cliName = this.toCliName(toolName, category);
    const argsJson = this.buildArgsJson(schemaDef);
    const lines: string[] = [];

    lines.push(`  sulla ${ cliName } '${ argsJson }'`);
    if (description) {
      lines.push(`    ${ description }`);
    }
    if (schemaDef && Object.keys(schemaDef).length > 0) {
      lines.push(`    Params: ${ this.formatParams(schemaDef) }`);
    }
    // Meta tools (exec, etc.) are what the example *uses* to wrap other calls.
    // Showing a nested `sulla meta/exec` example for exec itself would recurse
    // pointlessly — skip the Example line for meta category.
    if (category !== 'meta') {
      const innerCmd = `sulla ${ cliName } '${ argsJson }'`;
      const examplePayload = JSON.stringify({ command: innerCmd });
      lines.push(`    Example: sulla meta/exec ${ examplePayload }`);
    }
    return lines.join('\n');
  }

  // ────────────────────────────────────────────────────────────────
  // Credential status
  // ────────────────────────────────────────────────────────────────

  private async getConnectedIntegrations(): Promise<Set<string>> {
    // Lazy import — IntegrationService pulls in Postgres which needs
    // TextEncoder polyfilled in jsdom. Loading it only on demand keeps the
    // module importable from unit tests without that polyfill.
    try {
      const { getIntegrationService } = await import('../../services/IntegrationService');
      const svc = getIntegrationService();
      const enabled = await svc.getEnabledIntegrations();
      return new Set(enabled.map(e => e.integrationId));
    } catch {
      return new Set();
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Main execution
  // ────────────────────────────────────────────────────────────────

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { category, query } = input;

    const allCategories = toolRegistry.getCategories();
    const connectedIntegrations = await this.getConnectedIntegrations();

    // ── Query mode: filter tools by keyword ──
    if (query) {
      const q = (query as string).toLowerCase();
      const matchedLines: string[] = [];
      let matchCount = 0;
      for (const cat of allCategories) {
        const names = toolRegistry.getToolNamesForCategory(cat)
          .filter(n => !EXCLUDED_TOOLS.has(n));
        const matches = names.filter((name) => {
          if (name.toLowerCase().includes(q)) return true;
          const desc = toolRegistry.getToolDescription(name);
          return desc?.toLowerCase().includes(q);
        });
        if (matches.length > 0) {
          matchedLines.push('');
          matchedLines.push(`## ${ cat }`);
          for (const name of matches) {
            matchedLines.push(this.formatToolLine(name, cat));
          }
          matchCount += matches.length;
        }
      }
      if (matchCount === 0) {
        const available = allCategories.join(', ');
        return {
          successBoolean: false,
          responseString: `No tools found matching "${ query }". Available categories: ${ available }`,
        };
      }
      return {
        successBoolean: true,
        responseString: `${ INVOCATION_PREAMBLE }\n\nFound ${ matchCount } tools matching "${ query }":\n${ matchedLines.join('\n') }`,
      };
    }

    // ── Category mode: show one category in detail ──
    if (category) {
      if (!allCategories.includes(category)) {
        return {
          successBoolean: false,
          responseString: `Invalid category "${ category }". Available categories: ${ allCategories.join(', ') }`,
        };
      }
      const names = toolRegistry.getToolNamesForCategory(category)
        .filter(n => !EXCLUDED_TOOLS.has(n));
      const catDescs = toolRegistry.getCategoriesWithDescriptions();
      const catDesc = catDescs.find(c => c.category === category)?.description || '';
      const integSlug = CATEGORY_TO_INTEGRATION[category];
      const connected = integSlug && connectedIntegrations.has(integSlug);

      const lines: string[] = [];
      // For the meta category we must NOT emit the word "Example:" anywhere —
      // that's what marks meta tools as "callable directly, no wrapping needed".
      // The preamble is fine (no "Example:" token) but we still include it for
      // consistency since `exec` itself is the exec tool the preamble names.
      if (category !== 'meta') {
        lines.push(INVOCATION_PREAMBLE);
        lines.push('');
      }
      lines.push(`## ${ category }${ connected ? ' ✓ credentials connected' : '' }`);
      if (catDesc) lines.push(catDesc);
      lines.push('');
      for (const name of names) {
        lines.push(this.formatToolLine(name, category));
      }
      return { successBoolean: true, responseString: lines.join('\n').trim() };
    }

    // ── Default: list available categories only (no per-tool dump) ──
    const catDescs = toolRegistry.getCategoriesWithDescriptions();
    const lines: string[] = [];
    lines.push(INVOCATION_PREAMBLE);
    lines.push('');
    lines.push('## Available Tool Categories');
    lines.push('');
    for (const cat of allCategories) {
      const names = toolRegistry.getToolNamesForCategory(cat)
        .filter(n => !EXCLUDED_TOOLS.has(n));
      if (names.length === 0) continue;
      const catDesc = catDescs.find(c => c.category === cat)?.description || '';
      const integSlug = CATEGORY_TO_INTEGRATION[cat];
      const connected = integSlug && connectedIntegrations.has(integSlug);
      const badge = connected ? ' ✓ credentials connected' : '';
      lines.push(`- ${ cat } (${ names.length } tools)${ badge } — ${ catDesc }`);
    }
    lines.push('');
    lines.push('Call browse_tools with a category or query to see individual tools and their exec invocations.');

    return {
      successBoolean: true,
      responseString: lines.join('\n'),
    };
  }
}
