// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { DockerDiagnostics } from './DockerDiagnostics';
import { runDockerCommand } from './runDockerCommand';

export class DockerInspectHealthWorker extends BaseTool {
  name = '';
  description = '';
  private readonly diagnostics = new DockerDiagnostics();

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    let containers: string[];
    if (input.container) containers = Array.isArray(input.container) ? input.container : [input.container];
    else {
      const listed = await runDockerCommand(['ps', '-aq']);
      if (listed.exitCode !== 0) return { successBoolean: false, responseString: listed.stderr || listed.stdout };
      containers = listed.stdout.split(/\r?\n/).filter(Boolean);
    }
    const results = [];
    for (const container of containers) {
      const response = await runDockerCommand(['inspect', container]);
      if (response.exitCode !== 0) return { successBoolean: false, responseString: response.stderr || response.stdout };
      try {
        const inspected = JSON.parse(response.stdout)[0];
        const state = inspected.State ?? {};
        const health = state.Health;
        const flags = this.diagnostics.healthFlags(inspected);
        results.push({ container: inspected.Name?.replace(/^\//, ''), status: state.Status, healthStatus: health?.Status ?? null,
          healthLogs: (health?.Log ?? []).slice(-3).map((log: any) => ({ start: log.Start, end: log.End, exitCode: log.ExitCode, output: log.Output })),
          restartCount: inspected.RestartCount, oomKilled: state.OOMKilled, exitCode: state.ExitCode, startedAt: state.StartedAt,
          restartPolicy: inspected.HostConfig?.RestartPolicy, memoryLimit: inspected.HostConfig?.Memory, flags, needsAttention: flags.length > 0 });
      } catch { return { successBoolean: false, responseString: `Invalid docker inspect JSON for ${container}` }; }
    }
    return { successBoolean: true, responseString: JSON.stringify(results, null, 2), result: results };
  }
}
