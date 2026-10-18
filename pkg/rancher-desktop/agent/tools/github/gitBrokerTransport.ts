import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { requireConfiguredCredentialBroker } from '../../../vault-broker';
import { getIntegrationService } from '../../services/IntegrationService';

import type { ToolExecutionContext } from '../executionContext';

const MAX_GIT_REQUEST_BYTES = 128 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function brokerHeaders(headers: http.IncomingHttpHeaders | Headers): Record<string, string> {
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  return Object.fromEntries([...entries].flatMap(([name, value]) => {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || typeof value !== 'string') return [];
    return [[name, value]];
  }));
}

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

/** Narrow a verified GitHub caller context to the repository resolved by git. */
export function scopeGitHubRepositoryContext(
  ctx: ToolExecutionContext,
  accountId: string,
  repository: string,
): ToolExecutionContext {
  const scope = ctx.credential_scope;
  if (scope && (
    scope.integration_id !== 'github' ||
    scope.account_id !== accountId ||
    (scope.repository !== undefined && scope.repository !== repository)
  )) {
    throw new Error('github.git requires a signed credential scope for the active account and repository');
  }
  return {
    ...ctx,
    credential_scope: { integration_id: 'github', account_id: accountId, repository },
  };
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
  // For agent-local Git the tools service cannot inspect absolutePath because
  // that path exists only in the worker. The canonical Git worker resolves the
  // remote first; narrow the already-verified caller context here from that URL.
  const brokerContext = scopeGitHubRepositoryContext(ctx, accountId, repository);
  const broker = requireConfiguredCredentialBroker();

  const server = http.createServer(async(request, response) => {
    const abort = new AbortController();
    request.once('aborted', () => abort.abort());
    request.once('close', () => {
      if (!request.complete) abort.abort();
    });
    response.once('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    try {
      const incoming = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!incoming.pathname.startsWith(`${ scopedPath }/`)) {
        response.writeHead(404).end();
        return;
      }
      const headers = brokerHeaders(request.headers);
      const body = await readBody(request);
      const brokerRequest = broker.requestFor(brokerContext, {
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
      response.writeHead(upstream.status, brokerHeaders(upstream.headers));
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as any), response);
      else response.end();
    } catch {
      abort.abort();
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('github.git broker failed');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Git commands always run in Lima (or an agent container inside Lima), so
    // host loopback is unreachable even when there is no container binding.
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('github.git broker did not bind a TCP port');
  try {
    return await run(`http://host.lima.internal:${ address.port }${ scopedPath }`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
