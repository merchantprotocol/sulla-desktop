// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { prepareLinuxRuntimePaths } from './dockerHost';
import { LinuxRuntimeComposeBuilder } from './linuxRuntimeCompose';

const opts = { image: 'alpine:3.23', containerName: 'sulla-desktop-linux-runtime', cpus: 2, memoryMiB: 2048, ports: [] as any[] };

async function paths() {
  return prepareLinuxRuntimePaths(fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-compose-')));
}

describe('LinuxRuntimeComposeBuilder', () => {
  it('produces a hardened service: no privileged mode, no socket, no host namespaces, caps dropped', async() => {
    // risk: host-root escape through the service container
    const p = await paths();
    const doc: any = new LinuxRuntimeComposeBuilder().build(p, opts);
    const service = doc.services.runtime;

    expect(service.privileged).toBe(false);
    expect(service.cap_drop).toEqual(['ALL']);
    expect(service.security_opt).toContain('no-new-privileges:true');
    expect(service.network_mode).toBeUndefined();
    expect(service.pid).toBeUndefined();
    expect(JSON.stringify(doc)).not.toMatch(/docker\.sock/);
    for (const volume of service.volumes) {
      if (volume.type === 'bind') expect(volume.source.startsWith(p.root + path.sep)).toBe(true);
    }
  });

  it('maps persistent app directories into the guest and keeps worktrees in a named volume', async() => {
    const p = await paths();
    const targets = new LinuxRuntimeComposeBuilder().mounts(p);

    expect(targets).toContainEqual({ source: p.runtime, target: '/mnt/data' });
    expect(targets).toContainEqual({ source: p.files, target: '/mnt/sulla-files' });
    expect(targets).toContainEqual({ volume: 'worktrees', target: '/mnt/worktrees' });
  });

  it('publishes ports on loopback only and rejects privileged/duplicate/invalid ports', async() => {
    // risk: exposing the runtime to the LAN
    const p = await paths();
    const builder = new LinuxRuntimeComposeBuilder();
    const doc: any = builder.build(p, { ...opts, ports: [{ hostPort: 8080, containerPort: 80 }] });

    expect(doc.services.runtime.ports).toEqual(['127.0.0.1:8080:80/tcp']);
    expect(() => builder.build(p, { ...opts, ports: [{ hostPort: 80, containerPort: 80 }] })).toThrow(/unprivileged/);
    expect(() => builder.build(p, { ...opts, ports: [{ hostPort: 9000, containerPort: 1 }, { hostPort: 9000, containerPort: 2 }] })).toThrow(/unique/);
  });

  it('rejects mounts outside the app root and unsafe container names/limits', async() => {
    const p = await paths();
    const evil = { ...p, files: '/home/user' };

    expect(() => new LinuxRuntimeComposeBuilder().build(evil, opts)).toThrow(/app-owned/);
    expect(() => new LinuxRuntimeComposeBuilder().build(p, { ...opts, containerName: 'other' })).toThrow(/prefix/);
    expect(() => new LinuxRuntimeComposeBuilder().build(p, { ...opts, memoryMiB: 10 })).toThrow(/limits/);
  });

  it('writes a private compose file that parses as JSON', async() => {
    const p = await paths();
    const file = await new LinuxRuntimeComposeBuilder().write(p, opts);

    expect((fs.statSync(file).mode & 0o777)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).services.runtime.image).toBe('alpine:3.23');
  });
});
