// SPDX-License-Identifier: GPL-2.0-or-later
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

export const VAULT_PORT = 18787;

/** Splits `repo:tag` (a registry port is not a tag); null for digests or untagged refs. */
export function imageRepoTag(image) {
  if (image.includes('@')) return null;
  const colon = image.lastIndexOf(':');
  if (colon <= image.lastIndexOf('/')) return null;
  return { repo: image.slice(0, colon), tag: image.slice(colon + 1) };
}

/** Docker CLI runtime. The anchor (postgres) container owns the network namespace and publishes the vault port. */
export class DockerCliRuntime {
  name = 'docker';

  docker(args, { capture = false } = {}) {
    try {
      const out = execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return capture ? out.trim() : undefined;
    } catch (error) {
      // Only the first stderr line: docker argv can carry synthetic tokens and must not be echoed.
      throw new Error(`docker ${ args[0] } failed: ${ String(error?.stderr ?? '').split('\n')[0] }`);
    }
  }

  pull(image) { this.docker(['pull', '-q', image]); }

  hasImage(image) {
    try { this.docker(['image', 'inspect', image]); return true; } catch { return false; }
  }

  /** Pulls only when the image is not already local, so a locally built image can be smoked. */
  ensureImage(image) { if (!this.hasImage(image)) this.pull(image); }

  startAnchor(name, args, image) {
    this.docker(['run', '-d', '--name', name, '-p', `127.0.0.1::${ VAULT_PORT }`, ...args, image]);
    this.anchor = name;
  }

  networkArgs() { return ['--network', `container:${ this.anchor }`]; }

  runDetached(name, args, image) { this.docker(['run', '-d', '--name', name, ...this.networkArgs(), ...args, image]); }

  runOnce(args, image, command) {
    return this.docker(['run', '--rm', ...this.networkArgs(), ...args, image, ...command], { capture: true });
  }

  vaultHostPort() {
    return Number(this.docker(['port', this.anchor, `${ VAULT_PORT }/tcp`], { capture: true }).split('\n')[0].split(':').at(-1));
  }

  stop(name) { this.docker(['stop', name]); }

  /** -v also removes the container's anonymous volumes (postgres declares one), so nothing leaks. */
  remove(name) { this.docker(['rm', '-f', '-v', name]); }

  logs(name) { return this.docker(['logs', '--tail', '30', name], { capture: true }); }
}

/**
 * Sulla agent-container runtime: drives the VM's Docker daemon through the
 * `sulla docker/*` tools and joins every container to this agent container's
 * network namespace, so 127.0.0.1 reaches postgres and the vault directly.
 */
export class SullaToolRuntime {
  name = 'sulla';

  constructor() { this.anchor = hostname(); }

  tool(name, input) {
    let raw;
    try {
      raw = execFileSync('sulla', [`docker/${ name }`, JSON.stringify(input)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      throw new Error(`sulla docker/${ name } failed: ${ String(error?.stderr ?? '').split('\n')[0] }`);
    }
    const parsed = JSON.parse(raw);
    if (!parsed.success) throw new Error(`sulla docker/${ name } failed: ${ String(parsed.error?.message ?? 'unknown').split('\n')[0] }`);
    return String(parsed.result ?? '');
  }

  options(args) {
    if (args.some(arg => /\s/.test(arg))) throw new Error('sulla runtime options cannot contain whitespace');
    return args.join(' ');
  }

  pull(image) { this.tool('pull', { image }); }

  hasImage(image) {
    const ref = imageRepoTag(image);
    if (!ref) return false;
    // Docker 29 prints one IMAGE column (repo:tag); older CLIs print REPOSITORY and TAG columns.
    return this.tool('images', { all: true }).split('\n').some(line => {
      const [first, second] = line.trim().split(/\s+/);
      return first === image || (first === ref.repo && second === ref.tag);
    });
  }

  /** Pulls only when the image is not already local, so a locally built image can be smoked. */
  ensureImage(image) { if (!this.hasImage(image)) this.pull(image); }

  startAnchor(name, args, image) { this.runDetached(name, args, image); }

  networkArgs() { return ['--network', `container:${ this.anchor }`]; }

  runDetached(name, args, image) {
    this.tool('run', { image, name, options: this.options(['-d', ...this.networkArgs(), ...args]) });
  }

  runOnce(args, image, command) {
    if (command.some(arg => /\s/.test(arg))) throw new Error('sulla runtime commands cannot contain whitespace');
    const result = this.tool('run', { image, options: this.options(['--rm', ...this.networkArgs(), ...args]), command: command.join(' ') });
    const marker = 'Container ID: ';
    return result.includes(marker) ? result.slice(result.indexOf(marker) + marker.length).trim() : result.trim();
  }

  vaultHostPort() { return VAULT_PORT; }

  stop(name) { this.tool('stop', { container: name }); }

  remove(name) { this.tool('rm', { container: name, force: true }); }

  logs(name) { return this.tool('logs', { container: name, tail: 30 }); }
}
