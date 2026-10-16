import { setTimeout as delay } from 'node:timers/promises';

import tar from 'tar-stream';

import { config } from './config.js';
import { pool } from './db.js';
import { DockerApi } from './docker.js';

type StoredFile = string | { content: string; encoding?: string };

const RUNTIME_IMAGES: Record<string, string> = {
  node: process.env.SULLA_NODE_RUNTIME_IMAGE ?? 'ghcr.io/merchantprotocol/sulla-node-runtime:latest',
  python: process.env.SULLA_PYTHON_RUNTIME_IMAGE ?? 'ghcr.io/merchantprotocol/sulla-python-runtime:latest',
  shell: process.env.SULLA_SHELL_RUNTIME_IMAGE ?? 'ghcr.io/merchantprotocol/sulla-shell-runtime:latest',
};

async function makeArchive(slug: string, manifest: any, files: Record<string, StoredFile>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => {
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
  });
  const add = (name: string, content: Buffer) => new Promise<void>((resolve, reject) => {
    pack.entry({ name: `db-functions/${ slug }/${ name }`, mode: 0o644 }, content, error => error ? reject(error) : resolve());
  });
  await add('function.yaml', Buffer.from(JSON.stringify(manifest), 'utf8'));
  for (const [name, stored] of Object.entries(files)) {
    if (!name || name.startsWith('/') || name.includes('..') || name.includes('\\')) throw new Error(`Unsafe function path: ${ name }`);
    const content = typeof stored === 'string' ? Buffer.from(stored, 'utf8') : Buffer.from(stored.content, 'base64');
    await add(name, content);
  }
  pack.finalize();
  return done;
}

async function runtimePost(baseUrl: string, route: string, body: unknown): Promise<any> {
  const response = await fetch(`${ baseUrl }${ route }`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Runtime ${ route } returned ${ response.status }: ${ json.detail ?? JSON.stringify(json) }`);
  return json;
}

export class OnDemandRuntimeLauncher {
  constructor(private readonly docker = new DockerApi()) {}

  async run(functionRef: string, inputs: Record<string, string>): Promise<any> {
    const result = await pool.query(
      'SELECT slug, manifest, runtime, files, COALESCE(version, \'1.0.0\') AS version FROM function_definitions WHERE slug = $1',
      [functionRef],
    );
    const fn = result.rows[0];
    if (!fn) throw new Error(`Function "${ functionRef }" was not found`);
    const image = RUNTIME_IMAGES[fn.runtime];
    if (!image) throw new Error(`Function runtime "${ fn.runtime }" is not container-backed`);

    const name = `sulla-runtime-${ fn.runtime }-${ Date.now() }-${ Math.random().toString(36).slice(2, 7) }`;
    const id = await this.docker.create({
      name,
      image,
      labels: { 'com.sulla.workload': 'function-runtime', 'com.sulla.function': functionRef },
      network: config.dockerNetwork,
      autoRemove: false,
    });
    try {
      await this.docker.upload(id, '/var', await makeArchive(fn.slug, fn.manifest, fn.files ?? {}));
      await this.docker.start(id);
      let address = '';
      for (let attempt = 0; attempt < 60; attempt++) {
        const inspection = await this.docker.inspect(id);
        const networks = inspection.NetworkSettings?.Networks as Record<string, { IPAddress?: string }> | undefined;
        address = networks?.[config.dockerNetwork]?.IPAddress
          ?? Object.values(networks ?? {})[0]?.IPAddress
          ?? '';
        if (address) {
          try {
            const health = await fetch(`http://${ address }:8080/health`);
            if (health.ok) break;
          } catch { /* cold start */ }
        }
        await delay(250);
      }
      if (!address) throw new Error('Runtime container never received a network address');
      const baseUrl = `http://${ address }:8080`;
      const version = fn.version ?? '1.0.0';
      await runtimePost(baseUrl, '/load', { name: fn.slug, version, path: `/var/db-functions/${ fn.slug }` });
      const invoked = await runtimePost(baseUrl, '/invoke', { name: fn.slug, version, inputs });
      await pool.query(
        `INSERT INTO function_runs (slug, version, runtime, inputs, outputs, success, duration_ms, started_at, completed_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, TRUE, $6, NOW(), NOW())`,
        [fn.slug, version, fn.runtime, JSON.stringify(inputs), JSON.stringify(invoked.outputs ?? {}), invoked.duration_ms ?? 0],
      );
      return invoked.outputs ?? invoked;
    } finally {
      await this.docker.remove(id, true);
    }
  }
}
