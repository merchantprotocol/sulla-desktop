// @ts-check
import { TS_EXT_TO_TREAT_AS_ESM, ESM_TS_TRANSFORM_PATTERN } from 'ts-jest';

/** @type {import('jest').Config} */
export default {
  transform: {
    [ESM_TS_TRANSFORM_PATTERN]: ['ts-jest', { useESM: true }],
    '^.+\\.vue$':               './pkg/rancher-desktop/utils/testUtils/vue-jest.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@octokit|@babel|@jest|uuid|nanoid|got|p-timeout|p-cancelable|@sindresorhus|lowercase-keys|responselike|cacheable-request|normalize-url|cacheable-lookup|keyv|json-buffer|clone-response|http-cache-semantics|mimic-response|form-data-encoder|@types)/)',
  ],
  extensionsToTreatAsEsm:  [...TS_EXT_TO_TREAT_AS_ESM, '.vue'],
  moduleFileExtensions:    [
    'js',
    'json',
    'node', // For native modules, e.g. @napi-rs/xattr
    'ts',
    'vue',
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/dist',
    '<rootDir>/pkg/rancher-desktop/dist',
    '<rootDir>/.git',
    '<rootDir>/e2e',
    '<rootDir>/screenshots',
  ],
  moduleNameMapper: {
    '\\.css$':       '<rootDir>/pkg/rancher-desktop/config/emptyStubForJSLinter.js',
    '^@pkg/assets/': '<rootDir>/pkg/rancher-desktop/config/emptyStubForJSLinter.js',
    '^@pkg/(.*)$':   '<rootDir>/pkg/rancher-desktop/$1',
  },
  setupFiles: [
    // Must run first: polyfills TextEncoder/TextDecoder onto the jsdom
    // global so suites that import `pg` can load (jsdom omits them).
    '<rootDir>/pkg/rancher-desktop/utils/testUtils/setupTextEncoder.ts',
    '<rootDir>/pkg/rancher-desktop/utils/testUtils/setupVue.ts',
  ],
  testEnvironment:        'jsdom',
  testEnvironmentOptions: {
    customExportConditions: [
      'node',
      'node-addons',
    ],
  },
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/pkg/rancher-desktop/sudo-prompt/',
  ],
};
