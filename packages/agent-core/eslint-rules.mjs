// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Portability rules for packages/agent-core/src. The root eslint.config.mts
// and the package's own CI lint (test/lint.mjs) both use this object, so
// the two can't drift.

/** The portable agent loop must run unchanged on Node, Workers and Hermes. */
export const agentCorePortableRules = {
  'no-restricted-imports': ['error', {
    patterns: [{
      regex:   '^(node:|fs$|path$|crypto$|os$|http$|https$|net$|child_process$|buffer$|stream$|url$|util$|electron|react-native|cloudflare:)',
      message: 'agent-core is platform-neutral: take this through a host interface instead.',
    }],
  }],
  'no-restricted-globals': ['error', 'process', 'Buffer', 'require', 'fetch', 'window', 'document', 'console', 'setTimeout', 'setInterval', 'globalThis'],
  // The Hermes CLI can't parse classes without a Babel pass.
  'no-restricted-syntax':  ['error', 'ClassDeclaration', 'ClassExpression'],
};
