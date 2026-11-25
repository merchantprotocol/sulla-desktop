// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { ProviderToolActivityReporter } from '@pkg/agent/languagemodels/ProviderToolActivityReporter';

describe('ProviderToolActivityReporter', () => {
  it('forwards the full provider tool activity text without flattening or truncating it', () => {
    // risk: the human sees incomplete tool activity while Detailed contains the full provider call.
    const onActivity = vi.fn();
    const reporter = new ProviderToolActivityReporter(onActivity);
    const text = `${ 'provider tool arguments '.repeat(8) }\nEND_OF_FULL_ACTIVITY`;

    reporter.report(text, 'tool');

    expect(onActivity).toHaveBeenCalledExactlyOnceWith(text, 'tool');
  });
});
