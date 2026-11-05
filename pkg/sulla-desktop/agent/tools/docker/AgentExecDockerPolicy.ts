// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentDockerRunPolicy, type AgentContainerIdentity, type AgentDockerRunRequest } from './AgentDockerRunPolicy';

/** Applies the same ownership policy to docker commands issued through exec. */
export class AgentExecDockerPolicy {
  constructor(private readonly runPolicy = new AgentDockerRunPolicy()) {}

  apply(command: string, request: AgentDockerRunRequest, identity: AgentContainerIdentity): string {
    const persistent = request.persistent === true;
    if (persistent && !String(request.reason ?? '').trim()) throw new Error('persistent:true requires a non-empty reason');
    command = this.guardComposeUp(command, persistent);
    if (!/\bdocker\s+run\b/.test(command)) return command;
    const restart = command.match(/--restart(?:=|\s+)\S+/)?.[0];
    const result = this.runPolicy.apply({ ...request, options: restart ?? '' }, identity);
    const labelArgs = result.options.filter((value, index, all) => value === '--label' || all[index - 1] === '--label');
    const escaped = labelArgs.map(value => `'${ value.replace(/'/g, `'\\''`) }'`).join(' ');
    return command.replace(/\bdocker\s+run\b/, match => `${ match } ${ escaped }`);
  }

  /**
   * Compose services cannot be relabelled from the CLI, so a temporary
   * compose up is guarded instead: the resolved config is checked first and
   * the run is refused when any service declares a restart policy.
   */
  private guardComposeUp(command: string, persistent: boolean): string {
    if (persistent) return command;
    return command.replace(/\bdocker\s+compose\b([^\n;&|]*?)\s+up\b/g, (match, args: string) => {
      const guard = `{ if docker compose${ args } config 2>/dev/null | grep -Eq '^[[:space:]]+restart:[[:space:]]*"?(always|unless-stopped|on-failure)'; then echo '${ AgentExecDockerPolicy.COMPOSE_RESTART_REFUSED }' >&2; exit 64; fi; }`;
      return `${ guard } && ${ match }`;
    });
  }

  static readonly COMPOSE_RESTART_REFUSED = 'Refused: compose restart policies are not allowed for temporary agent containers. Remove restart: from the compose file, or pass persistent:true with a non-empty reason.';
}
