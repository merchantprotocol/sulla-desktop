// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VMExecutor } from '@pkg/backend/backend';
import { SULLA_FILES_GUEST_MOUNT_PATH, isGuestPathUsable, probeFilesAnchor } from '@pkg/backend/guestMountInfo';
import { traceEvent } from '@pkg/utils/startupTrace';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const MOUNT_PATH = SULLA_FILES_GUEST_MOUNT_PATH;
const MOUNT_PROBE_TIMEOUT_SECONDS = 15;
const MOUNT_UNRESPONSIVE_LIMIT = 3;
const ADAPTER_STATUS_FILE = '/tmp/sulla-files-fuse-status.json';
const ADAPTER_WAIT_MS = 120_000;
const ADAPTER_TOKEN_REPAIR_AFTER_MS = 30_000;
const ADAPTER_TOKEN_REPAIR_INTERVAL_MS = 5_000;
const ADAPTER_STATUS_STALE_MS = 20_000;
const ADAPTER_STATUS_GRACE_MS = 15_000;
const ADAPTER_PROPAGATION_GRACE_MS = 3_000;

interface SullaFilesAdapterStatus {
  phase:      'waiting-token' | 'starting' | 'mounting' | 'loading-tree' | 'mounted' | 'failed' | string;
  updatedAt:  string;
  reason?:    string;
  error?:     string;
}

export class SullaFilesMountAdapterService {
  constructor(
    private readonly refreshCredentials:(generation:number) => Promise<void>,
    private readonly revokeAnchor:() => void,
  ) {}

  async reattachStaleAgentMounts(executor:VMExecutor):Promise<void> {
    const names = (await executor.execCommand(
      { root: true, capture: true, expectFailure: true }, 'docker', 'ps', '--format', '{{.Names}}',
    )).split('\n').map(name => name.trim()).filter(name => /^sulla-agent-/.test(name));
    const python = 'import ctypes,os,sys; libc=ctypes.CDLL(None,use_errno=True); pid=int(sys.argv[1]); path=sys.argv[2].encode(); fd=libc.syscall(428,-100,ctypes.c_char_p(path),0x80000|0x8000|1); assert fd>=0,os.strerror(ctypes.get_errno()); ns=os.open("/proc/%d/ns/mnt"%pid,os.O_RDONLY); assert libc.setns(ns,0x00020000)==0,os.strerror(ctypes.get_errno()); [libc.umount2(ctypes.c_char_p(path),2) for _ in range(5)]; assert libc.syscall(429,fd,b"", -100,ctypes.c_char_p(path),0x00000004)==0,os.strerror(ctypes.get_errno())';
    for (const name of names) {
      const pid = (await executor.execCommand(
        { root: true, capture: true, expectFailure: true }, 'docker', 'inspect', '-f', '{{.State.Pid}}', name,
      )).trim();
      if (!/^\d+$/.test(pid)) continue;
      const healthy = await executor.execCommand(
        { root: true, expectFailure: true }, 'timeout', '5', 'nsenter', '-t', pid, '-m', '--', 'sh', '-c', '[ -n "$(ls -A /mnt/sulla-files)" ]',
      ).then(() => true, () => false);
      if (healthy) continue;
      await executor.execCommand(
        { root: true, expectFailure: true }, 'timeout', '10', 'python3', '-c', python, pid, MOUNT_PATH,
      ).catch(error => console.warn(`[SullaFiles] Could not reattach Files in ${ name }: ${ error instanceof Error ? error.message : String(error) }`));
    }
  }

  async waitForAdapter(executor:VMExecutor, credentialGeneration:number):Promise<void> {
    const started = Date.now();
    let lastPhase:string | undefined;
    let mountedSince:number | undefined;
    let waitingTokenSince:number | undefined;
    let lastTokenRepairAt = 0;

    for (;;) {
      if (await this.isAdapterMounted(executor)) return;
      const status = await this.adapterStatus(executor);
      const now = Date.now();
      const phase = status?.phase;
      if (phase !== lastPhase) {
        traceEvent(`mount: adapter phase ${ phase ?? 'unreported' }`);
        if (phase) console.log(`[SullaFiles] Files adapter ${ phase }${ status?.reason ? `: ${ status.reason }` : '' }`);
        lastPhase = phase;
      }
      if (phase === 'waiting-token') {
        waitingTokenSince ??= now;
        if (now - waitingTokenSince >= ADAPTER_TOKEN_REPAIR_AFTER_MS && now - lastTokenRepairAt >= ADAPTER_TOKEN_REPAIR_INTERVAL_MS) {
          lastTokenRepairAt = now;
          const tokenPresent = await executor.execCommand(
            { root: true, capture: true, expectFailure: true },
            'docker', 'exec', 'sulla_files_fuse', 'sh', '-c', 'test -s "$1" && echo present', 'sh', '/run/sulla-files-fuse/token',
          ).then(output => output.trim() === 'present', () => false);
          if (!tokenPresent) {
            traceEvent('mount: adapter waiting-token watchdog is rewriting missing token');
            await this.refreshCredentials(credentialGeneration);
          }
        }
      } else waitingTokenSince = undefined;
      if (phase === 'failed') throw new Error(`The Files adapter failed: ${ status?.reason ?? 'unknown' }${ status?.error ? ` (${ status.error })` : '' }`);
      if (phase === 'mounted' || phase === 'loading-tree') {
        mountedSince ??= now;
        if (now - mountedSince > ADAPTER_PROPAGATION_GRACE_MS) throw new Error('The Files adapter mounted inside its container, but the mount did not propagate to the guest');
      }
      if (!status) {
        if (now - started > ADAPTER_STATUS_GRACE_MS) throw new Error('The Files adapter did not report a status');
      } else if (now - Date.parse(status.updatedAt) > ADAPTER_STATUS_STALE_MS) {
        throw new Error(`The Files adapter stopped reporting progress (last phase ${ phase })`);
      }
      if (now - started > ADAPTER_WAIT_MS) throw new Error(`The Files adapter did not mount within ${ ADAPTER_WAIT_MS / 1000 }s (last phase ${ phase ?? 'unreported' })`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  async mountState(executor:VMExecutor):Promise<'adapter' | 'anchor' | 'none' | 'unexpected'> {
    const probe = await probeFilesAnchor(executor, MOUNT_PATH).catch(() => undefined);
    if (!probe || probe.state === 'not-mounted' || probe.state === 'unexpected') this.revokeAnchor();
    if (!probe || probe.state === 'not-mounted') return 'none';
    return probe.state;
  }

  async adapterStatus(executor:VMExecutor):Promise<SullaFilesAdapterStatus | undefined> {
    try {
      const output = await executor.execCommand(
        { root: true, capture: true, expectFailure: true },
        'docker', 'exec', 'sulla_files_fuse', 'cat', ADAPTER_STATUS_FILE,
      );
      const status = JSON.parse(output);
      return typeof status?.phase === 'string' && typeof status?.updatedAt === 'string' ? status : undefined;
    } catch { return undefined }
  }

  async isAdapterMounted(executor:VMExecutor):Promise<boolean> { return await this.mountState(executor) === 'adapter' }
}
