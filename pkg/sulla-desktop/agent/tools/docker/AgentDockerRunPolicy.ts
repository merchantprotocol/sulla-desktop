// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface AgentContainerIdentity { jobId: string; agentId: string }
export interface AgentDockerRunRequest {
  options?: string;
  persistent?: boolean;
  reason?: string;
  ttlSeconds?: number;
}

export class AgentDockerRunPolicy {
  static readonly DEFAULT_TTL_SECONDS = 4 * 60 * 60;

  constructor(private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1_000)) {}

  apply(request: AgentDockerRunRequest, identity: AgentContainerIdentity): { options: string[]; labels: Record<string, string> } {
    const persistent = request.persistent === true;
    const reason = String(request.reason ?? '').trim();
    if (persistent && !reason) throw new Error('persistent:true requires a non-empty reason');
    const options = this.tokenize(request.options ?? '');
    const restartIndex = options.findIndex(option => option === '--restart' || option.startsWith('--restart='));
    if (restartIndex >= 0 && !persistent) {
      throw new Error('Docker restart policies are refused for temporary agent containers. Pass persistent:true with a non-empty reason to opt out.');
    }
    const ttl = Number.isFinite(request.ttlSeconds) && Number(request.ttlSeconds) > 0
      ? Math.floor(Number(request.ttlSeconds)) : AgentDockerRunPolicy.DEFAULT_TTL_SECONDS;
    const labels: Record<string, string> = {
      'com.sulla.owner': 'agent',
      'com.sulla.job-id': identity.jobId || 'unknown',
      'com.sulla.agent-id': identity.agentId || 'unknown',
      'com.sulla.expires-at': String(this.nowSeconds() + ttl),
      'com.sulla.persistent': persistent ? 'true' : 'false',
    };
    if (persistent) labels['com.sulla.persistence-reason'] = reason;
    return { options: [...options, ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${ key }=${ value }`])], labels };
  }

  private tokenize(value: string): string[] {
    return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(token => token.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  }
}
