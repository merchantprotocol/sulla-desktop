// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content:  [
    './pkg/sulla-desktop/pages/**/*.{vue,js,ts,tsx}',
    './pkg/sulla-desktop/components/**/*.{vue,js,ts,tsx}',
    './pkg/sulla-desktop/entry/**/*.{js,ts}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
