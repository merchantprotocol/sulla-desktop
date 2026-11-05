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

  constructor(
    private readonly runPolicy = new AgentDockerRunPolicy(),
    private readonly composePolicy = new AgentComposeUpPolicy(),
  ) {}

  apply(command: string, request: AgentDockerRunRequest, identity: AgentContainerIdentity): AgentExecDockerResult {
    const persistent = request.persistent === true;
    if (persistent && !String(request.reason ?? '').trim()) throw new Error('persistent:true requires a non-empty reason');
    if (!persistent && this.declaresRestartPolicy(command)) throw new Error(AgentExecDockerPolicy.RESTART_REFUSED);
    const { labels } = this.runPolicy.apply({ persistent, reason: request.reason, ttlSeconds: request.ttlSeconds }, identity);
    const compose = this.composePolicy.apply(command, identity, labels, persistent);
    command = compose.command;
    if (!new RegExp(AgentExecDockerPolicy.LAUNCH.source).test(command)) {
      return compose.launches ? { command, labels } : { command };
    }
    const labelArgs = Object.entries(labels).map(([key, value]) => `--label '${ `${ key }=${ value }`.replace(/'/g, `'\\''`) }'`).join(' ');
    return { command: command.replace(AgentExecDockerPolicy.LAUNCH, match => `${ match } ${ labelArgs }`), labels };
  }

  /** True when any docker run/create/update segment sets a restart policy other than "no". */
  private declaresRestartPolicy(command: string): boolean {
    return command.split(/[\n;&|]+/).some(segment => /\bdocker\s+(?:container\s+)?(?:run|create|update)\b/.test(segment)
      && /--restart(?:=|\s+)["']?(?!no\b)[a-z]/i.test(segment));
  }

}

/** Rewrites compose launches into a job-owned project with a persisted label override. */
export class AgentComposeUpPolicy {
  apply(command: string, identity: AgentContainerIdentity, labels: Record<string, string>, persistent: boolean): { command: string; launches: boolean } {
    let launches = false;
    const rewritten = command.replace(/\bdocker\s+compose\b([^\n;&|]*?)\s+up\b([^\n;&|]*)/g, (_match, rawArgs: string, upArgs: string) => {
      launches = true;
      const requestedProject = this.projectName(rawArgs);
      const prefix = `sulla-agent-${ this.safe(identity.jobId, 'unknown') }-`;
      const project = requestedProject?.startsWith(prefix)
        ? requestedProject : `${ prefix }${ this.safe(requestedProject ?? 'default', 'default') }`;
      const args = this.withoutProjectName(rawArgs);
      const runtimeDir = `/mnt/data/sulla/runtime/agents/${ this.safe(identity.jobId, 'unknown') }/compose`;
      const override = `${ runtimeDir }/${ project }.override.yml`;
      const compose = `docker compose -p ${ this.quote(project) }${ args }`;
      const labelLines = Object.entries(labels)
        .map(([key, value]) => `      ${ JSON.stringify(key) }: ${ JSON.stringify(value) }`)
        .join('\\n');
      const writeOverride = [
        `mkdir -p ${ this.quote(runtimeDir) }`,
        `override=${ this.quote(override) }`,
        `services="$(${ compose } config --services)"`,
        `printf '%s\\n' 'services:' > "$override"`,
        `for service in $services; do printf '  "%s":\\n    labels:\\n${ labelLines.replace(/%/g, '%%') }\\n' "$service" >> "$override"; done`,
      ].join(' && ');
      const restartGuard = persistent ? 'true' : `! ${ compose } config 2>/dev/null | grep -Eq '^[[:space:]]+restart:[[:space:]]*"?(always|unless-stopped|on-failure)'`;
      return `{ ${ writeOverride } && if ${ restartGuard }; then ${ compose } -f "$override" up${ upArgs }; else echo '${ AgentExecDockerPolicy.COMPOSE_RESTART_REFUSED }' >&2; exit 64; fi; }`;
    });
    return { command: rewritten, launches };
  }

  private projectName(args: string): string | undefined {
    return args.match(/(?:^|\s)(?:-p|--project-name)(?:=|\s+)([A-Za-z0-9_.-]+)/)?.[1];
  }

  private withoutProjectName(args: string): string {
    return args.replace(/(?:^|\s)(?:-p|--project-name)(?:=|\s+)[A-Za-z0-9_.-]+/g, '').replace(/\s+/g, ' ');
  }

  private safe(value: string, fallback: string): string {
    const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return safe || fallback;
  }

  private quote(value: string): string { return `'${ value.replace(/'/g, `'\\''`) }'` }
}
