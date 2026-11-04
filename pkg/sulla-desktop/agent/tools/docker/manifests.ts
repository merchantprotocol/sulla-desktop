// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolManifest } from '../registry';

export const dockerToolManifests: ToolManifest[] = [
  {
    name:        'docker_build',
    description: 'Build a Docker image from a Dockerfile.',
    category:    'docker',
    schemaDef:   {
      path:    { type: 'string', description: 'Path to the directory containing the Dockerfile' },
      tag:     { type: 'string', description: 'Tag for the built image' },
      options: { type: 'string', optional: true, description: 'Additional docker build options' },
    },
    operationTypes: ['create', 'update', 'execute'],
    loader:         () => import('./docker_build'),
  },
  {
    name:        'docker_exec',
    description: 'Execute a command in a running Docker container.',
    category:    'docker',
    schemaDef:   {
      container: { type: 'string', description: 'Container name or ID' },
      command:   { type: 'string', description: 'Command to execute in the container' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./docker_exec'),
  },
  {
    name:        'docker_images',
    description: 'List Docker images.',
    category:    'docker',
    schemaDef:   {
      all: { type: 'boolean', optional: true, description: 'Show all images (default: only top-level images)' },
    },
    operationTypes: ['read', 'update', 'create', 'delete'],
    loader:         () => import('./docker_images'),
  },
  {
    name:        'docker_logs',
    description: 'Fetch the logs of a Docker container.',
    category:    'docker',
    schemaDef:   {
      container: { type: 'string', description: 'Container name or ID' },
      follow:    { type: 'boolean', optional: true, description: 'Follow log output' },
      tail:      { type: 'number', optional: true, description: 'Number of lines to show from the end' },
    },
    operationTypes: ['read'],
    loader:         () => import('./docker_logs'),
  },
  {
    name:        'docker_ps',
    description: 'List Docker containers.',
    category:    'docker',
    schemaDef:   {
      all:    { type: 'boolean', optional: true, description: 'Show all containers (default: only running)' },
      format: { type: 'string', optional: true, description: "Format output (e.g., 'table {{.Names}}\\t{{.Status}}')" },
    },
    operationTypes: ['read', 'execute'],
    loader:         () => import('./docker_ps'),
  },
  {
    name:        'docker_pull',
    description: 'Pull a Docker image from a registry.',
    category:    'docker',
    schemaDef:   {
      image: { type: 'string', description: 'Docker image to pull' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./docker_pull'),
  },
  {
    name:        'docker_rm',
    description: 'Remove one or more Docker containers.',
    category:    'docker',
    schemaDef:   {
      container: { type: 'string', description: 'Container name or ID to remove' },
      force:     { type: 'boolean', optional: true, description: 'Force removal of running containers' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./docker_rm'),
  },
  {
    name:        'docker_run',
    description: 'Run a Docker container. Agent containers are temporary by default (4 hour TTL), reject restart policies, and are reaped when the job ends. Use persistent:true with a non-empty reason only when persistence is required.',
    category:    'docker',
    schemaDef:   {
      image:   { type: 'string', description: 'Docker image to run' },
      name:    { type: 'string', optional: true, description: 'Container name' },
      command: { type: 'string', optional: true, description: 'Command to run in the container' },
      options:    { type: 'string', optional: true, description: 'Additional docker run options; restart policies require persistent:true and reason' },
      persistent: { type: 'boolean', optional: true, description: 'Opt out of temporary-only restart-policy protection; requires reason' },
      reason:     { type: 'string', optional: true, description: 'Required audit reason when persistent is true' },
      ttlSeconds: { type: 'number', optional: true, description: 'Expiration in seconds (default 14400 / 4 hours)' },
    },
    operationTypes: ['create', 'update', 'execute'],
    loader:         () => import('./docker_run'),
  },
  {
    name:        'docker_stop',
    description: 'Stop a running Docker container.',
    category:    'docker',
    schemaDef:   {
      container: { type: 'string', description: 'Container name or ID to stop' },
    },
    operationTypes: ['execute', 'delete'],
    loader:         () => import('./docker_stop'),
  },
];
