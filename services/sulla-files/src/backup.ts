import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { Config } from './config.js';

function command(name:string, args:string[]):Promise<void> {
  return new Promise((resolve, reject) => { const child = spawn(name, args, { stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${ name } exited ${ code }`))) });
}
export async function backup(config:Config):Promise<string> {
  if (!config.backupTarget) throw new Error('SULLA_FILES_BACKUP_TARGET is required');
  await mkdir(config.backupTarget, { recursive: true, mode: 0o700 });
  const destination = join(config.backupTarget, `sulla-files-${ new Date().toISOString().replace(/[:.]/g, '-') }.tar.gz`);
  await command('tar', ['--exclude=master.key', '-czf', destination, '-C', dirname(config.dataRoot), basename(config.dataRoot)]);
  console.log(`[SullaFiles] backup created ${ destination }`); return destination;
}
export async function restore(config:Config, archive?:string):Promise<string> {
  if (!config.backupTarget && !archive) throw new Error('SULLA_FILES_BACKUP_TARGET or an archive path is required');
  const selected = archive ? resolve(archive) : join(config.backupTarget!, (await readdir(config.backupTarget!)).filter(name => name.endsWith('.tar.gz')).sort().at(-1) ?? '');
  if (!selected.endsWith('.tar.gz')) throw new Error('No backup archive found');
  await mkdir(dirname(config.dataRoot), { recursive: true }); await command('tar', ['--exclude=master.key', '-xzf', selected, '-C', dirname(config.dataRoot)]);
  console.log(`[SullaFiles] restored ${ selected } into ${ config.dataRoot }`); return selected;
}
export async function nightlyBackups(config:Config):Promise<never> {
  for (;;) { const now = new Date(); const next = new Date(now); next.setHours(2, 0, 0, 0); if (next <= now) next.setDate(next.getDate() + 1); await new Promise(resolve => setTimeout(resolve, next.getTime() - now.getTime())); await backup(config) }
}
