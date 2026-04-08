import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SULLA_HOME_DIR_ENV = 'SULLA_HOME_DIR';
const SULLA_PROJECTS_DIR_ENV = 'SULLA_PROJECTS_DIR';
const SULLA_SKILLS_DIR_ENV = 'SULLA_SKILLS_DIR';
const SULLA_WORKSPACES_DIR_ENV = 'SULLA_WORKSPACES_DIR';
const SULLA_AGENTS_DIR_ENV = 'SULLA_AGENTS_DIR';
const SULLA_CONVERSATIONS_DIR_ENV = 'SULLA_CONVERSATIONS_DIR';
const SULLA_WORKFLOWS_DIR_ENV = 'SULLA_WORKFLOWS_DIR';
const SULLA_INTEGRATIONS_DIR_ENV = 'SULLA_INTEGRATIONS_DIR';
const SULLA_RESOURCES_DIR_ENV = 'SULLA_RESOURCES_DIR';
const SULLA_CODEBASE_DIR_ENV = 'SULLA_CODEBASE_DIR';

export function resolveSullaHomeDir(): string {
  const envPath = String(process.env[SULLA_HOME_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(os.homedir(), 'sulla');
}

export function resolveSullaResourcesDir(): string {
  const envPath = String(process.env[SULLA_RESOURCES_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaHomeDir(), 'resources');
}

export function resolveSullaProjectsDir(): string {
  const envPath = String(process.env[SULLA_PROJECTS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaHomeDir(), 'projects');
}

export function resolveSullaSkillsDir(): string {
  const envPath = String(process.env[SULLA_SKILLS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaResourcesDir(), 'skills');
}

export function resolveSullaWorkspacesDir(): string {
  const envPath = String(process.env[SULLA_WORKSPACES_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaHomeDir(), 'workspaces');
}

export function resolveSullaAgentsDir(): string {
  const envPath = String(process.env[SULLA_AGENTS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaResourcesDir(), 'agents');
}

export function resolveSullaWorkflowsDir(): string {
  const envPath = String(process.env[SULLA_WORKFLOWS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaResourcesDir(), 'workflows');
}

export function resolveSullaWorkflowsDraftDir(): string {
  return path.join(resolveSullaWorkflowsDir(), 'draft');
}

export function resolveSullaWorkflowsProductionDir(): string {
  return path.join(resolveSullaWorkflowsDir(), 'production');
}

export function resolveSullaWorkflowsArchiveDir(): string {
  return path.join(resolveSullaWorkflowsDir(), 'archive');
}

export function resolveSullaIntegrationsDir(): string {
  const envPath = String(process.env[SULLA_INTEGRATIONS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaResourcesDir(), 'integrations');
}

// ── User-level directories (~/sulla/{type}) for custom user content ──

export function resolveSullaUserSkillsDir(): string {
  return path.join(resolveSullaHomeDir(), 'skills');
}

export function resolveSullaUserAgentsDir(): string {
  return path.join(resolveSullaHomeDir(), 'agents');
}

export function resolveSullaUserWorkflowsDir(): string {
  return path.join(resolveSullaHomeDir(), 'workflows');
}

export function resolveSullaUserWorkflowsProductionDir(): string {
  return path.join(resolveSullaUserWorkflowsDir(), 'production');
}

export function resolveSullaUserWorkflowsDraftDir(): string {
  return path.join(resolveSullaUserWorkflowsDir(), 'draft');
}

export function resolveSullaUserWorkflowsArchiveDir(): string {
  return path.join(resolveSullaUserWorkflowsDir(), 'archive');
}

export function resolveSullaUserIntegrationsDir(): string {
  return path.join(resolveSullaHomeDir(), 'integrations');
}

// ── Aggregate resolvers — return all directories for a resource type ──

export function resolveAllSkillsDirs(): string[] {
  return [resolveSullaSkillsDir(), resolveSullaUserSkillsDir()];
}

export function resolveAllAgentsDirs(): string[] {
  return [resolveSullaAgentsDir(), resolveSullaUserAgentsDir()];
}

export function resolveAllWorkflowsProductionDirs(): string[] {
  return [resolveSullaWorkflowsProductionDir(), resolveSullaUserWorkflowsProductionDir()];
}

export function resolveAllIntegrationsDirs(): string[] {
  return [resolveSullaIntegrationsDir(), resolveSullaUserIntegrationsDir()];
}

/**
 * Validate that an agent ID is a simple, safe identifier (not a path).
 * Allows letters, digits, dot, underscore, and dash.
 */
function isValidAgentId(agentId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(agentId);
}

/**
 * Resolve an agent ID to its directory path, searching all agent directories.
 * Returns the first match found (resources first, then user), or null.
 */
export function findAgentDir(agentId: string): string | null {
  if (!isValidAgentId(agentId)) {
    return null;
  }

  for (const root of resolveAllAgentsDirs()) {
    const candidate = path.join(root, agentId);
    const resolved = path.resolve(candidate);

    // Ensure the resolved path is within the agents root directory
    const rootWithSep = path.resolve(root) + path.sep;
    if (!resolved.startsWith(rootWithSep)) {
      continue;
    }

    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

export function resolveSullaTrainingDir(): string {
  return path.join(resolveSullaHomeDir(), 'training');
}

export function resolveSullaLogsDir(): string {
  return path.join(resolveSullaHomeDir(), 'logs');
}

export function resolveSullaCodebaseDir(): string {
  const envPath = String(process.env[SULLA_CODEBASE_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(os.homedir(), '.sulla-desktop');
}

export function resolveSullaConversationsDir(): string {
  const envPath = String(process.env[SULLA_CONVERSATIONS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaHomeDir(), 'conversations');
}

const BOOTSTRAP_REPOS: { dir: () => string; repo: string }[] = [
  { dir: resolveSullaResourcesDir, repo: 'https://github.com/merchantprotocol/sulla-resources.git' },
];

export async function bootstrapSullaHome(): Promise<void> {
  const home = resolveSullaHomeDir();
  const logsDir = resolveSullaLogsDir();

  const trainingDir = resolveSullaTrainingDir();
  const conversationsDir = resolveSullaConversationsDir();

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(trainingDir, { recursive: true });
  fs.mkdirSync(conversationsDir, { recursive: true });

  // Clone default repos before creating subfolders — check for .git to detect
  // whether the directory is a real clone vs an empty dir created by mkdirSync.
  for (const { dir, repo } of BOOTSTRAP_REPOS) {
    const target = dir();
    if (fs.existsSync(path.join(target, '.git'))) {
      try {
        console.log(`[Sulla] Fetching latest for ${ target }`);
        await execFileAsync('git', ['-C', target, 'fetch', 'origin']);
        await execFileAsync('git', ['-C', target, 'reset', '--hard', '@{u}']);
        console.log(`[Sulla] Updated ${ target } successfully`);
      } catch (err) {
        console.error(`[Sulla] Failed to update ${ target }:`, err);
      }
      continue;
    }
    try {
      console.log(`[Sulla] Cloning ${ repo } into ${ target }`);
      await execFileAsync('git', ['clone', repo, target]);
      console.log(`[Sulla] Cloned ${ repo } successfully`);
    } catch (err) {
      console.error(`[Sulla] Failed to clone ${ repo }:`, err);
    }
  }

  // Ensure workflow subfolders exist (after clone so they don't block it)
  fs.mkdirSync(resolveSullaWorkflowsDraftDir(), { recursive: true });
  fs.mkdirSync(resolveSullaWorkflowsProductionDir(), { recursive: true });
  fs.mkdirSync(resolveSullaWorkflowsArchiveDir(), { recursive: true });

  // Ensure user-level directories exist for custom content
  fs.mkdirSync(resolveSullaUserSkillsDir(), { recursive: true });
  fs.mkdirSync(resolveSullaUserAgentsDir(), { recursive: true });
  fs.mkdirSync(resolveSullaUserWorkflowsProductionDir(), { recursive: true });
  fs.mkdirSync(resolveSullaUserWorkflowsDraftDir(), { recursive: true });
  fs.mkdirSync(resolveSullaUserWorkflowsArchiveDir(), { recursive: true });
  fs.mkdirSync(resolveSullaUserIntegrationsDir(), { recursive: true });
}
