import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

function quote(value: string): string {
  return `'${ value.replace(/'/g, `'"'"'`) }'`;
}

async function remoteRefs(repoRoot: string, remote: string): Promise<Map<string, string>> {
  const result = await runCommand(
    `git -C ${ quote(repoRoot) } for-each-ref --format='%(refname:short) %(objectname)' ${ quote(`refs/remotes/${ remote }`) }`,
    [], { runInLimaShell: true, timeoutMs: 30_000 },
  );
  const refs = new Map<string, string>();
  if (result.exitCode === 0) {
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const separator = line.lastIndexOf(' ');
      refs.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return refs;
}

export class GitFetchWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const absolutePath = typeof input.absolutePath === 'string' ? input.absolutePath.trim() : '';
    const remote = typeof input.remote === 'string' && input.remote.trim() ? input.remote.trim() : 'origin';
    const branch = typeof input.branch === 'string' && input.branch.trim() ? input.branch.trim() : '';
    const prune = input.prune === true;
    if (!absolutePath) return { successBoolean: false, responseString: 'absolutePath is required.' };

    let token: string | undefined;
    const redact = (value: string) => token ? value.split(token).join('***') : value;
    try {
      const rootResult = await runCommand(
        `git -C ${ quote(absolutePath) } rev-parse --show-toplevel`,
        [], { runInLimaShell: true, timeoutMs: 30_000 },
      );
      if (rootResult.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git error: ${ rootResult.stderr || rootResult.stdout }` };
      }
      const repoRoot = rootResult.stdout.trim();
      const before = await remoteRefs(repoRoot, remote);

      let fetchTarget = remote;
      let authPrefix = '';
      let credFlags = '';
      const tokenValue = await getIntegrationService().getIntegrationValue('github', 'token');
      token = tokenValue?.value;
      if (token) {
        const remoteUrlResult = await runCommand(
          `git -C ${ quote(repoRoot) } remote get-url ${ quote(remote) }`,
          [], { runInLimaShell: true, timeoutMs: 10_000 },
        );
        let remoteUrl = remoteUrlResult.stdout.trim();
        if (remoteUrl.includes('github.com')) {
          if (remoteUrl.startsWith('git@github.com:')) {
            remoteUrl = `https://github.com/${ remoteUrl.slice('git@github.com:'.length) }`;
          }
          fetchTarget = quote(remoteUrl);
          const helper = `'!f(){ test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GH_PAT"; }; f'`;
          credFlags = `-c credential.helper= -c credential.helper=${ helper } `;
          authPrefix = `GH_PAT=${ quote(token) } GIT_TERMINAL_PROMPT=0 `;
        }
      }

      // We fetch by token-free HTTPS URL for authentication, so explicitly
      // supply the destination refspec that a named remote would otherwise
      // contribute from remote.<name>.fetch.
      const refspec = branch
        ? ` ${ quote(`+refs/heads/${ branch }:refs/remotes/${ remote }/${ branch }`) }`
        : ` ${ quote(`+refs/heads/*:refs/remotes/${ remote }/*`) }`;
      const command = `${ authPrefix }git ${ credFlags }-C ${ quote(repoRoot) } fetch${ prune ? ' --prune' : '' } ${ fetchTarget }${ refspec }`;
      const result = await runCommand(command, [], { runInLimaShell: true, timeoutMs: 120_000 });
      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: redact(`Git fetch failed: ${ result.stderr || result.stdout }`) };
      }

      const after = await remoteRefs(repoRoot, remote);
      const updates: string[] = [];
      for (const [name, sha] of after) {
        const previous = before.get(name);
        if (!previous) updates.push(`  [new] ${ name } -> ${ sha.slice(0, 12) }`);
        else if (previous !== sha) updates.push(`  ${ name }: ${ previous.slice(0, 12) } -> ${ sha.slice(0, 12) }`);
      }
      for (const [name, sha] of before) {
        if (!after.has(name)) updates.push(`  [deleted] ${ name } (was ${ sha.slice(0, 12) })`);
      }

      return {
        successBoolean: true,
        responseString: updates.length
          ? `Fetched ${ remote }${ branch ? `/${ branch }` : '' }; updated remote-tracking refs:\n${ updates.join('\n') }`
          : `Fetched ${ remote }${ branch ? `/${ branch }` : '' }; remote-tracking refs already current.`,
      };
    } catch (error) {
      return { successBoolean: false, responseString: redact(`Git fetch failed: ${ (error as Error).message }`) };
    }
  }
}
