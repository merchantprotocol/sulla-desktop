/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { checkAgentManifestForPublish, findAgentSecret } from '../agentPublishSafety';

const baseManifest = (spec: Record<string, unknown> = {}) => ({
  apiVersion: 'sulla/v3' as const,
  kind: 'Agent' as const,
  manifestVersion: 1 as const,
  metadata: { slug: 'safe-agent', title: 'Safe Agent', description: '', version: '1.0.0' },
  spec: { prompt: 'Do useful work.', tools: [], skills: [], config: {}, promptFiles: {}, ...spec },
});

describe('agent marketplace publish safety', () => {
  it('detects credential material in serialized manifests', () => {
    expect(findAgentSecret(JSON.stringify({ config: { apiKey: 'sk-test-secret-value' } }))).toBe('OpenAI API key');
  });

  it('rejects vault, account, and personal-memory fields', () => {
    expect(checkAgentManifestForPublish(baseManifest({ config: { vaultCredentialId: 'vault-1' } })).sensitiveField).toContain('vault credential');
    expect(checkAgentManifestForPublish(baseManifest({ config: { accountId: 'acct-1' } })).sensitiveField).toContain('account identifier');
    expect(checkAgentManifestForPublish(baseManifest({ config: { memory: ['private note'] } })).sensitiveField).toContain('personal memory');
  });

  it('allows ordinary agent configuration', () => {
    const result = checkAgentManifestForPublish(baseManifest({ config: { temperature: 0.2, maxTokens: 4000, memoryEnabled: true, tokenBudget: 10 } }));
    expect(result.secret).toBeNull();
    expect(result.sensitiveField).toBeNull();
  });
});
