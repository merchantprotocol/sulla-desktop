// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentDockerRunPolicy, type AgentContainerIdentity, type AgentDockerRunRequest } from './AgentDockerRunPolicy';

export interface AgentExecDockerResult {
  command: string;
  /** Labels added to every container launch in the command; undefined when the command launches none. */
  labels?: Record<string, string>;
}

/** Applies the same ownership policy to docker commands issued through exec. */
export class AgentExecDockerPolicy {
  static readonly LAUNCH = /\bdocker\s+(?:container\s+)?(?:run|create)\b/g;
  static readonly RESTART_REFUSED = 'Docker restart policies are refused for temporary agent containers (docker run/create/update --restart). Pass persistent:true with a non-empty reason to opt out.';
  static readonly COMPOSE_RESTART_REFUSED = 'Refused: compose restart policies are not allowed for temporary agent containers. Remove restart: from the compose file, or pass persistent:true with a non-empty reason.';

  constructor(private readonly runPolicy = new AgentDockerRunPolicy()) {}

  apply(command: string, request: AgentDockerRunRequest, identity: AgentContainerIdentity): AgentExecDockerResult {
    const persistent = request.persistent === true;
    if (persistent && !String(request.reason ?? '').trim()) throw new Error('persistent:true requires a non-empty reason');
    if (!persistent && this.declaresRestartPolicy(command)) throw new Error(AgentExecDockerPolicy.RESTART_REFUSED);
    command = this.guardComposeUp(command, persistent);
    if (!new RegExp(AgentExecDockerPolicy.LAUNCH.source).test(command)) return { command };
    const { labels } = this.runPolicy.apply({ persistent, reason: request.reason, ttlSeconds: request.ttlSeconds }, identity);
    const labelArgs = Object.entries(labels).map(([key, value]) => `--label '${ `${ key }=${ value }`.replace(/'/g, `'\\''`) }'`).join(' ');
    return { command: command.replace(AgentExecDockerPolicy.LAUNCH, match => `${ match } ${ labelArgs }`), labels };
  }

  /** True when any docker run/create/update segment sets a restart policy other than "no". */
  private declaresRestartPolicy(command: string): boolean {
    return command.split(/[\n;&|]+/).some(segment => /\bdocker\s+(?:container\s+)?(?:run|create|update)\b/.test(segment)
      && /--restart(?:=|\s+)["']?(?!no\b)[a-z]/i.test(segment));
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
}
