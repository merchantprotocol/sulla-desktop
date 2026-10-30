// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const TEST_INSTANCE_NAME = 'firstrun-test';
export const TEST_INSTANCE_FLAG = '--sulla-test-instance';
export const TEST_PORT_OFFSET = 10_000;

export function requestedInstance(): string {
  return process.env.SULLA_INSTANCE?.trim() || '';
}

export function isFirstRunTestInstance(): boolean {
  return requestedInstance() === TEST_INSTANCE_NAME && process.argv.includes(TEST_INSTANCE_FLAG);
}

export function portOffset(): number {
  return isFirstRunTestInstance() ? TEST_PORT_OFFSET : 0;
}

export function hostPort(base: number): number {
  return base + portOffset();
}

export function loopbackOrigin(protocol: 'http' | 'https' | 'ws', basePort: number): string {
  return `${ protocol }://127.0.0.1:${ hostPort(basePort) }`;
}

/** Export every compose host-port variable before any runtime child is spawned. */
export function configureInstancePorts(): void {
  const bases = [3000, 3020, 6107, 6108, ...Array.from({ length: 20 }, (_, index) => 30116 + index)];
  for (const base of bases) process.env[`SULLA_PORT_${ base }`] = String(hostPort(base));
  process.env.SULLA_PORT_OFFSET = String(portOffset());
}
