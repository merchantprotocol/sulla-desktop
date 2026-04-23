export const RUNTIME_URLS: Record<string, string> = {
  python: 'http://127.0.0.1:30118',
  shell:  'http://127.0.0.1:30119',
  node:   'http://127.0.0.1:30120',
};

// File that signals a runtime has installable dependencies for a function.
export const DEPS_FILES: Record<string, string> = {
  python: 'requirements.txt',
  node:   'package.json',
  shell:  'packages.txt',
};
