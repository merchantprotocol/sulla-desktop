// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Container } from '@pkg/store/container-engine';

export function cleanName(value: string) {
  return value.replace(/^\//, '');
}

export function displayProject(value: string) {
  return value === 'sulla' ? 'Sulla' : value === 'Standalone Containers' ? 'Other containers' : value;
}

export function flatPorts(container: Container) {
  return Object.entries(container.ports || {}).flatMap(([target, bindings]) =>
    (bindings || []).map((binding) => {
      const [containerPort, protocol = 'tcp'] = target.split('/');
      return {
        containerPort,
        protocol,
        hostIp:   binding.HostIp || '127.0.0.1',
        hostPort: binding.HostPort,
      };
    }),
  );
}

export function isNetworkWide(ip: string) {
  return ip === '0.0.0.0' || ip === '::';
}

export function reachableFrom(ip: string) {
  return isNetworkWide(ip) ? 'Your whole network' : 'This Mac only';
}

export function imageName(image: any) {
  const raw = image.RepoTags?.[0] || '<none>:<none>';
  const separator = raw.lastIndexOf(':');
  const hasTag = separator > raw.lastIndexOf('/');
  return {
    repository: hasTag ? raw.slice(0, separator) : raw,
    tag:        hasTag ? raw.slice(separator + 1) : '<none>',
  };
}
