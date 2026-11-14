// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { BaseTool, ToolResponse } from '../base';
import { runDockerCommand } from './runDockerCommand';
import { DockerDiagnostics } from './DockerDiagnostics';

export class DockerStatsWorker extends BaseTool {
  name = ''; description = ''; private diagnostics = new DockerDiagnostics();
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const containers = input.container ? (Array.isArray(input.container) ? input.container : [input.container]) : [];
    const res = await runDockerCommand(this.diagnostics.buildStatsArgs(containers));
    if (res.exitCode !== 0) return { successBoolean: false, responseString: res.stderr || res.stdout };
    const rows = this.diagnostics.sortStats(this.diagnostics.parseStats(res.stdout), input.sort, input.limit);
    const table = ['NAME CPU% MEM USAGE / LIMIT MEM% NET I/O BLOCK I/O PIDS', ...rows.map(r => `${r.name} ${r.cpuPercent}% ${r.memoryUsage} / ${r.memoryLimit} ${r.memoryPercent}% ${r.networkIO} ${r.blockIO} ${r.pids}`)].join('\n');
    return { successBoolean: true, responseString: table, result: rows };
  }
}
