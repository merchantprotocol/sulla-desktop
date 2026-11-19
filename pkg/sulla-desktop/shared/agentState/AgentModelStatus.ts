// SPDX-License-Identifier: GPL-2.0-or-later

export interface AgentModelStatusValue {
  mapping?:  string;
  model:     string;
  provider?: string;
  /** Empty means the CLI default; null means this provider does not report effort. */
  effort:    string | null;
  source:    'resolved' | 'requested';
}

export class AgentModelStatus {
  static label(status?: AgentModelStatusValue | null): string {
    if (!status?.model) return 'Model / effort not reported';
    const effort = status.effort === null
      ? (/grok/i.test(status.provider ?? '') ? 'No effort setting' : 'Effort not reported')
      : status.effort === '' ? 'Default' : status.effort.charAt(0).toUpperCase() + status.effort.slice(1);
    return `${ status.model } · ${ effort }${ status.source === 'requested' ? ' (requested)' : '' }${ status.mapping ? ` · ${ status.mapping }` : '' }`;
  }
}
