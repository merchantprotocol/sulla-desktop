import type { AgentMarketplaceManifest } from '@pkg/agent/services/AgentDefinitionService';

const AGENT_SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { label: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{10,}/ },
  { label: 'GitHub token', pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: 'AWS access key', pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { label: 'Slack token', pattern: /\bxox[bp]-[A-Za-z0-9-]{10,}/ },
  { label: 'private key', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
];

export function findAgentSecret(agentJson: string): string | null {
  return AGENT_SECRET_PATTERNS.find(candidate => candidate.pattern.test(agentJson))?.label ?? null;
}

export function hasAbsoluteHomePath(prompt: string): boolean {
  return /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/.test(prompt);
}

function agentTextFields(manifest: AgentMarketplaceManifest): string[] {
  const spec = manifest.spec ?? ({} as AgentMarketplaceManifest['spec']);

  return [spec.prompt, spec.soul, spec.goals, ...Object.values(spec.promptFiles ?? {})].filter((v): v is string => typeof v === 'string');
}

export function checkAgentManifestForPublish(manifest: AgentMarketplaceManifest): { secret: string | null; warnings: string[] } {
  const warnings: string[] = [];

  if (agentTextFields(manifest).some(hasAbsoluteHomePath)) {
    warnings.push('The agent contains absolute home-directory paths (e.g. /Users/<name>/). They may not work on other machines.');
  }

  return { secret: findAgentSecret(JSON.stringify(manifest)), warnings };
}
