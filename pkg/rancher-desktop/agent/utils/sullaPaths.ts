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

export function resolveSullaHomeDir(): string {
  const envPath = String(process.env[SULLA_HOME_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(os.homedir(), 'sulla');
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

  return path.join(resolveSullaHomeDir(), 'skills');
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

  return path.join(resolveSullaHomeDir(), 'agents');
}

export function resolveSullaWorkflowsDir(): string {
  const envPath = String(process.env[SULLA_WORKFLOWS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaHomeDir(), 'workflows');
}

export function resolveSullaConversationsDir(): string {
  const envPath = String(process.env[SULLA_CONVERSATIONS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaHomeDir(), 'conversations');
}

const BOOTSTRAP_REPOS: { dir: () => string; repo: string }[] = [
  { dir: resolveSullaAgentsDir, repo: 'https://github.com/sulla-ai/agents.git' },
  { dir: resolveSullaSkillsDir, repo: 'https://github.com/sulla-ai/skills.git' },
  { dir: resolveSullaWorkflowsDir, repo: 'https://github.com/sulla-ai/workflows.git' },
];

export async function bootstrapSullaHome(): Promise<void> {
  const home = resolveSullaHomeDir();
  const conversationsDir = resolveSullaConversationsDir();

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(conversationsDir, { recursive: true });

  for (const { dir, repo } of BOOTSTRAP_REPOS) {
    const target = dir();
    if (fs.existsSync(target)) {
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
}
