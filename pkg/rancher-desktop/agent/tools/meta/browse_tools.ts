import { BaseTool, ToolResponse } from '../base';
import { toolRegistry } from '../registry';

/**
 * BrowseToolsWorker — read-only tool discovery.
 *
 * Returns a formatted markdown document listing tools as `sulla` CLI
 * invocations. Designed for the memory-recall subconscious agent to
 * surface relevant tools to the primary agent.
 *
 * Does NOT modify state.llmTools or state.foundTools — purely read-only.
 */
export class BrowseToolsWorker extends BaseTool {
  name = '';
  description = '';

  // ────────────────────────────────────────────────────────────────
  // Formatting helpers
  // ────────────────────────────────────────────────────────────────

  /**
   * Convert a tool name to its `sulla category/endpoint` CLI form.
   * e.g. "docker_ps" in category "docker" → "docker/ps"
   *      "exec" in category "meta" → "meta/exec"
   *      "git_commit" in category "github" → "github/git_commit"
   */
  private toCliName(toolName: string, category: string): string {
    const endpoint = toolName.startsWith(`${ category }_`)
      ? toolName.slice(category.length + 1)
      : toolName;
    return `${ category }/${ endpoint }`;
  }

  /**
   * Build a sample JSON argument string from the schemaDef.
   * Only includes required params with placeholder values.
   */
  private buildSampleArgs(schemaDef: Record<string, any>): string {
    const sample: Record<string, any> = {};
    for (const [key, spec] of Object.entries(schemaDef)) {
      if (spec.optional) continue;
      switch (spec.type) {
      case 'string':
        sample[key] = spec.description
          ? `<${ key }>`
          : `<${ key }>`;
        break;
      case 'number':
        sample[key] = 0;
        break;
      case 'boolean':
        sample[key] = true;
        break;
      case 'enum':
        sample[key] = spec.enum?.[0] ?? `<${ key }>`;
        break;
      case 'array':
        sample[key] = [`<${ key }>`];
        break;
      case 'object':
        sample[key] = {};
        break;
      }
    }
    return JSON.stringify(sample);
  }

  /**
   * Format the params line: "Params: image (required, string), name (optional, string)"
   */
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

  /**
   * Build a sample `sulla meta/exec` wrapper command showing how to call
   * the tool from within exec.
   */
  private buildExecExample(cliName: string, schemaDef: Record<string, any>): string {
    // Build a more realistic sample with the first required string param filled in
    const sample: Record<string, any> = {};
    for (const [key, spec] of Object.entries(schemaDef)) {
      if (spec.optional) continue;
      switch (spec.type) {
      case 'string':
        sample[key] = spec.enum?.[0] ?? `<${ key }>`;
        break;
      case 'number':
        sample[key] = 1;
        break;
      case 'boolean':
        sample[key] = true;
        break;
      case 'enum':
        sample[key] = spec.enum?.[0] ?? `<${ key }>`;
        break;
      case 'array':
        sample[key] = [`<${ key }>`];
        break;
      case 'object':
        sample[key] = {};
        break;
      }
    }
    const innerJson = JSON.stringify(sample);
    // Escape inner quotes for the nested JSON-in-shell pattern
    const escaped = innerJson.replace(/"/g, '\\"');
    return `sulla meta/exec '{"command":"sulla ${ cliName } ${ escaped }"}'`;
  }

  /**
   * Format a single tool entry as a markdown block.
   */
  private formatTool(toolName: string, category: string): string {
    const description = toolRegistry.getToolDescription(toolName);
    const schemaDef = toolRegistry.getSchemaDef(toolName);
    const cliName = this.toCliName(toolName, category);
    const lines: string[] = [];

    // Primary sulla command with sample args
    const sampleArgs = schemaDef && Object.keys(schemaDef).length > 0
      ? this.buildSampleArgs(schemaDef)
      : '{}';
    lines.push(`sulla ${ cliName } '${ sampleArgs }'`);

    // Description
    if (description) {
      lines.push(`  ${ description }`);
    }

    // Params
    if (schemaDef && Object.keys(schemaDef).length > 0) {
      lines.push(`  Params: ${ this.formatParams(schemaDef) }`);

      // Exec example only for tools with required params (skip trivial ones)
      const hasRequired = Object.values(schemaDef).some((spec: any) => !spec.optional);
      if (hasRequired && category !== 'meta') {
        lines.push(`  Example: ${ this.buildExecExample(cliName, schemaDef) }`);
      }
    }

    return lines.join('\n');
  }

  // ────────────────────────────────────────────────────────────────
  // Main execution
  // ────────────────────────────────────────────────────────────────

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { category, query } = input;

    const allCategories = toolRegistry.getCategories();

    // No args → list categories
    if (!category && !query) {
      const catDescriptions = toolRegistry.getCategoriesWithDescriptions();
      const lines = ['## Available Tool Categories', ''];
      for (const { category: cat, description } of catDescriptions) {
        const toolCount = toolRegistry.getToolNamesForCategory(cat).length;
        lines.push(`${ cat } — ${ description } (${ toolCount } tools)`);
      }
      lines.push('');
      lines.push('Call browse_tools with a category or query to see tool details.');
      return { successBoolean: true, responseString: lines.join('\n') };
    }

    // Validate category if provided
    if (category && !allCategories.includes(category)) {
      return {
        successBoolean: false,
        responseString: `Invalid category "${ category }". Available: ${ allCategories.join(', ') }`,
      };
    }

    // Determine which tools to show
    let toolNames: string[];
    let matchedCategories: string[];

    if (category) {
      toolNames = toolRegistry.getToolNamesForCategory(category);
      matchedCategories = [category];
    } else {
      // Search across all categories by query
      toolNames = [];
      matchedCategories = [];
      const q = (query || '').toLowerCase();
      for (const cat of allCategories) {
        const namesInCat = toolRegistry.getToolNamesForCategory(cat);
        const matches = namesInCat.filter((name) => {
          if (name.toLowerCase().includes(q)) return true;
          const desc = toolRegistry.getToolDescription(name);
          return desc?.toLowerCase().includes(q);
        });
        if (matches.length > 0) {
          toolNames.push(...matches);
          if (!matchedCategories.includes(cat)) {
            matchedCategories.push(cat);
          }
        }
      }
    }

    if (toolNames.length === 0) {
      return {
        successBoolean: false,
        responseString: `No tools found${ category ? ` in category "${ category }"` : '' }${ query ? ` matching "${ query }"` : '' }.\n\nAvailable categories: ${ allCategories.join(', ') }`,
      };
    }

    // Build output grouped by category
    const lines: string[] = [];

    if (query && !category) {
      lines.push(`Found ${ toolNames.length } tools matching "${ query }":`);
      lines.push('');
    }

    for (const cat of matchedCategories) {
      const catDescription = toolRegistry.getCategoriesWithDescriptions()
        .find(c => c.category === cat)?.description || '';
      lines.push(`## ${ cat }`);
      if (catDescription) {
        lines.push(catDescription);
      }
      lines.push('');

      const namesInCat = category
        ? toolNames
        : toolNames.filter((name) => {
          const toolCatNames = toolRegistry.getToolNamesForCategory(cat);
          return toolCatNames.includes(name);
        });

      for (const name of namesInCat) {
        lines.push(this.formatTool(name, cat));
        lines.push('');
      }
    }

    return {
      successBoolean: true,
      responseString: lines.join('\n').trim(),
    };
  }
}
