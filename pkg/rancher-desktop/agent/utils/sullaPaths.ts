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

export function resolveSullaIntegrationsDir(): string {
  const envPath = String(process.env[SULLA_INTEGRATIONS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaHomeDir(), 'integrations');
}

export function resolveSullaTrainingDir(): string {
  return path.join(resolveSullaHomeDir(), 'training');
}

export function resolveSullaLogsDir(): string {
  return path.join(resolveSullaHomeDir(), 'logs');
}

export function resolveSullaConversationsDir(): string {
  const envPath = String(process.env[SULLA_CONVERSATIONS_DIR_ENV] || '').trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
  }

  return path.join(resolveSullaHomeDir(), 'conversations');
}

const BOOTSTRAP_REPOS: { dir: () => string; repo: string }[] = [
  { dir: resolveSullaAgentsDir, repo: 'https://github.com/merchantprotocol/agents.git' },
  { dir: resolveSullaSkillsDir, repo: 'https://github.com/merchantprotocol/skills.git' },
  { dir: resolveSullaWorkflowsDir, repo: 'https://github.com/merchantprotocol/workflows.git' },
  { dir: resolveSullaIntegrationsDir, repo: 'https://github.com/merchantprotocol/integrations.git' },
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
