// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 30_000;
const POLL_CEILING_MS = 60 * 60 * 1_000;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function run(command, args) {
  try {
    return await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();

    throw new Error(`${ command } failed${ output ? `:\n${ output }` : '' }`, { cause: error });
  }
}

function jsonOutput(result) {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Apple returned invalid JSON: ${ output || '(empty output)' }`, { cause: error });
  }
}

function submissionIdFromError(error) {
  const output = [error.cause?.stdout, error.cause?.stderr].filter(Boolean).join('\n').trim();

  if (!output) return null;
  try {
    return JSON.parse(output).id || null;
  } catch {
    return null;
  }
}

function authArguments() {
  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  const key = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  const appleIdValues = [appleId, password, teamId];
  const apiKeyValues = [key, keyId, issuer];

  if (appleIdValues.every(Boolean)) {
    return ['--apple-id', appleId, '--password', password, '--team-id', teamId];
  }
  if (apiKeyValues.every(Boolean)) {
    return ['--key', key, '--key-id', keyId, '--issuer', issuer];
  }
  if (appleIdValues.some(Boolean) || apiKeyValues.some(Boolean)) {
    throw new Error('Incomplete Apple notarization credentials. Provide APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID, or APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER.');
  }
  return null;
}

async function submit(zipPath, authArgs) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await run('xcrun', ['notarytool', 'submit', zipPath, ...authArgs, '--output-format', 'json', '--no-wait']);
      const id = jsonOutput(result).id;

      if (id) return id;
      lastError = new Error('notarytool submit returned no submission id.');
    } catch (error) {
      // notarytool can lose its connection after Apple has accepted the
      // upload. Never create a duplicate submission if its output contained
      // the durable id despite returning a non-zero exit code.
      const id = submissionIdFromError(error);

      if (id) return id;
      lastError = error;
    }

    if (attempt < 3) {
      console.warn(`Notarization submission did not return an id (attempt ${ attempt }/3); retrying in 30 seconds.`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  throw lastError;
}

async function waitForResult(id, authArgs) {
  const startedAt = Date.now();
  let transientFailures = 0;

  while (Date.now() - startedAt < POLL_CEILING_MS) {
    try {
      const result = await run('xcrun', ['notarytool', 'info', id, ...authArgs, '--output-format', 'json']);
      const info = jsonOutput(result);
      const status = info.status;

      transientFailures = 0;
      if (status === 'Accepted') return;
      if (status === 'Invalid' || status === 'Rejected') {
        let log = '(notarytool log could not be retrieved)';

        try {
          const result = await run('xcrun', ['notarytool', 'log', id, ...authArgs]);
          log = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        } catch (error) {
          log = error.message;
        }
        throw new Error(`Apple notarization ${ status.toLowerCase() } submission ${ id }:\n${ log }`);
      }
      console.log(`Notarization submission ${ id } status: ${ status || 'unknown' }.`);
    } catch (error) {
      if (/notarization (invalid|rejected) submission/.test(error.message)) throw error;
      transientFailures++;
      console.warn(`Could not read notarization status for ${ id } (transient failure ${ transientFailures }); retrying.`);
    }

    const backoff = Math.min(POLL_INTERVAL_MS * Math.max(1, transientFailures), 5 * 60_000);
    const remaining = POLL_CEILING_MS - (Date.now() - startedAt);

    if (remaining > 0) await sleep(Math.min(backoff, remaining));
  }

  throw new Error(`Timed out after 60 minutes waiting for Apple notarization submission ${ id }.`);
}

async function retryStapler(action, appPath) {
  let lastError;

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await run('xcrun', ['stapler', action, appPath]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 6) {
        console.warn(`stapler ${ action } failed (attempt ${ attempt }/6); retrying in 30 seconds.`);
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  throw lastError;
}

export default async function notarizeWithRetry(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const authArgs = authArguments();

  if (!authArgs) {
    console.log('Apple notarization credentials are not present; skipping notarization.');
    return;
  }

  const appPath = path.join(context.appOutDir, `${ context.packager.appInfo.productFilename }.app`);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sulla-notarize-'));
  const zipPath = path.join(temporaryDirectory, 'Sulla Desktop.zip');

  try {
    console.log(`Creating notarization archive for ${ path.basename(appPath) }.`);
    await run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
    const id = await submit(zipPath, authArgs);

    console.log(`Apple accepted notarization submission ${ id }; polling it for up to 60 minutes.`);
    await waitForResult(id, authArgs);
    console.log(`Notarization submission ${ id } accepted; stapling ticket.`);
    await retryStapler('staple', appPath);
    await retryStapler('validate', appPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
