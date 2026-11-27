// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface LoadOptions {
  concurrency: number;
  holdSeconds: number;
  bodyKb: number;
  cancelCount: number;
  /** Non-zero enables the optional resource soak and holds streams this long (max five minutes). */
  durationSeconds: number;
}

export class LoadOptionsParser {
  static readonly maximumConcurrentRequestBodyBytes = 128 * 1024 * 1024;
  static readonly defaults: LoadOptions = {
    concurrency: 300,
    holdSeconds: 30,
    bodyKb: 350,
    cancelCount: 100,
    durationSeconds: 0,
  };

  parse(argv: string[]): LoadOptions {
    const options = { ...LoadOptionsParser.defaults };
    const values: Record<string, keyof LoadOptions> = {
      '--concurrency': 'concurrency',
      '--hold-seconds': 'holdSeconds',
      '--body-kb': 'bodyKb',
      '--cancel': 'cancelCount',
      '--duration': 'durationSeconds',
    };
    for (let index = 0; index < argv.length; index++) {
      const [flag, inlineValue] = argv[index].split('=', 2);
      if (flag === '--help' || flag === '-h') {
        throw new Error('Usage: tsx test-load.ts [--concurrency 300] [--hold-seconds 30] [--body-kb 350] [--duration 0|300] [--cancel 100]');
      }
      const key = values[flag];
      if (!key) throw new Error(`Unknown flag: ${ flag }`);
      const rawValue = inlineValue ?? argv[index + 1];
      if (rawValue === undefined || rawValue.startsWith('--')) {
        if (flag === '--cancel' && inlineValue === undefined) {
          options.cancelCount = 100;
          continue;
        }
        throw new Error(`Missing value for ${ flag }`);
      }
      if (inlineValue === undefined) index++;
      if (!/^\d+$/.test(rawValue)) throw new Error(`${ flag } must be a whole number`);
      const value = Number(rawValue);
      const ranges: Record<keyof LoadOptions, { min: number; max: number }> = {
        concurrency: { min: 1, max: 1_000 },
        holdSeconds: { min: 1, max: 300 },
      bodyKb: { min: 1, max: 1_024 },
        cancelCount: { min: 0, max: 1_000 },
        durationSeconds: { min: 0, max: 300 },
      };
      const range = ranges[key];
      if (value < range.min || value > range.max) throw new Error(`${ flag} must be between ${ range.min } and ${ range.max }`);
      options[key] = value;
    }
    if (options.cancelCount > options.concurrency) options.cancelCount = options.concurrency;
    const inFlightBodyBytes = options.concurrency * options.bodyKb * 1_000;
    if (inFlightBodyBytes > LoadOptionsParser.maximumConcurrentRequestBodyBytes) {
      throw new Error(`concurrency × body size exceeds the ${ LoadOptionsParser.maximumConcurrentRequestBodyBytes } byte in-flight body budget`);
    }
    return options;
  }
}
