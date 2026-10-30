// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import paths from '@pkg/utils/paths';

const SERVICE = 'Sulla';
const ACCOUNT = 'Sulla recovery key';
const STATUS_PATH = path.join(paths.appHome, 'recovery-key-storage.json');

export interface RecoveryKeyStorageStatus {
  location: 'icloud-keychain' | 'local-keychain' | 'unavailable';
  label: string;
  checkedAt: string;
}

function run(executable: string, args: string[], stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.end(stdin);
    let error = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (error.length < 512) error += chunk });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(error.trim() || `Keychain helper exited ${ code }`)));
  });
}

function read(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let value = ''; let error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (value.length < 128) value += chunk });
    child.stderr.on('data', chunk => { if (error.length < 512) error += chunk });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(value.trim()) : reject(new Error(error.trim() || `Keychain helper exited ${ code }`)));
  });
}

function record(location: RecoveryKeyStorageStatus['location']): RecoveryKeyStorageStatus {
  const status = {
    location,
    label: location === 'icloud-keychain' ? 'Saved in iCloud Keychain' :
      location === 'local-keychain' ? 'Saved on this Mac only' : 'Recovery key is not saved',
    checkedAt: new Date().toISOString(),
  } satisfies RecoveryKeyStorageStatus;
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATUS_PATH, JSON.stringify(status), { mode: 0o600 });
  return status;
}

/** Store an account recovery key as a discoverable macOS generic password. */
export async function saveRecoveryKeyToMacKeychain(_accountId: string, recoveryKey: string): Promise<RecoveryKeyStorageStatus> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(recoveryKey)) throw new Error('Recovery-key material is invalid');
  if (process.platform !== 'darwin') return record('unavailable');
  const source = `ObjC.import('Security');\nconst q=$.NSMutableDictionary.alloc.init;\n` +
    `q.setObjectForKey($.kSecClassGenericPassword,$.kSecClass);\n` +
    `q.setObjectForKey($(${ JSON.stringify(SERVICE) }),$.kSecAttrService);\n` +
    `q.setObjectForKey($(${ JSON.stringify(ACCOUNT) }),$.kSecAttrAccount);\n` +
    `q.setObjectForKey($.kCFBooleanTrue,$.kSecAttrSynchronizable);\n$.SecItemDelete(q);\n` +
    `q.setObjectForKey($(${ JSON.stringify(recoveryKey) }).dataUsingEncoding($.NSUTF8StringEncoding),$.kSecValueData);\n` +
    `q.setObjectForKey($.kSecAttrAccessibleAfterFirstUnlock,$.kSecAttrAccessible);\n` +
    `const s=$.SecItemAdd(q,null); if(s!==0) throw new Error('SecItemAdd '+s);\n`;
  try {
    await run('/usr/bin/osascript', ['-l', 'JavaScript', '-'], source);
    return record('icloud-keychain');
  } catch {
    await run('/usr/bin/security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w'], `${ recoveryKey }\n`);
    return record('local-keychain');
  }
}

export function recoveryKeyStorageStatus(): RecoveryKeyStorageStatus {
  try {
    const value = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')) as RecoveryKeyStorageStatus;
    if (['icloud-keychain', 'local-keychain', 'unavailable'].includes(value.location) && value.checkedAt) return value;
  } catch { /* no status has been recorded yet */ }
  return { location: 'unavailable', label: 'Recovery key is not saved', checkedAt: new Date().toISOString() };
}

/** Read is deliberately main-process-only; callers use it only to verify that the saved copy still exists. */
export async function readRecoveryKeyFromMacKeychain(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const value = await read('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']).catch(() => '');
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
