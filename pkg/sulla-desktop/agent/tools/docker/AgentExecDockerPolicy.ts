// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentDockerRunPolicy, type AgentContainerIdentity, type AgentDockerRunRequest } from './AgentDockerRunPolicy';

/** Applies the same ownership policy to docker commands issued through exec. */
export class AgentExecDockerPolicy {
  constructor(private readonly runPolicy = new AgentDockerRunPolicy()) {}

  apply(command: string, request: AgentDockerRunRequest, identity: AgentContainerIdentity): string {
    if (/\bdocker\s+compose\b[^\n;&|]*\bup\b/.test(command)) {
      throw new Error('docker compose up through agent exec is refused because Sulla cannot safely label every service without a generated override. Use docker_run, or a cataloged compose tool that applies the agent ownership override. Compose restart: policies are never accepted implicitly.');
    }
    if (!/\bdocker\s+run\b/.test(command)) return command;
    const restart = command.match(/--restart(?:=|\s+)\S+/)?.[0];
    const result = this.runPolicy.apply({ ...request, options: restart ?? '' }, identity);
    const labelArgs = result.options.filter((value, index, all) => value === '--label' || all[index - 1] === '--label');
    const escaped = labelArgs.map(value => `'${ value.replace(/'/g, `'\\''`) }'`).join(' ');
    return command.replace(/\bdocker\s+run\b/, match => `${ match } ${ escaped }`);
  }
}
