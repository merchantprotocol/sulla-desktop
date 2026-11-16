// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ContainerDriftReconciler } from '@pkg/backend/ContainerDriftReconciler';
import type { DockerCli } from '@pkg/backend/sullaComposeContainers';

const COMPOSE = ['compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla'];

/**
 * Just enough of the guest Docker CLI: `compose … config --hash <svc>` from the
 * desired definitions and `inspect` of running containers with their
 * com.docker.compose.config-hash label.
 */
class FakeDocker implements DockerCli {
  readonly desired = new Map<string, string>();
  readonly containers = new Map<string, { running: boolean; hash?: string }>();
  readonly calls: string[][] = [];
  failConfig = false;

  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (args[0] === 'compose') {
      if (this.failConfig) throw new Error('compose config failed');
      const service = args[args.length - 1];
      const hash = this.desired.get(service);

      return hash ? `${ service } ${ hash }\n` : '';
    }
    if (args[0] === 'inspect') {
      const container = this.containers.get(args[args.length - 1]);

      if (!container) throw new Error('Error: No such object');

      return `${ container.running } ${ container.hash ?? '<no value>' }\n`;
    }
    throw new Error(`unexpected docker ${ args.join(' ') }`);
  }
}

function setup() {
  const docker = new FakeDocker();
  const recreated: string[] = [];
  const lines: string[] = [];
  const reconciler = new ContainerDriftReconciler(docker, COMPOSE, async(service) => {
    recreated.push(service);
  }, { log: line => lines.push(line), warn: line => lines.push(line) });

  return { docker, recreated, lines, reconciler };
}

const FILES = { service: 'sulla_files', container: 'sulla_files' };
const TOOLS = { service: 'tools', container: 'sulla_tools' };
const VAULT = { service: 'sulla_vault', container: 'sulla_vault' };

describe('ContainerDriftReconciler', () => {
  // risk: sign-in — a running Files container kept the old secret env across boots (2026-11-16)
  it('recreates only the service whose running config hash differs from the compose file', async() => {
    const { docker, recreated, reconciler } = setup();

    docker.desired.set('sulla_files', 'aaaa1111new').set('tools', 'bbbb2222').set('sulla_vault', 'cccc3333');
    docker.containers.set('sulla_files', { running: true, hash: 'aaaa0000old' })
      .set('sulla_tools', { running: true, hash: 'bbbb2222' })
      .set('sulla_vault', { running: true, hash: 'cccc3333' });

    const outcomes = await reconciler.reconcileAll([FILES, TOOLS, VAULT]);

    expect(recreated).toEqual(['sulla_files']);
    expect(outcomes.map(outcome => outcome.kind)).toEqual(['recreated', 'unchanged', 'unchanged']);
  });

  // risk: availability — recreating an unchanged container would interrupt a live Files migration
  it('does not recreate when nothing drifted', async() => {
    const { docker, recreated, reconciler } = setup();

    docker.desired.set('sulla_files', 'same-hash');
    docker.containers.set('sulla_files', { running: true, hash: 'same-hash' });

    expect(await reconciler.reconcile(FILES)).toEqual({ kind: 'unchanged', service: 'sulla_files' });
    expect(recreated).toEqual([]);
  });

  // risk: data accuracy — a container compose did not stamp cannot be assumed current
  it('treats a running container with no compose hash label as drifted', async() => {
    const { docker, recreated, reconciler } = setup();

    docker.desired.set('tools', 'desired');
    docker.containers.set('sulla_tools', { running: true });

    expect((await reconciler.reconcile(TOOLS)).kind).toBe('recreated');
    expect(recreated).toEqual(['tools']);
  });

  // risk: availability — stopped or missing containers are the normal start path's job
  it('leaves stopped and missing containers to the normal start path', async() => {
    const { docker, recreated, reconciler } = setup();

    docker.desired.set('sulla_files', 'new').set('tools', 'new');
    docker.containers.set('sulla_files', { running: false, hash: 'old' });

    const outcomes = await reconciler.reconcileAll([FILES, TOOLS]);

    expect(outcomes.map(outcome => outcome.kind)).toEqual(['not-running', 'not-running']);
    expect(recreated).toEqual([]);
  });

  // risk: availability — no recreate on a guess when the desired hash cannot be computed
  it('does not recreate when the desired hash is unavailable', async() => {
    const { docker, recreated, reconciler } = setup();

    docker.failConfig = true;
    docker.containers.set('sulla_files', { running: true, hash: 'old' });

    expect((await reconciler.reconcile(FILES)).kind).toBe('unknown');
    expect(recreated).toEqual([]);
  });

  // risk: availability — one failed recreate must not stop the others
  it('keeps reconciling the rest when one recreate fails', async() => {
    const docker = new FakeDocker();
    const recreated: string[] = [];
    const reconciler = new ContainerDriftReconciler(docker, COMPOSE, async(service) => {
      if (service === 'sulla_files') throw new Error('up failed');
      recreated.push(service);
    }, { log: () => undefined, warn: () => undefined });

    docker.desired.set('sulla_files', 'new').set('tools', 'new');
    docker.containers.set('sulla_files', { running: true, hash: 'old' }).set('sulla_tools', { running: true, hash: 'old' });

    const outcomes = await reconciler.reconcileAll([FILES, TOOLS]);

    expect(outcomes.map(outcome => outcome.kind)).toEqual(['unknown', 'recreated']);
    expect(recreated).toEqual(['tools']);
  });

  // risk: security — drift logs carry service names and hash prefixes only
  it('asks compose for the hash with the project compose args and logs only hash prefixes', async() => {
    const { docker, lines, reconciler } = setup();

    docker.desired.set('sulla_files', '0123456789abcdef-desired');
    docker.containers.set('sulla_files', { running: true, hash: 'fedcba9876543210-running' });

    await reconciler.reconcile(FILES);

    expect(docker.calls).toContainEqual([...COMPOSE, 'config', '--hash', 'sulla_files']);
    expect(lines.join('\n')).toContain('01234567');
    expect(lines.join('\n')).not.toContain('0123456789abcdef-desired');
  });
});
