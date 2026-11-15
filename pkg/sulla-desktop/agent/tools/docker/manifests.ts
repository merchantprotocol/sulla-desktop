// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolManifest } from '../registry';

export const dockerToolManifests: ToolManifest[] = [
  {
    name: 'docker_stats', description: 'Read one-shot Docker CPU, memory, I/O and PID statistics.', category: 'docker',
    schemaDef: { container: { type: 'array', optional: true, items: { type: 'string' }, description: 'Optional container name(s)' }, sort: { type: 'enum', enum: ['cpu', 'mem', 'pids'], optional: true }, limit: { type: 'number', optional: true } },
    operationTypes: ['read'], loader: () => import('./docker_stats'),
  },
  {
    name: 'docker_inspect_health', description: 'Inspect container state, health checks, restarts, OOM and resource policy.', category: 'docker',
    schemaDef: { container: { type: 'array', optional: true, items: { type: 'string' }, description: 'Optional container name(s); omitted means all containers' } },
    operationTypes: ['read'], loader: () => import('./docker_inspect_health'),
  },
  {
    name: 'docker_system_df', description: 'Summarize Docker image, container, volume and build-cache disk usage.', category: 'docker',
    schemaDef: {}, operationTypes: ['read'], loader: () => import('./docker_system_df'),
  },
  {
    name: 'docker_vm_snapshot', description: 'Read-only VM load, memory, mounts and process resource snapshot.', category: 'docker',
    schemaDef: {}, operationTypes: ['read'], loader: () => import('./docker_vm_snapshot'),
  },
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
    description: 'Run a Docker container.',
    category:    'docker',
    schemaDef:   {
      image:   { type: 'string', description: 'Docker image to run' },
      name:    { type: 'string', optional: true, description: 'Container name' },
      command: { type: 'string', optional: true, description: 'Command to run in the container' },
      options: { type: 'string', optional: true, description: 'Additional docker run options' },
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
