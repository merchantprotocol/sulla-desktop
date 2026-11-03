// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

type ProviderValues = Readonly<Record<string, string | undefined>>;

export function kimiBaseUrl(values: ProviderValues): string {
  return values.region === 'china' ? 'https://api.moonshot.cn/v1' : 'https://api.moonshot.ai/v1';
}

export function alibabaBaseUrl(values: ProviderValues): string {
  const plan = values.plan || 'payg';
  const region = values.region || 'intl';

  if (plan === 'coding') {
    return region === 'cn'
      ? 'https://coding.dashscope.aliyuncs.com/v1'
      : 'https://coding-intl.dashscope.aliyuncs.com/v1';
  }
  if (region === 'us') return 'https://dashscope-us.aliyuncs.com/compatible-mode/v1';
  if (region === 'cn') return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
}
