// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ToolCommandFormatter } from './ToolCommandFormatter';

/** Read-only view of the tool registry the catalog is built from. */
export interface ToolCatalogSource {
  getCategories(): string[];
  getToolNamesForCategory(category: string): string[];
  getToolDescription(toolName: string): string;
  getSchemaDef(toolName: string): Record<string, any> | undefined;
}

export interface ToolCatalogEntry {
  name: string;
  category: string;
  description: string;
  /** Pre-formatted `sulla <category>/<tool>` block. */
  line: string;
}

/** Internal plumbing the agent already has; never listed. */
export const BROWSE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'file_search',
  'read_file',
  'write_file',
  'browse_tools',
]);

/**
 * Per-instance catalog of formatted tool lines. Rebuilt only when the
 * registry generation changes (the set of tool names per category), so
 * repeated browse_tools calls don't re-format the whole catalog.
 */
export class ToolCatalogIndex {
  private generation: string | null = null;
  private categoryNames: string[] = [];
  private entriesByCategory = new Map<string, ToolCatalogEntry[]>();

  constructor(
    private readonly source: ToolCatalogSource,
    private readonly formatter: ToolCommandFormatter = new ToolCommandFormatter(),
    private readonly excluded: ReadonlySet<string> = BROWSE_EXCLUDED_TOOLS,
  ) {}

  /** Categories that have at least one browsable tool. */
  categories(): string[] {
    this.ensureCurrent();
    return this.categoryNames;
  }

  entriesFor(category: string): ToolCatalogEntry[] {
    this.ensureCurrent();
    return this.entriesByCategory.get(category) ?? [];
  }

  allEntries(): ToolCatalogEntry[] {
    this.ensureCurrent();
    return this.categoryNames.flatMap(category => this.entriesByCategory.get(category) ?? []);
  }

  private ensureCurrent(): void {
    const namesByCategory = this.source.getCategories().map(category => ({
      category,
      names: this.source.getToolNamesForCategory(category).filter(name => !this.excluded.has(name)),
    }));
    const generation = namesByCategory.map(({ category, names }) => `${ category }:${ names.join(',') }`).join('|');
    if (generation === this.generation) return;

    this.entriesByCategory = new Map();
    this.categoryNames = [];
    for (const { category, names } of namesByCategory) {
      if (names.length === 0) continue;
      this.categoryNames.push(category);
      this.entriesByCategory.set(category, names.map(name => this.buildEntry(name, category)));
    }
    this.generation = generation;
  }

  private buildEntry(name: string, category: string): ToolCatalogEntry {
    const description = this.source.getToolDescription(name);
    const schemaDef = this.source.getSchemaDef(name);
    return {
      name,
      category,
      description,
      line: this.formatter.format(name, category, description, schemaDef),
    };
  }
}
