import { getIntegrationService } from '../services/IntegrationService';

import type { ToolExecutionContext } from './executionContext';

/** Narrow verified caller authority to a trusted runtime-selected credential. */
export async function scopeToolExecutionContext(
  ctx: ToolExecutionContext,
  integrationId: string,
  repository?: string,
): Promise<ToolExecutionContext> {
  const accountId = await getIntegrationService().getActiveAccountId(integrationId);
  const existing = ctx.credential_scope;
  if (existing && (
    existing.integration_id !== integrationId ||
    existing.account_id !== accountId ||
    (existing.repository !== undefined && repository !== undefined && existing.repository !== repository)
  )) {
    throw new Error('Verified credential scope does not match the selected tool target');
  }
  const resolvedRepository = repository ?? existing?.repository;
  return {
    ...ctx,
    credential_scope: {
      integration_id: integrationId,
      account_id:     accountId,
      ...(resolvedRepository ? { repository: resolvedRepository } : {}),
    },
  };
}

export function githubRepositoryFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const values = args as Record<string, unknown>;
  const explicit = typeof values.repository === 'string' ? values.repository.trim().replace(/^\/+|\/+$/g, '') : '';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(explicit)) return explicit;
  const owner = typeof values.owner === 'string' ? values.owner.trim() : '';
  const repo = typeof values.repo === 'string' ? values.repo.trim() : '';
  return owner && repo ? `${ owner }/${ repo }` : undefined;
}
