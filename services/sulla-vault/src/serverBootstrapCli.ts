import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';

import {
  createUserKey, createUserKeyPair, deriveLoginHash, deriveMasterKey, encryptWithKey, generateKey,
  wrapOrgKeyForMember,
} from '@sulla/vault-crypto';

function argument(name: string): string {
  const index = process.argv.indexOf(`--${ name }`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${ name } is required`);
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

async function main(): Promise<void> {
  const url = argument('url').replace(/\/$/, '');
  const email = argument('email').trim().toLowerCase();
  const displayName = argument('name').trim();
  const organization = argument('organization').trim();
  const token = process.env.SULLA_VAULT_SERVER_BOOTSTRAP_TOKEN;
  if (!token) throw new Error('SULLA_VAULT_SERVER_BOOTSTRAP_TOKEN is required');
  const statusResponse = await fetch(`${ url }/v1/server/bootstrap`, { headers: { 'x-sulla-bootstrap-token': token } });
  const status = await statusResponse.json() as { bootstrapped?: boolean; error?: string };
  if (!statusResponse.ok) throw new Error(status.error ?? `Bootstrap status failed (${ statusResponse.status })`);
  if (status.bootstrapped) {
    process.stdout.write('Server is already bootstrapped; existing data was preserved.\n');
    return;
  }
  const password = hiddenLine('First admin password: ');
  const confirmation = hiddenLine('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');
  if (password.length < 12) throw new Error('Password must contain at least 12 characters');

  const master = await deriveMasterKey(password);
  const loginHash = await deriveLoginHash(master.key);
  const { userKey, encryptedUserKey } = await createUserKey(master.key);
  const pair = await createUserKeyPair(userKey);
  const orgKey = await generateKey();
  const encryptedOrgName = await encryptWithKey(new TextEncoder().encode(organization), orgKey, 'sulla:org-name:v1');
  const wrappedOrgKey = await wrapOrgKeyForMember(orgKey, pair.publicKey);
  master.key.fill(0); userKey.fill(0); pair.privateKey.fill(0); orgKey.fill(0);

  const response = await fetch(`${ url }/v1/server/bootstrap`, {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'x-sulla-bootstrap-token': token },
    body:    JSON.stringify({
      email,
      displayName,
      loginHash,
      publicKey:           pair.publicKey,
      encryptedPrivateKey: pair.encryptedPrivateKey,
      encryptedUserKey,
      kdf:                 { salt: master.salt, parameters: master.parameters },
      encryptedOrgName,
      wrappedOrgKey,
    }),
  });
  const result = await response.json() as { status?: string; error?: string };
  if (!response.ok) throw new Error(result.error ?? `Bootstrap failed (${ response.status })`);
  process.stdout.write(`${ result.status === 'created' ? 'First owner created.' : 'Server is already bootstrapped; existing data was preserved.' }\n`);
}

main().catch((error) => {
  process.stderr.write(`Error: ${ error instanceof Error ? error.message : String(error) }\n`);
  process.exitCode = 1;
});
