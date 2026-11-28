// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

export interface SyntheticCertificates {
  vaultCertificatePath: string;
  vaultPrivateKeyPath: string;
  vaultCertificatePem: Buffer;
  vaultFingerprint: string;
  upstreamCertificatePath: string;
  upstreamPrivateKeyPath: string;
  upstreamCertificatePem: Buffer;
  vaultAppHome: string;
}

/** Makes short-lived, self-signed certificates solely for this local test run. */
export class CertificateFactory {
  async create(tempDir: string): Promise<SyntheticCertificates> {
    const certificatesDir = join(tempDir, 'certificates');
    const appHome = join(tempDir, 'xdg-data', 'sulla-desktop-firstrun-test');
    await mkdir(certificatesDir, { recursive: true });
    await mkdir(appHome, { recursive: true });

    const vaultCertificatePath = join(certificatesDir, 'vault.crt');
    const vaultPrivateKeyPath = join(certificatesDir, 'vault.key');
    const upstreamCertificatePath = join(certificatesDir, 'synthetic-upstream.crt');
    const upstreamPrivateKeyPath = join(certificatesDir, 'synthetic-upstream.key');
    this.createCertificate(vaultCertificatePath, vaultPrivateKeyPath, '/CN=127.0.0.1', 'IP:127.0.0.1');
    this.createCertificate(upstreamCertificatePath, upstreamPrivateKeyPath, '/CN=api.openai.com', 'DNS:api.openai.com');

    const vaultCertificatePem = await readFile(vaultCertificatePath);
    const vaultFingerprint = new X509Certificate(vaultCertificatePem).fingerprint256.replaceAll(':', '').toLowerCase();
    await writeFile(join(appHome, 'vault-tls-fingerprint'), vaultFingerprint, { mode: 0o600 });
    return {
      vaultCertificatePath,
      vaultPrivateKeyPath,
      vaultCertificatePem,
      vaultFingerprint,
      upstreamCertificatePath,
      upstreamPrivateKeyPath,
      upstreamCertificatePem: await readFile(upstreamCertificatePath),
      vaultAppHome: appHome,
    };
  }

  private createCertificate(certificatePath: string, keyPath: string, subject: string, subjectAltName: string): void {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2',
      '-keyout', keyPath, '-out', certificatePath, '-subj', subject,
      '-addext', `subjectAltName=${ subjectAltName }`,
    ], { stdio: 'ignore' });
  }
}

export interface MachineCapacity {
  loadAverage: number[];
  memAvailableBytes: number;
  memTotalBytes: number;
}

/** Refuses to start network work unless at least 4 GiB are available. */
export class MachineCapacityGuard {
  constructor(private readonly readMemInfo: () => Promise<string> = () => readFile('/proc/meminfo', 'utf8')) {}

  async check(): Promise<MachineCapacity> {
    const loadAverage = os.loadavg();
    let meminfo: string;
    try {
      meminfo = await this.readMemInfo();
    } catch {
      const fallback = { loadAverage, memAvailableBytes: os.freemem(), memTotalBytes: os.totalmem() };
      this.requireHeadroom(fallback);
      return fallback;
    }
    const totalMatch = /^MemTotal:\s+(\d+) kB/m.exec(meminfo);
    const availableMatch = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo);
    if (!totalMatch || !availableMatch) throw new Error('Load test refused: could not read MemAvailable from /proc/meminfo');
    const capacity = {
      loadAverage,
      memTotalBytes: Number(totalMatch[1]) * 1024,
      memAvailableBytes: Number(availableMatch[1]) * 1024,
    };
    this.requireHeadroom(capacity);
    return capacity;
  }

  private requireHeadroom(capacity: MachineCapacity): void {
    if (capacity.memAvailableBytes < 4 * 1024 ** 3) {
      throw new Error(`Load test refused: only ${ Math.floor(capacity.memAvailableBytes / 1024 ** 2) } MiB is available (4 GiB required)`);
    }
  }
}

export interface ProcessHandles {
  fdCount: number | null;
  socketCount: number | null;
}

/** Reads Linux fd/socket counts without invoking lsof once per sample. */
export class ProcessHandleReader {
  async read(pid: number): Promise<ProcessHandles> {
    try {
      const names = await import('node:fs/promises').then(fs => fs.readdir(`/proc/${ pid }/fd`));
      const targets = await Promise.all(names.map(async name => {
        try { return await import('node:fs/promises').then(fs => fs.readlink(`/proc/${ pid }/fd/${ name }`)); }
        catch { return ''; }
      }));
      return { fdCount: names.length, socketCount: targets.filter(target => target.startsWith('socket:[')).length };
    } catch {
      return { fdCount: null, socketCount: null };
    }
  }
}
