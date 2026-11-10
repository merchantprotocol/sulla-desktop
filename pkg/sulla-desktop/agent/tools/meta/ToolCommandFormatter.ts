// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Formats one tool as the `sulla <category>/<tool>` block browse_tools prints. */
export class ToolCommandFormatter {
  cliName(toolName: string, category: string): string {
    const endpoint = toolName.startsWith(`${ category }_`)
      ? toolName.slice(category.length + 1)
      : toolName;
    return `${ category }/${ endpoint }`;
  }

  /** JSON payload with only required fields as `<paramname>` placeholders. */
  argsJson(schemaDef: Record<string, any> | undefined): string {
    if (!schemaDef) return '{}';
    const required = Object.entries(schemaDef).filter(([, spec]) => !spec.optional);
    if (required.length === 0) return '{}';
    const parts = required.map(([key]) => `"${ key }":"<${ key }>"`);
    return `{${ parts.join(',') }}`;
  }

  paramsLine(schemaDef: Record<string, any>): string {
    const parts = Object.entries(schemaDef).map(([key, spec]) => {
      const req = spec.optional ? 'optional' : 'required';
      const type = spec.type === 'enum' ? `enum: ${ (spec.enum || []).join('|') }` : spec.type;
      return `${ key } (${ req }, ${ type })`;
    });
    return parts.join(', ');
  }

  /** Full block for one tool. Meta tools skip the nested Example line (they are the wrapper). */
  format(toolName: string, category: string, description: string, schemaDef: Record<string, any> | undefined): string {
    const cliName = this.cliName(toolName, category);
    const argsJson = this.argsJson(schemaDef);
    const lines: string[] = [`  sulla ${ cliName } '${ argsJson }'`];
    if (description) lines.push(`    ${ description }`);
    if (schemaDef && Object.keys(schemaDef).length > 0) {
      lines.push(`    Params: ${ this.paramsLine(schemaDef) }`);
    }
    if (category !== 'meta') {
      const examplePayload = JSON.stringify({ command: `sulla ${ cliName } '${ argsJson }'` });
      lines.push(`    Example: sulla meta/exec ${ examplePayload }`);
    }
    return lines.join('\n');
  }
}
