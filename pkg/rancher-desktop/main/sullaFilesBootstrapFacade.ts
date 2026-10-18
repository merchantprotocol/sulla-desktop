import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import paths from '@pkg/utils/paths';
import { resolveSullaFilesUserRoot } from '@pkg/utils/sullaFilesPaths';

export interface FilesBootstrapResult {
  ok:boolean;
  state?:'unlocked';
  legacyImport?:'clear' | 'imported';
  recovered?:boolean;
  code?:string;
}

/** Normal Desktop receives status only; key bytes exist solely in the child. */
export class SullaFilesBootstrapFacade {
  private run?:Promise<FilesBootstrapResult>;
  private readonly identityPath = path.join(paths.appHome, 'files-bootstrap-identity.enc');
  private readonly fingerprintPath = path.join(paths.appHome, 'files-tls-fingerprint');
  private readonly masterPath = path.join(paths.appHome, 'files-master-key.enc');

  initialize():Promise<FilesBootstrapResult> {
    this.run ??= this.spawn().finally(() => { this.run = undefined });
    return this.run;
  }

  async settled():Promise<void> { await this.run?.catch(() => undefined) }

  private async spawn():Promise<FilesBootstrapResult> {
    if (![this.identityPath, this.fingerprintPath].every(file => fs.existsSync(file))) {
      return { ok: false, code: 'FILES_BOOTSTRAP_NOT_PROVISIONED' };
    }
    const filesUserRoot = resolveSullaFilesUserRoot();
    return await new Promise(resolve => {
      const args = process.defaultApp ? [app.getAppPath(), '--sulla-files-bootstrap-helper'] : ['--sulla-files-bootstrap-helper'];
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          SULLA_FILES_BOOTSTRAP_IDENTITY_PATH:          this.identityPath,
          SULLA_FILES_TLS_FINGERPRINT_PATH:             this.fingerprintPath,
          SULLA_FILES_MASTER_KEY_PATH:                  this.masterPath,
          SULLA_FILES_USER_DATA_PATH:                   path.join(paths.appHome, 'electron'),
          SULLA_FILES_LEGACY_PRIMARY_PATH:              path.join(filesUserRoot.activePath, 'master.key'),
          SULLA_FILES_LEGACY_PRIMARY_ARCHIVE_PATH:      path.join(paths.appHome, 'files-legacy-shared-master-key.enc'),
          SULLA_FILES_LEGACY_QUARANTINE_PATH:           path.join(paths.sullaHome, 'private-files-quarantine', 'master.key'),
          SULLA_FILES_LEGACY_QUARANTINE_ARCHIVE_PATH:   path.join(paths.appHome, 'files-legacy-quarantined-master-key.enc'),
        },
      });
      let output = ''; let settled = false; let timedOut = false;
      const finish = (result:FilesBootstrapResult) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(result) } };
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 90_000);
      child.stdout.on('data', (chunk:Buffer) => { if (output.length < 4_096) output += chunk.toString('utf8') });
      child.once('error', () => { if (!timedOut) finish({ ok: false, code: 'FILES_BOOTSTRAP_HELPER_FAILED' }) });
      child.once('close', () => {
        if (timedOut) return finish({ ok: false, code: 'FILES_BOOTSTRAP_TIMEOUT' });
        try {
          const result = JSON.parse(output.trim()) as FilesBootstrapResult;
          const validSuccess = result.ok === true && result.state === 'unlocked' &&
            ['clear', 'imported'].includes(result.legacyImport ?? '') && typeof result.recovered === 'boolean';
          const validFailure = result.ok === false && typeof result.code === 'string' && /^FILES_[A-Z0-9_]{1,80}$/.test(result.code);
          finish(validSuccess || validFailure ? result : { ok: false, code: 'FILES_BOOTSTRAP_RESPONSE_INVALID' });
        } catch { finish({ ok: false, code: 'FILES_BOOTSTRAP_RESPONSE_INVALID' }) }
      });
    });
  }
}
