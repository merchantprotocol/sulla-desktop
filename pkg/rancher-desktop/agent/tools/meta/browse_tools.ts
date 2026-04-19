import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';
import { toolRegistry } from '../registry';

/**
 * BrowseToolsWorker — read-only tool discovery.
 *
 * Returns a flat list of ALL registered tools (minus internal meta tools)
 * grouped by category, like running `sulla --help`.
 *
 * For categories that correspond to integrations, notes whether credentials
 * are connected in the vault.
 */

/** Tools excluded from the listing — internal plumbing the agent already has */
const EXCLUDED_TOOLS = new Set([
  'exec',
  'file_search',
  'read_file',
  'write_file',
  'browse_tools',
]);

/**
 * Categories that map 1:1 to an integration slug in the vault.
 * Key = tool category, value = integration slug (if different).
 */
const CATEGORY_TO_INTEGRATION: Record<string, string> = {
  slack:    'slack',
  github:   'github',
  calendar: 'google-calendar',
  n8n:      'n8n',
  pg:       'postgresql',
  redis:    'redis',
  chrome:   'chrome',
};

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
    const parts: string[] = [];

    parts.push(`  sulla ${ cliName }`);
    if (description) {
      parts.push(`    ${ description }`);
    }
    if (schemaDef && Object.keys(schemaDef).length > 0) {
      parts.push(`    Params: ${ this.formatParams(schemaDef) }`);
    }
    return parts.join('\n');
  }

  // ────────────────────────────────────────────────────────────────
  // Credential status
  // ────────────────────────────────────────────────────────────────

  private async getConnectedIntegrations(): Promise<Set<string>> {
    try {
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
        return { successBoolean: false, responseString: `No tools matching "${ query }".` };
      }
      return {
        successBoolean: true,
        responseString: `Found ${ matchCount } tools matching "${ query }":\n${ matchedLines.join('\n') }`,
      };
    }

    // ── Category mode: show one category in detail ──
    if (category) {
      if (!allCategories.includes(category)) {
        return {
          successBoolean: false,
          responseString: `Unknown category "${ category }". Available: ${ allCategories.join(', ') }`,
        };
      }
      const names = toolRegistry.getToolNamesForCategory(category)
        .filter(n => !EXCLUDED_TOOLS.has(n));
      const catDescs = toolRegistry.getCategoriesWithDescriptions();
      const catDesc = catDescs.find(c => c.category === category)?.description || '';
      const integSlug = CATEGORY_TO_INTEGRATION[category];
      const connected = integSlug && connectedIntegrations.has(integSlug);

      const lines: string[] = [];
      lines.push(`## ${ category }${ connected ? ' ✓ credentials connected' : '' }`);
      if (catDesc) lines.push(catDesc);
      lines.push('');
      for (const name of names) {
        lines.push(this.formatToolLine(name, category));
      }
      return { successBoolean: true, responseString: lines.join('\n').trim() };
    }

    // ── Default: full flat listing of ALL tools ──
    const lines: string[] = [];
    let totalTools = 0;

    for (const cat of allCategories) {
      const names = toolRegistry.getToolNamesForCategory(cat)
        .filter(n => !EXCLUDED_TOOLS.has(n));
      if (names.length === 0) continue;

      const catDescs = toolRegistry.getCategoriesWithDescriptions();
      const catDesc = catDescs.find(c => c.category === cat)?.description || '';
      const integSlug = CATEGORY_TO_INTEGRATION[cat];
      const connected = integSlug && connectedIntegrations.has(integSlug);

      lines.push('');
      lines.push(`## ${ cat } (${ names.length } tools)${ connected ? ' ✓ credentials connected' : '' }`);
      if (catDesc) lines.push(catDesc);
      lines.push('');

      for (const name of names) {
        lines.push(this.formatToolLine(name, cat));
      }
      totalTools += names.length;
    }

    return {
      successBoolean: true,
      responseString: `# Sulla Tool Catalog — ${ totalTools } tools\n${ lines.join('\n') }`,
    };
  }
}
