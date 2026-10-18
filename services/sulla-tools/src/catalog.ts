import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import type { ToolExecutionContext } from '../../../pkg/rancher-desktop/agent/tools/executionContext.js';
import type { ToolExecutionTarget } from '../../../pkg/rancher-desktop/agent/tools/executionTargets.js';

export interface CatalogTool {
  name:            string;
  category:        string;
  description:     string;
  schemaDef:       Record<string, unknown>;
  executionTarget: ToolExecutionTarget;
}

let registry: typeof import('../../../pkg/rancher-desktop/agent/tools/registry.js').toolRegistry;
const tools = new Map<string, CatalogTool>();

export async function initializeCatalog(): Promise<void> {
  await import('../../../pkg/rancher-desktop/agent/tools/manifests.js');
  ({ toolRegistry: registry } = await import('../../../pkg/rancher-desktop/agent/tools/registry.js'));
  for (const { category } of registry.getCategoriesWithDescriptions()) {
    for (const name of registry.getToolNamesForCategory(category)) {
      tools.set(name, {
        name,
        category,
        description:     registry.getToolDescription(name),
        schemaDef:       registry.getSchemaDef(name) ?? {},
        executionTarget: registry.getExecutionTarget(name) ?? 'desktop-local',
      });
    }
  }
}

export function resolveTool(category: string, requested: string): CatalogTool | undefined {
  const tool = tools.get(`${ category }_${ requested }`) ?? tools.get(requested);

  return tool?.category === category ? tool : undefined;
}

export function listTools(category?: string): CatalogTool[] {
  return [...tools.values()].filter(tool => !category || tool.category === category).sort((a, b) => a.name.localeCompare(b.name));
}

const FIXED_INTEGRATION_CATEGORIES: Readonly<Record<string, string>> = {
  github:  'github',
  slack:   'slack',
  discord: 'discord',
  gdrive:  'google_drive',
  mobile:  'sulla-cloud',
};
const execFile = promisify(execFileCallback);

function githubRepository(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const values = args as Record<string, unknown>;
  const explicit = typeof values.repository === 'string' ? values.repository.trim().replace(/^\/+|\/+$/g, '') : '';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(explicit)) return explicit;
  const owner = typeof values.owner === 'string' ? values.owner.trim() : '';
  const repo = typeof values.repo === 'string' ? values.repo.trim() : '';
  return owner && repo ? `${ owner }/${ repo }` : undefined;
}

function repositoryFromGitHubRemote(remote: string): string | undefined {
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (ssh) return ssh[1];
  try {
    const url = new URL(remote);
    const repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    return url.protocol === 'https:' && url.hostname === 'github.com' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
      ? repository
      : undefined;
  } catch {
    return undefined;
  }
}

async function githubGitRepository(tool: CatalogTool, args: unknown): Promise<string | undefined> {
  if (!['git_fetch', 'git_pull', 'git_push'].includes(tool.name) || !args || typeof args !== 'object') return undefined;
  // Agent-local paths only exist in the worker container. The canonical Git
  // worker resolves its configured remote there, then the Desktop broker
  // derives and enforces the repository scope from that authoritative URL.
  if (tool.executionTarget === 'agent-local') return undefined;
  const values = args as Record<string, unknown>;
  const absolutePath = typeof values.absolutePath === 'string' ? values.absolutePath.trim() : '';
  const remote = typeof values.remote === 'string' && values.remote.trim() ? values.remote.trim() : 'origin';
  if (!absolutePath) return undefined;
  const result = await execFile('git', ['-C', absolutePath, 'remote', 'get-url', remote], { timeout: 10_000 });
  return repositoryFromGitHubRemote(result.stdout.trim());
}

function notifyUsesMobileDelivery(tool: CatalogTool, args: unknown): boolean {
  if (tool.name !== 'notify_user' || !args || typeof args !== 'object') return false;
  const targets = (args as Record<string, unknown>).targets;
  if (typeof targets === 'string') return targets.trim().toLowerCase() === 'mobile';
  return Array.isArray(targets) && targets.some(target =>
    typeof target === 'string' && target.trim().toLowerCase() === 'mobile');
}

/** Credential authority is derived from the trusted catalog entry, never caller-selected. */
export function credentialIntegrationForTool(tool: CatalogTool, args: unknown): string | undefined {
  return FIXED_INTEGRATION_CATEGORIES[tool.category] ??
    (tool.name === 'reconcile_github_pr_mirror' ? 'github' : undefined) ??
    (notifyUsesMobileDelivery(tool, args) ? 'sulla-cloud' : undefined);
}

/**
 * Narrow verified tool authority to the credential selected by the trusted
 * runtime. Tool arguments can select a repository but can never select or
 * forge an integration account.
 */
export async function scopeToolExecutionContext(
  ctx: ToolExecutionContext,
  tool: CatalogTool,
  args: unknown,
): Promise<ToolExecutionContext> {
  const integrationId = credentialIntegrationForTool(tool, args);
  if (!integrationId) return ctx;
  const { getIntegrationService } = await import('../../../pkg/rancher-desktop/agent/services/IntegrationService.js');
  const accountId = await getIntegrationService().getActiveAccountId(integrationId);
  const repository = integrationId === 'github'
    ? githubRepository(args) ?? await githubGitRepository(tool, args)
    : undefined;
  const derived = {
    integration_id: integrationId,
    account_id:     accountId,
    ...(repository ? { repository } : {}),
  };
  if (ctx.credential_scope && (
    ctx.credential_scope.integration_id !== derived.integration_id ||
    ctx.credential_scope.account_id !== derived.account_id ||
    (ctx.credential_scope.repository && ctx.credential_scope.repository !== derived.repository)
  )) {
    throw new Error('Verified credential scope does not match the selected tool target');
  }
  return { ...ctx, credential_scope: derived };
}

export async function executeCatalogTool(ctx: ToolExecutionContext, tool: CatalogTool, args: unknown): Promise<unknown> {
  const worker = await registry.createTool(tool.name);
  worker.executionContext = ctx;
  return worker.call(args);
}
