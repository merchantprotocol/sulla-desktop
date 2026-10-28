// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Checks if Sulla Desktop is running in a development or test environment
 * @returns True if Sulla Desktop is running in a development or test
 * environment
 */
const isDev = /^(?:dev|test)/i.test(process.env.NODE_ENV || '');
const isE2E = /e2e/i.test(process.env.SULLA_TEST ?? '');

export const isDevEnv = isDev || isE2E;
export const isDevBuild = !isE2E && isDev;
