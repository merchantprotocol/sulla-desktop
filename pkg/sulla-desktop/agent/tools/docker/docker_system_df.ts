// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { runDockerCommand } from './runDockerCommand';

export class DockerSystemDfWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(): Promise<ToolResponse> {
    const totals = await runDockerCommand(['system', 'df']);
    if (totals.exitCode !== 0) return { successBoolean: false, responseString: totals.stderr || totals.stdout };
    const verbose = await runDockerCommand(['system', 'df', '-v']);
    if (verbose.exitCode !== 0) return { successBoolean: false, responseString: verbose.stderr || verbose.stdout };
    const sections: Record<string, string[]> = { images: [], containers: [], volumes: [], buildCache: [] };
    let section = '';
    for (const line of verbose.stdout.split(/\r?\n/)) {
      const title = line.trim();
      if (/^Images space usage:/.test(title)) section = 'images';
      else if (/^Containers space usage:/.test(title)) section = 'containers';
      else if (/^Local Volumes space usage:/.test(title)) section = 'volumes';
      else if (/^Build cache usage:/.test(title)) section = 'buildCache';
      if (section) sections[section].push(line);
    }
    const largest = (lines: string[]) => lines.map(line => {
      const match = line.match(/([0-9.]+)\s*(GB|MB|kB|B)/i);
      const unit = match?.[2].toLowerCase();
      const multiplier = unit === 'gb' ? 1_000_000_000 : unit === 'mb' ? 1_000_000 : unit === 'kb' ? 1_000 : 1;
      return match ? { line, size: Number(match[1]) * multiplier, unit: match[2] } : undefined;
    }).filter((row): row is { line: string; size: number; unit: string } => row !== undefined).sort((a, b) => b.size - a.size).slice(0, 10);
    const totalsRows = totals.stdout.split(/\r?\n/).filter(line => line.trim());
    const totalsTable = totalsRows.slice(1).map(line => {
      const columns = line.trim().split(/\s{2,}/);
      return { type: columns[0], total: columns[1], active: columns[2], size: columns[3], reclaimable: columns[4] };
    });
    const result = { totals: totalsTable, sections, largestVolumes: largest(sections.volumes), largestImages: largest(sections.images) };
    return { successBoolean: true, responseString: JSON.stringify(result, null, 2), result };
  }
}
