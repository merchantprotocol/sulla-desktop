import path from 'node:path';

import { WorkFileClaimModel, WorkFileClaimRecord } from '../../database/models/WorkFileClaimModel';
import { runCommand } from '../util/CommandRunner';

function shellQuote(value: string): string {
  return `'${ value.replace(/'/g, `'"'"'`) }'`;
}

export async function resolveRepository(absolutePath: string): Promise<{ repoRoot: string; worktreePath: string }> {
  const worktree = await runCommand(
    `git -C ${ shellQuote(absolutePath) } rev-parse --show-toplevel`,
    [], { runInLimaShell: true, timeoutMs: 30_000 },
  );
  if (worktree.exitCode !== 0) throw new Error(worktree.stderr || worktree.stdout || 'Not a git repository');

  const common = await runCommand(
    `git -C ${ shellQuote(absolutePath) } rev-parse --path-format=absolute --git-common-dir`,
    [], { runInLimaShell: true, timeoutMs: 30_000 },
  );
  if (common.exitCode !== 0) throw new Error(common.stderr || common.stdout || 'Could not resolve git common directory');

  const commonDir = path.resolve(common.stdout.trim());
  const repoRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;

  return { repoRoot, worktreePath: path.resolve(worktree.stdout.trim()) };
}

export function normalizeClaimGlob(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Claim paths must be non-empty repository-relative globs: ${ value }`);
  }
  return normalized;
}

export function globMatches(file: string, glob: string): boolean {
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${ source }$`).test(file.replace(/\\/g, '/'));
}

export async function changedFiles(worktreePath: string): Promise<string[]> {
  const commands = [
    'git diff --name-only --cached',
    'git diff --name-only',
    'git ls-files --others --exclude-standard',
  ];
  const files = new Set<string>();
  for (const command of commands) {
    const result = await runCommand(
      `git -C ${ shellQuote(worktreePath) } ${ command.slice(4) }`,
      [], { runInLimaShell: true, timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) continue;
    result.stdout.split('\n').map(line => line.trim()).filter(Boolean).forEach(file => files.add(file));
  }
  return [...files].sort();
}

export function formatClaimWarnings(
  files: string[],
  claims: WorkFileClaimRecord[],
  currentWorktreePath: string,
): string {
  const conflicts = files.flatMap(file => claims
    .filter(claim => path.resolve(claim.worktree_path) !== path.resolve(currentWorktreePath))
    .filter(claim => globMatches(file, claim.path_glob))
    .map(claim => ({ file, claim })));
  if (!conflicts.length) return '';

  const lines = conflicts.map(({ file, claim }) =>
    `  ${ file } matches "${ claim.path_glob }" claimed by ${ claim.owner_label }` +
    `${ claim.owner_job_id ? ` (job ${ claim.owner_job_id })` : '' } in ${ claim.worktree_path }`);
  return `WARNING: ${ conflicts.length } changed file(s) match another worker's active claim:\n${ lines.join('\n') }`;
}

export async function claimWarningsForChangedFiles(absolutePath: string): Promise<string> {
  try {
    const resolved = await resolveRepository(absolutePath);
    const [files, claims] = await Promise.all([
      changedFiles(resolved.worktreePath),
      WorkFileClaimModel.listActive(resolved.repoRoot),
    ]);
    return formatClaimWarnings(files, claims, resolved.worktreePath);
  } catch (error) {
    return `WARNING: Could not check active file claims: ${ (error as Error).message }`;
  }
}
