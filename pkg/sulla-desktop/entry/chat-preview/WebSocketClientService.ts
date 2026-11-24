// SPDX-License-Identifier: GPL-2.0-or-later

/** Workflow artifact rendering can subscribe, but the preview has no live runtime. */
export function getWebSocketClientService() {
  return { onMessage: () => () => undefined };
}
