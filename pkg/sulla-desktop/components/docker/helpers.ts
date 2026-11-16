// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Container } from '@pkg/store/container-engine';

/** Pure formatting helpers for the Docker pages (container names, ports, images, health). */
export class DockerFormat {
  static cleanName(value: string) {
    return value.replace(/^\//, '');
  }

  static displayProject(value: string) {
    return value === 'sulla' ? 'Sulla' : value === 'Standalone Containers' ? 'Other containers' : value;
  }

  static flatPorts(container: Container) {
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

  static isNetworkWide(ip: string) {
    return ip === '0.0.0.0' || ip === '::';
  }

  static reachableFrom(ip: string) {
    return DockerFormat.isNetworkWide(ip) ? 'Your whole network' : 'This Mac only';
  }

  static imageName(image: any) {
    const raw = image.RepoTags?.[0] || '<none>:<none>';
    const separator = raw.lastIndexOf(':');
    const hasTag = separator > raw.lastIndexOf('/');
    return {
      repository: hasTag ? raw.slice(0, separator) : raw,
      tag:        hasTag ? raw.slice(separator + 1) : '<none>',
    };
  }

  /** Health from a `docker ps` status line: "Up 2 hours (healthy)", "Up 5 seconds (health: starting)". */
  static healthFromStatus(status: string | undefined): 'healthy' | 'unhealthy' | 'starting' | undefined {
    const match = /\((healthy|unhealthy|health: starting)\)/.exec(status ?? '')?.[1];

    return match === 'health: starting' ? 'starting' : match as 'healthy' | 'unhealthy' | undefined;
  }
}

/** @deprecated use DockerFormat.cleanName */
export const cleanName = (value: string) => DockerFormat.cleanName(value);
/** @deprecated use DockerFormat.displayProject */
export const displayProject = (value: string) => DockerFormat.displayProject(value);
/** @deprecated use DockerFormat.flatPorts */
export const flatPorts = (container: Container) => DockerFormat.flatPorts(container);
/** @deprecated use DockerFormat.isNetworkWide */
export const isNetworkWide = (ip: string) => DockerFormat.isNetworkWide(ip);
/** @deprecated use DockerFormat.reachableFrom */
export const reachableFrom = (ip: string) => DockerFormat.reachableFrom(ip);
/** @deprecated use DockerFormat.imageName */
export const imageName = (image: any) => DockerFormat.imageName(image);
/** @deprecated use DockerFormat.healthFromStatus */
export const healthFromStatus = (status: string | undefined) => DockerFormat.healthFromStatus(status);
