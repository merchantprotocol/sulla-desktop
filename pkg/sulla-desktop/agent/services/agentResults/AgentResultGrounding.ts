// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentResultItem, AgentResultLink } from '../../../shared/agentResults/AgentResultCard';

/**
 * Deterministic checks on a model-built result card. The model decides the
 * purpose, verdict and wording; identifiers it reports (PR numbers, commit
 * SHAs, file paths) are kept only when they literally appear in the agent's
 * report, and links come from the report text alone, never from the model.
 */
export class AgentResultGrounding {
  private static readonly URL = /https?:\/\/[^\s<>"'`)\]]+/g;

  links(report: string): AgentResultLink[] {
    const seen = new Set<string>();
    const links: AgentResultLink[] = [];
    for (const raw of report.match(AgentResultGrounding.URL) ?? []) {
      const url = raw.replace(/[.,;:]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ label: this.linkLabel(url), url });
      if (links.length === 6) break;
    }

    return links;
  }

  /** Drop every identifier the report does not contain. */
  ground(item: AgentResultItem): AgentResultItem {
    const text = item.report;
    const has = (value: string | undefined) => !!value && this.contains(text, value);
    const sha = (value: string | undefined) => (value && /^[0-9a-f]{7,40}$/i.test(value) && has(value) ? value.slice(0, 7) : undefined);
    const pr = (value: string | undefined) => {
      const digits = String(value ?? '').replace(/^#/, '');

      return /^\d{1,7}$/.test(digits) && this.contains(text, digits) ? `#${ digits }` : undefined;
    };

    const merges = item.merges
      ?.map(merge => ({ ...merge, pr: pr(merge.pr) ?? '', sha: sha(merge.sha) }))
      .filter(merge => merge.pr);
    // An environment the report never names (e.g. "Production") is a guess.
    const environments = item.environments?.filter(env => has(env.name));
    const findings = item.findings?.map(finding => ({ ...finding, file: has(finding.file?.split(':')[0]) ? finding.file : undefined }));
    const change = item.change && {
      ...item.change,
      pr:    pr(item.change.pr),
      files: item.change.files?.filter(file => has(file)),
    };

    return {
      ...item,
      ...(merges ? { merges } : {}),
      ...(environments ? { environments: environments.length ? environments : undefined } : {}),
      ...(findings ? { findings } : {}),
      ...(change ? { change } : {}),
      links: this.links(text),
    };
  }

  private contains(text: string, value: string): boolean {
    return text.toLowerCase().includes(value.toLowerCase());
  }

  private linkLabel(url: string): string {
    const pull = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
    if (pull) return `PR #${ pull[2] }`;
    const run = /github\.com\/[^/]+\/([^/]+)\/actions\/runs\//.exec(url);
    if (run) return `${ run[1] } run`;
    try {
      return new URL(url).host;
    } catch {
      return url.slice(0, 40);
    }
  }
}
