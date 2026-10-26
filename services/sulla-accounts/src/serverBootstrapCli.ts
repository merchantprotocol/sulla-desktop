// SPDX-License-Identifier: LicenseRef-Sulla-Fair-Code
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function hiddenLine(prompt: string): string {
  const tty = openSync('/dev/tty', 'r+');
  writeSync(tty, prompt);
  try {
    execFileSync('stty', ['-echo'], { stdio: [tty, tty, tty] });
    const bytes: number[] = [];
    const byte = Buffer.alloc(1);
    while (readSync(tty, byte, 0, 1, null) === 1 && byte[0] !== 10 && byte[0] !== 13) bytes.push(byte[0]);
    writeSync(tty, '\n');
    return Buffer.from(bytes).toString('utf8');
  } finally {
    try {
      execFileSync('stty', ['echo'], { stdio: [tty, tty, tty] });
    } finally {
      closeSync(tty);
    }
  }
}

function organizationSlug(name: string): string {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/g, '');
  return slug || 'organization';
}

function trustedOrigin(input: string): string {
  const url = new URL(input);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('--url must be an HTTPS origin or a loopback HTTP origin');
  }
  return url.origin;
}

async function request(url: string, token: string, init: RequestInit = {}, timeout = 30_000): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = await response.json() as Record<string, unknown>;
  return { response, body };
}

async function bootstrapped(endpoint: string, token: string): Promise<boolean> {
  const status = await request(endpoint, token, {}, 10_000);
  if (!status.response.ok) throw new Error(String(status.body.error ?? `Accounts bootstrap status failed (${status.response.status})`));
  return status.body.bootstrapped === true;
}

async function reconcileTimedOutBootstrap(endpoint: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    try {
      if (await bootstrapped(endpoint, token)) return true;
    } catch {
      // The local service may still be saturated by the original request. Keep
      // the retry bounded and never treat an unavailable status as success.
    }
  }
  return false;
}

async function main(): Promise<void> {
  const url = trustedOrigin(argument('url'));
  const email = argument('email').trim().toLowerCase();
  const displayName = argument('name').trim();
  const organizationName = argument('organization').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('First admin email is invalid');
  if (!displayName) throw new Error('First admin name is required');
  if (!organizationName) throw new Error('Organization name is required');
  const token = readFileSync(argument('token-file'), 'utf8').trim();
  if (Buffer.byteLength(token) < 32) throw new Error('Accounts bootstrap credential is invalid');
  const endpoint = `${url}/v1/admin/setup/first-owner`;
  if (await bootstrapped(endpoint, token)) {
    process.stdout.write('First organization administrator already exists; existing credentials were preserved.\n');
    return;
  }

  const password = hiddenLine('First account password: ');
  const confirmation = hiddenLine('Confirm account password: ');
  if (password !== confirmation) throw new Error('Account passwords do not match');
  if (password.length < 12) throw new Error('Account password must contain at least 12 characters');
  const body = JSON.stringify({
    email, displayName, password,
    organizationName,
    organizationSlug: organizationSlug(organizationName),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: Awaited<ReturnType<typeof request>>;
    try {
      result = await request(endpoint, token, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
    } catch (error) {
      if (await reconcileTimedOutBootstrap(endpoint, token)) {
        process.stdout.write('First organization administrator created; completion was confirmed after the initial request timed out.\n');
        return;
      }
      if (attempt === 1) throw error;
      continue;
    }
    if (!result.response.ok) throw new Error(String(result.body.error ?? `Accounts bootstrap failed (${result.response.status})`));
    process.stdout.write(result.body.status === 'created'
      ? 'First organization administrator created.\n'
      : 'First organization administrator already exists; existing credentials were preserved.\n');
    return;
  }
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
