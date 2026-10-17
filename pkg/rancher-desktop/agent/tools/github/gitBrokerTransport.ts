import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';

import { requireConfiguredCredentialBroker } from '../../../vault-broker';
import { getIntegrationService } from '../../services/IntegrationService';

import type { ToolExecutionContext } from '../executionContext';

const MAX_GIT_REQUEST_BYTES = 128 * 1024 * 1024;

function githubRepositoryPath(remoteUrl: string): string {
  const normalized = remoteUrl.startsWith('git@github.com:')
    ? `https://github.com/${ remoteUrl.slice('git@github.com:'.length) }`
    : remoteUrl;
  const url = new URL(normalized);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error('github.git broker transport only supports https://github.com repositories');
  }
  const path = url.pathname.replace(/\/$/, '');
  if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(path)) {
    throw new Error('GitHub remote must identify exactly one owner/repository');
  }
  return path.endsWith('.git') ? path : `${ path }.git`;
}

async function readBody(request: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_GIT_REQUEST_BYTES) throw new Error('github.git request exceeds local broker bound');
    chunks.push(buffer);
  }
  if (!chunks.length) return undefined;
  return Buffer.concat(chunks, total).toString('base64');
}

export async function withGitHubBrokerRemote<T>(
  ctx: ToolExecutionContext | undefined,
  remoteUrl: string,
  run: (proxyUrl: string) => Promise<T>,
): Promise<T> {
  if (!ctx) throw new Error('github.git requires a verified tool execution context');
  const repositoryPath = githubRepositoryPath(remoteUrl);
  const repository = repositoryPath.slice(1).replace(/\.git$/, '');
  const transportToken = crypto.randomBytes(24).toString('base64url');
  const scopedPath = `/${ transportToken }${ repositoryPath }`;
  const accountId = await getIntegrationService().getActiveAccountId('github');
  const scope = ctx.credential_scope;
  if (scope?.integration_id !== 'github' || scope.account_id !== accountId || scope.repository !== repository) {
    throw new Error('github.git requires a signed credential scope for the active account and repository');
  }
  const broker = requireConfiguredCredentialBroker();

  const server = http.createServer(async(request, response) => {
    const abort = new AbortController();
    request.once('aborted', () => abort.abort());
    try {
      const incoming = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!incoming.pathname.startsWith(`${ scopedPath }/`)) {
        response.writeHead(404).end();
        return;
      }
      const headers = Object.fromEntries(Object.entries(request.headers)
        .filter(([name, value]) => name.toLowerCase() !== 'authorization' && typeof value === 'string') as [string, string][]);
      const body = await readBody(request);
      const brokerRequest = broker.requestFor(ctx, {
        operation:    'github.git',
        ref:          { integrationId: 'github', accountId },
        url:          `https://github.com${ incoming.pathname.slice(transportToken.length + 1) }${ incoming.search }`,
        method:       request.method ?? 'GET',
        headers,
        ...(body === undefined ? {} : { body, bodyEncoding: 'base64' as const }),
        injections:   [{ field: 'token', target: 'header', name: 'authorization', scheme: 'GitHubBasic' }],
        responseType: 'binary-stream',
      });
      const upstream = await broker.executeStream(brokerRequest, abort.signal);
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      if (upstream.body) Readable.fromWeb(upstream.body as any).pipe(response);
      else response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'github.git broker failed');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('github.git broker did not bind a TCP port');
  try {
    return await run(`http://127.0.0.1:${ address.port }${ scopedPath }`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
