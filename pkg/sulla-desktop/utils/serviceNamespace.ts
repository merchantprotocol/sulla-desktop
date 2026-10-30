// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const DEFAULT_NAMESPACE = 'sulla';
const raw = (process.env.SULLA_INSTANCE_NAMESPACE || DEFAULT_NAMESPACE).trim().toLowerCase();

if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(raw)) {
  throw new Error('SULLA_INSTANCE_NAMESPACE must be 1-48 lowercase letters, numbers, underscores, or hyphens');
}

/** One identity for Compose, containers, networks, volumes, app data and ports. */
export const serviceNamespace = raw;
export const isDefaultServiceNamespace = serviceNamespace === DEFAULT_NAMESPACE;
export const composeProjectName = serviceNamespace.replaceAll('_', '-');
export const composeNetworkName = `${ composeProjectName }_default`;
export const composeFilePath = `/tmp/${ composeProjectName }-docker-compose.yml`;

export function namespacedAppPath(defaultPath: string): string {
  return isDefaultServiceNamespace ? defaultPath : `${ defaultPath }-${ composeProjectName }`;
}

export function serviceContainerName(service: string): string {
  return `${ composeProjectName }_${ service.replace(/^sulla_/, '') }`;
}
