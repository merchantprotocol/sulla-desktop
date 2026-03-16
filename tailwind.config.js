/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content:  [
    './pkg/rancher-desktop/pages/**/*.{vue,js,ts,tsx}',
    './pkg/rancher-desktop/components/**/*.{vue,js,ts,tsx}',
    './pkg/rancher-desktop/entry/**/*.{js,ts}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
