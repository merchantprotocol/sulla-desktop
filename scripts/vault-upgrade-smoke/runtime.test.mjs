// SPDX-License-Identifier: GPL-2.0-or-later
// The smoke must not pull an image that is already local (a locally built NEW tag is not in any registry),
// and must remove containers with their anonymous volumes. No Docker needed: the CLI call is stubbed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DockerCliRuntime, SullaToolRuntime, imageRepoTag } from './runtime.mjs';

class RecordingDocker extends DockerCliRuntime {
  constructor(localImages) { super(); this.localImages = new Set(localImages); this.calls = []; }
  docker(args) {
    this.calls.push(args);
    if (args[0] === 'image' && !this.localImages.has(args[2])) throw new Error('docker image failed: No such image');
  }
}

test('a local image is used as is and never pulled', () => {
  const docker = new RecordingDocker(['sulla-vault:agent-job-1-m3-abc1234']);
  docker.ensureImage('sulla-vault:agent-job-1-m3-abc1234');
  assert.deepEqual(docker.calls.filter(args => args[0] === 'pull'), []);
});

test('a missing image is pulled once', () => {
  const docker = new RecordingDocker([]);
  docker.ensureImage('ghcr.io/merchantprotocol/sulla-vault:sha-7f7e5a9');
  assert.deepEqual(docker.calls.filter(args => args[0] === 'pull'), [['pull', '-q', 'ghcr.io/merchantprotocol/sulla-vault:sha-7f7e5a9']]);
});

test('containers are removed together with their anonymous volumes', () => {
  // risk: every smoke run leaked one postgres volume on the host
  const docker = new RecordingDocker([]);
  docker.remove('agent-job-1-db');
  assert.deepEqual(docker.calls, [['rm', '-f', '-v', 'agent-job-1-db']]);
});

test('the sulla runtime matches repo and tag exactly, so a registry port is not read as a tag', () => {
  const runtime = new SullaToolRuntime();
  runtime.tool = () => 'REPOSITORY                          TAG          IMAGE ID\nlocalhost:5000/sulla-vault          dev          111\nsulla-vault                         other        222\n';
  assert.equal(runtime.hasImage('localhost:5000/sulla-vault:dev'), true);
  assert.equal(runtime.hasImage('sulla-vault:dev'), false);
  assert.equal(runtime.hasImage('localhost:5000/sulla-vault'), false);
  assert.deepEqual(imageRepoTag('localhost:5000/sulla-vault'), null);
});

test('the sulla runtime also reads the Docker 29 single IMAGE column', () => {
  const runtime = new SullaToolRuntime();
  runtime.tool = () => 'Docker Images (All):\nIMAGE                                    ID             DISK USAGE\nsulla-vault:agent-job-1-m3-abc1234       027327d3b515   275MB\n';
  assert.equal(runtime.hasImage('sulla-vault:agent-job-1-m3-abc1234'), true);
  assert.equal(runtime.hasImage('sulla-vault:other'), false);
  assert.deepEqual(imageRepoTag('img@sha256:abc'), null);
});
