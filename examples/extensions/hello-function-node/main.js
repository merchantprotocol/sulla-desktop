// SPDX-License-Identifier: GPL-2.0-or-later
export async function handler(inputs) {
  return { result: `Hello, ${inputs.name ?? 'world'}!` };
}
