// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { withGitHubBrokerRemote } from './gitBrokerTransport';
import { GitTraceSummary } from './gitTraceSummary';
import { usesContainerVaultAuthority } from '../../../vault-broker';
import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

function quote(value: string): string {
  return `'${ value.replace(/'/g, `'"'"'`) }'`;
}

/** Clone a GitHub repository without persisting credentials in its remote. */
export class GitCloneWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
    const absolutePath = typeof input.absolutePath === 'string' ? input.absolutePath.trim() : '';
    const branch = typeof input.branch === 'string' ? input.branch.trim() : '';
    const depth = input.depth;
    const filter = input.filter;
    const trace = input.trace === true;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      return { successBoolean: false, responseString: 'owner and repo must be valid GitHub path components.' };
    }
    if (!absolutePath.startsWith('/')) return { successBoolean: false, responseString: 'absolutePath must be an absolute path.' };
    if (input.depth !== undefined && (!Number.isInteger(depth) || depth < 1)) {
      return { successBoolean: false, responseString: 'depth must be a positive integer.' };
    }
    if (filter !== undefined && filter !== 'blob:none') {
      return { successBoolean: false, responseString: 'filter must be blob:none when provided.' };
    }
    const remoteUrl = `https://github.com/${ owner }/${ repo.replace(/\.git$/, '') }.git`;
    const localAuthority = usesContainerVaultAuthority();
    let token: string | undefined;
    let brokerUrl: string | undefined;
    const traceSuffix = (stderr: string) => trace ? `\nGit HTTP trace (redacted):\n${ GitTraceSummary.redact(stderr, brokerUrl) || '(no HTTP trace lines captured)' }` : '';
    const redact = (text: string) => {
      const withoutToken = token ? text.split(token).join('***') : text;
      return GitTraceSummary.redactCredentials(withoutToken, brokerUrl);
    };
    try {
      if (!localAuthority) token = (await getIntegrationService().getIntegrationValue('github', 'token'))?.value;
      const traceEnv = trace ? 'GIT_TRACE_CURL=1 GIT_CURL_VERBOSE=1 ' : '';
      const args = [
        `${ traceEnv }git clone${ branch ? ` --branch ${ quote(branch) }` : ''}${ depth ? ` --depth ${ depth }` : ''}${ filter ? ' --filter=blob:none' : ''} ${ quote(remoteUrl) } ${ quote(absolutePath) }`,
      ];
      const clone = (target: string) => runCommand(target, [], { runInGuest: true, timeoutMs: 1_800_000 });
      let result;
      if (localAuthority) {
        result = await withGitHubBrokerRemote(this.executionContext, remoteUrl, proxyUrl => {
          brokerUrl = proxyUrl;
          return clone(`${ traceEnv }git clone${ branch ? ` --branch ${ quote(branch) }` : ''}${ depth ? ` --depth ${ depth }` : ''}${ filter ? ' --filter=blob:none' : ''} ${ quote(proxyUrl) } ${ quote(absolutePath) }`);
        });
      } else if (token) {
        const helper = `'!f(){ test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GH_PAT"; }; f'`;
        result = await clone(`${ traceEnv }GH_PAT=${ quote(token) } GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.helper=${ helper } clone${ branch ? ` --branch ${ quote(branch) }` : ''}${ depth ? ` --depth ${ depth }` : ''}${ filter ? ' --filter=blob:none' : ''} ${ quote(remoteUrl) } ${ quote(absolutePath) }`);
      } else {
        result = await clone(args[0]);
      }
      // Do not leave the broker's one-use URL or any credential in .git/config.
      const reset = await runCommand(`git -C ${ quote(absolutePath) } remote set-url origin ${ quote(remoteUrl) }`, [], { runInGuest: true, timeoutMs: 10_000 });
      if (reset.exitCode !== 0) {
        // A partial clone can still have initialized .git/config; remove its
        // origin entry rather than leave a one-use secret persisted there.
        await runCommand(`git -C ${ quote(absolutePath) } remote remove origin`, [], { runInGuest: true, timeoutMs: 10_000 });
        if (result.exitCode !== 0) return { successBoolean: false, responseString: redact(`Git clone failed: ${ result.stderr || result.stdout }${ traceSuffix(result.stderr) }`) };
        return { successBoolean: false, responseString: redact(`The token-free origin could not be set: ${ reset.stderr || reset.stdout }`) };
      }
      if (result.exitCode !== 0) return { successBoolean: false, responseString: redact(`Git clone failed: ${ result.stderr || result.stdout }${ traceSuffix(result.stderr) }`) };
      return { successBoolean: true, responseString: `Cloned ${ owner }/${ repo } to ${ absolutePath }.` };
    } catch (error) {
      return { successBoolean: false, responseString: redact(`Git clone failed: ${(error as Error).message}${ traceSuffix('') }`) };
    }
  }
}
